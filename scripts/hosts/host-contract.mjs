/**
 * Host Adapter 契约 v1：普通 Node 宿主（外部 Chrome CDP）与 ego lite 共享的最小页面接口。
 *
 * 为什么要有这份契约（而不只是一段文档）：
 *   引擎 `scripts/decider-loop.mjs` 只消费 `page` 上的一小组方法。换宿主时最危险的失败形态
 *   不是报错，而是**缺失能力被静默当成「页面没有目标」**：闭环会一路 wait / no_targets，
 *   最后报「未达成」，看起来像模型不行，实际是宿主少了一个方法。所以把边界写成代码：
 *   `assertHostPage()` 让适配器在启动时 fail-closed 自检，`describeHostCapabilities()`
 *   让调用方与测试能核对实际边界。
 *
 * 三组能力（按真实调用点盘点，见 docs/HOST-ADAPTER.md）：
 *   * 默认 DOM 路径（`observeMode === "dom"`，引擎默认）：DOM_PATH_REQUIRED。
 *   * 入口路径（CLI / runner / 验收脚本）：ENTRY_PATH_REQUIRED（`goto`）。
 *     引擎自己不用 goto（它下发 `Page.navigate` + `waitForLoadState`），但入口必须有一个
 *     「等新文档真的提交」的导航方法，否则调用方会被旧文档的 `readyState === complete` 骗过去。
 *   * snapshot / ref 路径（ego 专有，引擎在 DOM 观测为空时兜底）：SNAPSHOT_PATH_MEMBERS。
 *     第二宿主**明确不提供**：调用必须抛 HostCapabilityError，不许返回空快照冒充成功。
 *
 * 能力是**声明**出来的，不是靠「方法存不存在」推断：适配器可以把不支持的方法实现成
 * 一调用就抛错的 stub（这正是 fail-closed 想要的），此时「有函数」不等于「有能力」。
 * 所以宿主在 page 上放一份 `hostCapabilities`（HOST_CAPABILITY_KEY），
 * describeHostCapabilities() 优先读它，只有没声明时才退回结构推断（如 ego 的 page）。
 *
 * 错误码约定（重要）：
 *   * 除取消外，所有错误码都以 `HOST_` 开头、**不以 `EGO_` 开头**。引擎的
 *     `rethrowBrowserStop()` 把 `EGO_*` 当成「控制/安全停止」直接上抛；如果等待超时也带
 *     `EGO_` 前缀，`settle` 的等待超时就变成致命错误，改变既有语义。
 *   * **取消是唯一的例外**：`HostAbortError` 的 code 是 `EGO_HOST_ABORTED`。
 *     取消是控制停止，必须让引擎 `rethrowBrowserStop()` 直接上抛给调用方，
 *     不能被当成「导航中途」「动作失败」或普通步骤错误吞掉。
 *   * 导航导致的 evaluate 失败必须保留 Chrome 原文（如
 *     "Execution context was destroyed, most likely because of a navigation."），
 *     引擎靠 NAVIGATION_ERROR_PATTERN 识别它并重试观测。
 */

/** 契约版本：page 方法集或错误语义有不兼容变化时递增。 */
export const HOST_CONTRACT_VERSION = 1;

/** page 上自我声明的能力块（键名固定，见 describeHostCapabilities）。 */
export const HOST_CAPABILITY_KEY = "hostCapabilities";

/**
 * 默认 DOM 路径必需方法（引擎实际调用点）：
 *   evaluate            observeDom / stateInPage / selectInPage / scrollInPage / readScrollY …
 *   cdp                 Input.dispatchMouseEvent / dispatchKeyEvent / insertText / Emulation.setDeviceMetricsOverride
 *   url                 runJevStep 的 urlBefore / urlAfter 与进展判定
 *   title               决策上下文里的页面标题
 *   waitForLoadState    settle 的导航等待、观测遇导航时的有界重试
 *   keyboard.press      type_text_submit 派发 Enter
 */
export const DOM_PATH_REQUIRED = Object.freeze([
  "evaluate",
  "cdp",
  "url",
  "title",
  "waitForLoadState",
  "keyboard.press",
]);

/**
 * 入口路径必需方法（CLI / runner / 验收脚本）：
 *   goto(url, { waitUntil, timeout })   导航并**等新文档提交**，不能拿旧文档的 readyState 判成功。
 */
export const ENTRY_PATH_REQUIRED = Object.freeze(["goto"]);

/**
 * ego 专有的 snapshot / ref 派生动作：第二宿主不提供。
 * 列出来是为了让「不支持」变成可核对的显式状态，而不是缺字段导致 TypeError。
 */
export const SNAPSHOT_PATH_MEMBERS = Object.freeze([
  "snapshot",
  "click",
  "fill",
  "press",
  "selectOption",
]);

/** 与引擎 requireNavigationError() 保持同一判据：evaluate 撞上导航是可重试的。 */
export const NAVIGATION_ERROR_PATTERN =
  /execution context (?:was )?destroyed|cannot find context|context.*navigation/i;

/** 与引擎 requireWaitTimeout() 保持同一判据（name + message 拼起来测）。 */
export const TIMEOUT_ERROR_PATTERN = /timeout|timed out/i;

export const isNavigationError = (err) => NAVIGATION_ERROR_PATTERN.test(String(err?.message || err));

export const isTimeoutError = (err) =>
  TIMEOUT_ERROR_PATTERN.test(String(err?.name || "") + " " + String(err?.message || err));

/** 所有 Host 错误的基类：带稳定 `code`，便于调用方/测试断言而不是匹配自然语言。 */
export class HostError extends Error {
  constructor(message, { code = "HOST_ERROR", cause, details } = {}) {
    super(message);
    this.name = "HostError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    if (details !== undefined) this.details = details;
  }
}

/** 运行环境根本没有这项能力（例如 Node < 22 没有全局 WebSocket）：显式拒绝，不尝试半残连接。 */
export class HostUnsupportedError extends HostError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "HOST_UNSUPPORTED" });
    this.name = "HostUnsupportedError";
  }
}

/** 宿主明确不实现某个能力（如 snapshot / ref 路径）。 */
export class HostCapabilityError extends HostError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "HOST_CAPABILITY_MISSING" });
    this.name = "HostCapabilityError";
  }
}

/**
 * 调用方取消（AbortSignal）。**唯一带 `EGO_` 前缀的 Host 错误**：取消是控制停止，
 * 引擎 `rethrowBrowserStop()` 会把它原样上抛，而不是算成导航/步骤失败吞掉。
 * 取消后页面的方法立即失败，但 `close()` 仍然可用（清理不依赖 signal）。
 */
export class HostAbortError extends HostError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "EGO_HOST_ABORTED" });
    this.name = "HostAbortError";
    this.controlStop = true;
  }
}

/** 连接或会话已断开（socket 关闭、target 被外部关闭、崩溃）。 */
export class HostDisconnectedError extends HostError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "HOST_DISCONNECTED" });
    this.name = "HostDisconnectedError";
  }
}

/**
 * 可被引擎识别为「等待超时」的超时（name 固定 "TimeoutError"，message 含 "timed out"）。
 * 只用于连接/发现阶段、`page.waitForLoadState` 与 `page.goto` —— 这几处的语义就是
 * 「等一个条件直到超时」，引擎/调用方可以据此继续。
 * 刻意不带 `EGO_` 前缀：它等价于 ego 的 waitForLoadState 超时。
 */
export class HostTimeoutError extends HostError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "HOST_TIMEOUT" });
    this.name = "TimeoutError";
  }
}

/** CDP 命令长时间无响应（连接卡死）。刻意不叫 TimeoutError：它不能被当成「页面还在加载」。 */
export class HostStalledError extends HostError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "HOST_COMMAND_STALLED" });
    this.name = "HostStalledError";
  }
}

/** 协议层错误：endpoint 不是 CDP、CDP 返回 error、响应结构不符预期。 */
export class HostProtocolError extends HostError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "HOST_PROTOCOL_ERROR" });
    this.name = "HostProtocolError";
  }
}

/** 导航被浏览器拒绝（`Page.navigate` 的 `errorText`，如 net::ERR_NAME_NOT_RESOLVED）。 */
export class HostNavigationError extends HostError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "HOST_NAVIGATION_FAILED" });
    this.name = "HostNavigationError";
  }
}

/** 页面上下文里抛出的异常（含导航导致的 context 销毁）。message 保留 Chrome 原文。 */
export class HostEvaluationError extends HostError {
  constructor(message, options = {}) {
    super(message, { ...options, code: "HOST_EVALUATE_ERROR" });
    this.name = "HostEvaluationError";
  }
}

const getPath = (target, path) =>
  path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), target);

/** 返回缺失的方法名（空数组 = 契约满足）。entry=true 时把入口方法也算进去。 */
export function missingHostMethods(page, { entry = false } = {}) {
  const required = entry ? [...DOM_PATH_REQUIRED, ...ENTRY_PATH_REQUIRED] : [...DOM_PATH_REQUIRED];
  return required.filter((path) => typeof getPath(page, path) !== "function");
}

/**
 * fail-closed 自检：宿主/适配器在把 page 交给引擎（或入口）之前必须调用一次。
 * 缺失方法直接抛 HostCapabilityError，而不是等到闭环里静默空转。
 */
export function assertHostPage(page, { label = "page", entry = false } = {}) {
  const required = entry ? [...DOM_PATH_REQUIRED, ...ENTRY_PATH_REQUIRED] : [...DOM_PATH_REQUIRED];
  if (!page || typeof page !== "object") {
    throw new HostCapabilityError(`${label} 不是对象，无法满足 Host 契约 v${HOST_CONTRACT_VERSION}`, {
      details: { required, version: HOST_CONTRACT_VERSION },
    });
  }
  const missing = missingHostMethods(page, { entry });
  if (missing.length) {
    throw new HostCapabilityError(
      `${label} 缺少${entry ? "入口 / 默认 DOM" : "默认 DOM"}路径必需方法：${missing.join(", ")}（Host 契约 v${HOST_CONTRACT_VERSION}）`,
      { details: { missing, required, version: HOST_CONTRACT_VERSION } }
    );
  }
  return page;
}

/**
 * 只读能力描述：调用方/测试用它核对实际边界，不靠文档假设。
 *   domPath      true = 可以跑引擎默认 DOM 路径
 *   entryPath    true = 可以当 CLI/runner 入口（有 goto）
 *   snapshotPath true = 支持 ego 的 snapshot / ref 路径
 *   declared     true = 用的是 page.hostCapabilities 的自述，而不是结构推断
 *   unsupported  明确不提供的方法名
 *
 * 注意：**不要**用「方法是不是函数」判断 snapshot 路径。适配器把不支持的方法实现成
 * 一调用就抛错的 stub 时，结构推断会得出「支持」的错误结论。
 */
export function describeHostCapabilities(page) {
  const missing = missingHostMethods(page, { entry: true });
  const required = [...DOM_PATH_REQUIRED];
  const entryRequired = [...ENTRY_PATH_REQUIRED];
  const declaredCapabilities = page?.[HOST_CAPABILITY_KEY];
  if (declaredCapabilities && typeof declaredCapabilities === "object") {
    const unsupported = Array.isArray(declaredCapabilities.unsupported)
      ? [...declaredCapabilities.unsupported]
      : [];
    return {
      version: HOST_CONTRACT_VERSION,
      declared: true,
      domPath: declaredCapabilities.domPath !== false && missingHostMethods(page).length === 0,
      entryPath: declaredCapabilities.entryPath !== false && typeof getPath(page, "goto") === "function",
      missing,
      snapshotPath: declaredCapabilities.snapshotPath === true,
      unsupported,
      required,
      entryRequired,
    };
  }
  const present = SNAPSHOT_PATH_MEMBERS.filter((name) => typeof getPath(page, name) === "function");
  return {
    version: HOST_CONTRACT_VERSION,
    declared: false,
    domPath: missingHostMethods(page).length === 0,
    entryPath: typeof getPath(page, "goto") === "function",
    missing,
    snapshotPath: present.length === SNAPSHOT_PATH_MEMBERS.length,
    unsupported: SNAPSHOT_PATH_MEMBERS.filter((name) => !present.includes(name)),
    required,
    entryRequired,
  };
}
