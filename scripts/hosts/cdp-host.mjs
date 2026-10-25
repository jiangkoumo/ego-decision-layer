/**
 * 最小 CDP 宿主适配器：普通 Node（≥ 22，自带 WebSocket）+ 外部 Chrome 的 CDP endpoint。
 *
 * 目标：让 `scripts/decider-loop.mjs` 的**默认 DOM 路径**在没有 ego lite 的进程里也能跑通，
 * 并给 CLI / runner 提供一个会「等新文档真的提交」的 `page.goto()`。
 * 只依赖 Node 自带能力（全局 WebSocket + fetch），不引入 Playwright / Puppeteer / ws。
 *
 * 契约（v1，见 ./host-contract.mjs 与 docs/HOST-ADAPTER.md）：
 *   const { page, metadata, close } = await connectCdpHost({ endpoint, signal, timeoutMs });
 *   - endpoint：`http(s)://host:port`（走 /json/version 发现浏览器级 WebSocket）或
 *     `ws(s)://…/devtools/browser/<id>`（直连）。
 *   - **默认只新建并管理自有 target**（about:blank 起步），绝不接管用户已有标签页。
 *   - `close({ keepPage })`：默认关闭自有 target 并断开连接；`keepPage: true` 只断连接、留下页面。
 *     永不调用 `Browser.close` —— 外部浏览器归调用方所有；`Target.closeTarget` 的
 *     `success` 也会如实核对，不会把 `success:false` 报成「已关闭」。
 *
 * 取消（AbortSignal）的语义，逐条明确：
 *   * 取消**只**让 page 方法失败（HostAbortError，code 带 `EGO_` 前缀 = 控制停止，引擎会直接上抛），
 *     不会自动销毁连接：否则「取消」和「资源已释放」会缠在一起，调用方无法判断还需不需要清理。
 *   * `close()` 不依赖 signal，取消之后照常清理，且幂等。
 *   * 在途命令会被立刻拒绝（不会挂到命令超时 30s）。
 *   * 取消与副作用的边界：已经派发的 `Input.dispatchKeyEvent(keyDown)` 用一次 `keyUp` 收尾
 *     （没有配对 keyDown 时渲染器直接忽略，不引入新副作用；否则页面会留一个卡住的按键）。
 *     除此之外取消后不再派发任何新动作；已派发但结果未知的动作交给调用方复核，宿主不重试。
 */

import {
  DOM_PATH_REQUIRED,
  ENTRY_PATH_REQUIRED,
  HOST_CAPABILITY_KEY,
  HostAbortError,
  HostCapabilityError,
  HostDisconnectedError,
  HostError,
  HostEvaluationError,
  HostNavigationError,
  HostProtocolError,
  HostStalledError,
  HostTimeoutError,
  HostUnsupportedError,
  HOST_CONTRACT_VERSION,
  SNAPSHOT_PATH_MEMBERS,
  assertHostPage,
  isNavigationError,
} from "./host-contract.mjs";

/** 需要 Node ≥ 22：全局 WebSocket 自 22 起稳定可用（本适配器不依赖任何第三方包）。 */
export const MIN_NODE_MAJOR = 22;

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_LOAD_STATE_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const WAIT_UNTIL_STATES = Object.freeze(["load", "domcontentloaded", "commit"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const abortError = (signal, what = "宿主操作") =>
  new HostAbortError(`${what}被调用方取消（AbortSignal）`, {
    cause: signal?.reason instanceof Error ? signal.reason : undefined,
  });

function throwIfAborted(signal, what = "宿主操作") {
  if (signal?.aborted) throw abortError(signal, what);
}

/** 运行环境自检：没有 WebSocket 就显式拒绝，而不是等一个必然失败的连接。 */
function assertWebSocketRuntime() {
  if (typeof globalThis.WebSocket === "function") return;
  const current = String(process?.versions?.node || "unknown");
  const major = Number(current.split(".")[0]) || 0;
  throw new HostUnsupportedError(
    `当前 Node ${current} 没有全局 WebSocket：CDP 宿主需要 Node ≥ ${MIN_NODE_MAJOR}（Node 自带 undici WebSocket），` +
      (major && major < MIN_NODE_MAJOR ? `当前主版本 ${major}，请升级 Node。` : "请确认运行时未禁用 WebSocket。")
  );
}

/** endpoint 归一化：http(s) 走发现流程，ws(s) 直连；裸 host:port 补 http://。 */
function normalizeEndpoint(endpoint) {
  const raw = String(endpoint ?? "").trim();
  if (!raw) {
    throw new HostProtocolError(
      "connectCdpHost 需要 endpoint：http://127.0.0.1:<端口>（推荐，自动发现浏览器级 WebSocket）或 ws://…/devtools/browser/<id>"
    );
  }
  if (/^wss?:\/\//i.test(raw)) return { wsUrl: raw, httpEndpoint: null };
  const base = (/^https?:\/\//i.test(raw) ? raw : `http://${raw}`).replace(/\/+$/, "");
  return { wsUrl: null, httpEndpoint: base };
}

/** 带超时 + 取消的 JSON GET（用于 /json/version）。 */
async function fetchJson(url, { signal, timeoutMs, what }) {
  throwIfAborted(signal, what);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new HostProtocolError(`${what}失败：HTTP ${res.status}（${url}）`);
    return await res.json();
  } catch (err) {
    if (signal?.aborted) throw abortError(signal, what);
    if (timedOut) throw new HostTimeoutError(`${what} timed out after ${timeoutMs}ms（${url}）`);
    if (err instanceof HostError) throw err;
    throw new HostProtocolError(`${what}失败：${err?.message || err}（${url}）`, { cause: err });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

const SESSION_GONE_PATTERN =
  /session closed|target closed|session with given id|has been closed|inspector\.detached|detached from target|not attached/i;

/**
 * 一条浏览器级 CDP 连接。所有请求共享一个 WebSocket，靠自增 id 对应响应（**不是 FIFO**：
 * 响应可能乱序，事件也可能插在中间）。
 */
class CdpConnection {
  constructor(wsUrl, { commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS } = {}) {
    this.wsUrl = wsUrl;
    this.commandTimeoutMs = commandTimeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.sessionGone = new Map(); // sessionId -> 原因（target 被外部关闭 / 崩溃）
    this.closed = false;
    this.closeInfo = null;
    this.ws = null;
  }

  /** 标记某个会话已消失（target 被外部关闭/崩溃）：该会话上的后续调用必须显式失败。 */
  markSessionGone(sessionId, reason) {
    if (sessionId) this.sessionGone.set(sessionId, reason);
  }

  sessionGoneReason(sessionId) {
    return this.sessionGone.get(sessionId);
  }

  /** 订阅解码后的消息（`{method, params, sessionId}` 或 `{id, result|error}`）。 */
  onMessage(handler) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  open({ signal, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS }) {
    throwIfAborted(signal, "连接 CDP 端点");
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (err) {
          try {
            this.ws?.close();
          } catch {
            /* 已经关了就算了 */
          }
          reject(err);
        } else {
          resolve();
        }
      };
      const onAbort = () => finish(abortError(signal, "连接 CDP 端点"));
      const timer = setTimeout(
        () => finish(new HostTimeoutError(`连接 CDP 端点 timed out after ${timeoutMs}ms（${this.wsUrl}）`)),
        timeoutMs
      );
      signal?.addEventListener("abort", onAbort, { once: true });

      let ws;
      try {
        ws = new globalThis.WebSocket(this.wsUrl);
      } catch (err) {
        finish(new HostProtocolError(`无法创建 WebSocket 连接：${err?.message || err}（${this.wsUrl}）`, { cause: err }));
        return;
      }
      this.ws = ws;
      ws.addEventListener("open", () => finish(), { once: true });
      ws.addEventListener("error", (event) => {
        const detail = event?.message || event?.error?.message || "WebSocket error";
        finish(new HostDisconnectedError(`连接 CDP 端点失败：${detail}（${this.wsUrl}）`));
      });
      ws.addEventListener("message", (event) => this.#handleMessage(event.data));
      ws.addEventListener("close", (event) => this.#handleClose(event));
    });
  }

  #handleClose(event) {
    const reason = event?.reason || `WebSocket 关闭（code=${event?.code ?? "?"}）`;
    this.#markClosed(reason);
  }

  #markClosed(reason) {
    if (this.closed) return;
    this.closed = true;
    this.closeInfo = { reason };
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(
        new HostDisconnectedError(`CDP 连接已断开：${entry.method} 未完成（${reason}）`, {
          details: { method: entry.method, requestId: id },
        })
      );
    }
    this.pending.clear();
  }

  #handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return; // 半包/非法帧不致命：CDP 消息总是完整 JSON
    }
    if (message?.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const text = String(message.error.message || "unknown error");
        // target/会话被外部关闭时 CDP 会回错误而不是静默断 socket：必须报成断连，
        // 不能报成「协议错误」让调用方以为是命令写错了。
        if (SESSION_GONE_PATTERN.test(text)) {
          this.markSessionGone(message.sessionId, text);
          entry.reject(
            new HostDisconnectedError(`${entry.method}: ${text}（页面会话已消失）`, {
              details: { method: entry.method, cdpError: message.error },
            })
          );
          return;
        }
        const err = new HostProtocolError(`${entry.method}: ${text}`, {
          details: { method: entry.method, cdpError: message.error },
        });
        err.cdpCode = message.error.code;
        entry.reject(err);
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    for (const handler of [...this.listeners]) {
      try {
        handler(message);
      } catch {
        /* 观察者的异常不能破坏连接 */
      }
    }
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId]
   * @param {{timeoutMs?: number}} [options] 单条命令的响应上限（覆盖默认 commandTimeoutMs）。
   *   等待类调用（waitForLoadState / goto）必须传它，否则 250ms 的等待可能被拖成 30s。
   */
  send(method, params = {}, sessionId, options = {}) {
    if (this.closed) {
      return Promise.reject(
        new HostDisconnectedError(
          `CDP 连接已断开，无法发送 ${method}：${this.closeInfo?.reason || "connection closed"}`
        )
      );
    }
    const budget = Number.isFinite(options?.timeoutMs) ? Math.max(1, options.timeoutMs) : this.commandTimeoutMs;
    const id = this.nextId++;
    const payload = { id, method, params: params ?? {} };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new HostStalledError(
            `CDP 命令 ${method} 在 ${Math.round(budget)}ms 内无响应（不会按「页面仍在加载」重试）`
          )
        );
      }, budget);
      this.pending.set(id, { resolve, reject, method, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HostDisconnectedError(`发送 ${method} 失败：${err?.message || err}`, { cause: err }));
      }
    });
  }

  close(reason = "client_close") {
    if (this.closed) {
      this.closeInfo = this.closeInfo || { reason };
      return;
    }
    this.#markClosed(reason);
    try {
      this.ws?.close(1000, String(reason).slice(0, 120));
    } catch {
      /* 关不掉也不影响后续清理 */
    }
  }
}

/**
 * 按键映射。**只映射引擎实际用到的 Enter**：多一个键就是多一份没被测过的派发路径。
 * 其他键要加时先补测试（含 keyDown/keyUp 配对与真实默认动作）。
 * Enter 带 `text: "\r"`：rawKeyDown 不产生 char 事件，隐式表单提交会因此不触发（实测）。
 * 与 Puppeteer 同一做法：有 text 用 `keyDown`，否则 `rawKeyDown`。
 */
const KEY_DEFINITIONS = Object.freeze({
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
});

/** 把 (函数, 参数) 组成能在页面里直接求值的表达式（returnByValue 走 JSON 往返）。 */
function buildExpression(fn, arg) {
  if (typeof fn === "string") return fn;
  if (typeof fn !== "function") {
    throw new HostProtocolError("page.evaluate 只接受函数或表达式字符串（与引擎实际调用一致）");
  }
  const source = Function.prototype.toString.call(fn);
  const argExpression = arg === undefined ? "" : JSON.stringify(arg) ?? "undefined";
  return `(${source})(${argExpression})`;
}

/** returnByValue 的反序列化：只接受能通过 JSON 往返的值。 */
function unwrapRemoteObject(result) {
  if (!result) return undefined;
  if (result.type === "undefined") return undefined;
  if (result.unserializableValue !== undefined) {
    switch (result.unserializableValue) {
      case "NaN":
        return NaN;
      case "Infinity":
        return Infinity;
      case "-Infinity":
        return -Infinity;
      case "-0":
        return -0;
      default:
        return result.unserializableValue;
    }
  }
  if (Object.prototype.hasOwnProperty.call(result, "value")) return result.value;
  throw new HostEvaluationError(
    `page.evaluate 返回值不可按 JSON 序列化（type=${result.type}${result.className ? `, class=${result.className}` : ""}）：` +
      "宿主只支持可序列化的返回值，请勿从 evaluate 直接返回 DOM 节点 / 函数"
  );
}

function evaluationErrorFrom(details) {
  const exception = details?.exception;
  const text = String(exception?.description || details?.text || "evaluate 失败");
  const err = new HostEvaluationError(text.slice(0, 800), {
    details: {
      text: details?.text,
      lineNumber: details?.lineNumber,
      columnNumber: details?.columnNumber,
    },
  });
  // 保留 Chrome 原文，让引擎的 requireNavigationError() 能识别「撞上导航」并重试观测。
  if (isNavigationError(err)) err.navigation = true;
  return err;
}

/**
 * 构造 page 适配器。外部只经 connectCdpHost 拿到它；这里单独成函数是为了让
 * “page 上有哪些方法、缺哪些方法、支持哪些能力”一眼可读（契约自检也读同一个对象）。
 *
 * @param {object} params
 * @param {CdpConnection} params.connection
 * @param {string} params.sessionId
 * @param {string} params.initialUrl
 * @param {{promise: Promise, isCancelled: () => boolean, reason: () => Error}} params.cancel
 */
function createCdpPage({ connection, sessionId, initialUrl = "about:blank", cancel }) {
  const state = { cancelled: false, closed: false, targetGone: false, keptPage: false };
  const tracked = { url: initialUrl, title: null, loaderId: null };

  function assertUsable() {
    if (state.closed) throw new HostDisconnectedError("宿主已关闭（close() 已调用），不能再操作页面");
    if (state.cancelled || cancel.isCancelled()) {
      state.cancelled = true;
      throw cancel.isCancelled() ? cancel.reason() : new HostAbortError("宿主会话已被取消（AbortSignal）");
    }
    if (state.targetGone) throw new HostDisconnectedError("页面 target 已被外部关闭或崩溃，连接不可再用");
    const sessionGone = connection.sessionGoneReason(sessionId);
    if (sessionGone) throw new HostDisconnectedError(`页面会话已消失：${sessionGone}`);
    if (connection.closed) {
      throw new HostDisconnectedError(`CDP 连接已断开：${connection.closeInfo?.reason || "connection closed"}`);
    }
  }

  /** 发一条页面级命令：与取消做 race，取消时立即拒绝（不会挂到命令超时）。 */
  function runCommand(method, params, options = {}) {
    assertUsable();
    const promise = connection.send(method, params, sessionId, options);
    return Promise.race([promise, cancel.promise]);
  }

  async function runEvaluate(fn, arg, options = {}) {
    assertUsable();
    const expression = buildExpression(fn, arg);
    const response = await runCommand(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: false,
        includeCommandLineAPI: false,
        replMode: false,
        silent: false,
      },
      options
    );
    if (response?.exceptionDetails) throw evaluationErrorFrom(response.exceptionDetails);
    return unwrapRemoteObject(response?.result);
  }

  const waitTimeoutError = (stateName, timeout, detail) =>
    new HostTimeoutError(
      `waitForLoadState("${stateName}") timed out after ${timeout}ms${detail ? `（${detail}）` : ""}`
    );

  async function waitForLoadState(stateName = "load", options = {}) {
    assertUsable();
    const wanted = stateName === "domcontentloaded" ? "interactive" : "complete";
    const timeout = options.timeout ?? DEFAULT_LOAD_STATE_TIMEOUT_MS;
    const startedAt = Date.now();
    let lastReady = null;
    for (;;) {
      assertUsable();
      const remaining = timeout - (Date.now() - startedAt);
      if (remaining <= 0) throw waitTimeoutError(stateName, timeout, `当前 readyState=${lastReady ?? "unknown"}`);
      try {
        // 探针本身也受本次等待预算约束：不能让一条卡住的 evaluate 把 250ms 拖成 30s。
        lastReady = await runEvaluate(() => document.readyState, undefined, {
          timeoutMs: Math.max(25, Math.round(remaining)),
        });
      } catch (err) {
        if (err?.code === "HOST_COMMAND_STALLED") {
          throw waitTimeoutError(stateName, timeout, `最后一次 readyState 探针在预算内没有返回：${err.message}`);
        }
        if (!isNavigationError(err)) throw err; // 控制/取消/协议错误绝不按「还在加载」吞掉
      }
      if (lastReady === "complete" || (wanted === "interactive" && lastReady === "interactive")) return;
      const left = timeout - (Date.now() - startedAt);
      if (left <= 0) throw waitTimeoutError(stateName, timeout, `当前 readyState=${lastReady ?? "unknown"}`);
      await sleep(Math.min(25, left));
    }
  }

  async function goto(url, options = {}) {
    assertUsable();
    if (typeof url !== "string" || !url) {
      throw new HostProtocolError("page.goto 需要一个 URL 字符串");
    }
    const waitUntil = options.waitUntil ?? "load";
    if (!WAIT_UNTIL_STATES.includes(waitUntil)) {
      throw new HostCapabilityError(
        `page.goto 的 waitUntil 只支持 ${WAIT_UNTIL_STATES.join(" / ")}（收到 "${waitUntil}"）：` +
          "cdp-host 不实现 networkidle 类语义（需要 Network 域统计在途请求），请调用方自行映射或改用 load/domcontentloaded。"
      );
    }
    const timeout = options.timeout ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
    const startedAt = Date.now();
    const remaining = () => timeout - (Date.now() - startedAt);

    // ── 1) 导航前的 loaderId：判断「新文档真的提交了」的基准 ──
    let previousLoaderId = tracked.loaderId;
    if (!previousLoaderId) {
      try {
        const tree = await runCommand("Page.getFrameTree", {}, { timeoutMs: Math.max(25, remaining()) });
        previousLoaderId = tree?.frameTree?.frame?.loaderId ?? null;
        if (previousLoaderId) tracked.loaderId = previousLoaderId;
      } catch (err) {
        assertUsable();
        if (!isNavigationError(err) && err?.code !== "HOST_COMMAND_STALLED") throw err;
      }
    }

    // ── 2) 发起导航 ──
    const nav = await runCommand("Page.navigate", { url }, { timeoutMs: Math.max(25, remaining()) });
    if (nav?.errorText) {
      throw new HostNavigationError(`goto(${url}) 被浏览器拒绝：${nav.errorText}`, {
        details: { url, errorText: nav.errorText },
      });
    }
    const targetLoaderId = nav?.loaderId ?? null;
    const sameDocument = !targetLoaderId;

    // ── 3) 等新文档提交。绝不直接读旧文档的 readyState 判成功 ──
    if (!sameDocument) {
      for (;;) {
        assertUsable();
        if (tracked.loaderId === targetLoaderId) break;
        if (remaining() <= 0) {
          throw new HostTimeoutError(
            `goto(${url}) timed out after ${timeout}ms（等不到新文档提交：` +
              `期望 loaderId=${targetLoaderId}，当前=${tracked.loaderId ?? "unknown"}）`
          );
        }
        await sleep(10);
      }
    } else {
      // 同文档导航（如只改 hash）：loaderId 不变，按最终 URL 判定。
      for (;;) {
        assertUsable();
        try {
          const href = await runEvaluate(() => location.href, undefined, { timeoutMs: Math.max(25, remaining()) });
          if (typeof href === "string" && href === url) break;
        } catch (err) {
          if (!isNavigationError(err)) throw err;
        }
        if (remaining() <= 0) {
          throw new HostTimeoutError(`goto(${url}) timed out after ${timeout}ms（同文档导航没有落到目标 URL）`);
        }
        await sleep(10);
      }
    }

    // ── 4) 等文档进入目标状态（commit 就是「提交即可」）──
    if (waitUntil !== "commit") {
      const budget = Math.max(25, remaining());
      try {
        await waitForLoadState(waitUntil, { timeout: budget });
      } catch (err) {
        if (err?.code === "HOST_TIMEOUT") {
          throw new HostTimeoutError(
            `goto(${url}) timed out after ${timeout}ms（新文档已提交，但 waitUntil="${waitUntil}" 未在预算内达成：${err.message}）`
          );
        }
        throw err;
      }
    }

    let finalUrl = url;
    try {
      finalUrl = await url_();
    } catch {
      finalUrl = tracked.url || url;
    }
    return {
      url: finalUrl,
      requestedUrl: url,
      loaderId: targetLoaderId,
      waitUntil,
      sameDocument,
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function url_() {
    assertUsable();
    try {
      const live = await runEvaluate(() => location.href);
      if (typeof live === "string" && live) tracked.url = live;
      return typeof live === "string" ? live : tracked.url;
    } catch (err) {
      // 文档正在导航时 location 取不到：用 Page.frameNavigated 跟踪到的 URL。
      if (isNavigationError(err)) return tracked.url;
      throw err;
    }
  }

  async function title_() {
    assertUsable();
    try {
      const live = await runEvaluate(() => document.title);
      if (typeof live === "string") tracked.title = live;
      return typeof live === "string" ? live : tracked.title ?? "";
    } catch (err) {
      if (isNavigationError(err)) return tracked.title ?? "";
      throw err;
    }
  }

  const unsupported = (method) => {
    throw new HostCapabilityError(
      `cdp-host 不提供 page.${method}()：这是 ego lite 专有的 snapshot / ref 路径` +
        "（需要宿主自建快照索引与 ref 解析）。第二宿主只实现默认 DOM 路径与 goto 入口；" +
        "需要 snapshot/ref 时请在 ego-browser 里运行引擎，或改用选择器/DOM 原生 API。" +
        `（Host 契约 v${HOST_CONTRACT_VERSION}，不支持：${SNAPSHOT_PATH_MEMBERS.join(", ")}）`,
      { details: { method, unsupported: [...SNAPSHOT_PATH_MEMBERS], version: HOST_CONTRACT_VERSION } }
    );
  };

  const releaseAbortListener = () => {
    if (typeof cancel.detach === "function") cancel.detach();
  };

  const page = {
    contractVersion: HOST_CONTRACT_VERSION,
    host: "cdp",
    sessionId,

    // 能力是**声明**的：snapshot 系列方法存在（一调用就抛错），但明确报告为不支持。
    [HOST_CAPABILITY_KEY]: Object.freeze({
      domPath: true,
      entryPath: true,
      snapshotPath: false,
      unsupported: [...SNAPSHOT_PATH_MEMBERS],
      version: HOST_CONTRACT_VERSION,
    }),

    // ── 默认 DOM 路径必需 ────────────────────────────────────────────────
    evaluate: (fn, arg) => runEvaluate(fn, arg),

    cdp: (method, params, options = {}) => {
      if (!method || typeof method !== "string") {
        return Promise.reject(new HostProtocolError("page.cdp 需要一个 CDP method 字符串"));
      }
      return runCommand(method, params ?? {}, options);
    },

    url: () => url_(),
    title: () => title_(),
    waitForLoadState: (stateName, options) => waitForLoadState(stateName, options),

    keyboard: {
      async press(key) {
        assertUsable();
        const def = KEY_DEFINITIONS[key];
        if (!def) {
          throw new HostCapabilityError(
            `cdp-host 的 keyboard.press 只映射了引擎实际使用的键（${Object.keys(KEY_DEFINITIONS).join(", ")}）；` +
              `收到 "${key}"：要支持请先补真实按键测试，不要在没测过的派发路径上加键。`
          );
        }
        const base = {
          key: def.key,
          code: def.code,
          windowsVirtualKeyCode: def.keyCode,
          nativeVirtualKeyCode: def.keyCode,
        };
        // 有 text 的键必须用 keyDown（CDP 会补 char 事件）；rawKeyDown 只用于纯控制键。
        const keyDownType = def.text ? "keyDown" : "rawKeyDown";
        let keyDownError = null;
        try {
          await runCommand("Input.dispatchKeyEvent", {
            type: keyDownType,
            ...base,
            ...(def.text ? { text: def.text, unmodifiedText: def.text } : {}),
          });
        } catch (err) {
          // keyDown 可能已派发也可能没有（取消/断连都算「结果未知」）。先记下，收尾后上抛。
          keyDownError = err;
        }
        // keyUp 只是对可能已落地的 keyDown 收尾：没有配对 keyDown 时渲染器直接忽略，
        // 不引入新副作用；但漏掉它会让页面留一个卡住的按键（Enter 会反复触发默认动作）。
        // 所以这一步**绕过取消**直接发，失败也不掩盖上面的原始错误。
        try {
          await connection.send("Input.dispatchKeyEvent", { type: "keyUp", ...base }, sessionId);
        } catch {
          /* 连接已经没了，没什么可收尾的 */
        }
        if (keyDownError) throw keyDownError;
        // keyDown+keyUp 都发出去了：若此刻已被取消，仍然上抛取消，让调用方知道要停。
        assertUsable();
      },
    },

    // ── 入口路径必需（CLI / runner）──────────────────────────────────────
    goto: (targetUrl, options) => goto(targetUrl, options),

    // ── ego 专有路径：显式拒绝（不返回空快照冒充成功）────────────────────
    snapshot: () => unsupported("snapshot"),
    click: () => unsupported("click"),
    fill: () => unsupported("fill"),
    press: () => unsupported("press"),
    selectOption: () => unsupported("selectOption"),

    // ── 内部（非契约）：供 host 生命期与事件跟踪使用 ─────────────────────
    __state: state,
    __tracked: tracked,
    __trackFrame(frame) {
      if (!frame) return;
      if (frame.url) tracked.url = frame.url;
      if (frame.loaderId) tracked.loaderId = frame.loaderId;
    },
    __trackTitle(title) {
      if (typeof title === "string") tracked.title = title;
    },
    __runEvaluate: runEvaluate,
    __assertUsable: assertUsable,
    __releaseAbortListener: releaseAbortListener,
  };

  return page;
}

/**
 * 连接一个外部 Chrome CDP endpoint，返回自有页面的最小宿主。
 *
 * @param {object} options
 * @param {string} options.endpoint  `http(s)://host:port` 或 `ws(s)://…/devtools/browser/<id>`
 * @param {AbortSignal} [options.signal]  取消连接/会话；取消后 page 方法立即失败，close() 仍可清理
 * @param {number} [options.timeoutMs=10000]  连接/发现阶段的超时
 * @param {number} [options.commandTimeoutMs=30000]  单条 CDP 命令无响应的上限（不按“页面在加载”处理）
 * @param {string} [options.url="about:blank"]  新建 target 的初始 URL
 * @param {{width:number,height:number}} [options.viewport=null]  显式设置视口（走
 *   Emulation.setDeviceMetricsOverride）；默认不动宿主视口，交给引擎的退化处理
 * @returns {Promise<{page: object, metadata: object, close: (options?: {keepPage?: boolean}) => Promise<object>}>}
 */
export async function connectCdpHost(options = {}) {
  assertWebSocketRuntime();
  const {
    endpoint,
    signal,
    timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    url: initialUrl = "about:blank",
    viewport = null,
  } = options;

  throwIfAborted(signal, "连接 CDP 宿主");
  const target = normalizeEndpoint(endpoint);

  // ── 1) 发现浏览器级 WebSocket ────────────────────────────────────────
  let wsUrl = target.wsUrl;
  let browserVersion = null;
  if (!wsUrl) {
    const version = await fetchJson(`${target.httpEndpoint}/json/version`, {
      signal,
      timeoutMs,
      what: "读取 CDP /json/version",
    });
    wsUrl = version?.webSocketDebuggerUrl;
    if (!wsUrl) {
      throw new HostProtocolError(
        `${target.httpEndpoint} 没有返回 webSocketDebuggerUrl：这不是可用的浏览器级 CDP endpoint` +
          "（请用 --remote-debugging-port 启动 Chrome，或直接给浏览器级 ws:// 地址）"
      );
    }
    browserVersion = version?.Browser || null;
  }
  throwIfAborted(signal, "连接 CDP 宿主");

  // ── 2) 取消通道：一条 promise，所有在途操作与它 race ──────────────────
  let cancelled = false;
  let cancelReason = null;
  let rejectCancel;
  const cancelPromise = new Promise((_, reject) => {
    rejectCancel = reject;
  });
  cancelPromise.catch(() => {}); // 单独 reject 时不要产生未处理拒绝
  const triggerCancel = () => {
    if (cancelled) return;
    cancelled = true;
    cancelReason = abortError(signal, "宿主操作");
    rejectCancel(cancelReason);
  };
  const onAbort = () => {
    triggerCancel();
    if (pageRef) pageRef.__state.cancelled = true;
  };
  let pageRef = null;
  const cancel = {
    promise: cancelPromise,
    isCancelled: () => cancelled,
    reason: () => cancelReason ?? new HostAbortError("宿主会话已被取消（AbortSignal）"),
    detach: () => signal?.removeEventListener("abort", onAbort),
  };
  // 连接阶段也要能被取消打断：与命令 race，避免一条挂起的请求把 abort 拖到命令超时。
  const abortable = (promise) => Promise.race([promise, cancelPromise]);
  if (signal) {
    if (signal.aborted) throw abortError(signal, "连接 CDP 宿主");
    signal.addEventListener("abort", onAbort, { once: true });
  }

  const connection = new CdpConnection(wsUrl, { commandTimeoutMs });
  let createdTargetId = null;
  let sessionId = null;

  const cleanupPartial = async (reason) => {
    const problems = [];
    if (createdTargetId && !connection.closed) {
      try {
        const res = await connection.send("Target.closeTarget", { targetId: createdTargetId });
        if (res && res.success === false) problems.push("清理时 Target.closeTarget 返回 success:false");
      } catch (err) {
        problems.push(`关闭自有 target 失败：${err?.message || err}`);
      }
    }
    connection.close(reason);
    return problems;
  };

  let page = null;
  // 清理只走这一个 catch：**任何**失败（含取消、就绪探测超时）都会关掉已建 target 与连接。
  try {
    await connection.open({ signal, timeoutMs });
    throwIfAborted(signal, "连接 CDP 宿主");

    // 不传 width/height：新版 Chrome 只在 newWindow 下接受尺寸，且“新建窗口”会抢用户焦点。
    // 需要固定视口时用 Emulation.setDeviceMetricsOverride（下面按需下发）。
    const created = await abortable(connection.send("Target.createTarget", { url: initialUrl }));
    createdTargetId = created?.targetId;
    if (!createdTargetId) throw new HostProtocolError("Target.createTarget 没有返回 targetId");

    const attached = await abortable(
      connection.send("Target.attachToTarget", { targetId: createdTargetId, flatten: true })
    );
    sessionId = attached?.sessionId;
    if (!sessionId) throw new HostProtocolError("Target.attachToTarget 没有返回 sessionId");

    // Page.enable 才能拿到 Page.frameNavigated（导航提交与 url()/title() 的兜底来源）。
    await abortable(connection.send("Page.enable", {}, sessionId));

    if (viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)) {
      await abortable(
        connection.send(
          "Emulation.setDeviceMetricsOverride",
          { width: Math.round(viewport.width), height: Math.round(viewport.height), deviceScaleFactor: 1, mobile: false },
          sessionId
        )
      );
    }

    if (!browserVersion) {
      try {
        const version = await abortable(connection.send("Browser.getVersion"));
        browserVersion = version?.product || null;
      } catch {
        if (cancelled) throw cancel.reason();
        browserVersion = null; // 纯信息，取不到不影响契约
      }
    }

    page = createCdpPage({ connection, sessionId, initialUrl, cancel });
    pageRef = page;

    // ── 事件跟踪：导航提交、title、target 关闭、崩溃 ──
    connection.onMessage((message) => {
      if (!message?.method) return;
      if (message.sessionId === sessionId) {
        if (message.method === "Page.frameNavigated") {
          const frame = message.params?.frame;
          if (frame && !frame.parentId) page.__trackFrame(frame);
          return;
        }
        if (message.method === "Inspector.targetCrashed") {
          page.__state.targetGone = true;
          return;
        }
      }
      if (message.method === "Target.detachedFromTarget" && message.params?.sessionId === sessionId) {
        connection.markSessionGone(sessionId, "Target.detachedFromTarget（target 已被外部关闭）");
        page.__state.targetGone = true;
      }
    });

    // ── 就绪探测：新 target 的默认执行上下文可能延后一点才可用 ──
    const readyBudget = Math.min(timeoutMs, 5_000);
    const readyDeadline = Date.now() + readyBudget;
    let ready = false;
    let lastReadyError = null;
    while (!ready) {
      throwIfAborted(signal, "等待新页面就绪");
      try {
        await abortable(page.__runEvaluate(() => 1, undefined, { timeoutMs: Math.max(25, readyDeadline - Date.now()) }));
        ready = true;
      } catch (err) {
        assertNotCancelledOrRethrow(err);
        lastReadyError = err;
        if (!isNavigationError(err) && err?.code !== "HOST_PROTOCOL_ERROR" && err?.code !== "HOST_COMMAND_STALLED") {
          throw err;
        }
        if (Date.now() >= readyDeadline) {
          throw new HostProtocolError(
            `新 target 在 ${readyBudget}ms 内无法执行脚本：${lastReadyError?.message || lastReadyError}`,
            { cause: lastReadyError }
          );
        }
        await sleep(50);
      }
    }

    // ── 取消的最后一道闸：绝不返回一个“看起来可用”的已取消宿主 ──
    throwIfAborted(signal, "连接 CDP 宿主");
    if (cancelled) throw cancel.reason();
  } catch (err) {
    const problems = await cleanupPartial(cancelled ? "cancelled" : "connect_failed");
    signal?.removeEventListener("abort", onAbort);
    if (problems.length) err.cleanupProblems = problems;
    throw err;
  }

  // 到这里为止全部是同步代码：检查 + 安装监听之间没有 await，不可能漏掉 abort 事件。
  if (signal?.aborted) {
    // 理论上到不了（上面已检查），保守兜底：不能把已取消的宿主交出去。
    page.__state.cancelled = true;
  }

  let closed = false;
  const metadata = {
    contractVersion: HOST_CONTRACT_VERSION,
    host: "cdp",
    ownedPage: true,
    createdTarget: true,
    targetId: createdTargetId,
    sessionId,
    endpoint: wsUrl,
    httpEndpoint: target.httpEndpoint,
    browserVersion,
    initialUrl,
    viewport: viewport ? { ...viewport } : null,
  };

  /**
   * 关闭：默认关自有 target + 断连接；`keepPage: true` 只断连接。
   * 幂等；取消之后同样可用；**从不关闭外部浏览器**。
   * `Target.closeTarget` 的 `success` 会如实反映到结果里。
   */
  async function close({ keepPage = false } = {}) {
    if (closed) {
      return { closed: true, alreadyClosed: true, keptPage: page.__state.keptPage, targetClosed: false };
    }
    closed = true;
    page.__state.closed = true;
    page.__state.keptPage = Boolean(keepPage);
    page.__releaseAbortListener();

    const result = {
      closed: true,
      alreadyClosed: false,
      keptPage: Boolean(keepPage),
      targetId: createdTargetId,
      targetClosed: false,
      browserClosed: false, // 契约：宿主从不关闭外部浏览器
    };

    if (!keepPage) {
      if (page.__state.targetGone) {
        result.targetClosed = true; // 外部已经关掉了，不必再发命令
      } else if (!connection.closed) {
        try {
          const response = await connection.send("Target.closeTarget", { targetId: createdTargetId });
          if (response && typeof response.success === "boolean") {
            result.targetClosed = response.success;
            if (!response.success) result.targetCloseError = "Target.closeTarget 返回 success:false";
          } else {
            // 老版本可能不回 success：命令本身成功即视为已关闭
            result.targetClosed = true;
          }
        } catch (err) {
          result.targetClosed = false;
          result.targetCloseError = String(err?.message || err);
        }
      }
    }
    connection.close(keepPage ? "keep_page" : "close");
    return result;
  }

  assertHostPage(page, { label: "connectCdpHost().page", entry: true });
  return { page, metadata, close };
}

/** 取消时把取消错误原样上抛；其他错误交给调用方决定。 */
function assertNotCancelledOrRethrow(err) {
  if (err instanceof HostError && err.code === "EGO_HOST_ABORTED") throw err;
}

export {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_LOAD_STATE_TIMEOUT_MS,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  WAIT_UNTIL_STATES,
  DOM_PATH_REQUIRED,
  ENTRY_PATH_REQUIRED,
};
