# P2 共同基准（第一批，10 项）

双宿主共同验收集：同一组**目标、起始页面、输入、确定性验证器与预算**，分别在 ego lite 与
「普通 Node + 外部 Chrome（CDP）」上跑一遍，用同一份报告口径汇总。

```bash
node bench/common-benchmark/run.mjs                       # 两个宿主；缺宿主则 SKIP 并写明原因
node bench/common-benchmark/run.mjs --hosts both --out /tmp/p2.json
node bench/test-common-benchmark.mjs                      # 清单/口径/预算/清理的离线自测
```

退出码：`0` 所有被请求的宿主通过 / `1` 有宿主失败 / `2` 宿主缺失被 SKIP 或用法错误。

## 与 P1 套件的关系（复用，不另起一套）

任务本体（fixture、注入决策、`verify` 断言）**直接引用** `bench/host-acceptance/tasks.mjs` 的
10 项，不复制代码；本目录只加了三件 P1 没有的东西：

1. **任务格式与预算**（`tasks.mjs`）：每项写明起始页、输入、验证器位置、步数/时间/决策请求上限；
2. **统一 runner**（`run.mjs`）：两个宿主同一条执行路径，宿主缺失按 SKIP 记录原因；
3. **汇总报告**（`suite.mjs`）：成功率、错误成功率、延迟、请求数、花费、护栏拒绝率、人工接管率、
   失败消耗，字段与未知值口径固定。

P1 的 12 项里有 2 项（`no-text-source`、`batch-two-fields`）不在本批 10 项内：前者与
`type-text` 共享「无文本来源」路径，后者是批处理能力验证，留到第二批补齐。

## 任务格式

| 字段 | 含义 |
| --- | --- |
| `id` / `goal` / `expect` | 报告口径用；`expect=goal` 要求引擎 `success=true`，`expect=guard` 要求**不**成功 |
| `start` | `about:blank` + 就地注入的合成 fixture（`bench/host-acceptance/tasks.mjs#<id>`） |
| `input` | 注入判定器的确定性选择、`--text` 候选、是否启用响应校验 |
| `verifier` | 任务自带的 `verify(page, ctx)`：动作后真实 DOM/URL/派发记录断言 |
| `budget` | `steps`（引擎步数）、`timeMs`（单任务墙钟）、`decisionRequests`（判定器调用上限） |
| `conditions` | 登录/验证码/地域/站点变化：合成任务一律 `not-applicable`，真实站点任务另行记录 |

**预算执行方式**：`maxSteps` 直接传给引擎；`decisionRequests` 由包装的 `ask` 计数，超限即抛
`EGO_BENCH_BUDGET`（`executionStopped`），引擎停止而不是继续派发；`timeMs` 用 P1 的
单任务超时（超时关闸、后续任务记 `notRun` 并停止整套）。三项任一越界，该任务 `budgetPassed=false`
并判失败——不把「跑完了但超预算」算通过。

**网络隔离**：引擎调用期间替换 `globalThis.fetch`，任何外部请求都会记数并抛错；任务结束断言
`networkRequests === 0`。宿主的 CDP 连接与 fixture 注入在替换之前完成，不受影响。

## 报告字段

顶层：`schemaVersion`、`taskSet`、`runtime`、`hosts[]`（`host`/`status`/`reason`/`report`/`staged`/`cleanup`）、
`complete`、`status`。

`hosts[].report.summary`：

| 字段 | 口径 |
| --- | --- |
| `passed` / `failed` / `complete` | 任务通过数（`taskPassed`）、总数、是否全部跑完 |
| `successRate` | 通过 / 已跑任务 |
| `goalSuccessRate` | 只统计 `expect=goal` 的任务 |
| `falseSuccessRate` | 引擎说成功但 DOM 断言不成立 / 已跑任务（**错误成功率**） |
| `guardrailRejectionRate` | `expect=guard` 任务里被 guard/stale/控制停止拦下的比例 |
| `rejectionRateAllTasks` | 同一口径放开到全部任务 |
| `rejectionMatches` | 「是否被拦」与 `expect` 一致的**任务数**（不是比例） |
| `zeroDispatchGuardTasks` / `dispatchCountGuardTasks` | 护栏任务里 0 派发 / 已派发后才停止（`control-stop`）的数量 |
| `postStopPageCalls` | 控制停止之后引擎仍发起的页面调用总数（必须 0） |
| `decisionRequests` / `dispatches` / `latencyMs` / `networkRequests` | 计数与墙钟总和 |
| `costUsd` / `humanTakeoverRate` / `unknownMetrics` | 注入判定器下测不到，一律 `null`，不猜 0 |
| `failureConsumption` | 失败任务数及其延迟、请求数、费用（无失败时费用记 0） |

单任务还保留 P1 的 `metrics.phases`（观测/决策/执行/校验分阶段耗时）、`stopReason`、
`guardrailRejections`、`history`（紧凑化），以及新增的 `networkRequests`、`budgetPassed`。

## 宿主腿

| 腿 | 做法 | 清理与如实记录 |
| --- | --- | --- |
| `cdp` | 未给 `--endpoint` 就用 `--headless=new` 自建临时 profile 的 Chrome，`connectCdpHost` 只建自有 target | 关自有 target（`targetClosed` 必须为 true）、SIGTERM→SIGKILL 后按 PID 复查进程、删临时 profile；任一步失败即 `status=failed` |
| `ego` | 普通 `ego-browser nodejs` 子进程，脚本在 TaskSpace 里跑同一 `runCommonBenchmark` | `finish({ keep: [] })`；超时则报 `TaskSpace cleanup unconfirmed`，不算通过 |

**ego 腿为什么要暂存一拷贝**：在本工作区的 LayerFS 路径下，ego 运行时的动态 `import` 会**挂住**
（同一字节的模块放 `/tmp` 或 `~/LayerFS` 就能立刻加载，见下「LayerFS 观察」）。因此 ego 腿先把 5 个
模块（两份 `suite.mjs` / `tasks.mjs` + `scripts/decider-loop.mjs`）拷到临时目录，**逐文件校验 sha256**
后才 import，并把 `staged.files` 与原因写进报告。普通路径（仓库在主盘上）不需要这步，也没有被绕过。

## 本机实测（2026-10-25，本 worktree）

| 宿主 | 结果 | 决策请求 | 派发 | 延迟总和 | 错误成功 | 护栏拒绝率 | 清理 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| cdp（临时 headless Chrome 156） | 10/10，exit 0 | 13 | 17 | 152ms | 0 | 100%（4/4 guard） | target 关闭 + 进程退出 |
| ego（ego lite 0.6.0.20） | 10/10，exit 0 | 13 | 17 | 271ms | 0 | 100%（4/4 guard） | TaskSpace 正常 finish |

两腿都是 `networkRequests=0`、`rejectionMatches=10`、`postStopPageCalls=0`。
原始结果：`RESULTS.local.json`（本机生成，结构即报告格式）。

这些数字只说明**机制一致性**：合成 DOM + 注入判定器（`options.ask`），**不是**模型成功率，
也不是线上站点成功率。延迟受机器负载影响，不构成性能基准。

## 真实站点候选（本轮只登记，不跑）

`tasks.mjs` 的 `SITE_CANDIDATES` 只是候选清单，runner 不会执行它们。纳入条件：起始 URL 稳定、
验证器可用 URL 路径或 DOM 状态表达、登录/验证码/地域影响可记录。

| 候选 | 拟用验证器 | 已知前置 |
| --- | --- | --- |
| HN 导航 | `pathname === /newcomments` | 无需登录；站点结构长期稳定 |
| 维基搜索 | `pathname === /wiki/Jev` + 词条 DOM | 自动翻译不得参与字符串比较 |
| DDG 设置页原生下拉 | 选中值 + 设置持久化 | 需先定义「改选后如何确定性核对」 |

## 尚未验证（如实）

- 真实模型（Jev）与真实站点：本批全部离线；`jev-1.14.0` 的线上成功率未测。
- 费用 / token / 人工接管：注入判定器下不可比，报告 `null`。
- Windows / Linux 的 CDP 腿：只在本机 macOS + Chrome 156 跑过。
- 每项任务的延迟都是单次测量，没有重复轮次与方差。
- ego 腿的暂存拷贝是环境适配；在非 LayerFS 路径下未单独验证「直接 import 也正常」这条旁路。

## LayerFS 观察（本 worktree）

- **ego 运行时无法从本工作区路径 import 模块**：`ego-browser nodejs -e 'await import("<ws>/bench/...mjs")'`
  在 15–25s 内无任何输出（含首行 `console.log`），同样字节的文件放 `~/LayerFS/` 或 `/tmp` 秒回。
  `fs.realpath/stat` 在该路径上都是 1ms，所以不是节点元数据慢，更像 ego 加载器对该路径的处理问题。
  未深挖；runner 用暂存拷贝绕过并写进报告，没有把问题当成通过。
- 常规操作没有看到 EPERM、`._` 文件、权限错误或挂载断开：`git status --short` 0.06s，
  `node bench/test-common-benchmark.mjs` 5.2s，`node bench/test-host-integration-live.mjs --suite --suite-only`
  6.4s，`git diff --check` 0 退出。与源仓库相比没有明显变慢的主观差异，但没有做同机对照计时。
- `ego-browser nodejs` 从 stdin 读脚本：**heredoc 与 `< file` 在本环境都不生效**（进程挂住、无输出），
  管道（`printf … | ego-browser nodejs`）和 `-e 'await import("file:///…")'` 正常。runner 用
  `spawn` + `stdin.end()`，等价于管道，因此不受影响。
