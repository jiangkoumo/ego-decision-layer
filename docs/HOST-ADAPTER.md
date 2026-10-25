# Host Adapter：在普通 Node + 外部 Chrome 上复用决策引擎

本文是 **Host Adapter 契约 v1** 的实现说明。契约本体是代码：
[`scripts/hosts/host-contract.mjs`](../scripts/hosts/host-contract.mjs)；
第二宿主的实现是 [`scripts/hosts/cdp-host.mjs`](../scripts/hosts/cdp-host.mjs)。
验收测试是 [`bench/test-cdp-host.mjs`](../bench/test-cdp-host.mjs)。

> 状态：**只覆盖引擎的默认 DOM 路径 + 入口所需的 `goto`**。ego lite 专有的
> `snapshot` / ref 派生动作（`page.click(ref)` 等）**没有**实现，调用会显式失败。
> 这不是「暂时缺」，是刻意的能力边界（见下）。

## 为什么需要契约，而不是「有个 page 就行」

引擎 [`scripts/decider-loop.mjs`](../scripts/decider-loop.mjs) 只消费 `page` 上的一小组方法。
换宿主时最危险的失败形态不是报错，而是**缺失能力被当成「页面没有目标」**：闭环会一路
`wait` / `no_targets`，最后报「未达成」，看起来像模型不行，实际是宿主少了一个方法。

所以边界写成代码：`assertHostPage()` 让适配器在启动时 fail-closed 自检，
`describeHostCapabilities()` 让调用方与测试核对实际边界。能力是 page **自述**的
（`page.hostCapabilities`），不是靠「方法存不存在」推断——adapter 完全可以把不支持的方法
实现成「一调用就抛错」的 stub，这恰恰是 fail-closed 想要的行为，结构推断会把它误判成「支持」。

## 接口

```js
import { connectCdpHost } from "<repo>/scripts/hosts/cdp-host.mjs";

const { page, metadata, close } = await connectCdpHost({
  endpoint,          // "http://127.0.0.1:<port>" 或 "ws://…/devtools/browser/<id>"
  signal,            // 可选 AbortSignal
  timeoutMs,         // 可选，连接/发现超时，默认 10000
  commandTimeoutMs,  // 可选，单条 CDP 命令无响应上限，默认 30000
  url,               // 可选，新建 target 的初始 URL，默认 "about:blank"
  viewport,          // 可选 {width,height}，走 Emulation.setDeviceMetricsOverride；默认不动视口
});

await page.goto(url, { waitUntil: "load", timeout: 30000 }); // load | domcontentloaded | commit
await close({ keepPage: false });
```

`metadata`：`{ contractVersion, host:"cdp", ownedPage, createdTarget, targetId, sessionId,
endpoint, httpEndpoint, browserVersion, initialUrl, viewport }`。
`close()` 返回 `{ closed, alreadyClosed, keptPage, targetId, targetClosed, browserClosed:false,
targetCloseError? }`——`browserClosed` 恒为 `false`，因为宿主**从不**调用 `Browser.close`。

### page 方法（默认 DOM 路径，引擎会调用）

| 方法 | 语义 | 引擎调用点 |
| --- | --- | --- |
| `evaluate(fn, arg)` | 页面上下文执行函数，参数**单个**、走 JSON 往返，返回值必须可序列化 | `observeDom` / `stateInPage` / `selectInPage` / `scrollInPage` / `readScrollY` |
| `cdp(method, params, {timeoutMs}?)` | 页面会话（带 `sessionId`）上的裸 CDP | `Input.dispatchMouseEvent` / `Input.insertText` / `Input.dispatchKeyEvent` / `Emulation.setDeviceMetricsOverride` |
| `url()` | 当前文档 URL；导航中 evaluate 失败时用 `Page.frameNavigated` 兜底 | `urlBefore` / `urlAfter`、进展判定 |
| `title()` | 当前文档标题；同上兜底 | 决策上下文 |
| `waitForLoadState(state, {timeout})` | 只接受 `load`（`complete`）/ `domcontentloaded`（`interactive`）；其他值（含 `commit`、`networkidle*`）**在发任何探针之前**抛 `HostCapabilityError`，不会静默按 `load` 等待 | `settle` 的导航等待、观测遇导航的有界重试 |
| `keyboard.press(key)` | 真实 `Input.dispatchKeyEvent`（`Enter` 带 `text:"\r"`，否则隐式提交不触发） | `type_text_submit` |

### page 方法（入口路径，引擎不调用）

| 方法 | 语义 |
| --- | --- |
| `goto(url, {waitUntil, timeout})` | 导航并**等新文档真的提交** |

`goto` 的顺序是：读导航前的 `loaderId`（`Page.getFrameTree`，或用事件已经跟踪到的）→
`Page.navigate` → 等 `Page.frameNavigated` 把主 frame 的 `loaderId` 换成导航返回的那个 →
再按 `waitUntil` 等文档状态。**绝不**在 `Page.navigate` 之后直接读旧文档的
`readyState === "complete"` 判成功——`about:blank` 从页面出发导航时旧文档永远是 `complete`，
那样会立刻返回一个还没提交的「成功」。`waitUntil:"commit"` 只等提交。
`waitUntil` 只接受 `load` / `domcontentloaded` / `commit`；`networkidle*` **明确拒绝**
（需要 Network 域统计在途请求，不假装实现）。

### 明确不支持（调用即 `HostCapabilityError`）

`page.snapshot()`、`page.click(ref)`、`page.fill(ref)`、`page.press(ref)`、`page.selectOption(ref)`
——ego lite 专有的 snapshot / ref 路径（宿主自建快照索引 + ref 解析）。
需要时在 ego-browser 里跑引擎，或改用选择器 / 原生 DOM API。

**这条边界的可观察后果**：引擎在 DOM 观测为空（页面真的没有可交互元素）时会回退到
`page.snapshot()`。在 cdp-host 上这会是**显式的能力错误**，而不是「静默 no_targets」。
CLI / runner 集成时建议 catch `err.code === "HOST_CAPABILITY_MISSING"` 单独提示。

## 错误码

| 类 | code | name | 说明 |
| --- | --- | --- | --- |
| `HostAbortError` | `EGO_HOST_ABORTED` | `HostAbortError` | 调用方取消。**唯一带 `EGO_` 前缀的错误**：取消是控制停止，引擎 `rethrowBrowserStop()` 会直接上抛，不会被当成导航 / 动作失败吞掉 |
| `HostTimeoutError` | `HOST_TIMEOUT` | `TimeoutError` | 连接 / `waitForLoadState` / `goto` 的等待超时（与 ego 的 wait 超时同义，可继续） |
| `HostStalledError` | `HOST_COMMAND_STALLED` | `HostStalledError` | 单条 CDP 命令无响应。**不**匹配 timeout 判据：连接卡死不能被当成「页面还在加载」而重试 |
| `HostDisconnectedError` | `HOST_DISCONNECTED` | — | socket 断开、target 被外部关闭、会话被销毁（`Session closed` / `Target closed` 也归到这里） |
| `HostNavigationError` | `HOST_NAVIGATION_FAILED` | — | `Page.navigate` 返回 `errorText`（如 `net::ERR_NAME_NOT_RESOLVED`） |
| `HostCapabilityError` | `HOST_CAPABILITY_MISSING` | — | 明确不支持的能力 / 未映射的按键 / 不支持的 `waitUntil` |
| `HostProtocolError` | `HOST_PROTOCOL_ERROR` | — | endpoint 不是 CDP、CDP 返回 error（`cdpCode` 保留原始码）、响应结构不符 |
| `HostEvaluationError` | `HOST_EVALUATE_ERROR` | — | 页面里抛出的异常。message 保留 Chrome 原文，因此 `Execution context was destroyed…` 仍能被引擎的 `requireNavigationError()` 识别成「撞上导航」并重试 |
| `HostUnsupportedError` | `HOST_UNSUPPORTED` | — | 运行环境没有这项能力（如 Node < 22 没有全局 `WebSocket`）：显式拒绝，不发起半残连接 |

## 取消（AbortSignal）与清理

- 取消**只**让 page 方法失败，**不**销毁连接：否则「取消」和「资源已释放」会缠在一起，
  调用方无法判断还需不需要清理。
- 在途命令被立刻拒绝（不会挂到 `commandTimeoutMs`）。
- `close()` 不依赖 signal，取消之后照常清理，且幂等；`keepPage:true` 只断连接、留下页面。
- 取消与副作用的边界：已派发的 `Input.dispatchKeyEvent(keyDown)` 会用一次 `keyUp` **收尾**
  ——没有配对 keyDown 时渲染器直接忽略，不引入新副作用，但漏掉它会让页面留一个卡住的按键
  （Enter 会反复触发默认动作）。除此之外取消后不再派发任何新动作；**已派发但结果未知**的动作
  交给调用方复核，宿主不重试。
- 连接阶段被取消时，已经创建的自有 target 会被关掉（`Target.closeTarget`），
  连接阶段失败也走同一条清理路径。

## 页面归属

- 默认**只新建并管理自有 target**（`Target.createTarget` + `Target.attachToTarget`），
  不激活已有标签页、不抢焦点（不调 `Target.activateTarget` / `Page.bringToFront`）。
- `close()` 默认只关自有 target；`keepPage:true` 连 target 都不关。
- `Target.closeTarget` 返回 `success:false` 时，`targetClosed` 如实为 `false` 并附
  `targetCloseError`，不会把失败报成「已关闭」。

## 运行前置条件

- **Node ≥ 22**：用 Node 自带的全局 `WebSocket`（undici），零第三方依赖。
  Node 更低版本会在 `connectCdpHost` 处得到 `HostUnsupportedError`。
- 一个**外部** Chrome/Chromium 的 CDP endpoint。自己起一个干净实例（不给应用包/用户配置添麻烦）：

  ```bash
  PROFILE="$(mktemp -d)"
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    --user-data-dir="$PROFILE" --remote-debugging-port=0 --headless=new \
    --no-first-run --no-default-browser-check about:blank &
  # 端口写在 $PROFILE/DevToolsActivePort 的第一行
  ```

  然后 `connectCdpHost({ endpoint: "http://127.0.0.1:<端口>" })`。
  `bench/test-cdp-host.mjs` 就是这么做的：自建临时 profile、记录 PID、结束时关掉进程并删目录。

## 验证

```bash
node bench/test-cdp-host.mjs                    # 离线协议层 + 真实 Chrome（有 Chrome 才跑 B 段）
EGO_CDP_HEADFUL=1 node bench/test-cdp-host.mjs  # 用有头 Chrome 跑 B 段
EGO_CDP_CHROME=/path/to/chrome node bench/test-cdp-host.mjs
```

A 段（离线、CI 可跑）用自建的假 CDP 服务器（`node:http` + 手写 WebSocket 帧）覆盖：
请求/响应对应（乱序也算对）、事件按 `sessionId` 路由、`waitForLoadState` 超时与**探针预算**、
`goto` 的提交判定 / 导航失败 / 提交超时 / `commit` / 同文档导航、取消（连接前 / 连接中 / 连接后 /
在途命令 / 按键收尾）、断连、`close` 归属与 `success:false`、能力边界、无 WebSocket 时的显式拒绝。

B 段（真实 Chrome，缺少浏览器时 SKIP 并单独列出）覆盖：`evaluate`、真实 CDP 点击与输入、
`keyboard.press(Enter)` 触发表单提交、`goto` 同站/跨站与失败导航、外部关闭 target 后的断连、
自有页面与**用户原有页面**的归属、`keepPage`、浏览器未被关闭、进程与临时 profile 清理，
以及引擎 `runJevAutonomousLoop` 在默认 DOM 路径上真跑一遍（注入判定器，不联网、不需要凭证）。

## 未验证 / 边界

- 只在 macOS + Google Chrome（156.x）实测；Linux / Windows 的 Chrome 路径与 CDP 行为未验证。
- `goto` 的提交判定是「导航返回的目标 `loaderId` 在主 frame 上出现」。**导航被后续导航 supersede（连续两次导航，前一个 `loaderId` 永不出场）的情形未复现**：假服务器与真实 Chrome 测试都没有这个场景，因此这里没有多导航竞态仲裁（不排除后续导航、不比较导航序号）。遇到这类页面时表现为 `goto` 等提交直到 `timeout` 后 `HostTimeoutError`，而不是悄悄拿错文档。需要处理时应先在真实 Chrome 里复现，再扩导航策略。
- 单条 CDP 命令的默认 `commandTimeoutMs`（30s）仍然是有界兜底：`waitForLoadState` / `goto` 的每条探针都受该次等待预算约束（不会被拖到 30s），但 `page.cdp` / `page.evaluate` 的单条命令最长仍可等满 30s；需要更紧的上限时由调用点传 `{timeoutMs}`。
- `networkidle*` 类等待未实现；需要时由调用方用页面内状态自行判定。
- 跨宿主（ego lite ↔ cdp-host）的同任务对照由发布流程单独做，不在本适配器的测试范围内。
- 视觉兜底（`visualGrounder`）走的是 `page.evaluate` + 裸 CDP，路径与 ego 相同，
  但真实站点上的定位质量没有为本宿主单独测量。
