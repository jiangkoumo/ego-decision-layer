# ego-decision-layer 演进规划（Roadmap）

## 当前进度与下一阶段优先级（2026-10-28）

方向：**去宿主化，同时保持 ego lite 一等公民**。继续以原始数据、确定性验收与 fail-closed 执行护栏作为交付依据。
当前发布为 v0.12.0：P1 与 P3 最小版在 v0.11.0 交付，P2 第二批随 v0.12.0 发布。尚未发布的 main 已合入有界滚动循环修复、八项真实任务 v2 与被动诊断；首轮双宿主 16 次试验为 13 次达成、错误成功 0，失败完整保留，见[测量说明](bench/live-benchmark/README.md)。其余未交付项仍为规划，不承诺未经验证的模型能力或完成日期。

| 优先级 | 工作 | 验收标准与依赖 |
| --- | --- | --- |
| P0：当前发布 | v0.12.0 交付 P2 第二批及异常路径回归；v0.11.0 交付 P1 外部 CDP 入口与 P3 MCP 最小入口；v0.10.0 已交付 `update` / `--version` 与英文 README | 更新集成、版本一致性与真实浏览器冒烟通过；版本元数据、标签和 Release 对齐 |
| P1：去宿主化（v0.11.0 已交付） | 最小 Host Adapter 契约与普通 Node + 外部 Chrome CDP endpoint 入口已提供，保留 ego lite 体验；真实 CDP 目前只在 macOS 验证 | 同一组搜索、点击、输入任务在两个宿主通过；遮挡、陈旧目标、危险动作与控制停止仍按原语义处理；连接与页面归属、清理可验证 |
| P2：共同基准（v0.12.0 第二批已交付） | 受控任务扩至 12 项，双宿主各 12/12；真实 Jev 首批为 HN 导航与 Wikipedia 搜索、每宿主每任务 3 轮，10/12 达成、错误成功 0。小样本不代表普遍成功率；后续再扩到 30–50 个真实任务 | 相同目标、输入、验证器与预算；报告成功率、错误成功率、延迟、请求数、花费、护栏拒绝率、人工接管率及失败消耗；登录、验证码、地域与站点变化单独记录 |
| P3：MCP 入口（v0.11.0 最小版已交付） | 已提供实验性 stdio `browser_task`、状态查询与取消；去重仅限当前服务进程，真实运行目前只在 macOS 验证 | 返回任务标识、确定性验证结果、停止原因与已执行动作；明确取消、重试、连接释放和页面所有权；调用方重试不盲目重复已有副作用 |
| P4：视觉实验 | 通过现有 `visualGrounder` 注入 Jev 图像 + box 定位，默认关闭、显式开启 | 先核实 Jev 1.14 / `jev-preview` 的官方契约与实际可用性；验证截图缩放、CSS 坐标映射、页面漂移、遮挡及无法确认的危险区域处理；测定位准确率、请求延迟与实际点击成功率 |
| P4：后端横评 | 使用共同任务集比较 Jev、候选 Clef / Clef-flash 与一个本地小模型 | 先确认服务、模型版本、能力与价格；固定任务和执行护栏，记录响应中的实际模型版本、配置与原始数据；不把缺少可比能力的模型硬凑成版本 A/B |
| P5：失败升级 | 连续无进展或 blocked 时，打包状态交给大模型规划，再有界恢复 | 设置升级次数、总步数、时间与费用预算；区分未派发、已派发与结果未知，结果未知先复核；人工接管和执行护栏不被规划结果绕过 |

### 实施边界

- **2026-10-28 main 集成已完成（未发布）**：滚动揭示额度只由已验证交互进展恢复，检测旧状态振荡，保留真实新内容与业务数量差异；snapshot 路径不再消耗未执行的 reveal 配额。新增 `--tasks v2` 显式八项集与离线诊断分析，旧 `all` 默认仍为 v1。首轮 ego 8/8、CDP 5/8，三个失败分别为 HN 模型请求 `fetch failed`、Jev / Alan Turing 搜索五步耗尽；搜索入口选取稳定性仍待解决。下一步优先复现这些失败，再扩到 30–50 项；不能把循环修复表述为搜索可靠性保证。

- **P2 第二批已完成**：[Issue #14](https://github.com/jiangkoumo/ego-decision-layer/issues/14) 补齐 `no-text-source` 与 `batch-two-fields`；[Issue #15](https://github.com/jiangkoumo/ego-decision-layer/issues/15) 提供真实 Jev 双宿主测量入口。复跑受控集用 `node bench/common-benchmark/run.mjs --hosts both`；真实测量用 `node bench/live-benchmark/run.mjs --live --hosts both --tasks all --rounds 3`，原始数据与限制见 [测量说明](bench/live-benchmark/README.md)。两项均通过独立审阅，保留 CDP Wikipedia 的两次五步预算失败；下一步扩充真实任务覆盖。
- P2 本轮不绑定引擎全面拆分或新宿主能力；保持 `scripts/decider-loop.mjs` 的稳定导出。后续模块化沿真实依赖逐步推进，每次只验证受影响部分。
- Jev box 首先比较「当前几何中心策略 vs 图像定位」。只有确认旧版与新版支持相同输入和输出契约，才做同能力的版本对照；合成受控页面的结果与真实站点结果分开报告。
- 中文站点任务可包含知网、B 站、淘宝搜索等候选；是否纳入取决于可重复性、访问条件与确定性验收，不先承诺覆盖。
- 暂缓迁移 `bench/raw/` 与演示视频：原始证据继续随仓库保留。体量影响安装时再评估 Release 附件或数据分支，并保留校验和、对应脚本 revision、稳定下载入口与复算命令；移走当前文件不会缩小已有 Git 历史。
- 上游合作作为长期选项：向 ego lite 提议正式的第三方决策层挂载点，降低覆盖官方技能入口的维护成本。这里只记录方向，尚未联系上游。

---

## 已有阶段与历史验证记录

下面保留早期五阶段规划、实现与当时验证证据；历史耗时不代表当前版本的性能保证。

本项目（`ego-decision-layer`）的核心定位是 **「基于 System One 极低延迟决策的轻量浏览器自动化闭环」**。
在实测中，单步决策仅 0.35~0.5s、端到端整步约 1.0~1.4s，纯裸 CDP 派发，无重型框架包装。

为进一步提升执行性能、降低故障率，并借鉴业界前沿开源项目（**Stagehand v4、Browser-Use、Midscene.js、Skyvern**）的优秀架构思想，我们制定了以下演进规划。

> **核心原则**：
> 1. **不照抄外部源码**：深入理解开源项目要解决的底层问题与实现原理，结合 `ego-browser` 运行时特性自研实现，追求更高效率与更少开销。
> 2. **保持零重型依赖与极速优势**：坚守原生 ESM、裸 CDP、极简内存占用，绝不引入 Playwright / Puppeteer 等厚重抽象。
> 3. **安全与确定性第一**：所有模型推测必须经过执行层严格护栏（陈旧检测、可见性校验、命中测试与危险动作拦截）。

---

## 借鉴开源项目的关键架构洞察

| 开源项目 | 核心设计亮点 | 解决的问题 | 我们如何借鉴并做得更好 |
|---|---|---|---|
| **Stagehand v4** (Browserbase) | 1. 结构化数据抽取原语 `extract()`<br>2. 动作路径缓存与自愈机制（Action Cache） | 1. 弥补纯操作循环在数据提取场景的空白<br>2. 相同页面高频重复操作的昂贵往返 | 1. 自研 `extract()` 原语，复用自建 DOM 语义流，由文本模型严格输出类型化 JSON<br>2. 基于 DOM 结构指纹实现 0ms 本地动作重放，变动时自动回退 Jev |
| **Browser-Use** (Y Combinator) | 表单级多动作打包（Multi-Action Batching） | 登录页或多字段表单每个字段都需要一次 LLM 往返，导致 4~6 秒延迟 | 允许 Jev 在置信度充分时返回动作序列（聚焦 + 输入 + 提交），一次 CDP 批处理派发完成 |
| **Midscene.js** (ByteDance) | 视觉驱动定位与兜底（Visual Grounding Fallback） | 纯 DOM/a11y 树遇到 Canvas、无语义纯图标、复杂 WebGL 时元素表为空 | 针对连续 `no_targets` 设计轻量坐标/视觉逃生通道，避免直接判输退出 |
| **现代 SPA 观测实践** | DOM Mutation 变更静默窗口（Debounced Mutation Settle） | 避免固定死等（waitForTimeout）或单依赖 load 事件导致的过长等待或时机误判 | 在页面挂载微型 MutationObserver，以变动静默期自适应结束等待，静止页面直接 40ms 返回 |

---

## 五大优化里程碑

```
┌────────────────────────────────────────────────────────────────────────┐
│  Phase 1 (P0): 自适应 Mutation 页面稳定等待机制 (Adaptive Settle)       │  ← ✅ 已完成 (v0.5.0)
│  - 静态交互 40ms 极速返回（节省 60~80ms 及 75% IPC 调用）               │
│  - 动态异步 DOM 自适应静默判定，消除无效固定延迟                        │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
┌────────────────────────────────────▼───────────────────────────────────┐
│  Phase 2 (P1): 结构化数据抽取原语 (extract primitive)                   │  ← ✅ 已完成 (v0.6.0)
│  - 导出 extract(page, instruction, { schema }) 原语                     │
│  - CLI 支持 --extract "提取商品清单" --schema schema.json                │
│  - 复用自建轻量 DOM 语义流，无需写 ad-hoc 选择器                       │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
┌────────────────────────────────────▼───────────────────────────────────┐
│  Phase 3 (P2): 动作指纹缓存与自愈回放 (Action Cache & Fast Replay)       │  ← ✅ 已完成 (v0.7.0)
│  - 记录成功路径的 DOM 特征指纹与操作映射                                │
│  - 相同意图 0ms 免模型请求直达；DOM 变动或守卫拒绝时无缝自愈回退 Jev    │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
┌────────────────────────────────────▼───────────────────────────────────┐
│  Phase 4 (P3): 多动作批量打包派发 (Multi-Action Batching)               │  ← ✅ 已完成 (v0.8.0)
│  - 表单级输入打包（批量输入 + 提交），多步表单 1 步完成                 │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │
┌────────────────────────────────────▼───────────────────────────────────┐
│  Phase 5 (P4): 无语义界面视觉兜底通道 (Visual Grounding Fallback)       │  ← ✅ 已完成 (v0.9.0)
│  - Canvas / 复杂 SVG 控件下的轻量视觉与坐标辅助决策                     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 阶段一：自适应 Mutation 页面稳定等待机制（Phase 1）— ✅ 已完成（2026-10-16, v0.5.0）

### 目标与指标
- 针对无 DOM 变更的静态交互（如聚焦输入框、点开已渲染菜单、标签页切换），`settle` 耗时由原有的固定轮询（约 120ms）降低至 **~40ms**，减少 3~4 次 IPC 通信。
- 针对有动态渲染的复杂 SPA，通过 `MutationObserver` 监控变动静止期，在 DOM 停止突变 40~50ms 后立即唤醒下一步，避免过早观测或过长等待。
- 导航检测保持绝对安全：一旦 URL 改变或 `readyState` 非 complete，自动切换至受控导航等待。
- 提供离线单测覆盖（无网络、无浏览器凭证）与 A/B 兼容模式。

### 实际实现

页内 `MutationObserver`（`installMutationTracker`）+ 一次状态查询（`stateInPage`），`settle` 分两段有界等待：

| 场景 | 旧实现 | 新实现 |
| --- | --- | --- |
| 静态交互（无 DOM 变动） | 固定 40ms + 多轮轮询（约 120ms 窗口） | **一次 evaluate 即返回**（2~3 次 IPC） |
| 动作触发异步渲染 | 看不见变动，只能靠下一轮观测兜底 | 等变动静止超过 `settleQuietMs`（默认 120ms） |
| 持续变动（游戏 tick / 无限滚动） | 无此路径 | `settleMaxMs`（默认 600ms）硬上限兑现 |
| 导航 | URL/readyState 轮询 | 语义不变（URL 变化 / 非 complete / evaluate 抛错） |

新增导出：`installMutationTracker`、`stateInPage`、`settle`（返回 `{ quiet, navigated, fast }`）。
可调项：`settleQuietMs`（默认 120）、`settleGraceMs`（默认 = quietMs）、`settleMaxMs`（默认 600）、
`settleMinMs`（默认 40）、`settleMode: "legacy"`（A/B 对照旧行为）。
追踪器挂载失败时自动退回旧轮询行为，不影响任务完成。

### 验证

`sed "s|__REPO__|$PWD|g" bench/test-settle-mutation.mjs | ego-browser nodejs` → **23 通过 / 0 失败**（离线，无需凭证）。
回归：`test-offline-e2e` 11/11、`test-frame-targets` 37/37、`test-viewport-degraded` 54/54、
`test-scroll-progress` 27/27、`test-clickable-regions` 16/16、`test-emoji-clip` 21/21、真实 Jev 冒烟 exit 0。

### 未验证（如实记录）

只在 `about:blank` 合成 DOM 上量化；真实站点（X、DuckDuckGo 设置页）的端到端收益尚未单独测量。

---

## 阶段二：结构化数据抽取原语（Phase 2）— ✅ 已完成（2026-10-16, v0.6.0）

### 目标与指标
- 弥补纯交互操作在数据提取场景的空白，让 Agent 能以一条语句从当前页面（或指定局部区域）抽取类型化 JSON 结构，无需手写 ad-hoc 选择器。
- 坚持自研原生与零外部依赖：纯原生 ESM 实现，无 Playwright/Cheerio/ajv 等重型包。
- 有界 DOM 语义流提取：通过 `page.evaluate()` 提取紧凑语义流（过滤不可见后代、保留 `display:contents` 内容、表格保留行列结构、限制节点与深度上限、按 Unicode 码点安全截断）。
- 严格 Schema 校验与全量验证：支持明确的 JSON Schema 子集（`type`、`properties`、`items`、`required`、`enum`、`minItems`、`maxItems`、`additionalProperties` 及单项简写），全量校验所有数组项与类型约束；不支持的 Schema 特性在调用前显式报错（fail-closed），不静默放行。
- 确定性控制与安全传播：接管、失控、evaluate 安全超时等错误立即向上传播，`settle` 与 `extract` 绝不当作普通导航吞掉，停止后续 DOM 或模型调用。
- 选择器范围收敛：`selector` 不存在或语法错误时直接失败退出，禁止回退 `document.body`，且不发起模型请求。
- 本地后端与模型错误处理：支持本地 OpenAI 兼容后端免 Key、支持 `apiKeyFile` 与覆盖合并；检查 `finish_reason`、refusal 与截断，截断或错误响应直接判定失败。

### 实际实现

- **引擎层新增与增强导出 (`scripts/decider-loop.mjs`)**：
  - `extract(page, instruction, options = {})`：核心数据抽取原语，返回包含 `{ success, data, instruction, schema, pageInfo, phases, model, usage }` 的类型化结果。
  - `extractSemanticStreamInPage(payload)`：页面内紧凑语义 Markdown 流提取器，支持局部 `selector` 和 `maxChars` 预算。
  - `normalizeExtractionSchema(schema)` 与 `validateSchema(data, schema)`：纯原生轻量 Schema 校验器，全量验证数组与对象，支持 minItems/maxItems/enum 等约束，不支持特性快速报错。
  - `resolveExtractionModel(options)` 与 `callTextModelForExtraction(...)`：支持本地 OpenAI 兼容端点免 key、正确解析 apiKeyFile，检查 finish_reason 截断与 refusal。
  - 控制停止与异常传播：`settle` 和 `extract` 中通过 `rethrowBrowserStop` 保留控制/接管异常，只有明确的上下文销毁才归入导航重试。
  - `renderExtractSummary(result)`：控制台人类友好摘要渲染器（展示稳定、观测与抽取耗时）。
- **CLI 增强 (`scripts/ego-decision-layer`)**：
  - 支持 `--extract <instruction>` 与 `--schema <json|file>`，校验 JSON 格式与 Schema 合法性（非法报 exit 2）。
  - 凭证检查分流：纯抽取仅需文本模型配置，不强制要求 Jev Key；操作+抽取需两者齐备。
  - 任务编排：无目标描述时导航后直达抽取；有目标描述时先跑 Jev 操作循环，达成后再执行抽取。
- **持久测试套件**：
  - `bench/test-extract-http.mjs`：纯 Node 离线测试（mock fetch，48 项断言全过），覆盖真实 HTTP 路径、本地免 key、apiKeyFile、截断响应拒绝、枚举与条目数约束、控制停止传播与非合法 Schema 快速失败。
  - `bench/test-extract.mjs`：浏览器离线验收（40 项断言全过），覆盖语义流、隐藏过滤、局部选择器失败关闭、全真 DOM 提取、Schema 校验与网络哨兵（0 次真实 fetch）。

### 验证

1. **离线单测与协议验证**：
   - `node bench/test-extract-http.mjs`：退出码 0，48 项 HTTP/Schema/控制断言全通。
   - `sed "s|__REPO__|$PWD|g" bench/test-extract.mjs | ego-browser nodejs`：退出码 0，40 项断言全通（网络哨兵确认 0 次外部 fetch）。
2. **相关回归套件**：
   - `test-settle-mutation` (23/23)、`test-offline-e2e` (11/11)、`test-release-consistency` (20/20)、`test-credential-chain` (12/12)、`test-wire-skill` (171/171)、`test-route-trace` (62/62) 全部退出码 0。
3. **真实线上验证**：
   - Hacker News：提取前 3 条新闻标题、链接与得分，经同页 DOM（`.athing` 与 `.score`）逐条核对，3 条标题、绝对外部 URL 与得分文本 100% 精确匹配；测试 minItems 约束成功与超限失败路径（exit 0 与 exit 1 均如预期兑现）。
   - Wikipedia：复合任务先执行 Jev 搜索提交，达成后接力抽取首句定义，exit 0。
   - 单轮耗时数据仅作为当次调用记录，不代表系统级性能基准（真实耗时受服务端网络与负载波动影响）。

### 未验证（如实记录）

- 针对超大单页应用（如无限滚动 100 屏）的增量分页抽取尚未封装成批量迭代器（留待后续阶段或由调用方循环调用驱动）。

---

## 阶段三：动作指纹缓存与自愈回放（Phase 3）— v0.7.0，修复后待独立复验

### 核心机制与安全边界
- **身份隔离**：指纹计算基于完整页面 URL（含 origin、路径、query、hash）、完整目标 URL（不做短路径截断）、可交互元素的 role/kind/name 以及控件当前值（value/checked/selectedIndex）。
- **执行上下文绑定**：缓存键将当前候选文本列表、已完成步骤进度、后端配置及验证选项做 SHA-256 摘要；候选文本变动时不会重放历史旧文本；纯模型生成的文本不进入回放缓存。
- **目标唯一性与类型兼容**：页面存在重复语义目标时 fail-closed 拒绝回放；目标 kind 或 URL 不兼容时拒绝回放。
- **显式禁用最高优先级**：`cache: false` 绝对优先于传入的 `actionCache`，禁用时零命中、步步走模型。
- **恢复与副作用安全**：
  - 派发前若发现目标不可见或结构漂移，重新观测并在当前步骤内最多回退一次实时 Jev 决策；
  - 动作一旦派发（可能已在宿主生效），若无 DOM 进展或派发报错，立即作废该缓存条目并终止当前循环（`cache_replay_unverified` / `action_outcome_unknown`），**绝不盲目重复派发**，交由调用方复核。
- **真 LRU 与有界持久化**：命中时刷新访问顺序，超出容量时淘汰最久未访问条目；持久化加载限制文件大小与条目上限，校验结构并按 TTL 过滤过期条目。
- **计时规范**：命中缓存仅跳过服务端模型往返（`decideMs = 0`），DOM 观测、坐标定位与 CDP 派发仍如实耗时，不宣传 0ms 整个动作。

### 验证证据
1. **持久离线测试套件**：
   - `bench/test-action-cache.mjs`：53 项断言全过，覆盖输入变更不重放、`cache:false` 最高优先级、完整 URL / origin 隔离、重复语义目标 fail-closed、真 LRU / TTL 边界、不可见目标派发前回退一次、无进展回放作废且循环终止、部分派发报错停止不重放。
2. **真实线上验证**：
   - `bench/test-action-cache-live.mjs`：真实 Wikipedia 验证通过；冷启动搜索 Jev 的决策计时为 1023ms（1 次模型请求，单次观测）；相同输入热启动命中缓存，`decideMs = 0`，0 次模型请求；随后候选改为 Ada Lovelace，缓存未命中，实时请求到达正确词条。
3. **回归验证**：
   - `test-extract-http` (48/48)、`test-extract` (40/40)、`test-settle-mutation` (23/23)、`test-offline-e2e` (11/11)、`test-guardrails` (39/39)、`test-release-consistency` (20/20) 全部绿灯。

### 未验证（如实记录）
- 针对跨多页面复杂深层流程（>50 步）的长链路径缓存策略尚未做专项测量。

---

## 阶段四：多动作批量打包派发（Phase 4）— ✅ 已完成（2026-10-17, v0.8.0）

### 目标与指标
- 消除多字段表单/连续操作每步都必须经历一次“观测 -> 模型往返 -> 派发 -> 稳定等待”的昂贵开销。
- 支持定义与执行动作批次（Action Batch）：如连续填充多个表单项、或填充字段后紧随提交按钮，在单步内完成。
- 执行层原子预检护栏（Atomic Pre-flight Guardrails）：派发前对批次内每一个动作进行静态合规检查与 `assessDanger` 危险动作扫描，任一动作命中危险词表则整批拦截，0 次派发，绝不产生前置部分副作用。
- 显著性能提升：整批动作只在末尾调用一次 `settle` 页面稳定等待，避免每个微动作都硬交数十至数百毫秒的 settle/IPC 开销。
- 执行中断与状态记录：执行序列中若遇到某个动作命中测试失败（offscreen/covered/stale），精确记录已执行动作（`executedSubActions`）并安全停止，绝不盲目重复派发已有副作用的操作。
- 与 Phase 3 动作指纹缓存无缝协同：将验证成功的动作批次作为复合操作缓存，热启动时 0ms 直接批处理派发。

### 实际实现
- **引擎层原语导出与调度 (`scripts/decider-loop.mjs`)**：
  - `isActionBatch(val)` 与 `normalizeActionBatch(rawBatch, targets, options)`：规范化子动作序列（支持 click、type_text、type_text_submit、select、scroll_down、scroll_up、wait），严格校验目标元素存在性与候选文本绑定。
  - `ActionCache` 增强：支持复合批处理动作缓存条目结构校验与真 LRU 持久化管理。
  - `runJevStep` 批处理支持：
    - 静态校验与原子拦截：派发前执行全量 `assessDanger` 扫描，任一子动作危险直接整批拦截并作废对应缓存，0 次派发；
    - 首个目标即时可用性守卫：缓存命中回放时在第 0 步执行前校验目标 live 状态，结构漂移时安全自愈并回退实时决策；
    - 裸 CDP 批量派发循环：动作间以极小微任务间隙（默认 15ms）连续派发，中途遇不可见/遮挡时中断，记录已派发列表 `executedSubActions` 与失败索引 `failedSubActionIndex`；
    - 单一 settle 结算：整批动作序列只在末尾调用 1 次 `settle`；
    - 复合缓存写入：整批执行成功且产生进展时，将子动作签名数组作为复合批处理条目写入 ActionCache。
  - `runJevAutonomousLoop` 调度与日志：支持 `result.action === "batch"` 的统计追踪（`batchCount`、`batchActionsCount`）与步骤日志展示。
  - `renderJevSummary` 摘要增强：支持展示 `动作批处理: 执行 X 个批次 (共 Y 个子动作)`。
- **CLI 增强 (`scripts/ego-decision-layer`)**：
  - 增加 `--batch`（默认启用）与 `--no-batch`（显式禁用单步批处理）；
  - 配置透传与帮助文档更新。
- **持久测试套件 (`bench/test-multi-action-batch.mjs`)**：
  - 包含 53 项严格断言，覆盖批次定义与规范化边界、ActionCache 批次持久化、全真 DOM 多字段单步批量填充+提交、末尾单一 settle 等待断言、危险动作全量原子拦截（0 派发）、中途目标丢失安全中断与状态记录、ActionCache 冷写热直发（0ms decideMs）、自主循环调度与 0 次外部网络请求哨兵。

### 验证证据
1. **离线单测与协议验证**：
   - `sed "s|__REPO__|$PWD|g" bench/test-multi-action-batch.mjs | ego-browser nodejs`：退出码 0，53 项断言全部通过（网络哨兵确认 0 次外部 fetch）。
2. **全量既有回归套件（100% 绿灯）**：
   - `test-credential-chain` (12/12)
   - `test-guardrails` (39/39)
   - `test-extract-http` (48/48)
   - `test-wire-skill` (171/171)
   - `test-route-trace` (62/62)
   - `test-action-cache` (53/53)
   - `test-offline-e2e` (11/11)
   - `test-settle-mutation` (23/23)
   - `test-extract` (40/40)
   - `test-release-consistency` (20/20)
3. **真实表单单步批处理效果**：
   - 用户名与邮箱填充紧随提交按钮在单个步骤内派发完成，整批仅产生 1 次 settle 页面稳定等待；
   - 包含 "Delete Account" 危险动作的批次被原子拦截，前置安全输入框与危险按钮均 0 次派发；
   - 热启动命中缓存后跳过模型请求，`decideMs = 0`，0 次网络模型往返直接完成表单填写与提交。

### 未验证（如实记录）
- 针对超长动态表单（如带多步异步校验并动态插入子表单的流程）的深层批次调度策略尚未做专项压测。

---

## 阶段五：无语义界面视觉兜底通道（Phase 5）— ✅ 已完成（2026-10-17, v0.9.0）

### 目标与指标
- 借鉴 Midscene.js 的视觉驱动定位思想，解决复杂 Web 应用中 Canvas、富 SVG、无无障碍属性自定义图形控件导致 DOM 元素表为空（连续 `no_targets` 甚至提前失败退出）的痛点。
- 页面内几何扫描器 `scanVisualRegionsInPage()`：当 DOM 可交互元素表为空（或显式开启视觉探查）时，扫描页面中的 `<canvas>`、`<svg>`、图形容器与非文本交互区域，提取其视口几何包围盒 (boundingRect)、中心锚点 `{ x, y }`、尺寸与关联标签/aria 属性。
- 坐标级执行层严格护栏 (Fail-Closed)：
  - 视口边界严校验：`validateCoordinates(x, y, viewport)` 严校验 `0 <= x <= innerWidth, 0 <= y <= innerHeight`，任何负数、NaN、超出视口的坐标必须立即拒绝派发 (`guardRejected: "coordinates_out_of_bounds"`)；
  - 危险区域拦截：对视觉区域携带的 label 严格复用 `assessDanger` 扫描，命中支付/删除等危险词表时立即拦截 (`dangerous_action`)，0 次 CDP 派发。
- 可插拔视觉定位器接入与调度机制：
  - 在 `runJevStep` / `runJevAutonomousLoop` 中接入视觉兜底流程（`options.visualFallback !== false`）；
  - 当页面无语义元素（`no_targets`）时自适应激活视觉通道，支持注入 `options.visualGrounder(page, goal, context)` 或构筑视觉选择题调度模型。
- 与 Phase 3 动作指纹缓存无缝协同：坐标动作验证成功后可记录动作签名并缓存，热启动时 0ms 决策耗时直接派发。

### 实际实现
- **引擎层原语导出与调度 (`scripts/decider-loop.mjs`)**：
  - `scanVisualRegionsInPage(payload)`：页面内扫描 `<canvas>`、`<svg>`、`[role="img"]` 等，提取视口内几何包围盒、中心锚点 `{ x, y }` 与可读标签；
  - `validateCoordinates(x, y, viewport)`：严格坐标有限数值与视口内外边界校验；
  - `handleVisualFallbackStep(ctx)`：视觉几何指纹计算、缓存查询、`visualGrounder` 调度、Fail-Closed 执行层护栏、裸 CDP 派发与单一 settle 结算；
  - `ActionCache` 增强：支持 `click_at` 与 `click_visual` 坐标动作合法性校验与持久化重载；
  - `runJevAutonomousLoop`：支持 `visualStepsCount` 统计与步骤日志；
  - `renderJevSummary`：输出 `视觉兜底: 激活 X 次视觉坐标定位` 统计行。
- **CLI 增强 (`scripts/ego-decision-layer`)**：
  - 增加 `--visual-fallback`（默认启用）与 `--no-visual-fallback`（显式禁用）；
  - 配置透传与帮助文档更新。
- **持久测试套件 (`bench/test-visual-fallback.mjs`)**：
  - 包含 45 项严格断言，覆盖坐标边界校验、ActionCache 坐标存取、几何扫描器提取、Canvas 自适应视觉定位派发、视口越界坐标拦截、危险动作拦截、ActionCache 冷写热直发、自主循环调度与 0 次外部网络请求哨兵。

### 验证证据
1. **离线单测与协议验证**：
   - `sed "s|__REPO__|$PWD|g" bench/test-visual-fallback.mjs | ego-browser nodejs`：退出码 0，45 项断言全部通过（网络哨兵确认 0 次外部 fetch）。
2. **全量回归套件（100% 绿灯）**：
   - `test-multi-action-batch` (53/53)
   - `test-action-cache` (53/53)
   - `test-offline-e2e` (11/11)
   - `test-settle-mutation` (23/23)
   - `test-extract` (40/40)
   - `test-extract-http` (48/48)
   - `test-guardrails` (39/39)
   - `test-credential-chain` (12/12)
   - `test-wire-skill` (171/171)
   - `test-route-trace` (62/62)
   - `test-release-consistency` (20/20)
3. **真实图形页面效果**：
   - 在纯 Canvas 且无常规 DOM targets 的页面中，自适应激活视觉模式，成功计算中心锚点并完成 CDP 点击；
   - 越界坐标与包含 "Delete" 危险标签的操作被执行层 100% 拦截，0 次事件派发；
   - 热启动命中缓存跳过模型请求，`decideMs = 0` 直接命中坐标。

### 未验证（如实记录）
- 针对复杂 WebGL / 3D Canvas 内部多层深度交互的坐标映射尚未做多视角量化。

