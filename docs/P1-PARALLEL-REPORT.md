# P1 并行开发与主控验收记录

状态：用户已批准合并与推送。三个子任务和主控 CLI 已依次合入本地 `main`（集成合并提交 `7ee3307`），从第二个分支起均先 rebase 并重跑检查。版本仍为 0.10.0，未创建新标签或 Release。推送结果以远端分支与本报告提交的包含关系核对。

## 已完成

用户批准 Issue #8 / #9 / #10 后，通过 Herdr 独立 worktree 和可见 pane 并行开发，子模型均为 `magpie/opendesign/deepseek-v4-flash`。共同基线是远端 `origin/main` 的 `e468266`；主控本地 `main` 的 `7705165` 另含协作规则，两个基线之间的文件差异仅为 `AGENTS.md`。

| Issue / 分支 | pane / worktree | 本地提交 | 相对 main 的 diff stat |
| --- | --- | --- | --- |
| [#8](https://github.com/jiangkoumo/ego-decision-layer/issues/8) `feat/8-cdp-host` | `w1Z:p1` / `~/.herdr/worktrees/ego-decision-layer/feat-8-cdp-host` | `c0bb884`、`dae5649` | 4 files、2738 insertions |
| [#9](https://github.com/jiangkoumo/ego-decision-layer/issues/9) `feat/9-cdp-runner` | `w10:p1` / `~/.herdr/worktrees/ego-decision-layer/feat-9-cdp-runner` | `cdc8d32`、`27c79e1` | 3 files、1774 insertions |
| [#10](https://github.com/jiangkoumo/ego-decision-layer/issues/10) `test/10-dual-host-acceptance` | `w21:p1` / `~/.herdr/worktrees/ego-decision-layer/test-10-dual-host-acceptance` | `b585560` | 5 files、1325 insertions |

`git log main..<分支> --oneline` 另包含共有的 `e468266 Merge pull request #7 ...`，因为主控 main 与远端 main 在相同代码上分别包含不同历史。新增业务提交如上表。

- #8：普通 Node 22+、原生 WebSocket、外部 Chrome CDP；仅创建自有 target。实现引擎默认 DOM 路径及 `goto`，明确拒绝 ego snapshot/ref 专有方法。取消后停止新操作，清理仍可用。
- #9：独立 `node scripts/run-cdp-task.mjs --config <file>`；操作/抽取编排、最终 URL 复核、动作证据与未知结果、取消和连接释放。纯抽取带 `until` 显式拒绝（参数错误），避免条件未验证却报告成功。
- #10：12 个共享受控任务，包含点击、导航、输入、搜索提交、原生下拉、复选框、遮挡、陈旧 ref、危险动作、控制停止、缺文本、批处理。
- 主控：共享 Bash CLI 增加 `--cdp-endpoint`，CDP 路径跳过 ego 二进制检查和自动接管；配置携带解析后引擎路径；新增 CLI 隔离检查、真实跨 worktree 集成检查和中英文说明。

## 实际验证

下列结果由主控在本次会话实际执行。跨 worktree 导入真实模块完成集成，没有复制子任务实现或提前合并。

| 命令 / 运行位置 | 退出码 | 结果 |
| --- | --- | --- |
| `node bench/test-cdp-host.mjs`，#8 worktree 最终提交 | 0 | 167 通过、0 失败、0 SKIP；包含真实 Chrome、导航/输入、取消、页面归属与进程清理 |
| `node bench/test-cdp-runner.mjs`，#9 worktree 最终提交 | 0 | 104 通过、0 失败；1 SKIP 是该 worktree 内缺 #8 文件的真实浏览器项，另由下方跨 worktree 检查完成 |
| `node bench/test-cdp-cli.mjs`，主控仓库 | 0 | 15 项隔离检查；验证真实 Bash 解析和配置传输，任务进程注入，不冒充浏览器验证 |
| `ego-browser nodejs < /tmp/ego-p1-run-ego.mjs` | 0 | 同一引擎的 ego lite 12/12；7 个目标任务、5 个护栏任务，falseSuccess=0；TaskSpace 收尾关闭 |
| `node bench/test-host-integration-live.mjs --suite`，配下方跨 worktree 环境变量 | 0 | 外部 Chrome 12/12、falseSuccess=0；真实 Jev HN、表单、共享 CLI 均 success=true、verified=true；保留无关 target；Chrome PID 40649 确认退出 |
| `node bench/test-route-trace.mjs` | 0 | 62/62 |
| `node bench/test-wire-skill.mjs` | 0 | 171/171，临时 HOME |
| `node bench/test-windows-paths.mjs` | 0 | 36/36 |
| `node bench/test-release-consistency.mjs` | 0 | 20/20；本地尚无 v0.10.0 tag 的既有警告，不作为失败 |
| `node bench/test-no-bh-dependency.mjs` | 0 | 9/9 |
| `bash -n scripts/ego-decision-layer`、`git diff --check` | 0 | 语法与 diff 检查通过 |
| `bash scripts/wire-agent-skills.sh --check`，真机只读 | 1 | 4 个 Agent 入口仍为官方软链，已接管 0 / 无需 2 / 漂移 4；没有改写全局配置来消除该结果 |

真实模型响应为 `jev-1.14.0`。HN 最终 URL 为 `https://news.ycombinator.com/newcomments`；受控表单最终 `/done?q=integration`；共享 CLI 最终 `/done?q=cli-check`。原 ego CLI 的 Wikipedia 冒烟与 HN 导航也实际 exit 0 并命中对应最终 URL。

受控 DOM + 注入判定器仅验证机制一致性，不能当作真实模型或线上站点成功率。费用/token/人工接管指标为未知值。

尚未合并时的真实集成复跑命令：

```bash
EGO_JEV_CDP_HOST="$HOME/.herdr/worktrees/ego-decision-layer/feat-8-cdp-host/scripts/hosts/cdp-host.mjs" \
EGO_CDP_RUNNER="$HOME/.herdr/worktrees/ego-decision-layer/feat-9-cdp-runner/scripts/run-cdp-task.mjs" \
EGO_HOST_ACCEPTANCE_SUITE="$HOME/.herdr/worktrees/ego-decision-layer/test-10-dual-host-acceptance/bench/host-acceptance/suite.mjs" \
node bench/test-host-integration-live.mjs --suite
```

合并后无需这些路径覆盖。Chrome 默认 macOS 标准路径，可通过 `EGO_CDP_CHROME` 覆盖。`--suite --suite-only` 只跑受控任务，不需 Jev 凭证。

## 审阅与未完成

子任务交叉只读审阅后，主控核实并安排原 writer 修复：未知等待状态静默降级、能力推断测试缺口、纯抽取绕过 until、零派发批次误报部分执行、顶层错误/未知结果未聚合。主控自身 CLI 增加 Node 前置诊断与显式引擎路径；真实集成脚本收紧启动失败与临时进程清理。

以下保留为限制或后续工作：

- Wikipedia 在线搜索在外部 Chrome 的 5 步预算下有成功也有失败（缺目标后滚动/展开搜索耗尽预算）。首轮三任务与 CLI 结果均成功，但清理阶段超时，不能把整轮算通过；清理已修，后续两次 Wiki 检查 exit 1。没有继续放宽断言或修改引擎。默认稳定门槛采用 HN 与受控搜索表单，`--wiki` 保留可选复跑。
- `goto` 的目标 loaderId 被另一导航替换时，可能等待到上限；尚未复现，记录而不扩展导航策略。
- CDP 无 snapshot/ref 路径、无 networkidle；只在本机 macOS + Chrome 实测，Windows/Linux 真实 CDP 尚未验证。
- 主控与子 worktree 的发布检查口径不同：#8 报 worktree 目录名导致既有发布一致性检查失败；主控标准仓库位置实际 20/20。未改该既有测试。
- 无版本升级、标签或 Release 操作；不把开发能力写成 v0.10.0 已发布内容。没有新增 MCP、视觉模型或失败升级能力。
- 工具纪律偏差：子代理在早期开发/审阅中曾用 shell grep/head/sed 读取代码，其中 #8 一次 sed -i 写测试；违反当前 Pi 硬门禁。主控已明确纠正，最后修复轮使用 Pi 文件工具，主控独立复跑关键验收。偏差不能因测试通过而消失，本轮流程不能宣称完全符合硬门禁。

## 合并与复验

用户批准「合并推送」后，先合并远端 main 的共同历史，保留本地 AGENTS.md 协作规则，再按顺序集成：

| 分支 | 合并提交 | rebase 后业务提交 |
| --- | --- | --- |
| `feat/8-cdp-host` | `a25a420` | 原 `c0bb884`、`dae5649` 保留 |
| `feat/9-cdp-runner` | `aa674f5` | `bb3585b`、`b2f9c06` |
| `test/10-dual-host-acceptance` | `57877aa` | `12e288b` |
| `feat/p1-cdp-cli-integration` | `7ee3307` | `61134c0` |

本轮实际复验：#8 适配器 167/167（exit 0）、#9 编排 104/104（exit 0，真实浏览器项仍单独 SKIP），#10 rebase 后 ego lite 12/12（exit 0）。完整集成分支不带跨 worktree 环境覆盖运行 `node bench/test-host-integration-live.mjs --suite`，exit 0：CDP 受控 12/12，HN、表单和共享 CLI 均 verified=true，模型 `jev-1.14.0`，临时 Chrome PID 49971 确认退出。CLI 15/15、Windows 路径 36/36、路由 62/62、版本一致性 20/20、无外部依赖检查 9/9 及 Bash 语法/diff 检查均 exit 0。

版本检查本轮未再出现缺少 v0.10.0 tag 的警告；未为此次开发创建新发布。原有已知限制与工具纪律偏差保持上文记录。worktree 与分支保留，没有清理。
