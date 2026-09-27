---
name: ego-decision-layer
description: 多步线性浏览器任务（连续点击、翻页、搜索表单提交、导航跳转）的默认入口：用 `ego-decision-layer` 一条命令让决策层在单个 ego-browser 进程内闭环决策（默认 System One / Jev，可换本地 OpenAI 兼容后端；browser automation / multi-step click chain / form submit / navigation），不再每步退回大模型思考。单步动作、精确 DOM/选择器、批量抓取仍走 ego-browser 原生 API；也可把官方 ego-browser 技能入口接管成路由层。当任务涉及浏览器多步操作、要写 ego-browser nodejs 脚本（await import / fetch / 凭证落盘）时读它。
metadata:
  version: "0.4.4"
  date: "2026-09-26"
  requires: ego-browser
---
# ego-decision-layer — 给 ego-browser 装一个可插拔的决策层

这是一个**附加技能（外挂）**：它只存在于 Agent 的技能目录里（如 `~/.agents/skills/ego-decision-layer/`），
**不修改 ego lite 应用包里的任何文件**，因此 ego lite 升级不会把它冲掉。

本技能的组成（都在本 SKILL.md 所在目录内）：

| 路径 | 作用 |
| --- | --- |
| `scripts/decider-loop.mjs` | 引擎（决策闭环、元素表解析、退出判定） |
| `scripts/ego-decision-layer` | 命令行入口（会自动在 同目录 / 仓库根 / `~/.agents/lib/` 里找引擎） |
| `scripts/wire-agent-skills.sh` | 把 Agent 技能目录里的官方 `ego-browser` 入口接管成**路由层**（见下节） |
| `overlay/ego-browser/SKILL.md.in` | 路由层的模板（接管时生成，正文仍指向 App 当前版本） |
| `examples/bench/` | 对照基准脚本（A 组 Jev 闭环 vs B 组经典循环） |

命令行两种调用方式，任选其一：

```bash
ego-decision-layer --url "…" "目标"                        # 已链接进 PATH 时
"<本技能目录>/scripts/ego-decision-layer" --url "…" "目标"  # 直接用技能内的入口
```

基础用法、Space/Page/选择器/收尾纪律仍以 `ego-browser` 技能为准；本技能只负责「让 Jev 加速」这件事。

## 路由：什么时候用我

| 任务形状 | 走哪条路 |
| --- | --- |
| **多步线性**：连续点击、翻页/下一页、搜索框输入并提交、多字段表单、导航到目标页 | **本技能**（`ego-decision-layer` CLI 或 `runJevAutonomousLoop`） |
| 单个动作；需要精确选择器/DOM、批量抽取、截图、文件、网络请求、CDP | `ego-browser` 原生 API（读官方技能） |
| 内容生成、业务判断（回什么话、选哪个商品、写哪段文案） | 大模型决定，把决定喂给上面两条 |

**但「默认用哪个」不能只靠这段表格**：ego lite 会把官方 `ego-browser` 技能写进每个 Agent 的技能目录
（`~/.agents/skills/ego-browser`、`~/.claude/skills/ego-browser` …，由 App 在安装/升级时重建），
而官方正文不知道 ego-decision-layer 存在 —— 于是 Agent 默认照它写逐步脚本。用本技能的接管脚本把这个入口换成
**路由层**，Agent 先看到的就是上面的路由规则。**`install.sh` 默认就接管；`ego-decision-layer` CLI 首次运行时
也会在检测到官方入口时补一次**（`EGO_JEV_NO_WIRE=1` 关闭）：

```bash
bash scripts/wire-agent-skills.sh            # 接管/刷新（幂等；只写 Agent 技能目录，不碰应用包）
bash scripts/wire-agent-skills.sh --check    # 只读：已接管 N / 无需接管 M / 漂移 K（漂移则 exit 1）
bash scripts/wire-agent-skills.sh --restore  # 还原成官方软链（启用标记与 always-on 块一并清掉）
```

接管后：入口是包外的一层 `SKILL.md`，正文仍软链到 App 当前版本的官方技能（升级自动跟随），
只有「先路由、再决定写不写脚本」那一段是本技能加的。`update.sh` 与 `ego-decision-layer` CLI 都会自动重接管
（ego lite 升级会把入口还原）。**应用包内任何文件都没动。**
`--restore` 是**粘性**的：它记下「不接管」的选择，之后 CLI 首跑不会自动接管回去；
重新启用要显式跑一次接管（`bash scripts/wire-agent-skills.sh`）。

想让它**在读技能之前**就知道路由：`bash scripts/wire-agent-skills.sh --always-on AGENTS.md`
（显式开关，默认不写任何用户文件；块带标记、幂等、可 `--restore` 精确移除）。
路由状态可事后审计：`ego-decision-layer --route-status`（只读 JSON，不起浏览器、不要凭证）。

**派浏览器任务给子代理时必须显式点名**：实测子代理 / 一次性无会话上下文的上下文里既没有技能清单、
也没有任何 AGENTS.md 内容，接管与 always-on 都到不了它们。`ego-decision-layer --handoff-prompt`
打印一段可直接粘贴的指派块（路由判据 + 解析后的技能目录 / CLI / SKILL.md 真实路径 + 可照抄的命令模板，
结尾提示用 `--route-status` 核对）；`--handoff-prompt --json` 给机器可读的
`{prompt, skillDir, cliPath, skillMdPath}`。只读选项，不起浏览器、不需要凭证。

## 加速能力

多步按钮点击、翻页、搜索表单、导航跳转这类「下一步做什么很明确」的线性任务，不要每走一步都
退出来交给大模型慢思考。可以让 Jev（TypeSafe System One）在单个进程内闭环决策执行。

实测（2026-09-26, 服务端 `jev-1.13.0`，维基百科搜索任务）：单步（观测+决策+执行+校验）约
**1.0–1.4s**，其中**决策请求本身约 0.35–0.52s**（10 次采样 352–524ms，中位 434ms），
**执行（派发 + 稳定等待）约 0.56–0.99s 是当前单步的大头**；分阶段数字由
`renderJevSummary` 打印。旧文档的「单步决策约 1.0–1.5s」实为**整步耗时**，不是决策请求本身。
**对照实测**（同任务、同元素表、同验证器，
交替 3 轮取中位数）：

| 任务 | Jev 单进程闭环 | 经典循环（每步一进程 + 大模型思考） | 结果 |
| --- | ---: | ---: | --- |
| HN 两步复合导航 | 中位 **4.9s**（1 进程，12 次浏览器调用） | 中位 **9.7s**（3 进程） | Jev 快 **~2.0×** |
| 维基百科搜索（两组都要生成文本） | 中位 **5.4s**（1 步） | 中位 **10.1s**（2 进程） | Jev 快 **~1.9×** |

差异主要来自**决策延迟**：Jev 决策请求约 0.35–0.52s/次（整步合计约 1.0–1.4s），而可用大模型 1.6–4.5s/次（实测 kimi-k3 1.8s、
minimax-m3 1.6s、glm-5.3 3.2s、qwen3.8-max 3.5s、deepseek-v4-pro 4.5s；gpt-5.6-luna 与
grok-4.6 端点 503 不可用）。进程启动实测只占约 250–350ms/次，**不是**主要成本。

样本只有 3 对/任务且**方差很大**（经典组单轮 7.3s–22s，上述是不同批次中更好的那批），
不构成基准；只能说量级上 Jev 闭环约为经典循环的一半时间。基准脚本在 仓库的 `examples/bench/`
（`run-pair.sh` + `arm-a.js` / `arm-b-step.js`）。

测量纪律：请求里写的是浮动别名 `jev-latest`，**服务端实际服务哪个版本只有响应里的 `model` 字段能回答**
——每次测量都要记下它（`renderJevSummary` 会打印），否则事后无法判断数字属于哪版模型。
2026-09-26 曾出现约 5 分钟的 `403 RBAC: access denied`（凭证文件完好，随后自愈）：环境本身会变，
只记「能跑通」不够。

**Jev 快在哪里、不快在哪里**：省的是**决策往返**（Jev 决策请求 0.35–0.52s/次 vs 大模型 1.6–4.5s/次）
和**每步退出浏览器上下文**的开销。引擎自身也已重构（详见仓库 `PORT-REPORT.md`）：观测改成一次
`page.evaluate` 自建 DOM 元素表（约 2–4ms，替代 110–130ms 的 `page.snapshot()`），动作改成**裸 CDP
`Input.dispatchMouseEvent`**（13–16ms，替代 788–1005ms 的 `page.click`），等待改成可观察条件。
HN 两步导航端到端因此从 4569ms 降到 1675ms。目标能用选择器写死时，直接写代码仍比两者都快。

**凭证**：`ego-browser nodejs` 内嵌运行时只继承最小化登录环境（HOME/PATH 等），shell 里
export 的变量不会传进去，所以凭证只能来自文件。查找顺序：
`--api-key` > `TYPESAFE_API_KEY`（仅普通 node 进程可见）> `TYPESAFE_API_KEY_FILE` >
`~/.config/ego-decision-layer/credentials` > `~/.config/typesafe/api_key` > rc 文件（`~/.zshrc`/`~/.bashrc`/
`~/.bash_profile`/`~/.profile`）里的 `export TYPESAFE_API_KEY=…`。所以已经 export 过 key 的机器
不必再落盘一次。`~/.config/typesafe/api_key` 仍是「一行裸 Key」的既有形态（权限 600）；
文件都找不到时 CLI 直接报错 exit 3。后端地址 `TYPESAFE_BASE_URL` 可覆盖，主后端失败时的
降级端点 `TYPESAFE_FALLBACK_BASE_URL`（不设即不降级，`fallback: false` 可关）；**这两个变量由
CLI 在父进程读取后写进配置传给子进程**（ego 运行时自身读不到自定义环境变量），直接写
`ego-browser nodejs` 脚本时用 `options.baseUrl` / `options.fallbackBaseUrl`。

**没凭证也能先自测**：`ego-browser nodejs < bench/test-offline-e2e.mjs` 在 `about:blank` 上注入 DOM，
用 `options.ask` 注入确定性判定器（不联网、不需要 key），但观测、`locate`、裸 CDP 派发、真实 DOM 断言
全走真实路径，并断言整个用例一次 `fetch` 都没发。判定器注入契约：`options.ask(state, questions, options)`，
与引擎自己的 `askJev` 同签名；默认仍走 TypeSafe。

**决策后端可换**：契约形如 `decide({ state, questions, options }) → { answers, meta }`；默认 System One
（语义不变），配置 `~/.config/ego-decision-layer/decider.json` 可切到本地 OpenAI 兼容端点
（`kind: "openai-compatible"`），CLI 用 `--decider` / `--base-url` / `--model` 覆盖。本地文本模型
没有校准置信度（`capabilities.confidence: false`），引擎跳过置信度阈值升级但保留全部执行层护栏
（陈旧 / `guardRejected` / 跨 frame fail-closed / 危险动作拦截 / 候选合法性校验）；细节见 README。

**决策结构**（对齐 [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) 的
dynamic operation + target）：每次观测产出「索引化元素表」，每个可交互元素一个 `ref`，并携带
当前值；一次请求同时问 **operation** 和各操作的 **target**（推测性问题，彼此不可见）；
每个 target 头只列出与它兼容的元素，executor 只消费命中操作对应的那个头。

```
ref=2 | textbox | "Query Field" | 当前值="hello world"
ref=4 | checkbox | "Subscribe Newsletter" | 未勾选
ref=6 | combobox | "Country Select" | 当前值="Japan" | 选项=[Switzerland|Japan|Germany]
ref=10 | anchor | "Next Page" | /next

operation: click / type_text / type_text_submit / select / scroll_up / scroll_down / wait / done / blocked
           └─ 只列出当前页面受支持的操作
click_target      ← 只含可点元素（按钮/链接/复选框，不含输入框与原生下拉）
type_text_target  ← 只含可输入元素（textbox/searchbox/textarea）
select_target     ← 原生下拉，候选写成 元素#选项序号（如 ref=6#2）
```

`done` / `blocked` 就是 operation 之一，不另设概率阈值；复选框/单选不会被当成可编辑元素。
原生下拉的选项索引与勾选态快照不暴露，由引擎额外做**一次**批量页面调用补齐。

1. **终端一行命令直接驱动**（在任何项目与路径下可用）：

```bash
# 简单目标
ego-decision-layer --url "https://example.com" "点击登录按钮并聚焦输入框"

# 需要输入文本：候选由调用方给，Jev 只负责选字段和选哪段文本
ego-decision-layer --url "https://en.wikipedia.org/wiki/Main_Page" --text "Jev" \
  --until "/wiki/Jev" "在页面顶部的搜索框中输入并提交搜索"

# 让模型自己写文本（已配置好，无需 --text）
ego-decision-layer --url "https://en.wikipedia.org/wiki/Main_Page" "在维基百科搜索框里搜索哥德尔不完备定理"

# 复用已有 space，并在完成后保留 space 供人工检查
ego-decision-layer --space 3 --keep-space --steps 15 "点击未发送帖子并保存"
```

`--until <substr>` 给确定性退出条件（URL 包含该子串即判成功），比依赖 Jev 自评 `done` 可靠得多，
强烈建议带上。退出码 0 表示成功，1 表示未达成目标（此时 space 会被保留供排查）。

#### 文本生成配置（`~/.config/typesafe/text_model.json`，当前指向 opencode-go）

```json
{
  "baseUrl": "https://opencode.ai/zen/go/v1",
  "apiKeyJson": { "file": "~/.pi/agent/auth.json", "path": "opencode-go.key" },
  "model": "deepseek-v4.1-flash",
  "sessionHeader": "x-opencode-session",
  "sessionId": "ego-decision-layer",
  "userAgent": "ego-decision-layer/1.0",
  "headers": { "x-opencode-client": "ego-decision-layer" }
}
```

- `apiKeyJson` **引用已有凭证文件**而非复制密钥；也可直接写 `apiKey`。
- `opencode-go` 必须带 `x-opencode-session`（稳定会话 id，用于路由与提示缓存），
  缺它直接 400 `MissingSessionID`。
- 实测 `deepseek-v4.1-flash` 会输出 `reasoning_content`，**`reasoning:{enabled:false}` 无效**，
  生成耗时 1.3–1.9s；答案在 `content` 字段，引擎只读它。带生成的整步约 3.8s。

2. **在任何 `ego-browser nodejs` 脚本中导入复用**：

```js
import { runJevAutonomousLoop } from "<本技能目录>/scripts/decider-loop.mjs";

// Jev 在当前页面自主连续操作，直到 check 通过或 Jev 判定 done
const result = await runJevAutonomousLoop(page, "依次打开 new 页面，再打开 comments 页面", {
  maxSteps: 8,
  text: ["Jev"],                                              // 可填文本候选（可选）
  check: async (p) => (await p.url()).includes("/newcomments"), // 确定性成功条件（推荐）
});
console.log(result); // { success, reason, steps, history }
```

配套导出：`askJev(state, questions, options)` 做单次判断、`parseActionTargets(snapshot)`
把快照解析成元素表（含 kind/当前值）、`enrichTargets(page, targets)` 一次批量调用补齐下拉选项与
勾选态、`buildQuestions(targets, { texts, hasTextSource })` 组装操作/目标问题、
`buildActionMenu()` / `extractCandidateRefs()` 构建动作菜单与提取候选目标、
`validateChoice(response, questions)` 响应校验（拒收非 argmax 或概率和不一致的响应）、
`generateText(input, options)` / `loadTextModelConfig()` 文本生成、`runJevStep(page, goal, options)` 走一步。

### 边界（实测）

> **滚动密集站点（含 X）：本文件此前写它们“不可用”，那条警告已作废**——它依据的 0/15 是用有缺陷的
> harness 测出来的（锚点在**一次**页面加载里测量、任务却在**另一次**加载里跑；X 时间线每次加载内容都变，
> 锚点帖往往已不存在，引擎再强也点不中。见 `bench/reveal-tasks.js:137` 与 `:181`）。
> 有效的配对测量（4 任务 × 2 引擎 × 6 轮，详见 `BH-PORT-REPORT.md`）：
>
> | 场景 | 改动前 | 改动后 |
> | --- | --- | --- |
> | X 上必须连滚 >3 次的深帖任务（`x-far`） | **0/6**（6 次全 `stuck`） | **6/6** |
> | X 合计（已剔除“锚点找不到”的不可测轮） | 14/20 | 18/18 |
>
> 机制：**滚动若真的移动了视口、或露出新元素，就算作进展**（移植自 browser-harness 的 `fingerprint()` 思路；本项目**不依赖**它）；
> 到页面边界仍会停，`maxSteps` 仍是硬上限。**emoji 截断已修**（按码点截断 + 请求前清理孤立代理，
> X 上 34 次运行 0 次 Jev 400）。
>
> 仍然成立的两条限制：
> - **「有界滚动揭示」在真实站点几乎不触发**（它只在“选了需要目标的动作却解析不出目标”时生效；
>   真实长列表里 Jev 会自己滚或点相似链接）——但它已不是必需品，滚动本身现在能推进目标。
> - Jev 若在页面边界反复交替上/下滚，仍可能跑到 `maxSteps`（有界，但不优雅；实测未遇到）。

- **新建标签页视口 0×0 是宿主常态（本机实测，不是异常）**：本机 ego lite 0.5.1.13 上，
  `taskSpace` 新建的标签页在**未导航 / `goto(domcontentloaded)` 之后 / `load` 之后**读到的
  `window.innerWidth/innerHeight` **全是 0×0**，`page.info()` 也拿不到尺寸；覆盖是
  **per-space / per-page** 的，**紧接着新开的 space 仍是 0×0**（不会跨运行生效）。元素表按
  **视口可见性**构建（既有设计，不是 bug），0×0 时恒为空 → 不处理就是每轮 `no_targets` + 700ms
  等待，**白烧步数且一次模型都没问**（决策 0ms），用户还看不出原因。所以**默认行为是自动撑起**：
  循环入口读一次视口（`page.evaluate`，不新增 CDP），任一为 0 时自动
  `Emulation.setDeviceMetricsOverride { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }`
  并打印一行说明，然后照常跑；**视口本来正常时不做任何覆盖调用**（零额外 CDP）。
  `--force-viewport <宽x高>[@缩放]`（库 `options.forceViewport`）指定尺寸（优先于自动值）；
  `--no-force-viewport`（库 `options.strictViewport: true`）才回到「退化直接失败」；
  **只有自动撑起也失败**（CDP 报错）或显式 strict 时才以 `viewport_degraded` 失败
  （`steps: 0`、不派发、不问模型）。退出时按需用 `Emulation.clearDeviceMetricsOverride` 清理
  （保留了 space / 页面时不清理），**清理结果如实报告（不谎报“已清除”）**：本机 0.5.1.13 实测，
  同进程调过 `clearDeviceMetricsOverride` 之后 `innerWidth/innerHeight` 仍显示覆盖值。
  **来源**：0×0 常态与症状由另一个 Agent harness（Hermes Agent）在本机真实运行中发现；
  0.4.2 曾把它当异常硬失败（在本机正常路径上就是回归），0.4.3 改回默认自动撑起。
- Jev 只发一次并行判断、**无跨请求记忆**：复合目标（A 然后 B）依赖引擎回填的「已完成步骤」，
  已内置并已验证（两步导航、已填字段改写、下拉改选、勾选均通过）。更长链路未做专项评估。
- 元素表由**一次 `page.evaluate` 在页面内自建**（默认 `maxTargets` 60 项、可见文本 `maxText` 2500
  字符），元素每次观测都会**重新编号**。候选分两遍收集：原生交互标签与 `role=…`（a11y 类，
  **优先占预算**）先收；再把**无 role 的容器型可点元素**（`<div onclick>`、`tabindex`、
  `cursor:pointer` 块级容器）补成 `clickable-region`（映射到 `kind: clickable`，自动进入同一套
  点击决策）。去重：节点身份 + 祖先去重（嵌套容器只收最内层）；被占满的容器（内含 a11y 元素
  且占了它一半以上面积）、`<a href>` 里的容器、`<label for>` 都不与 a11y 元素双收。
  观测根除主文档外还包括**同源 iframe 文档与开放的 shadow root**；frame 内目标打 `frameOrigin` 标，
  `locate` 对它们做**逐层命中校验**：每层把点换算到该层坐标系（含 `clientLeft/clientTop`），
  断言该层 `elementFromPoint` **严格命中承载下一层的 `<iframe>` 自身**（iframe 没有可命中的后代）；
  任一层不成立即 `covered`，不派发。命中测试在元素**自己的 root** 里做（frame 内也可能有 shadow root）。
  任何一层解析不了（`defaultView` 为 null / frame 链断）记 `frame_unresolved`；frame 元素到其所在文档根的
  **祖先链**上只要有非 identity 的 2D 线性变换（scale/rotate/skew）或 `zoom !== 1` 记 `frame_transformed`
  （纯平移、`translateZ(0)` 这类只影响合成的写法放行），两者都直接拒绝（不猜坐标、不退化成 {0,0}）；
  同时校验元素没被 frame 自身视口裁掉（`offscreen`），并跳过跨 frame 滚不动的 `scrollIntoView`。
  跨域 iframe 不处理。
  定位不交给选择器：引擎掌握节点身份，动作走裸 CDP
  （`Input.dispatchMouseEvent`）。两层陈旧防护：① **陈旧校验**：只执行与本次元素表一致的 `ref`，
  不一致记为 `staleTarget` 跳过；② **执行前守卫**：命中测试 + 可见/可用性检查，失败记为
  `guardRejected`（原因有 `node_gone`/`disconnected`/`disabled`/`invisible`/`readonly`/
  `offscreen`/`covered`/`not_select`/`option_unavailable`/`dangerous_action`/
  `frame_unresolved`/`frame_transformed`）。
  `dangerous_action` 是**危险动作前置拦截**：目标名称/选项命中「支付/删除/退订」词表（我们自己的
  中文 + 英文词表）时**不执行**并直接停（不重试）；`options.dangerGuard === false` 可整体关闭。
- **视口外目标（有界滚动揭示）**：元素表只覆盖当前视口，目标可能在下方。当某步“选了需目标的
  动作却没解析出目标”（或元素表为空）时，引擎会**滚动约一屏后重新观测**（默认最多 4 次，
  `maxReveals` 可调），并在候选多于预算时**优先列出本次尚未展示过的元素**，因此滚动总能露出
  下一批而不是反复只看同一批。**`maxTargets` 默认值不变**（元素表大小不变，载荷不增长）。
  滚动到边界、或滚动后没有带来任何新元素时立即停止，并把该次计入 `no_progress`。
- **文本来源**三选一：`--text` 候选（Jev 从中选，优先）→ `~/.config/typesafe/text_model.json`
  的模型（**当前已配置为 opencode zen / `minimax-m3`**；严格只接受恰好一个非空 `text`
  字段的 JSON，不合格则判 `text_model_failed` 而不是猜值）→ 都没有时不提供输入操作。
  可用 `textModel: null` 显式禁用，或传自定义 `async (input) => string` 函数接入其他模型。
- 由模型生成的文本会让落地 URL 不可预测（中文搜索词会被编码），这类任务不要指望 `--until`，
  靠 `jev_done` 或 `check` 判成功。
- **`viewport_degraded`（宿主视口 0×0）**：视口退化（0×0）**且**自动撑起失败（`Emulation.setDeviceMetricsOverride` 报错），
  或显式 `--no-force-viewport` / `options.strictViewport` 要求直接失败时返回：`steps: 0`、不派发任何动作、不问模型。
  **默认**在 0×0 时会自动撑起 1280×900 后照常跑（视口正常时零额外 CDP），不报此因。
- 退出条件。成功：`check_passed` / `check_passed_after_step`（`check` 通过，推荐）或 `jev_done`
  （Jev 判定完成）。失败：`viewport_degraded`（视口 0×0 **且**自动撑起失败或显式 strict，**未执行任何动作**；
  默认会自动撑起 1280×900 后照常跑，不报此因）、`no_progress`（连续 5 次变更类动作页面无变化）、`stuck`（同一动作连续
  3 次无变化，含反复滚动）、`target_missing`（选了需目标的动作却没解析出目标，**且已用完有界滚动
  揭示额度**，连续 2 次）、
  `no_targets`（连续 3 次元素表为空）、`guard_rejected`（执行前守卫拒绝，决策已陈旧或元素不可用，
  该步未执行）、`invalid_response`（Jev 响应校验不通过，未执行）、`blocked`、`text_model_failed`、
  `no_text_source`、`action_failed`、`max_steps_reached`。
  失败时先看 `result.reason` 再决定是否重试；`guard_rejected` 与 `target_missing` 表示**什么都没执行**，重试前需要重新观测。
- `blocked` 由 Jev 判断（验证码/登录墙/无可用推进手段/反复无进展）。合成拦截页已验证：
  纯拦截页首步即判 `blocked`，登录墙试一次后判 `blocked`。**真实**验证码站未测。
- 比较「页面是否变化」时忽略 URL 的 `#hash`：点锚点链接不算有进展。
- 每步浏览器调用：默认 **1 次 `page.evaluate`**（在页面内自建元素表）+ url/title；
  `page.snapshot()` 仅在显式 `observe: "snapshot"` 时使用。实测（HN 首页）：自建元素表约
  **2–4ms / ~2k 字符**（其中容器型可点元素扫描约 1–2ms），`page.snapshot()` **110–130ms / 27484 字符**。
- 下面两条关于「快照」的实测限制（下拉选项、复选框覆盖）适用于 `observe: "snapshot"` 这条旧路径。
- 真实站点实测：原生下拉能读到全选项（wikipedia.org 语言选择器 77 项，1 步改选成功）。
  DuckDuckGo 设置页 DOM 有 18 个复选框：默认自建元素表路径 18 个全部覆盖（视口内 5 个，
  拉高视口后 18 个），而 `observe: "snapshot"` 路径仍是 0 个（1×1 的自定义样式 input 不进辅助树）。
  无 role 的容器型可点元素实测 YouTube 首页 3 个、X 首页 5 个；真实 Jev 能选中它
  （YouTube 视频元数据块 → `/watch`，见 `bench/test-realjev-region.mjs`）。
  httpbin 表单的复选框在快照里既无 loc 也无名称，靠「文档顺序」
  兜底补齐名称与勾选态；仅当数量完全一致时才敢用，否则显示「勾选态未知」而不会谎报。
- 动作后不用固定延迟：先短静默，再用 `waitForLoadState("load")` 兜底捕捉**延迟导航**
  （实测下拉改选触发的跳转会晚于 400ms，若只用固定延迟会把“已跳转”误判成“未变化”，
  导致 Jev 重复执行同一动作）。
- **原生下拉的「选中项不在当前 options 里」有了一次重问**：观测时选中的 option 到执行时可能
  已经不在 DOM 的 options 里（选项被 JS 重建/重排）。旧实现把它当失败/无进展，最后 `stuck`；
  现在改为**一次**带新选项的重问（`maxOptionRetries` 默认 1），重问仍失败才显式报 `stuck`。
- **旧的「维基语言选择器」基线元素已变**：`www.wikipedia.org` 上那个 77 项的 `#searchLanguage`
  现在是 `opacity:0`（被自定义语言列表 UI 取代），引擎按可见性规则跳过它——「约 2/3 成功」
  那条基线已无法在原元素上复现。同类「原生下拉改选」任务在 DuckDuckGo 设置页（语言下拉 80 项、
  含 Dansk）实测 **6/6**（`bench/test-native-select.mjs`）。
- Jev 走完不等于业务正确：仍要按本 Skill 的观察纪律复核最终页面状态。
- 该站可能开启自动翻译（实测 Chrome 把注入的英文表单译成中文，`Switzerland`→`瑞士`），
  元素名与选项名可能与目标语言不一致；Jev 跨语言选择正常，但用**字符串比较**做 `--until` 或
  `check` 会误判，请改用 URL 路径或 DOM 状态。

## ego 内嵌运行时的两条静默失败限制（实测）

写 `ego-browser nodejs` 脚本时踩过，两条都是**无声失败**，排查很坑：

1. **静态 import 内置模块会让整个脚本无声退出**：`import { createServer } from "node:http"`
   不报错、无输出、exit 0。**必须用 `await import("node:http")`**。
   本地文件与引擎同理，用 `await import("/绝对/路径.mjs")`。
2. **运行时不能起服务、也不能访问 loopback**：`server.listen()` 的回调永不触发；
   `fetch("http://127.0.0.1:…")` 会挂起后 exit 0。外部 HTTPS `fetch()` 正常。
   要测本地代码，把服务起在 ego 之外，用普通 node 进程去测。

配套的两条环境事实：

- **自定义环境变量一律不传入**（不止 `TYPESAFE_API_KEY`）：`export FOO=bar` 在运行时里读不到。
  需要传配置时，在**父进程把值替换进脚本文本**再送进去（`ego-decision-layer` CLI 就是这么传 goal/url 等配置的）；
  凭证走上面的文件链，不靠环境变量。
- **`process.cwd()` 是 `/`**，不是 shell 的工作目录。脚本里不要依赖相对路径。

## 不要改应用包里的文件

有需要时不要在
`/Applications/ego lite.app/Contents/Frameworks/ego Framework.framework/Versions/*/Resources/ego-skills/ego-browser/SKILL.md`
里加内容：那是供应商受签名的应用包，升级会替换该目录（`Versions/0.5.0.32` → 新版本号），
改动会丢失。要扩展就放到包外的 `~/.agents/skills/<自己的技能>/`。

想改的其实是「官方技能开头那段路由」时，也别去改包内文件：用 `scripts/wire-agent-skills.sh`
接管包外的 `…/skills/ego-browser` 入口（路由层 + 软链回包内正文），`--restore` 可撤销。
