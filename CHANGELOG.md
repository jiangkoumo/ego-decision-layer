# 更新日志

版本号只有一个来源：`SKILL.md` frontmatter 里的 `metadata.version`。本文件顶部条目、
`.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json` 都必须与它一致；
改版本后跑 `node bench/test-release-consistency.mjs`。

每个版本按 **新增 / 修复 / 更正 / 未验证** 分组。「更正」记的是被实测推翻的旧结论，
不是新功能；「未验证」如实列出还没测过的边界。

## 0.4.3 — 2026-09-26

### 修复

- **0.4.2 的「视口 0×0 就硬失败」在本机正常路径上就是回归 → 改成默认自动撑起**。本机复测确认：
  `taskSpace` 新建的标签页在未导航 / `domcontentloaded` / `load` 之后 `innerWidth/innerHeight`
  都是 `0×0`，`page.info()` 也为空——**0×0 是这台机器的常态，不是异常**。0.4.2 之后
  `examples/bench/run-pair.sh A` 从 `success:true, steps:2` 变成 `viewport_degraded`，CLI 冒烟也 exit 1。
  现在 `runJevAutonomousLoop` 入口仍只读一次视口（`page.evaluate`，不新增 CDP），任一为 0 时
  **默认自动** `Emulation.setDeviceMetricsOverride`（`1280x900@1`）并打印一行说明，然后照常跑；
  视口正常时**零额外 CDP**；只有自动撑起失败（CDP 报错）或显式 strict 时才 `viewport_degraded`
  （`steps: 0`、不派发、不问模型）。引擎结果新增 `viewportOverride`（本次实际下发的覆盖），
  CLI 据此决定退出时是否清理。

### 新增

- **`--no-force-viewport`（CLI）/ `options.strictViewport`（库）**：显式要求「视口退化就直接失败」，
  把 0.4.2 的 fail-fast 保留为**可选**行为。`--force-viewport <宽x高>[@缩放]` 保留，尺寸优先于自动默认值。
- **`bench/test-viewport-degraded.mjs` 改写为 0.4.3 语义**：0×0 默认自动撑起并继续、strict 失败、
  CDP 撑不起来失败、正常视口零额外 CDP、显式值优先、确定性、CLI 参数。

### 更正

- **「覆盖跨进程持续」是错的**（0.4.2 写入）。本机复测：覆盖是 **per-space / per-page** 的——
  给某个 space 设过覆盖后，**紧接着新开的 space 仍是 0×0**；旧 `run-pair A success:true` 是因为
  当时别处已有覆盖。已从 SKILL / README / CHANGELOG 更正。
- **「0×0 是异常宿主」的定位也是错的**（0.4.2）：本机新 space 常态就是 0×0。
- `Emulation.clearDeviceMetricsOverride` 在本机 0.5.1.13 上**确实不回退**（同进程 set→clear 后
  `innerWidth/innerHeight` 仍是覆盖值）——这一事实保留；但 CLI 不再把它当作“覆盖仍在生效”的依据，
  而是退出时再读一次视口、如实报告。

### 未验证

- 同 0.4.2：本地模型后端只用 stub 验证，未在真实本地推理服务上端到端跑过；跨域 iframe 不处理；
  frame 祖先带缩放/旋转直接拒绝；危险词表是启发式；真实验证码 / 登录墙未测。
- 自动撑起的默认尺寸 `1280x900@1` 是否适合所有任务未做遍历；`clearDeviceMetricsOverride` 在其它
  ego lite 版本上的行为未测（只在 0.5.1.13 上测过）。

## 0.4.2 — 2026-09-26

### 修复

- **视口退化为 0×0 时不再静默降级成 `no_targets`**。真实来源：另一个 Agent harness
  （Hermes Agent）在本机跑多步任务时，agent space 的标签页视口是 `0×0`
  （`window.innerWidth/innerHeight = 0`），元素表按视口可见性构建 → 恒为空。旧行为是每轮
  `no_targets` + 700ms 等待，**4 步白烧、决策 0ms、一次模型都没问**，用户看不出原因。
  现在 `runJevAutonomousLoop` 在**循环入口**读一次视口（一次 `page.evaluate`，不新增 CDP 调用），
  任一为 0 时**立即**返回 `viewport_degraded`（`steps: 0`、不派发任何动作、不问模型），
  并在返回值 `hint` 与日志里给出可执行提示。`no_targets` 语义不变（元素表为空但视口正常时
  仍走原逻辑）；检查放在循环入口，`runJevStep` 不变。

### 新增

- **`--force-viewport <宽x高>[@缩放]`（CLI）/ `options.forceViewport`（库）**：给退化宿主的显式
  逃生通道。循环开始前用 `Emulation.setDeviceMetricsOverride` 撑起视口（默认关闭，不改默认行为）；
  退出时按需用 `Emulation.clearDeviceMetricsOverride` 清理——**保留了 space / 页面时不清理**
  （`--keep` / `--keep-space`，或任务失败时 CLI 会自动保留 space），覆盖仍在生效并在输出里说明，
  方便人工检查。非法输入 → 退出码 2，错误信息说明期望格式。`parseViewportSpec` 导出，
  接受 `1280x900` / `1280x900@2` / `{ width, height, deviceScaleFactor? }`。
- **测试 `bench/test-viewport-degraded.mjs`**（纯 node、stub page、stub fetch，无浏览器无凭证）：
  覆盖 0×0 明确失败（fetch 0、步数 ≤ 1、不派发）、`forceViewport` 后正常推进、正常视口行为不变、
  提示字样、两次运行逐字节一致、CLI 非法输入 exit 2。

### 未验证

- 同 0.4.1：本地模型后端只用 stub 验证，未在真实本地推理服务上端到端跑过；跨域 iframe 不处理；
  frame 祖先带缩放/旋转直接拒绝；危险词表是启发式；真实验证码 / 登录墙未测。
- **视口退化的修复由 stub 覆盖 + 真实 Hermes 运行验证，未在更多宿主上遍历**。该版本把 0×0
  当异常硬失败——0.4.3 复测证明它在**本机正常路径上就是回归**，视口相关实测结论已在 0.4.3「更正」。

## 0.4.1 — 2026-09-26

### 新增

- **`--handoff-prompt`（CLI）**：把「派活给子代理必须显式点名」做成产品能力。
  决策探针实测：交互式会话 5/5 主动走本技能，而**子代理 / 一次性无会话上下文 0/6**——
  这类上下文里既没有技能清单、也没有任何 AGENTS.md 内容，接管与 always-on 都到不了它们。
  该选项打印一段可直接粘贴的指派块：路由判据（多步线性走本 CLI、单步 / 精确 DOM / 批量抓取走
  `ego-browser` 原生 API）、**解析后的真实路径**（技能目录 / CLI / SKILL.md，复用既有解析逻辑、
  不硬编码 `~`）、「先读 SKILL.md 再动手」、可照抄的命令模板（`--url` / `--until` / `--steps` / 目标句），
  结尾提示用 `--route-status` 核对。默认纯文本；`--handoff-prompt --json` 给
  `{prompt, skillDir, cliPath, skillMdPath}`。只读：不起浏览器、不需要凭证、不写任何文件，
  也不触发首跑接管；输出不含任何外部仓库名，且确定性（两次运行逐字节一致）。
- **README「让 Agent 真的用上它」**：三档手段与实测差异（交互式主动走；子代理必须显式指派 →
  `--handoff-prompt`；常驻兜底 → `--always-on`），并如实写明边界：不读技能的 Agent 绕不过去；
  个人作用域技能在 Cowork / 云会话不加载。
- **`docs/WHY.md`**：为什么是「可插拔决策层」而不是「又一个包装」；三组可复算证据各带复算命令
  或出处，并明写未验证边界。生态事实一律指向 `docs/ECOSYSTEM.md`，不在该文重复。
- **测试 `bench/test-handoff-prompt.mjs`**（纯 node、无浏览器无凭证）：断言真实路径、路由判据、
  命令模板、`--json` 结构、不含外部仓库名、两次运行逐字节一致。

### 未验证

- 同 0.4.0：本地模型后端只用 stub 验证，未在真实本地推理服务上端到端跑过；跨域 iframe 不处理；
  frame 祖先带缩放/旋转直接拒绝；危险词表是启发式；真实验证码 / 登录墙未测。
- `--handoff-prompt` 产出的是**指派文本**，不是强制机制，也不改变执行成功率；探针样本仍是
  n=5/6、单机单模型、只报计划（见 README「已知限制」），不能外推成真实执行成功率。

## 0.4.0 — 2026-09-26

> **破坏性变更（改名）**：项目从 `ego-jev` 改名为 **`ego-decision-layer`**。公开身份都变了：
> 安装命令（`npx skills add jiangkoumo/ego-decision-layer`）、技能名（`ego-decision-layer`）、CLI 路径
> （`scripts/ego-jev` → `scripts/ego-decision-layer`；引擎 `scripts/ego-jev.mjs` → `scripts/decider-loop.mjs`）、
> 配置目录（`~/.config/ego-jev` → `~/.config/ego-decision-layer`）、always-on 块标记
> （`<!-- ego-jev:route … -->` → `<!-- ego-decision-layer:route … -->`）。
>
> **迁移三步**（旧命令 `ego-jev` 仍可用，保留为兼容垫片；环境变量 `EGO_JEV_*` 与引擎的 24 个导出
> **签名与名字都没动**）：
>
> ```bash
> bash scripts/rename-self.sh --dry-run   # 1. 先看它会做什么（不写任何文件）
> bash scripts/rename-self.sh             # 2. 执行（幂等）
> # 3. 重开 Agent 会话（技能列表是启动时快照的）
> ```

### 新增

- **改名 + 本地迁移脚本 `scripts/rename-self.sh`**：幂等、支持 `--dry-run`。顺序：旧接管先 `--restore` →
  记下 always-on 清单 → 删旧技能软链 / 建新软链（`~/.local/bin` 也更新）→ 迁移配置目录 →
  用新名重接管 → 重插 always-on → 自检。旧配置目录仍读得到（新目录不存在而旧目录存在时沿用并提示一次）。
- **历史入口垫片 `scripts/ego-jev`**：打印一行改名提示后 exec 新 CLI，`~/.local/bin/ego-jev` 不断。
- **`--restore` 能清旧 always-on 块**：wire 脚本同时识别新旧块标记。
- **测试**：断言旧名的测试改到新名；`test-release-consistency.mjs` 新增**身份一致性**断言
  （`SKILL.md` name == 插件清单 name == `skills/<name>/`）与**旧名白名单**扫描；新增
  `bench/test-rename-self.mjs`（临时 HOME + 假官方软链：`--dry-run` 不写盘、真跑后迁移到位、
  `--check` exit 0、再跑幂等）。

### 未验证

- 同 0.3.4：本地模型路径只用 stub `fetch` 验证，未在真实本地推理服务上端到端跑过；hooks 未做、
  路由触发率未量化。
- 改名后的**真实第三方会话**（Codex / Cursor 等重新读取新技能名）未实测；远端仓库改名由维护者在
  GitHub 侧完成，本仓库只改本地身份。
- 迁移脚本只在临时 HOME 的模拟布局上验证过；未在本机实盘的多用户 / 多技能目录组合上验证。

## 0.3.4 — 2026-09-26

### 新增

- **决策后端（decider）抽成可插拔的一层**：正式契约 `decide({ state, questions, options }) → { answers, meta }`
  （`meta` 带 `model` / `usage` / `endpoint` / `kind`）。既有 16 个导出签名不变，`options.ask` 语义保持
  （注入实现优先级最高）。默认仍是 System One（`askJev`），未配置时行为与从前完全一致。
- **本地模型路径（`kind: "openai-compatible"`）**：`POST {baseUrl}/chat/completions`，适配
  llama.cpp / ollama / vLLM / LM Studio 等 OpenAI 兼容端点。`questions` 按稳定顺序确定性地渲染成
  一段文本（不掺时间戳/随机数），要求严格 JSON；非 JSON / 缺问题头 / 候选非法 → 按既有
  `invalid_response` 失败，不猜、不派发任何动作。
- **诚实的能力声明**：适配器 `capabilities: { confidence: false }`——文本 LLM 没有校准置信度。
  引擎据此跳过 `minOpConfidence` / `minTargetConfidence` / `doneThreshold` / `stuckThreshold`
  四类基于置信度的阈值升级（默认全关），**绝不伪造概率数字**；但执行层护栏一条不少（陈旧校验、
  `guardRejected`、跨 frame fail-closed、危险动作拦截、`validateChoice` 候选合法性校验）。
- **文件式配置 + CLI 开关**：`~/.config/ego-jev/decider.json`（`kind`/`baseUrl`/`model`/
  `apiKey`/`apiKeyFile`/`timeoutMs`/`headers`）；CLI 加 `--decider <kind>` / `--base-url` / `--model`。
  本地后端不需要 TypeSafe 凭证，凭证预检相应放宽。README 加「决策后端」一节，`SKILL.md` 对应一句。
- 新增 `bench/test-decider-backend.mjs`（离线、stub `fetch`、不需凭证）覆盖：默认路径请求体形状、
  本地后端提示完整性/顺序稳定性、解析失败不派发、置信度能力差异、三类护栏仍生效、注入 ask 优先。

### 未验证

- 本地模型路径只用 **stub `fetch`** 验证过：**没有在真实的本地推理服务上端到端跑过**（llama.cpp /
  ollama / vLLM / LM Studio 任一都没试）。真实端点的超时、`response_format` 支持度、JSON 遵循率
  均未测量。
- 同 0.3.3：hooks 方案未做、路由触发率未量化、个人作用域技能在 Cowork / 云会话不加载未实测；
  `docs/ECOSYSTEM.md` 的三列计数是文件树机械计数，★ 数与更新日期会变。

## 0.3.3 — 2026-09-26

### 新增

- **生态一览 [`docs/ECOSYSTEM.md`](docs/ECOSYSTEM.md)**：同一思路（用 Jev / System One 替掉 ego lite
  每步的大模型决策）在 5 天内出现了多个项目，本文档用**同一套 GitHub API 查询**做了中立的点状普查：
  每个项目一行自述**照抄其 GitHub About 原文**，★数 / 创建日期 / 测试类文件数 / 原始数据 / CHANGELOG
  都可复算（口径写进文档）。刻意不做排名、不评价优劣、不比较性能，并明说**没有跑过他们的代码**。
  README 的「致谢」节加了一行指向它。回归保护：`bench/test-release-consistency.mjs` 的
  「文档里不出现未登记上游 github URL」断言**只显式放行这一个文档**（理由写在断言旁）；
  「代码行不得出现外部仓库名」这条不变。

### 未验证

- 同 0.3.2：hooks 方案未做、路由触发率未量化、个人作用域技能在 Cowork / 云会话不加载未实测。
- `docs/ECOSYSTEM.md` 的三列计数是**文件树机械计数**，不是测试用例数或质量评分；★ 数与更新
  日期会变，且第三方目录（aiskill.market）的条目未经本仓库独立复核。

## 0.3.2 — 2026-09-26

### 更正

- **always-on 到不了子代理**：实测（全新会话的决策探针，中立 cwd，只报计划不执行）——
  **交互式会话 5/5 主动走 ego-jev**（当时只有同名接管 + 自身技能两层，未开 always-on），
  而**子代理 / 一次性无会话上下文 0/6**（开 always-on 前 0/4）；探针直接确认这类上下文里
  **既没有技能清单、也没有任何 AGENTS.md 内容**。所以 always-on 那行只对会读指令文件的
  交互式会话有效；派活给子代理必须在 handoff 里显式写明用 `ego-jev` CLI。
- **路由句被拼在最易被截断的位置**：接管层把路由句拼在**厂商描述之后**。技能选择只看
  「技能名 + description」，而描述会在技能多时按模型上下文的约 1% 做预算压缩、**优先丢最少用的尾部**，
  单条也有长度上限——放在末尾等于最先被砍掉（本机实测：约 600+ 字符英文之后才出现那句中文）。
  现在改为**路由句在前、厂商描述在后**（厂商文本一字未删、未改写，只挪位置），并把路由句改写成
  以「触发条件 + 动作」开头，不再以「本入口已由 ego-jev 接管：」这种陈述打头；长度不增（反而更短）。
  always-on 块第一句同样改为触发条件 + 命令，命令紧跟其后。测试新增**位置断言**
  （不是 contains 断言）防止以后改拼法时悄悄退化。

### 未验证

- 同 0.3.1：hooks 方案未做；个人作用域技能在 Cowork / 云会话不加载未在真机上实测。
- 触发率测量是**决策探针**（只报计划、不执行）且样本很小（交互式 n=5，子代理 n=6），
  不能当作真实执行成功率；always-on 的**增量**效果也未测出（基线已 5/5，天花板效应）。

## 0.3.1 — 2026-09-26

### 修复

- **`--restore` 会被下一次 CLI 运行静默撤销**：`--ensure`（CLI 首跑接管）只认「有启用标记」与
  「检测到官方入口」，没有「用户已明确选择不接管」的持久状态。于是 `--restore` 清掉标记后，
  下次跑 `ego-jev` 又会把入口接管回去（只打一行提示）——**用户的显式决定被自动流程反转**。
  现在 `--restore` 会写一个持久化的 opt-out 标记（`~/.config/ego-jev/opted-out`，内容确定性，
  无时间戳/随机数），`--ensure` 见到它直接退出、什么都不做（连官方入口都不探测）。
- **opt-out 状态下的诊断文案自相矛盾**：明明是「已按用户选择不接管」，末行仍打印
  「所有 ego-browser 入口都已接管且最新」。现在该状态打印「按你的选择未接管任何入口
  （重新启用命令见上）」；已接管状态与漂移状态的文案不变。

### 更正

- **`--restore` 现在是粘性的**：它不再只是「这一次还原」，而是「以后也别自动接管」。
  重新启用必须用**显式动作**：`bash scripts/wire-agent-skills.sh`（或 `./install.sh` 的接管步骤）
  会清掉 opt-out 标记并恢复接管；自动路径（`--ensure` / `--if-enabled`）永远不解除它。

### 新增

- `--status-json` / `ego-jev --route-status` 增加 `optedOut` 字段；`--check` 在 opt-out 状态下
  输出「已按用户选择不接管」并 **exit 0**（这是健康状态，不是漂移）。
  「没有 opt-out 的普通未接管」仍按既有语义 `exit 1`（回归保护已加进测试）。

### 未验证

- 同 0.3.0：hooks 方案未做、路由触发率未量化、个人作用域技能在 Cowork / 云会话不加载未实测。

## 0.3.0 — 2026-09-26

> **破坏性变更（安装默认行为）**：`./install.sh` 现在**默认**接管官方 `ego-browser` 入口；
> `ego-jev` CLI 首次运行也会在检测到官方入口时接管一次。想退回旧行为：安装加 `--no-wire`，
> 或随时 `bash scripts/wire-agent-skills.sh --restore`（把入口还原成官方软链，并移除所有 always-on 块）。

### 新增

- **首装就默认接管**：`install.sh` 默认执行接管（`--wire` 仍接受，视为显式启用；`--no-wire` 跳过）。
  接管失败时安装仍然成功（提示原因 + 明确说 CLI 仍可用），只有显式 `--wire` 才让安装退出非零。
- **CLI 首跑一次性接管**：`scripts/ego-jev` 跑任务前看一眼官方入口——已接管过就静默刷新；
  没接管过但检测到官方入口，就首跑接管一次并打印一行说明（含 `--restore` 还原命令）；
  两者都不是则什么都不做（不建目录、不打噪音）。`EGO_JEV_NO_WIRE=1` 整体关闭（旧名
  `EGO_JEV_NO_HEAL=1` 仍接受）。这步任何失败只降级为一行提示，**不改变任务的退出码**。
- **`--check` 给出结论而不是「跳过」**：没有官方入口的目录明确写「无需接管（没有官方
  `ego-browser` 入口；该 Agent 通过自身的 ego-jev 技能被发现）」，并汇总
  **已接管 N / 无需接管 M / 漂移 K**；有漂移仍 exit 1。`--check` 保持只读（连 mtime 都不变）。
- **always-on 路由块（显式开关，默认不写任何用户文件）**：
  `bash scripts/wire-agent-skills.sh --always-on <file>` 向指定文件插入一段带标记的说明块
  （`<!-- ego-jev:route begin -->` … `end`），幂等、可 `--restore` 精确移除，首次写入前备份到
  同目录 `.bak`。适合放在项目 `AGENTS.md` 或 `~/.claude/CLAUDE.md`：让 Agent 在读任何技能之前
  就知道「多步线性浏览器任务先走 ego-jev」。
- **路由可审计**：新增只读命令 `scripts/ego-jev --route-status`，输出机器可读 JSON
  （`enabled` / `dirs[]` / `summary{n,m,k}` / `alwaysOn[]` / `vendor` / `generatedHash`），
  不起浏览器、不需要凭证、不建 TaskSpace。同一份信息作为 `route` 段写进 CLI 的结果 JSON，
  `renderJevSummary` 也带一行（`路由: 已接管 2 / 无需 1 / 漂移 0 · always-on 1`）。
- **`--restore` 一次清两样**：同时把接管层还原成官方软链、并移除所有已记录的 always-on 块。

### 修复

- `--check` 对「目录里没有官方入口」只打一行「跳过」，用户看不出结论；现在给出明确结论与原因。
- CLI 自愈只在**已有启用标记**时才动手，导致「装完但从未接管」的机器永远不会走 ego-jev；
  现在首跑接管。

### 更正

- 旧文档把 `--wire` 写成可选的「顺便」动作，实际效果是多数用户装完仍走官方正文；
  0.3.0 起默认接管，`--no-wire` 才是显式跳过。

### 未验证

- **hooks 方案没做**：`SessionStart` / `UserPromptSubmit` 注入 `additionalContext` 是唯一
  「必须发生」的强制层，但它要写用户的 Agent settings；本轮只文档说明，不自动改用户设置。
- **路由触发率没有量化**：没有测「Agent 实际走 ego-jev 的比例」（需要另一套 grader）。
- **always-on 的覆盖边界如实记录**：个人作用域技能在 Cowork / 云会话里不加载，always-on 那行
  一样受会话类型限制；它只影响读这个文件的 Agent。

## 0.2.0 — 2026-09-26

> 本次把 `SKILL.md` 里从未发布过的 `1.0.0` 占位对齐到实际发布线 `0.2.0`。`1.0.0` 从未打过 tag、
> 也从未发布，而项目仍有公开已知边界（跨域 iframe 不处理、危险词表是启发式、真实验证码站未测），
> 宣称 1.x 属过度声明。此后版本号只从 `SKILL.md` 读。

### 新增

- **元素表补全：无 role 的容器型可点元素**。`<div onclick>` 卡片/行、`tabindex` 区块、
  `cursor:pointer` 块级容器补成 `clickable-region`（映射到既有 `kind: clickable`，问题层与执行层未改）。
  a11y 元素优先占预算；嵌套容器只收最内层；被占满的容器、`<a href>` 里的容器、`<label for>`
  都不与 a11y 元素双收。实测 YouTube 首页 3 个、X 首页 5 个；真实 Jev 能选中它
  （YouTube 视频元数据块 → `/watch`，见 `bench/test-realjev-region.mjs`）。
- **跨 frame / shadow 观测**。观测根扩到主文档 + 同源 iframe 文档 + 开放 shadow root；
  shadow host 的发现改成惰性遍历并跨 root 公平推进（旧实现只看主文档前 2000 个节点，
  靠后的 shadow root 永远进不了观测根）。
- **跨 frame 派发的 fail-closed 守卫**。逐层命中校验：每层把点换算到该层坐标系（含
  `clientLeft/clientTop`），断言该层 `elementFromPoint` 严格命中承载下一层的 `<iframe>` 自身；
  任一层不成立即 `covered`。`defaultView` 为 null / frame 链断 → `frame_unresolved`；
  frame 元素到文档根的祖先链上有非 identity 的 2D 线性变换（scale/rotate/skew）或 `zoom !== 1`
  → `frame_transformed`（纯平移、`translateZ(0)` 放行）。全部 0 次 CDP 派发，
  不再退化成 `{0,0}` 后盲点。
- **判定器可注入（`options.ask`）+ 离线端到端自测**。`options.ask` 与引擎自己的 `askJev` 同签名
  （state 文本 + questions 对象）。新增 `bench/test-offline-e2e.mjs`：在 `about:blank` 上注入 DOM，
  用注入判定器跑「真实观测 → 真实 `locate` → 裸 CDP 派发 → 真实 DOM 断言」，不联网、不需要凭证，
  并断言整个用例一次 `fetch` 都没发。
- **服务端实际模型版本 + 分阶段耗时**。`askJev` 把响应里的 `model` / `usage` 带回（`receipt` 载体），
  每步产出 `phases`（观测 / 决策 / 执行 / 校验）并累计到循环；新增导出 `renderJevSummary`，
  CLI 收尾打印这张表。请求里写的是浮动别名 `jev-latest`，服务端实际服务哪个版本只有响应的
  `model` 字段能回答。
- **危险动作前置拦截**。目标名称 / 选项文本命中「支付 / 删除 / 退订」词表（中文 + 英文，我们自己的）
  时不执行，记 `guardRejected=dangerous_action` 并直接停（不重试）；`dangerGuard: false` 可整体关闭。
- **凭证查找链 + 后端可降级**。查找顺序：`--api-key` > `TYPESAFE_API_KEY`（仅普通 node 可见）>
  `TYPESAFE_API_KEY_FILE` > `~/.config/ego-jev/credentials` > `~/.config/typesafe/api_key` >
  rc 文件（`~/.zshrc` / `~/.bashrc` / `~/.bash_profile` / `~/.profile`）里的
  `export TYPESAFE_API_KEY=…`——全部是文件，因为 ego 运行时拿不到父进程环境变量。
  后端地址 `TYPESAFE_BASE_URL` 可覆盖；主后端失败时的降级端点 `TYPESAFE_FALLBACK_BASE_URL`
  （不设即不降级，`fallback: false` 可关）；这两个变量由 CLI 在父进程读取后写进配置传给子进程。
- **原生下拉二次决策**。观测时选中的 option 到执行时可能已经不在 DOM 的 options 里；
  旧实现把它当失败 / 无进展，最后 `stuck`。现在改为**一次**带新选项的重问
  （`maxOptionRetries` 默认 1），重问仍失败才显式报 `stuck`。

### 修复

- **跨 frame 父层命中校验过宽**：旧判定接受 iframe 的祖先（`hit.contains(fe)`），于是 iframe 设
  `pointer-events:none`、外面套一个可点击 wrapper 时，校验通过而 CDP 点到 wrapper，代码却记执行成功。
  改为严格命中 iframe 自身（iframe 没有可命中的后代，放宽从来不需要）。
- **只查 frame 自身 transform**：祖先 `scale` / `rotate` / `skew` 会让 frame 内坐标换算失真，
  点击可能落到别处而放大的 iframe 仍满足命中测试。改为沿祖先链逐个检查 2D 线性部分与 `zoom`
  （解析 `matrix` / `matrix3d`），纯平移与 `translateZ(0)` 放行。
- **`TREE_SCAN_CAP` 声明与实现不一致**：注释说它是「所有 root 的合计上限」，但保底配额让最坏上界
  变成 `8000 + 31×2000`。改成跨 root 轮转（与 region 扫描同款），上限成为硬约束。
- **frame × shadow 组合恒被误拒**：frame 内 shadow root 里的元素，命中测试用的是 frame 的
  `Document.elementFromPoint`（只返回 shadow host），身份对不上，恒判 `covered`。改用元素自己的 root。

### 更正

- **决策延迟口径**：旧文档写「单步决策约 1.0–1.5s」，实测那其实是**整步耗时**；
  决策请求本身 352–524ms（10 次采样，中位 434ms）。整步 1.0–1.4s。
- **当前瓶颈在执行**：分阶段数据显示单步的大头是「派发 + 稳定等待」0.56–0.99s，
  而不是决策（0.35–0.52s）。旧说法「省的是决策往返」仍然成立（决策比大模型快），
  但单步耗时的大头已经不在决策那一段。
- **维基语言选择器旧基线失效**：`www.wikipedia.org` 上那个 77 项的 `#searchLanguage` 现在是
  `opacity:0`（被自定义语言列表 UI 取代），引擎按可见性规则跳过它——旧「约 2/3 成功」的基线
  无法在原元素上复现。同类「原生下拉改选」在 DuckDuckGo 设置页语言下拉实测 6/6
  （`bench/test-native-select.mjs`）。

### 未验证

- **跨域 iframe 不处理**：读不到 `contentDocument`，这类树不在观测范围内。
- **frame 祖先带缩放 / 旋转时直接拒绝**：这是有意的 fail-closed 取舍，不是「支持变换后的 frame」。
  宁可拒绝也不猜坐标。
- **危险词表是启发式**：`remove` / `pay` 这类词可能误伤；站点改版后词表可能要调。
- **降级路径默认关闭，且没有真实第二后端验证**：只用假端点验证了机制本身。
- **真实验证码 / 登录墙未测**：只在合成拦截页上验证过 `blocked` 分支。

## 0.1.0 — 2026-09-22

首个带 tag 的发布（release 标题「引擎重建 + 一键更新」）。

### 新增

- 按剖析结果重建引擎：观测改成一次 `page.evaluate` 自建 DOM 元素表（约 2ms，替代 110–130ms 的
  `page.snapshot()`），动作改成裸 CDP `Input.dispatchMouseEvent`（13–16ms，替代 788–1005ms 的
  `page.click`），等待改成可观察条件。HN 两步导航端到端 4569ms → 1675ms。
- 响应校验、执行期守卫、滚动感知的进展判定、按码点截断（emoji 安全）。
- `update.sh` 一键更新，并在 README 记录。

### 更正

- 撤回「X 等虚拟化站点不可用」的警告：那个 0/15 是用有缺陷的 harness 测出来的
  （锚点在另一次页面加载里测量），不是引擎能力问题。
