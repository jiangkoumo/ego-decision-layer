# 双宿主验收任务集（HOST-ACCEPTANCE）

ROADMAP **P1（去宿主化）/ P2（共同基准）** 的首批可复跑验收任务：**12 项**，同一组目标、输入、
验证器与预算分别在 ego lite 与「普通 Node + 外部 Chrome（CDP）」两个宿主上跑。

```bash
# 宿主 A：ego lite（真实浏览器、真实 TaskSpace）
sed "s|__REPO__|$PWD|g" bench/host-acceptance/run-ego.mjs | ego-browser nodejs

# 宿主 B：外部 Chrome（适配器就绪后；普通 node，不能用 ego 运行时——它访问不了 loopback）
node bench/host-acceptance/run-cdp.mjs --endpoint http://127.0.0.1:9222
```

## 这组数字说明什么、不说明什么

| 说明 | 不说明 |
| --- | --- |
| 引擎的观测 / 决策消费 / 定位 / 裸 CDP 派发 / 执行前守卫 / 危险词表 / 批处理在两个宿主上语义一致 | **模型成功率**：判定器是注入的确定性实现（`options.ask`），不是真实 Jev |
| 真实 DOM 与 URL 在动作后确实变了（或确实没变，且一次都没派发） | 线上站点成功率：fixture 全部注入在 `about:blank`，是**合成受控 DOM** |
| 护栏（遮挡 / 陈旧 / 危险 / 控制停止）在第二宿主上仍然 fail-closed | 费用、token、人工接管率：本机测不到，报告里一律 `null` |

引擎侧契约与 `bench/test-offline-e2e.mjs` 相同（`options.ask` 注入 + 真实观测 + 裸 CDP 派发 + 真实 DOM 断言）；
本目录把「一次性离线自测」扩展成**固定任务集 + 双入口 + 指标口径**，用于宿主适配与后续重构的验收集。

## 任务集（`bench/host-acceptance/tasks.mjs`）

| # | id | 覆盖点 | 预期 | 真实验证（动作后的 DOM/URL） |
| --- | --- | --- | --- | --- |
| 1 | `click-button` | 点击（`Input.dispatchMouseEvent`） | goal | `window.__clicked === 1`，首步 `action=click` 且无守卫拒绝 |
| 2 | `click-link-nav` | 链接导航（文档真的换了） | goal | URL 变 `blob:`、新文档有 `#next`、`title=Page Two` |
| 3 | `type-text` | 输入（聚焦 + 全选 + `Input.insertText`） | goal | `input.value === 'hello-acceptance'` 且决策文本一致 |
| 4 | `search-submit` | 搜索提交（`type_text_submit` → Enter → `submit` 事件） | goal | 表单 `submit` 收到值，且派发记录里有 `keyboard.press:Enter` |
| 5 | `select-native` | 原生下拉改选（`selectInPage` + change） | goal | `select.value='dk'` 且 change 事件带出 `dk` |
| 6 | `checkbox-toggle` | 复选框勾选 | goal | `checkbox.checked=true` 且 change 事件收到 `true` |
| 7 | `covered-target` | 遮挡（overlay 盖住按钮） | guard | `window.__clicked===0`、守卫理由全是 `covered`、**派发 0 次** |
| 8 | `stale-ref` | 陈旧 ref（判定器引用不存在的 ref） | guard | 每步 `staleTarget='ref=999'`、`window.__clicked===0`、**派发 0 次** |
| 9 | `danger-action` | 危险动作（`Delete account` 命中「删除」词表） | guard | `guardRejected='dangerous_action'`、`dangerousMatch` 非空、**派发 0 次** |
| 10 | `control-stop` | 控制停止（动作已落地后用户接管） | guard | 抛 `EGO_CONTROL_LOST`；`postStopCalls===0`（引擎没有再尝试任何页面调用）；停止后派发数不增长 |
| 11 | `no-text-source` | 缺文本来源（候选存在、判定器选 none、无生成模型） | guard | `reason=no_text_source`、`input.value` 未变、**派发 0 次** |
| 12 | `batch-two-fields` | 多动作批处理（两字段 + 提交单步） | goal | 两字段落地、表单已提交、`batchExecutedCount===3` |

两条如实记录的取舍（不是伪装通过）：

- **`stale-ref` 用 `validate: false`**：注入判定器返回的 `ref=999` 不在本次候选里，响应校验会先以
  `choice_not_offered` 拒收（那是另一条路径）。要复现「判定器看的是上一轮元素表」就必须关掉响应校验；
  断言仍落在引擎**自己的**陈旧检查（`staleTarget`）与零派发上。
- **`control-stop` 用包装 page 注入控制异常**：真实「用户接管」需要人工在浏览器里操作，不可复跑。
  包装层在第 1 个动作派发完成后让下一次页面调用抛 `EGO_CONTROL_LOST`（ego 侧真实错误码同形），
  并统计「停止之后引擎还尝试了几次页面调用」——必须为 0。
- fixture 里的 `<script>` **不会执行**（`innerHTML` 不跑脚本），所以提交监听一律在 `setup` 里用
  `page.evaluate` 安装；这也保证了 `setup` 只准备环境，不代替被测动作。

## 入口与覆盖路径

| 入口 | 宿主 | 说明 |
| --- | --- | --- |
| `run-ego.mjs` | ego lite | 经 `ego-browser nodejs` 通过 stdin 执行；自己开 TaskSpace，结束时 `finish({ keep: [] })` |
| `run-cdp.mjs` | 外部 Chrome | 普通 node + `connectCdpHost({ endpoint })`，用适配器的 `page` 跑同一套任务，`close({ keepPage })` 只回收自有 target |

两个入口都允许**显式覆盖**引擎与适配器路径（跨 worktree 复验时动态 import 已有模块，不复制代码）：

```bash
# ego：placeholders 用 sed 覆盖（未替换的占位符视为未设置）
sed -e "s|__REPO__|$PWD|g" \
    -e "s|__ENGINE__|/abs/path/to/other/worktree/scripts/decider-loop.mjs|" \
    -e "s|__TASK_IDS__|click-button,select-native|" \
    bench/host-acceptance/run-ego.mjs | ego-browser nodejs

# CDP：命令行直接覆盖
node bench/host-acceptance/run-cdp.mjs --endpoint http://127.0.0.1:9222 \
  --adapter /abs/path/to/other/worktree/scripts/hosts/cdp-host.mjs \
  --engine  /abs/path/to/other/worktree/scripts/decider-loop.mjs
```

默认引擎是**当前工作树**的 `scripts/decider-loop.mjs`（`suite.mjs` 用 `new URL("../../scripts/decider-loop.mjs", import.meta.url)`
解析，即「仓库根/scripts/decider-loop.mjs」；报告里的 `engine=` 字段打印实际使用的绝对路径）。

`run-ego.mjs` 自身保持 **ASCII only**：它经 stdin 进入 ego 运行时，不能依赖宿主对非 ASCII 字节的解码；
中文 fixture 与断言都在 `tasks.mjs`（真实文件，按 UTF-8 加载）。

## 指标口径

每项任务记录（`report.results[i].metrics`）：

| 字段 | 含义 | 未知时 |
| --- | --- | --- |
| `taskPassed` | **机制通过**：`verify` 的真实 DOM/URL 断言成立，且「引擎 goal 是否符合预期」 | — |
| `expectationSatisfied` | `expect=goal` 要求引擎 `success===true`；`expect=guard` 要求引擎 `success!==true` | — |
| `engineGoalSuccess` | 引擎自己判定的 goal 结果（`success`） | 抛出时 `null` |
| `falseSuccess` | 引擎说成功但 DOM 断言不成立（**错误成功**） | `false` |
| `stopReason` | `result.reason`，或 `thrown:<code>`（控制停止/超时） | `null` |
| `decisionRequests` | 判定器被调用次数（= 决策请求数；注入实现不发网络请求） | — |
| `latencyMs` | 单任务墙钟耗时 | — |
| `phases` | 观测/决策/执行/校验分阶段耗时（引擎上报） | 抛出时 `null` |
| `guardrailRejections` | 守卫拒绝明细（`covered` / `stale_ref` / `dangerous_action` …） | `[]` |
| `dispatches` | 真实派发事件数（鼠标/键盘/文本/下拉） | — |
| `postStopPageCalls` | 控制停止**之后**引擎仍发起的页面调用次数（必须 0） | 无停止时 `null` |
| `costUsd` / `tokens` / `humanTakeover` | 费用 / token / 人工接管 | **一律 `null`**（本机测不到，不猜 0） |

汇总（`report.summary`）把两种口径分开报，**不用 goal=false 算失败率**：

```
total expectedTotal notRun halted complete
taskPassed taskFailed
goalTasks { total, taskPassed, engineGoalSuccess }
guardTasks { total, taskPassed, engineSucceededAnyway, stopReasons }
falseSuccesses decisionRequests dispatches latencyMs guardrailRejections
unknownMetrics: ["costUsd","tokens","humanTakeover"]
disclaimer
```

`guardTasks.engineSucceededAnyway > 0` 是可疑信号（护栏任务里引擎不该报成功）。

## 退出码与 SKIP

| 入口 | 0 | 1 | 2 |
| --- | --- | --- | --- |
| `run-ego.mjs` | 12 项全跑过且 `failed=0` | 有任务失败 / 不完整 | 导入套件失败 |
| `run-cdp.mjs` | 同上 | 有任务失败 / 不完整 | 用法错误、**适配器缺失（SKIP）**、连接失败 |

`ego-browser` CLI 自身可能以 0 退出，所以判定**同时**要求输出里 `tasks=12` 与 `failed=0`；
`run-cdp.mjs` 的「适配器缺失」显式打印 `SKIP:` 并 exit 2——缺依赖不算通过。

单任务超时（`--timeout-ms` / `__TIMEOUT_MS__`，默认 60s）会：清掉自己的 timer、**关闸**（让仍在跑的
引擎循环下一次触碰 page 就抛错，不会派发到下一个 fixture）、停止整套验收并在 `notRun` 里列出未跑任务。

## 本机基线（2026-10-25，ego lite 0.6.0.20 / chromium 154）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 离线端到端（改造前基线） | `sed "s\|__REPO__\|$PWD\|g" bench/test-offline-e2e.mjs \| ego-browser nodejs` | 11 通过 / 0 失败，exit 0 |
| 双宿主验收（ego 腿） | `sed "s\|__REPO__\|$PWD\|g" bench/host-acceptance/run-ego.mjs \| ego-browser nodejs` | `tasks=12 failed=0 passed=12`，`goalTasks=7/7`、`guardTasks=5/5`，`falseSuccess=0`，exit 0 |
| 外部 Chrome 腿 | `node bench/host-acceptance/run-cdp.mjs --endpoint …` | **SKIP**（本 worktree 没有 `scripts/hosts/cdp-host.mjs`，exit 2） |

ego 腿的分阶段耗时（本机、注入判定器，决策阶段接近 0ms）不构成模型性能数据；它只用于确认
「观测 → 决策消费 → 定位 → 派发 → 校验」这条链路在两个宿主上行为一致。

## 尚未验证（如实）

- **外部 Chrome 腿未跑**：适配器（`scripts/hosts/cdp-host.mjs`）不在本 worktree，`run-cdp.mjs` 目前只验证了
  SKIP 路径。契约（`connectCdpHost({ endpoint, signal, timeoutMs })` → `{ page, metadata, close({ keepPage }) }`）
  已按主控给的版本实现调用面，等适配器落地后由主控集成复验。
- **真实站点任务**：本文件全部是合成受控 DOM。登录墙、验证码、地域、站点改版、自动翻译这些因素
  需要单独记录的线上任务集（P2 后续扩到 30–50 个真实任务）。
- **费用 / token / 人工接管**：离线注入判定器下不可比，报告里标 `null`。
