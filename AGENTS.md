# AGENTS.md

给安装、验证、或修改本仓库的 AI Agent 看的说明。

## 这是什么

`ego-decision-layer` 用 [TypeSafe](https://docs.typesafe.ai) 的 System One 模型 **Jev** 替代浏览器自动化里
「每步回到大模型思考」的往返：输入一张**索引化元素表**，一次请求返回**操作 + 目标元素**，
观察/执行/校验/退出条件都由代码负责。

它建立在 [ego lite](https://github.com/citrolabs/ego-lite)（`ego-browser`）之上，是**外挂**，
**从不修改 ego lite 应用包**。

## 安装

```bash
npx skills add jiangkoumo/ego-decision-layer      # 推荐，一行装进 Agent 技能目录（含引擎与 CLI）
# 或：git clone https://github.com/jiangkoumo/ego-decision-layer.git && cd ego-decision-layer && ./install.sh --test
```

## 装完必须验证（别只看代码，跑起来）

```bash
ego-browser --version                                   # 前置条件
test -f ~/.config/typesafe/api_key && echo "key ok"     # 凭证存在
"<技能目录>/scripts/ego-decision-layer" \
  --url "https://en.wikipedia.org/wiki/Main_Page" \
  --text "Jev" --until "/wiki/Jev" --steps 5 \
  "type Jev into the search box and submit"

# 接管过官方 ego-browser 入口的话，确认它还生效：
bash "<技能目录>/scripts/wire-agent-skills.sh" --check   # 期望 exit 0
```

期望：**exit 0** 且输出含 `"success": true`。退出码：`0` 达成 / `1` 未达成（space 保留供排查）
/ `2` 参数错误 / `3` 缺凭证。

## 硬约束

- **不要写 ego lite 应用包**（`/Applications/ego lite.app/…`）：供应商受签名，升级会替换
  `Resources/ego-skills/`，改动必然丢失。扩展只放包外。
- **接管官方入口只能在包外**：ego lite 会把官方 `ego-browser` 技能写进每个 Agent 的技能目录
  （`~/.agents/skills/ego-browser` 等），并在升级时重建。要加路由就改包外那一层，
  用 `scripts/wire-agent-skills.sh`（幂等、可 `--restore`），别改包内 SKILL.md。
- **凭证必须落盘成文件**：`ego-browser nodejs` 内嵌运行时只继承最小化登录环境，
  `TYPESAFE_API_KEY` 之类的**自定义环境变量不会传进去**。查找链：`--api-key` > 环境变量 >
  `TYPESAFE_API_KEY_FILE` > `~/.config/ego-decision-layer/credentials` > `~/.config/typesafe/api_key` >
  rc 文件里的 `export TYPESAFE_API_KEY=…`。后端地址 `TYPESAFE_BASE_URL` 可覆盖，主后端失败时的
  降级端点 `TYPESAFE_FALLBACK_BASE_URL`（不设即不降级）；**这两个后端变量由 CLI 在父进程读取后写进
  配置传给子进程**（ego 运行时读不到自定义环境变量）。
- 不要提交任何密钥；文本模型配置可用 `apiKeyJson` 按路径引用已有凭证，不要复制。
- 保持可被 `npx skills add` 安装：`SKILL.md` 必须在仓库根，且只用相对路径引用 `scripts/…`。

## 运行时事实（实测踩过的坑，能省你很多时间）

| 行为 | 详情 |
| --- | --- |
| 静态 import 内置模块会静默杀死脚本 | `import { x } from "node:http"` → 无输出、exit 0。必须 `await import("node:…")` |
| 不能起服务、不能访问 loopback | `server.listen()` 回调不触发；`fetch("http://127.0.0.1:…")` 挂起后 exit 0；外部 HTTPS 正常 |
| `process.cwd()` 是 `/` | 脚本里不要依赖相对路径 |
| 自定义环境变量被剥离 | 传配置要在父进程把值替换进脚本文本 |
| `loc` 里可能含 `]` | 属性要从第一个 `[` 解析到**最后一个** `]`，否则 `input[name="a"]` 会被截断 |
| 勾选态不在快照里 | 用一次批量 `page.evaluate()` 读；DOM 与快照数量不一致时报告「未知」，不许猜 |
| 浏览器开着自动翻译 | 元素名/选项名可能被翻译；`--until` 不许比较 UI 字符串，比 URL 路径或 DOM 状态 |

## 仓库结构

```
SKILL.md                 技能本体（刻意放根目录，`npx skills add` 就是找它）
scripts/decider-loop.mjs  引擎
scripts/ego-decision-layer CLI（自动在 同目录 / 仓库根 / ~/.agents/lib 里找引擎）
scripts/wire-agent-skills.sh  把官方 ego-browser 入口接管成路由层（幂等，可 --check / --restore）
overlay/ego-browser/     路由层模板（渲染到 Agent 技能目录，不是装进应用包）
examples/bench/          A/B 对照基准（Jev 闭环 vs 每步大模型循环）
install.sh               手工安装（接 CLI 进 PATH + 准备凭证；`--wire` 顺便接管入口）
update.sh                一键更新（接管过则自动重接管）
CHANGELOG.md             版本历史（顶部条目必须与 SKILL.md 的 metadata.version 一致）
.claude-plugin/          Claude Code 插件元数据（plugin.json / marketplace.json）
skills/ego-decision-layer/  插件技能目录（SKILL.md / scripts / overlay 是指向仓库根的相对软链）
docs/                    demo 素材与重做脚本（banner.svg / demo.gif / capture-demo.mjs …）
```

## 开发协作与范围

以下约定借鉴自 `pi-pstack` 的 `AGENTS.md`，按本仓库的技能、CLI 和浏览器引擎适配。

- 开工先读 `README.md`、`SKILL.md` 与涉及模块；涉及规划时再读 `ROADMAP.md`。
  当前能力以实现与实际验证为准，不能把规划、历史报告或本机配置写成所有用户已具备的功能。
- 优先做可审阅、可验证的最小改动；不顺带重构无关模块，不碰用户或其他 agent 的改动。
- 调用 ego-browser、TypeSafe 或其他外部接口前，按实际使用版本核对文档与示例；
  发布代码依赖公开契约，诊断探针里的内部路径不能直接变成运行依赖。
- 本机浏览器、技能目录、模型与凭证配置属于环境适配；新增能力必须说明前置条件，
  模型配置可覆盖，不能假设其他用户拥有相同环境。
- 引入或适配第三方代码时固定来源 revision，保留作者与许可声明，并在 `THIRD-PARTY.md`
  记录来源、涉及范围与适配；不静默跟随上游默认分支。
- 同一工作目录或 worktree 同时只有一个 writer；reviewer 只读。交接写清目标、允许修改的路径、
  禁止事项、已批准决定、验收证据与遇阻时联系的主控。

## 检查与交付

- 开始实现前跑受影响模块的最相关检查，记录基线；完成后按下方「开发约定」重跑必需的专项检查。
  修 bug 优先补能在修复前失败、修复后通过的回归测试；新行为补有意义的行为测试，
  不为低影响的可逆修改新增只复述实现的测试。
- 不让语法检查、构建、模块加载或 mock 通过冒充真实行为验证；宣称支持浏览器工作流时，
  用真实任务核对最终 URL 或 DOM 状态。缺网络、凭证、浏览器而 SKIP 的检查单独列出。
- 文档修改核对相对链接、来源、状态描述与 diff；纯文字修改无需新增实现测试，
  也无需运行未受影响的浏览器冒烟或性能基准。
- 修改源文件后用现有生成流程更新生成物；接管层改 `overlay/ego-browser/` 与生成脚本，
  插件技能正文改根目录 `SKILL.md`，不直接修安装目录的生成正文或复制软链目标。
- 安装、更新、接管测试优先用临时 HOME、临时技能目录或测试支持的隔离配置；
  不修改用户现有全局配置来证明安装成功。下方要求的真机 `--check` 保持只读。
- 同一个失败经两轮修复仍未通过时，停止继续修改该问题，报告命令、退出码、失败证据与已尝试方案；
  不通过删测试、放宽断言或隐瞒 SKIP 消除失败。
- 交付前跑 `git diff --check` 并审阅 diff；commit 前用 `git status --short` 核对不包含无关文件。
- 全局安装、写入用户 Agent 配置、发布、合并、rebase、推送、删除 worktree 或分支、
  丢弃未提交改动，必须已有用户明确授权；要求先展示再批准时，先给出可审阅结果。
- 交付记录四项：已完成、实际验证结果（命令与退出码或只读检查依据）、未完成、具体阻碍。

## 子 agent 与并行开发

通用规则见全局 `~/.pi/agent/AGENTS.md`「子 agent 与并行开发」。本仓库补充：

- 源文件与其生成物不能拆给不同任务；共享文件还包括版本元数据（版本号要和 CHANGELOG 等保持一致），留给主控。
- 子 agent 开工前跑受影响模块的检查记下基线，完成后按「开发约定」重跑必需的专项检查。
- 子 agent 报告里分别列出测试通过、失败、SKIP，以及真实浏览器任务的验证结果。
- 主控汇总时再附上每个分支的 `git diff main...<分支> --stat`。

## 开发约定

- 引擎改动在 `scripts/decider-loop.mjs`，保持导出稳定：`askJev`、`parseActionTargets`、`enrichTargets`、
  `buildQuestions`、`runJevStep`、`runJevAutonomousLoop`、`generateText`、`loadTextModelConfig`、
  `resolveTextApiKey`、`loadApiKey`。
- 改完引擎要重跑上面的冒烟测试**和** `./examples/bench/run-pair.sh A`。
- 改 `observeDom` 的元素收集（候选选择器、去重、预算）要重跑 `bench/test-clickable-regions.mjs`
  （离线、无需凭证）与 `bench/test-ddg-toggles.mjs`（需网络，复现 DuckDuckGo 那条旧限制）。
- 改 `clickable-region` 的 role 词元或候选行格式要重跑 `bench/test-realjev-region.mjs`：它用**真实 Jev**
  验证 Jev 能选中该词元（需网络 + 凭证，缺一 SKIP 且不伪装通过）。
- 改 `observeDom` 的观测根（iframe / shadow 遍历）或 `locateForInput` 的命中测试要重跑
  `bench/test-frame-targets.mjs`（离线，覆盖 frame fill/click、shadow fill/click 与 covered 对照）。
- 改判定器调用点 / `options.ask` 契约 / 分阶段耗时或 `renderJevSummary` 要重跑
  `bench/test-offline-e2e.mjs`（离线、无需凭证：注入 ask，但观测 + 裸 CDP 派发 + 真实 DOM 断言全走真实路径，
  并断言整个用例不碰网络）。
- 改凭证查找链 / `loadApiKey` / `readCredential` 要重跑 `node bench/test-credential-chain.mjs`；
  改后端地址或降级路径要重跑 `node bench/test-backend-fallback.mjs`（两者都无需浏览器/网络）。
- 改危险动作词表或 `assessDanger` 要重跑 `node bench/test-guardrails.mjs`（[6]/[7] 段覆盖）。
- 改 `select` 执行分支 / `optionStale` / `maxOptionRetries` 要重跑 `node bench/test-select-reask.mjs`
  （离线）；真实站点成功率测量用 `bench/test-native-select.mjs`（需网络 + 凭证，缺一 SKIP）。
- 改 `scripts/wire-agent-skills.sh` / `overlay/` / `install.sh` 要重跑 `node bench/test-wire-skill.mjs`
  与 `node bench/test-route-trace.mjs`（都用临时 HOME 造官方软链，无需浏览器与凭证），
  并在真机上 `bash scripts/wire-agent-skills.sh --check` 一次。
- `scripts/ego-decision-layer` 启动时会调 `wire-agent-skills.sh --ensure`：已启用则静默刷新；未启用但检测到官方
  入口则首跑接管一次并打印一行；两者都不是则什么都不做（`EGO_JEV_NO_WIRE=1`，旧名 `EGO_JEV_NO_HEAL=1`）。
  这步不得改变任务退出码；改这块要重跑同一个单测（[29]/[32] 段覆盖）。
- **always-on 块只在显式 `--always-on <file>` 时写入**：默认安装/运行不写任何用户文件。
  `--check` 必须保持只读（不写启用标记、不改 mtime）；`--restore` 要同时清掉接管层与 always-on 块。
- 接管脚本要兼容 macOS 自带的 bash 3.2（没有 `local -n`、关联数组、`mapfile`）。
- 生成物必须确定性（不能写时间戳/随机数），否则 `--check` 会永远报漂移。
- **版本号只有一个来源**：`SKILL.md` 的 frontmatter `metadata.version`；`CHANGELOG.md` 顶部条目、
  `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json` 必须与它一致。改版本后跑
  `node bench/test-release-consistency.mjs`（纯 node，无需浏览器/凭证）。
- **demo 素材必须由真实运行产生**（不许手绘界面）：录帧用
  `sed "s|__REPO__|$PWD|g" docs/capture-demo.mjs | ego-browser nodejs`，再按 `docs/README.md`
  里的 ffmpeg 命令合成 GIF/MP4，社交预览图用 `docs/make-social-preview.mjs`。
- 插件技能目录 `skills/ego-decision-layer/` 里只放**指向仓库根**的相对软链，不复制 SKILL.md 正文
  （正文只有仓库根一份，软链保证 clone 后可用）。
- 接管层只在 Agent 技能目录里写：`SKILL.md` 是生成的，`references/`、`scripts/`、`learnings/`
  是软链——不要把正文拷进去（会跟 App 版本脱节）。
- 只用真实命令输出和退出码宣称完成；不确定就明说哪一步失败。
- 基准的 B 臂（browser-harness + jev-ultrafast）的驱动脚本已撤出仓库（引擎已移植进 `scripts/decider-loop.mjs`），
  报告里的 B 栈数字由 `bench/raw/` 原始数据复算，旧脚本在 git 历史里。改 benchmark 后跑
  `node bench/test-no-bh-dependency.mjs`（不变量：可执行脚本里不许出现 browser-harness 调用面）。
- 报基准数字必须带上产生它的脚本。
