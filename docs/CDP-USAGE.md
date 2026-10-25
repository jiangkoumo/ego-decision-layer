# 外部 Chrome（CDP）任务入口

`scripts/run-cdp-task.mjs` 是**普通 Node 进程**里的第二个宿主：用外部 Chrome 的 CDP endpoint 替代
ego lite 的 `taskSpace`，观测 / 决策 / 执行 / 校验 / 护栏 / 缓存 / 批量 / 抽取仍然全部由
`scripts/decider-loop.mjs` 负责。它不改引擎导出、不改 ego 默认入口、不起服务、也不刷新路由接管层。

> 状态：编排与错误语义已实现并有离线行为测试（`bench/test-cdp-runner.mjs`）。
> 宿主适配器 `scripts/hosts/cdp-host.mjs` 由另一任务提供；**本入口的真实浏览器验收（外部 Chrome 上的
> 搜索/点击/输入）尚未在本仓库跑过**，见文末「验证状态」。

## 两条用法

```bash
# 1) 命令：日志走 stderr，结果 JSON 走 stdout（可直接 JSON.parse）
node scripts/run-cdp-task.mjs --config /tmp/cdp-task.json
node scripts/run-cdp-task.mjs --help

# 2) 库：编排可被行为测试直接驱动
import { runCdpTask } from "./scripts/run-cdp-task.mjs";
const result = await runCdpTask(cfg, { onLog: () => {} });
```

退出码：`0` 成功 / `1` 未达成 / `2` 参数或配置错误 / `3` 缺凭证 / `130` 取消（SIGINT）/ `143` 取消（SIGTERM）。

## 准备外部 Chrome

Chrome 从 136 起**必须**用非默认的 `--user-data-dir` 才开放 CDP；请用一次性 profile，别指向日常用的那个：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir=/tmp/ego-cdp-profile \
  --no-first-run --no-default-browser-check about:blank &

curl -s http://127.0.0.1:9333/json/version | grep webSocketDebuggerUrl
# 把 webSocketDebuggerUrl 的值填进配置的 cdpEndpoint
```

本入口只连、只清理**自己创建的专属 target**；`close({ keepPage: false })` 关掉自己那一页并释放连接，
**绝不关闭你的浏览器进程**。

## 配置

现有 `scripts/ego-decision-layer` 的 cfg 字段全部可用，只多一个 `cdpEndpoint`：

```json
{
  "cdpEndpoint": "ws://127.0.0.1:9333/devtools/browser/…",
  "cdpTimeoutMs": 15000,
  "goal": "在顶部搜索框输入 Jev 并提交",
  "url": "https://en.wikipedia.org/wiki/Main_Page",
  "until": "/wiki/Jev",
  "texts": ["Jev"],
  "steps": 5,
  "cache": true,
  "cacheFile": "/tmp/ego-action-cache.json",
  "cacheContext": { "until": "/wiki/Jev", "decider": null },
  "batch": true,
  "visualFallback": true,
  "apiKey": null,
  "baseUrl": null,
  "fallbackBaseUrl": null,
  "deciderConfig": null,
  "forceViewport": "1280x900@1",
  "strictViewport": false,
  "extractInstruction": null,
  "extractSchema": null,
  "extractionModel": null,
  "routeFile": null,
  "keepSpace": false
}
```

| 字段 | 说明 |
| --- | --- |
| `cdpEndpoint` | **必需**。`http://127.0.0.1:<port>`（适配器自动读 `/json/version`）或 `ws://…/devtools/browser/<id>` |
| `cdpTimeoutMs` | 连接超时，默认 `15000` |
| `goal` / `extractInstruction` | 至少要有一个；只有抽取时不跑操作循环 |
| `until` | 确定性退出条件（URL 子串）。**最终 URL 复核**，未命中绝不判成功 |
| `cache` / `cacheFile` / `cacheContext` | 动作缓存开关、文件与身份上下文（与 CLI 同义） |
| `forceViewport` | 字符串 `<宽>x<高>[@缩放]`，原样透传引擎（`1280x900` / `1280x900@2`） |
| `strictViewport` | `true` = 视口退化时直接失败，不自动撑起 |
| `extractionModel` | 已解析好的文本模型配置；缺省时入口自己调 `resolveExtractionModel`（缺配置 → exit 3） |
| `routeFile` | 只读：把这个 JSON 带进结果的 `route` 字段。本入口**不做**路由刷新 |
| `keepSpace` / `keepPage` | 完成后保留页面供排查（连接仍会释放） |

CDP 模式**不接受** `spaceId`（不复用 ego taskSpace）和 `keep`（不按页面 label 保留），传了直接 exit 2。

## 宿主适配器契约

```js
const { page, metadata, close } = await connectCdpHost({ endpoint, signal, timeoutMs });
```

* `page` 必须提供引擎实际消费的 API：`evaluate(fn, arg)`、`url()`、`title()`、`cdp(method, params)`、
  `waitForLoadState(state, { timeout })`，以及导航用的 `goto(url, { waitUntil, timeout })`。
  `waitUntil` 只用 `load` / `domcontentloaded` / `commit`（本入口传 `domcontentloaded`）。
* **导航只有一份实现（在适配器里）**：本入口直接 `await page.goto(...)`，不再自己搭一套
  `Page.navigate` + 轮询的兜底——两份有界导航/异常处理会互相矛盾，也容易把控制停止当导航噪声吞掉。
  适配器缺 `goto` 时按契约错误失败（`exit 2`），不降级。
* `waitForTimeout(ms)` 可选（cdp-host 不提供）：没有就跳过导航后那 800ms 额外等待。
* `close({ keepPage })`：`keepPage: true` 保留页面但仍释放连接；`false` 连页面一起清理。
  适配器返回的 receipt（`targetClosed` / `keptPage` / `browserClosed:false`）会进 `connection.receipt`。
  失败的连接、异常、取消都会在 `finally` 里调用它（保留页面的策略见下）。

### 覆盖适配器 / 引擎路径（跨 worktree 验证）

按优先级从高到低：

| 目的 | 注入方式 |
| --- | --- |
| 适配器 | `deps.connectCdpHost`（函数）→ `deps.hostModule`（路径/命名空间）→ `cfg.hostModule`（绝对路径或 `file://`）→ 环境变量 `EGO_JEV_CDP_HOST` → 默认 `scripts/hosts/cdp-host.mjs` |
| 引擎 | `deps.engine`（模块）→ `deps.enginePath` → `cfg.engineModule` → 环境变量 `EGO_JEV_LIB` → 默认 `scripts/decider-loop.mjs` |

适配器是**延迟动态导入**：配置/凭证错误在加载适配器之前就以 exit 2 / 3 失败，不会先起浏览器。

## 结果字段（stdout JSON）

关键语义：**确定性 `verified` 与模型 `done` 分开**。

* `success` / `exitCode` / `reason` / `stopReason`（引擎原始停止原因）/ `modelDone`
* `verified`：`until` 在**最终 URL** 上复核通过；`jev_done` 只是模型判断完成 → `verified: false`
* 配了 `until` 而最终 URL 未命中 → `success: false`、`reason: "until_not_matched"`、`untilMatched: false`
* `url` / `title`：释放连接**之前**重读的最终页面状态；`steps`：`null` 表示未知（不拿日志条数冒充）
* `stepLog`：引擎的步骤日志（stderr 同样输出）；`actions`：结构化动作记录（引擎没给 history 时为 `null`）

`actions[]` 把**决策意图**和**已执行证据**分开，绝不从意图推断已派发：

```json
{
  "intent": { "action": "click", "target": "Go", "text": null, "option": null, "batchSize": null },
  "dispatched": true,
  "executedSubActions": null,
  "failedSubActionIndex": null,
  "observed": { "changed": true, "progressed": true, "urlAfter": "…", "scrollMoved": null },
  "skipped": { "guardRejected": null, "staleTarget": null, "targetMissing": false, "optionStale": null, "invalidResponse": null },
  "cacheHit": false,
  "outcomeUnknown": false,
  "error": null,
  "durationMs": 812,
  "step": 1
}
```

* `dispatched`：`true` 已派发（有 `executedSubActions` 或 `changed` 证据）/ `false` 确认未派发
  （守卫拒绝、陈旧目标、`invalidResponse`、`wait`/`done`/`blocked`）/ `null` 未知。
* `outcomeUnknown`：可能已产生副作用但未核实（单步结果未知、`action_outcome_unknown`、取消时在飞的一步）。
* 结果级 `outcomeUnknown` 在取消、引擎报 `action_outcome_unknown`、宿主中止时为 `true`。

其余字段：`extracted` / `extractSkipped` / `data` / `schema` / `phases` / `cacheHits` / `cacheHeals` /
`serverModels` / `serverEndpoints` / `usage` / `viewport` / `viewportOverride` / `hint` / `metadata` /
`route` / `elapsedMs`，以及 `connection: { endpoint, connected, released, keepPage, closeError }`。

## 取消与页面保留

* `SIGINT` / `SIGTERM`（命令模式）或 `deps.signal`（库调用）触发取消：
  **停止派发新动作**（闸门在每步 `check` 里，取消后不再有观测/决策/派发），在飞的一步会跑完，
  `finally` 里释放连接。
* 取消后结果：`cancelled: true`、`reason: "cancelled"`、`steps: null`、`outcomeUnknown: true`，
  退出码 `130` / `143`。
* 页面保留策略统一在 `finally` 决定：`keepSpace`/`keepPage` 为真、**失败**、或**取消** → `close({ keepPage: true })`；
  只有完全成功且未显式保留才 `close({ keepPage: false })`。连接无论如何都会释放。
* 宿主控制权丢失（适配器抛 `EGO_HOST_ABORTED` 而本次没有收到取消信号）→ `reason: "host_control_stop"`，
  与用户取消区分开，不重复派发；同一个错误码在**本次 signal 已取消**时才归类为用户取消。
  其他宿主错误（`HOST_NAVIGATION_FAILED`、连接断开、超时）照旧分类为 `navigation_failed` / `connect_failed` 等。

## 与共享 CLI 的集成（主控负责）

`scripts/ego-decision-layer` 侧新增 `--cdp-endpoint <url>`，把现有 cfg 加上 `cdpEndpoint` 后写到临时文件，
再 `node scripts/run-cdp-task.mjs --config <file>`。CDP 模式禁止 `--space` / `--keep`，支持 `--keep-space`。
CLI 行为测试在主控分支，本文件只描述 runner 侧契约。

## 验证状态

已跑（`node bench/test-cdp-runner.mjs`，98 项断言，退出码 0）：配置校验先于适配器加载、退出码 2/3、
字段透传、`verified` 与模型 done 分离、`until` 最终 URL 复核、`until` 未命中不 success、抽取门控与失败、
取消阻止新派发并在 `finally` 释放连接、`EGO_HOST_ABORTED` 与用户取消区分、动作意图/已执行/未知（含批次
部分执行）三段报告、导航只走 `goto`（缺 `goto` 按契约错误 `exit 2`；`HOST_NAVIGATION_FAILED` 仍算导航失败）、
CLI 的 `--config` / `--help` / 退出码与 stdout JSON，以及**真实引擎**（假 page、无浏览器）的 `check_passed`
与取消路径。

SKIP（不计入通过）：外部 Chrome 上的真实搜索/点击/输入。原因：`scripts/hosts/cdp-host.mjs` 尚由另一任务提供，
本仓库里没有该模块；适配器合入后由主控用真实 Chrome 复验本页描述的命令与结果字段。
