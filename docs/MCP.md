# MCP 入口（`browser_task`）

这是 ROADMAP **P3** 的最小可交付版本：把已经验收过的 P1 独立运行入口
（`scripts/run-cdp-task.mjs`）包一层 stdio MCP server。
观测、决策、执行、护栏、抽取、最终 URL 复核、连接释放**全部仍在 P1 里**，这里只做协议边界，
不复制引擎逻辑，也不改 `scripts/decider-loop.mjs` 的导出。

> 状态：自 v0.11.0 起随版本发布的可选、实验性入口；MCP 依赖只安装在 `mcp/` 下，
> 不属于核心运行时。未在 Windows / Linux 上验证。

## 前置条件

- Node ≥ 22（P1 宿主用 Node 自带的 `WebSocket`）
- 一个启用了 CDP 的外部 Chrome/Chromium
- Jev 凭证（`~/.config/typesafe/api_key` 等现有文件链；默认 Jev 后端）
- `mcp/` 目录下装依赖：`npm --prefix mcp install`（唯一依赖是固定版本的
  `@modelcontextprotocol/sdk`，见 `mcp/package.json`）

## 启动

配置只由**服务端启动者**提供，工具参数不能覆盖：

```bash
npm --prefix mcp install
cat > /tmp/ego-mcp.json <<'JSON'
{ "cdpEndpoint": "http://127.0.0.1:9222", "steps": 10, "forceViewport": "1280x900" }
JSON
node mcp/server.mjs --config /tmp/ego-mcp.json
```

`--config` 支持字段：

| 字段 | 说明 |
| --- | --- |
| `cdpEndpoint` | **必填**，外部 Chrome 的 `http(s)://` / `ws(s)://` endpoint |
| `steps` | 每任务最大步数（1–200，默认 10） |
| `cdpTimeoutMs` | 连接超时（1–60000，默认 15000） |
| `deciderConfig` | 决策后端覆盖，语义同 P1/引擎 |
| `forceViewport` | 如 `"1280x900@1"`，原样交给引擎 |

MCP 客户端配置示例（Claude Code / 任意 stdio 客户端）：

```json
{ "mcpServers": { "ego-decision-layer": {
  "command": "node",
  "args": ["/absolute/path/to/ego-decision-layer/mcp/server.mjs", "--config", "/absolute/path/to/mcp.json"]
} } }
```

启动失败（参数错误、配置不合法）一律 **exit 2**，只往 stderr 说明，不启动浏览器、不写 stdout。

## 工具

### `browser_task`

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `url` | 是 | 起始地址，只接受 `http(s)` 或 `about:blank`；不允许带账号密码 |
| `goal` | 是 | 操作目标（自然语言） |
| `until` | 是 | **确定性**退出条件：最终 URL 必须包含该子串 |
| `text` | 否 | 可填文本候选，字符串或字符串数组 |
| `taskId` | 否 | 调用方指定的稳定 id（`[A-Za-z0-9_.:-]`，≤128）。不传则由服务端生成 |

本入口**故意强制 `until`**：MCP 的调用方离页面更远，只凭模型自评 `jev_done` 无法复核。
没有确定性条件时会显式拒绝，而不是悄悄按 `jev_done` 报成功。

返回（`structuredContent`，同时是一段 JSON 文本）：

| 字段 | 含义 |
| --- | --- |
| `instanceId` | 本 server 进程的随机标识，用于区分重启前后 |
| `taskId` | 本次任务 id |
| `state` | `running` / `finished` / 未知见下 |
| `cancelRequested` | 是否收到过取消请求 |
| `replayed` | 该 id 之前已执行过，本次**没有**再跑浏览器 |
| `retry.scope` | 恒为 `this_process_only`：幂等只在当前进程内成立 |
| `retry.automaticRerun` | 恒为 `false` |
| `result` | P1 的完整结果（见下） |

`result` 里对调用方最有用的字段：

- `success` / `verified`：只有 P1 的确定性复核通过时 `success` 才为 true；`verified` 表示
  `until` 在**最终 URL** 上命中（`untilVerification: "final_url"`）。
- `reason` / `stopReason`：停止原因。`success=false` 时先看这里，再看是否 `outcomeUnknown`。
- `actions[]`：**已执行动作的证据**，每项含 `intent`（决策意图）、`dispatched`
  （`true` 已派发 / `false` 确认未派发 / `null` 未知）、`observed`（页面变化）、`skipped`
  （守卫拒绝原因）、`batchPartial`、`error`。意图不等于已执行。
- `outcomeUnknown`：**可能已产生副作用但未核实**（取消、丢失执行证据、批次部分执行）。
- `connection`：`connected` / `released` / `keepPage` / `receipt`（宿主清理回执）/ `closeError`。
- `elapsedMs`、`steps`、`serverModels`、`phases`、`url`、`title`。

### `browser_task_status`

入参 `{ taskId }`。只读本进程内存里的记录，**不碰浏览器**。
三个状态必须分清：

- `running` / `finished`：本进程里有记录。
- `unknown` + `reason: "task_not_found"` + `safeToRetry: false`：
  **不能**当成「上次没执行」。服务重启后记录就没了，而副作用可能已经发生。

### `browser_task_cancel`

入参 `{ taskId }`。设置取消请求（协作式：不再派发新动作，收尾释放连接）。
它**不回滚**已经派发的动作，本次响应也不是连接已释放的证明；
要结论就轮询 `browser_task_status` 直到 `finished`。

## 取消与连接释放

- MCP 标准的 `notifications/cancelled`（客户端中断请求）**不会**给原请求返回结果。
  本实现在收到取消后仍然完成清理，并把最终证据写进任务记录，用 `browser_task_status` 取。
- 另一种方式是先起任务、再显式调 `browser_task_cancel`，同样轮询状态。
- 取消只停止新动作；在途的一步可能已经落地，所以 `outcomeUnknown: true`。
- 连接释放与页面归属完全沿用 P1：每次任务创建**自有**页面，不激活/不关闭用户已有标签页；
  成功时关闭自有页面并释放连接；失败或取消时保留页面供排查，但**仍释放 CDP 连接**。
- stdio 客户端断开、`SIGINT` / `SIGTERM` 会取消所有在跑任务并等待收尾后退出。

## 重试语义（调用方必须读）

| 情形 | 建议 |
| --- | --- |
| 同一进程内，同 `taskId` 同参数重复调用 | 返回原记录（`replayed: true`），**不重跑** |
| 同一进程内，同 `taskId` 不同参数 | 拒绝（`task_id_conflict`），不改写原记录 |
| 记录数达到上限（默认 100） | 拒绝新任务（`task_capacity_reached`），**不淘汰**旧记录，免得丢掉重试证据 |
| 服务重启后重试同 `taskId` | 服务端不知道它，**不要**当作未执行，先看 `browser_task_status` |
| 换新 `taskId` 重试 | 会真的再执行；**可能重复副作用**，调用方要先核对页面状态 |

也就是说：本入口提供的是「**返回足够信息让调用方判断**」，不是跨进程的副作用去重。
日志默认丢弃（`onLog` 置空），避免把输入的文本写进传输通道。

## 失败关闭（fail-closed）

- 参数不合规（未知字段、非法 URL、空 `goal`/`until`、超长文本）→ 协议错误 `-32602`，**不连浏览器**。
- 缺凭证 / 配置非法 → 携带 `reason: "preflight_error"` 与 `exitCode: 3|2` 的结果，**不连浏览器**。
- 引擎/宿主抛异常 → `reason: "runner_exception"`、`actions: null`、`outcomeUnknown: true`，
  不编造动作记录。
- 配了 `until` 但最终 URL 未命中 → 绝不 `success`（P1 的 `until_not_matched`）。

## 验证

```bash
# 离线：真实 MCP stdio 传输 + P1 runner（注入宿主与引擎，不联网、不需要凭证）
node mcp/test-stdio.mjs

# 真实浏览器冒烟：本机 Chrome + 真实 Jev + 本地受控表单
node mcp/test-live.mjs
```

本轮实测（macOS 27.2 / Node 22.22.2 / Chrome 本机 / 模型 `jev-1.14.0`）：

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node mcp/test-stdio.mjs` | 0 | **41 通过 / 0 失败**（工具列表、参数校验、fail-closed、同 id 重放与冲突、容量、显式取消、协议取消、EOF 退出、连接释放） |
| `node mcp/test-live.mjs` | 0 | 真实任务 `success=true`、`verified=true`、`reason=check_passed`、最终 URL `/done?q=hello`、2 步、`connection.released=true`（`targetClosed=true`、`browserClosed=false`）、无关注标签页保留 |

## 未验证 / 边界

- 只在本机 macOS + Chrome 实测；Windows / Linux 的 Chrome 路径与 CDP 行为未验证。
- 只测了 stdio 传输；没有 Streamable HTTP 入口，也没有鉴权层（不要把它直接暴露到网络）。
- `browser_task_status` 的记录在进程内，**不持久化**；崩溃后无法回答「上次做到哪一步」。
- 没有 MCP 的 task-augmented 请求支持（`params.task` 显式拒绝）：长任务请用 `taskId` + 状态轮询。
- 真实站点的成功率 / 费用 / token / 人工接管率：本入口不产生这类数据，报告里一律为 `null`。
- 本入口强制要求 `until`，纯抽取任务不在 MCP 范围内。
