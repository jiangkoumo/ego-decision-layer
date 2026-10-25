// Issue #8 验收：最小 CDP 宿主适配器（scripts/hosts/cdp-host.mjs + host-contract.mjs）。
//
// 为什么要分两段：
//   A 段用**自建的假 CDP 服务器**（node:http + 手写 WebSocket 帧）验证协议层：请求/响应对应、
//     事件路由、超时、取消、断连、close 归属、goto 的“新文档提交”判定与能力边界。完全离线，CI 能跑。
//   B 段用**真实外部 Chrome**（独立临时 profile + 独立进程）验证 evaluate、真实 CDP 点击/输入、
//     导航等待、goto 跨站导航、外部关闭 target 的断连、页面归属与清理，并让引擎
//     `runJevAutonomousLoop` 在默认 DOM 路径上真跑一遍（注入判定器，不联网、不需要凭证）。
//
// 依赖：Node ≥ 22（全局 WebSocket）。B 段需要本机有 Chrome/Chromium；找不到就 SKIP 并单独列出，
// 不用「假通过」冒充真实行为。
//
// 用法:
//   node bench/test-cdp-host.mjs                   # 两段都跑（有 Chrome 时）
//   EGO_CDP_HEADFUL=1 node bench/test-cdp-host.mjs # 用有头 Chrome 跑 B 段（默认 headless）
//   EGO_CDP_CHROME=/path/to/chrome node bench/test-cdp-host.mjs
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(BENCH);
const JE = join(ROOT, "scripts", "decider-loop.mjs");
const HOST = join(ROOT, "scripts", "hosts", "cdp-host.mjs");
const CONTRACT = join(ROOT, "scripts", "hosts", "host-contract.mjs");

let pass = 0;
let fail = 0;
const skips = [];
const check = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
};
const skip = (name, why) => {
  skips.push(`${name} — ${why}`);
  console.log(`  SKIP ${name}（${why}）`);
};
const section = (title) => console.log(`\n${title}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 断言某个调用抛出的错误：返回被捕获的 error 供后续断言，没抛返回 null。 */
async function expectsError(fn, label = "") {
  try {
    await fn();
    return null;
  } catch (err) {
    return err ?? new Error(`${label} 抛出了非 Error 值`);
  }
}

const { connectCdpHost, MIN_NODE_MAJOR, WAIT_UNTIL_STATES } = await import(HOST);
const {
  HOST_CONTRACT_VERSION,
  HOST_CAPABILITY_KEY,
  DOM_PATH_REQUIRED,
  ENTRY_PATH_REQUIRED,
  SNAPSHOT_PATH_MEMBERS,
  HostAbortError,
  HostCapabilityError,
  HostDisconnectedError,
  HostError,
  HostNavigationError,
  HostStalledError,
  HostTimeoutError,
  HostUnsupportedError,
  assertHostPage,
  describeHostCapabilities,
  isNavigationError,
  isTimeoutError,
} = await import(CONTRACT);

/** 引擎 rethrowBrowserStop() 的实际判据：`String(err.code).startsWith("EGO_")`。 */
const engineTreatsAsControlStop = (err) => String(err?.code || "").startsWith("EGO_");

// ════════════════════════════════════════════════════════════════════════════
// 假 CDP 服务器（离线协议层）
// ════════════════════════════════════════════════════════════════════════════

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeTextFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeControlFrame(opcode, payload) {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

/**
 * 最小 CDP 假服务器：只实现本适配器用到的协议面（握手、文本帧、ping/pong、close），
 * 加上按方法名分派响应、事件广播、静默、断连等可编程行为。
 * handler 返回：结果对象 | {__error} | {__stall} | {__close} | Promise<上述之一>
 */
function createFakeCdpServer(options = {}) {
  const state = {
    requests: [],
    httpRequests: [],
    sockets: new Set(),
    handlers: new Map(Object.entries(options.handlers ?? {})),
    wssPath: "/devtools/browser/FAKE",
    browserVersion: options.browserVersion ?? "FakeChrome/1.0",
  };

  const defaultHandler = (msg) => {
    switch (msg.method) {
      case "Target.createTarget":
        return { targetId: "FAKE-TARGET-1" };
      case "Target.attachToTarget":
        return { sessionId: "FAKE-SESSION-1" };
      case "Target.closeTarget":
        return { success: true };
      case "Browser.getVersion":
        return { product: "FakeChrome/1.0", protocolVersion: "1.3" };
      case "Runtime.evaluate":
        return { result: { type: "undefined" } };
      default:
        return {};
    }
  };

  const server = createServer((req, res) => {
    state.httpRequests.push(`${req.method} ${req.url}`);
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          Browser: state.browserVersion,
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}${state.wssPath}`,
        })
      );
      return;
    }
    if (req.url?.startsWith("/json/list")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "FAKE-TARGET-1", type: "page" }]));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(String(key) + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    state.sockets.add(socket);
    const conn = { socket, buffer: Buffer.alloc(0), fragments: [] };
    const send = (message) => {
      try {
        socket.write(encodeTextFrame(JSON.stringify(message)));
      } catch {
        /* 已断开 */
      }
    };
    const closeSocket = () => {
      try {
        socket.destroy();
      } catch {
        /* 已断开 */
      }
      state.sockets.delete(socket);
    };

    socket.on("data", (chunk) => {
      conn.buffer = Buffer.concat([conn.buffer, chunk]);
      for (;;) {
        if (conn.buffer.length < 2) return;
        const b0 = conn.buffer[0];
        const b1 = conn.buffer[1];
        const fin = (b0 & 0x80) !== 0;
        const opcode = b0 & 0x0f;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (conn.buffer.length < 4) return;
          len = conn.buffer.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (conn.buffer.length < 10) return;
          len = Number(conn.buffer.readBigUInt64BE(2));
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (conn.buffer.length < offset + maskLen + len) return;
        const mask = masked ? conn.buffer.subarray(offset, offset + 4) : null;
        const payload = Buffer.from(conn.buffer.subarray(offset + maskLen, offset + maskLen + len));
        if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
        conn.buffer = conn.buffer.subarray(offset + maskLen + len);

        if (opcode === 0x8) {
          closeSocket();
          return;
        }
        if (opcode === 0x9) {
          socket.write(encodeControlFrame(0xa, payload));
          continue;
        }
        if (opcode === 0x1 || opcode === 0x0) {
          conn.fragments.push(payload);
          if (!fin) continue;
          const text = Buffer.concat(conn.fragments).toString("utf8");
          conn.fragments = [];
          handleCommand(text, { send, closeSocket });
        }
      }
    });
    socket.on("error", () => state.sockets.delete(socket));
    socket.on("close", () => state.sockets.delete(socket));
  });

  function handleCommand(text, { send, closeSocket }) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    state.requests.push({ method: msg.method, params: msg.params, sessionId: msg.sessionId, id: msg.id, at: Date.now() });
    const handler = state.handlers.get(msg.method) ?? defaultHandler;
    const outcome = handler(msg, { send, closeSocket, requests: state.requests });
    const finish = (resolved) => {
      if (resolved && resolved.__stall) return;
      if (resolved && resolved.__close) {
        closeSocket();
        return;
      }
      if (resolved && resolved.__error) send({ id: msg.id, error: resolved.__error });
      else send({ id: msg.id, result: resolved ?? {} });
    };
    if (outcome && typeof outcome.then === "function") outcome.then(finish);
    else finish(outcome);
  }

  return {
    state,
    async start() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = server.address().port;
      return {
        httpEndpoint: `http://127.0.0.1:${port}`,
        wsUrl: `ws://127.0.0.1:${port}${state.wssPath}`,
      };
    },
    setHandler(method, fn) {
      state.handlers.set(method, fn);
    },
    requests(method) {
      return state.requests.filter((r) => r.method === method);
    },
    count(method) {
      return this.requests(method).length;
    },
    broadcast(message) {
      const socket = [...state.sockets][0];
      if (!socket) return false;
      try {
        socket.write(encodeTextFrame(JSON.stringify(message)));
        return true;
      } catch {
        return false;
      }
    },
    dropSockets() {
      for (const socket of [...state.sockets]) {
        try {
          socket.destroy();
        } catch {
          /* 已断开 */
        }
        state.sockets.delete(socket);
      }
    },
    async stop() {
      this.dropSockets();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 常用：让 Runtime.evaluate 里的 readyState / location.href 可控。 */
function installDocumentState(fake, { readyState = () => "complete", href = () => "about:blank" } = {}) {
  fake.setHandler("Runtime.evaluate", (msg) => {
    const expression = msg.params.expression;
    if (/readyState/.test(expression)) return { result: { type: "string", value: readyState() } };
    if (/location\.href/.test(expression)) return { result: { type: "string", value: href() } };
    if (/document\.title/.test(expression)) return { result: { type: "string", value: "" } };
    return { result: { type: "undefined" } };
  });
}

// ════════════════════════════════════════════════════════════════════════════
// 0) 契约模块自检（纯函数）
// ════════════════════════════════════════════════════════════════════════════
section("[0] 契约模块自检");
{
  check("契约版本是正整数", Number.isInteger(HOST_CONTRACT_VERSION) && HOST_CONTRACT_VERSION >= 1, String(HOST_CONTRACT_VERSION));
  check(
    "必需方法覆盖引擎默认 DOM 路径的真实调用面",
    ["evaluate", "cdp", "url", "title", "waitForLoadState", "keyboard.press"].every((m) => DOM_PATH_REQUIRED.includes(m)),
    JSON.stringify([...DOM_PATH_REQUIRED])
  );
  check("入口路径包含 goto（runner/CLI 需要）", [...ENTRY_PATH_REQUIRED].join(",") === "goto", JSON.stringify([...ENTRY_PATH_REQUIRED]));
  check("snapshot 路径成员齐全", SNAPSHOT_PATH_MEMBERS.includes("snapshot") && SNAPSHOT_PATH_MEMBERS.includes("click"));

  const full = {
    evaluate() {},
    cdp() {},
    url() {},
    title() {},
    waitForLoadState() {},
    goto() {},
    keyboard: { press() {} },
  };
  const caps = describeHostCapabilities(full);
  check("引擎路径 + goto 齐全 → domPath/entryPath 都为 true", caps.domPath === true && caps.entryPath === true, JSON.stringify(caps));
  check("没有声明时退回结构推断（snapshot 方法齐全 → snapshotPath true）", caps.declared === false && caps.snapshotPath === false, JSON.stringify(caps));
  check("assertHostPage(entry:true) 对完整 page 不抛错", (() => {
    try {
      assertHostPage(full, { entry: true });
      return true;
    } catch {
      return false;
    }
  })());

  // 关键：把不支持的方法实现成「一调用就抛错」的 stub，不能被判成“支持”
  const stubPage = {
    ...full,
    [HOST_CAPABILITY_KEY]: { domPath: true, entryPath: true, snapshotPath: false, unsupported: [...SNAPSHOT_PATH_MEMBERS] },
  };
  for (const name of SNAPSHOT_PATH_MEMBERS) stubPage[name] = () => { throw new HostCapabilityError("不提供"); };
  const stubCaps = describeHostCapabilities(stubPage);
  check(
    "声明了不支持的 stub 方法 → snapshotPath false（不能靠“有函数”判断）",
    stubCaps.declared === true && stubCaps.snapshotPath === false,
    JSON.stringify(stubCaps)
  );
  check("声明的 unsupported 原样暴露", stubCaps.unsupported.length === SNAPSHOT_PATH_MEMBERS.length, JSON.stringify(stubCaps.unsupported));

  const broken = { evaluate() {}, cdp() {} };
  const brokenCaps = describeHostCapabilities(broken);
  check("缺方法 → domPath false 且 missing 精确", brokenCaps.domPath === false && brokenCaps.missing.length === 5, JSON.stringify(brokenCaps.missing));
  const brokenErr = await expectsError(() => assertHostPage(broken, { label: "假 page" }));
  check("assertHostPage 缺方法 → HostCapabilityError", brokenErr instanceof HostCapabilityError, String(brokenErr));
  check(
    "assertHostPage 错误里带缺失清单",
    brokenErr?.details?.missing?.includes("waitForLoadState") && /waitForLoadState/.test(brokenErr?.message || ""),
    JSON.stringify(brokenErr?.details?.missing)
  );
  const withoutGoto = { evaluate() {}, cdp() {}, url() {}, title() {}, waitForLoadState() {}, keyboard: { press() {} } };
  const entryErr = await expectsError(() => assertHostPage(withoutGoto, { entry: true, label: "无 goto 的 page" }));
  check("缺 goto → 入口自检失败并点名 goto", /goto/.test(entryErr?.message || "") && entryErr?.details?.missing?.includes("goto"), String(entryErr?.message));

  const navText = "Execution context was destroyed, most likely because of a navigation.";
  check("isNavigationError 认 Chrome 的导航原文", isNavigationError(new Error(navText)) === true);
  check("isNavigationError 不误判普通错误", isNavigationError(new Error("boom")) === false);
  check(
    "isTimeoutError 与引擎 requireWaitTimeout 同判据（name + message）",
    isTimeoutError({ name: "TimeoutError", message: "x" }) === true && isTimeoutError(new Error("waitForLoadState timed out")) === true
  );

  const nonAbortErrors = [
    new HostError("x"),
    new HostCapabilityError("x"),
    new HostDisconnectedError("x"),
    new HostStalledError("x"),
    new HostTimeoutError("x"),
    new HostUnsupportedError("x"),
    new HostNavigationError("x"),
  ];
  check(
    "除取消外所有错误码都是 HOST_ 前缀（不能带 EGO_，否则等待超时会被当控制停止）",
    nonAbortErrors.every((err) => /^HOST_/.test(err.code) && !engineTreatsAsControlStop(err))
  );
  const abortErr = new HostAbortError("x");
  check(
    "取消是唯一 EGO_ 码：引擎 rethrowBrowserStop 会直接上抛（不会被当导航/步骤失败吞掉）",
    engineTreatsAsControlStop(abortErr) && abortErr.code === "EGO_HOST_ABORTED",
    String(abortErr.code)
  );
  check("HostTimeoutError 的 name 是 TimeoutError（引擎靠这个认等待超时）", new HostTimeoutError("x").name === "TimeoutError");
  check("HostStalledError 不会被误认成等待超时（不能当成页面还在加载）", isTimeoutError(new HostStalledError("命令无响应")) === false);
  check("HostAbortError 不会被误认成等待超时", isTimeoutError(abortErr) === false);
  check("goto 的 waitUntil 白名单不含 networkidle（不假装实现）", !WAIT_UNTIL_STATES.includes("networkidle0") && WAIT_UNTIL_STATES.includes("commit"), JSON.stringify([...WAIT_UNTIL_STATES]));
}

// ════════════════════════════════════════════════════════════════════════════
// 1) 协议层：连接、自有 target、入口自检
// ════════════════════════════════════════════════════════════════════════════
section("[1] 协议层：连接与自有 target");
{
  const fake = createFakeCdpServer();
  const { httpEndpoint, wsUrl } = await fake.start();
  const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
  const methods = fake.state.requests.map((r) => r.method);
  check("http endpoint 走 /json/version 发现浏览器级 ws", fake.state.httpRequests.includes("GET /json/version"), JSON.stringify(fake.state.httpRequests));
  check("默认新建自有 target（Target.createTarget）", methods.includes("Target.createTarget"), JSON.stringify(methods.slice(0, 6)));
  check("metadata.createdTarget === true", host.metadata.createdTarget === true && host.metadata.ownedPage === true, JSON.stringify(host.metadata));
  check("metadata.targetId / sessionId 与服务器返回一致", host.metadata.targetId === "FAKE-TARGET-1" && host.page.sessionId === "FAKE-SESSION-1", JSON.stringify(host.metadata));
  const attach = fake.requests("Target.attachToTarget")[0];
  check("attachToTarget 用 flatten:true", attach?.params?.flatten === true, JSON.stringify(attach?.params));
  check("attachToTarget 不带 sessionId（浏览器级命令）", attach?.sessionId === undefined, String(attach?.sessionId));
  check("Page.enable 带上 sessionId（页面级命令）", fake.requests("Page.enable")[0]?.sessionId === "FAKE-SESSION-1", String(fake.requests("Page.enable")[0]?.sessionId));
  check("不抢焦点、不关浏览器", !methods.includes("Target.activateTarget") && !methods.includes("Page.bringToFront") && !methods.includes("Browser.close"), JSON.stringify(methods));

  const caps = describeHostCapabilities(host.page);
  check("connectCdpHost 返回值通过入口自检（含 goto）", caps.domPath === true && caps.entryPath === true && caps.missing.length === 0, JSON.stringify(caps));
  check("page 自述能力（declared=true）", caps.declared === true, JSON.stringify(caps));

  const before = fake.state.httpRequests.length;
  const host2 = await connectCdpHost({ endpoint: wsUrl, timeoutMs: 3000 });
  check("ws:// 直连不需要 /json/version", fake.state.httpRequests.length === before, JSON.stringify(fake.state.httpRequests.slice(before)));
  check("ws:// 直连也能拿到 browserVersion（Browser.getVersion）", host2.metadata.browserVersion === "FakeChrome/1.0", String(host2.metadata.browserVersion));
  await host2.close();
  await host.close();
  await fake.stop();
}

section("[2] 协议层：请求/响应对应（乱序也各归各的）+ 单命令超时");
{
  const fake = createFakeCdpServer();
  const { httpEndpoint } = await fake.start();
  fake.setHandler("Fake.slow", () => new Promise((resolve) => setTimeout(() => resolve({ marker: "slow" }), 80)));
  fake.setHandler("Fake.fast", () => ({ marker: "fast" }));
  const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
  const [slow, fast] = await Promise.all([host.page.cdp("Fake.slow", { n: 1 }), host.page.cdp("Fake.fast", { n: 2 })]);
  check("乱序响应各自对应自己的请求", slow?.marker === "slow" && fast?.marker === "fast", JSON.stringify({ slow, fast }));
  check("params 原样透传", fake.requests("Fake.slow")[0]?.params?.n === 1, JSON.stringify(fake.requests("Fake.slow")[0]?.params));
  check("page.cdp 带 sessionId", fake.requests("Fake.fast")[0]?.sessionId === "FAKE-SESSION-1", String(fake.requests("Fake.fast")[0]?.sessionId));

  fake.setHandler("Fake.err", () => ({ __error: { code: -32000, message: "boom from CDP" } }));
  const cdpErr = await expectsError(() => host.page.cdp("Fake.err"));
  check("CDP error → HostProtocolError 且 message 含方法名与原文", cdpErr?.code === "HOST_PROTOCOL_ERROR" && /Fake\.err/.test(cdpErr.message) && /boom from CDP/.test(cdpErr.message), String(cdpErr));
  check("CDP 错误码保留在 cdpCode", cdpErr?.cdpCode === -32000, String(cdpErr?.cdpCode));

  // 单命令超时覆盖：默认 30s 的命令超时必须能被调用点收窄
  fake.setHandler("Fake.hang", () => ({ __stall: true }));
  const stalledAt = Date.now();
  const stalled = await expectsError(() => host.page.cdp("Fake.hang", {}, { timeoutMs: 120 }));
  const stalledMs = Date.now() - stalledAt;
  check("page.cdp 支持单命令 timeoutMs 覆盖默认 30s", stalled?.code === "HOST_COMMAND_STALLED" && stalledMs < 800, `${stalledMs}ms / ${stalled?.code}`);
  check("卡死不是等待超时（不会被当成页面还在加载）", isTimeoutError(stalled) === false, String(stalled?.name));
  await host.close();
  await fake.stop();
}

section("[3] 协议层：evaluate 语义");
{
  const fake = createFakeCdpServer();
  const { httpEndpoint } = await fake.start();
  const seen = [];
  fake.setHandler("Runtime.evaluate", (msg) => {
    seen.push(msg.params);
    const expression = msg.params.expression;
    if (/throw/.test(expression)) {
      return { exceptionDetails: { text: "Uncaught", exception: { description: "Error: boom-42\n    at <anonymous>:1:1" } } };
    }
    if (/destroyed/.test(expression)) {
      return {
        exceptionDetails: {
          text: "Uncaught",
          exception: { description: "Execution context was destroyed, most likely because of a navigation." },
        },
      };
    }
    if (/unserializable/.test(expression)) return { result: { type: "object", className: "HTMLElement" } };
    if (/nan/.test(expression)) return { result: { type: "number", unserializableValue: "NaN" } };
    if (/undefined/.test(expression)) return { result: { type: "undefined" } };
    return { result: { type: "object", value: { ok: true, n: 7 } } };
  });
  const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });

  const result = await host.page.evaluate((a, b) => ({ ok: true, n: a + b }), [3, 4]);
  const firstExpression = seen[seen.length - 1]?.expression || "";
  check("evaluate 把函数源码与 JSON 参数组成页面表达式", /\(a, b\) =>/.test(firstExpression) && /\[3,4\]/.test(firstExpression), firstExpression.slice(0, 120));
  check("evaluate 走 returnByValue / awaitPromise", seen[seen.length - 1]?.returnByValue === true && seen[seen.length - 1]?.awaitPromise === true);
  check("evaluate 返回反序列化后的值", result?.ok === true && result?.n === 7, JSON.stringify(result));

  await host.page.evaluate(() => 1);
  check("无参数 evaluate 组成 ()()", /\)\(\)$/.test(seen[seen.length - 1].expression), seen[seen.length - 1].expression.slice(-20));
  check("evaluate 返回值 undefined 时得到 undefined", (await host.page.evaluate(() => undefined)) === undefined);

  const thrown = await expectsError(() => host.page.evaluate(() => { throw new Error("boom-42"); }));
  check("页面内抛错 → HostEvaluationError 且保留原文", thrown?.code === "HOST_EVALUATE_ERROR" && /boom-42/.test(thrown.message), String(thrown?.message));

  const navigated = await expectsError(() => host.page.evaluate(() => { /* destroyed */ }));
  check("导航销毁上下文 → 错误文本匹配引擎的导航判据", isNavigationError(navigated) === true, String(navigated?.message));
  check("导航销毁上下文 → 带 navigation 标记且不是控制停止", navigated?.navigation === true && !engineTreatsAsControlStop(navigated), String(navigated?.code));

  const bad = await expectsError(() => host.page.evaluate(() => { /* unserializable */ }));
  check("不可序列化返回值 → 显式报错（不静默返回 undefined）", /不可按 JSON 序列化/.test(bad?.message || ""), String(bad?.message));

  const nanValue = await host.page.evaluate(() => { /* nan */ });
  check("unserializableValue NaN → NaN", Number.isNaN(nanValue), String(nanValue));
  await host.close();
  await fake.stop();
}

section("[4] 协议层：事件路由（导航期间 url() 用事件兜底）");
{
  const fake = createFakeCdpServer();
  const { httpEndpoint } = await fake.start();
  let destroyed = false;
  fake.setHandler("Runtime.evaluate", (msg) => {
    if (/location\.href/.test(msg.params.expression) && destroyed) {
      return { exceptionDetails: { text: "Uncaught", exception: { description: "Execution context was destroyed." } } };
    }
    return { result: { type: "string", value: "http://live.test/current" } };
  });
  const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
  check("evaluate 正常时 url() 返回实时值", (await host.page.url()) === "http://live.test/current");

  destroyed = true;
  fake.broadcast({
    method: "Page.frameNavigated",
    sessionId: "FAKE-SESSION-1",
    params: { frame: { id: "F1", url: "http://tracked.test/after-nav", loaderId: "L1", securityOrigin: "http://tracked.test" } },
  });
  await sleep(30);
  check("导航中 evaluate 失败 → url() 用 frameNavigated 兜底而不是抛错", (await host.page.url()) === "http://tracked.test/after-nav", String(await host.page.url()));

  fake.broadcast({
    method: "Page.frameNavigated",
    sessionId: "OTHER-SESSION",
    params: { frame: { id: "F9", url: "http://evil.test/other-session", loaderId: "L9" } },
  });
  await sleep(30);
  check("别的 session 的事件被忽略", (await host.page.url()) === "http://tracked.test/after-nav", String(await host.page.url()));

  fake.broadcast({
    method: "Page.frameNavigated",
    sessionId: "FAKE-SESSION-1",
    params: { frame: { id: "SUB", url: "http://iframe.test/inside", parentId: "F1", loaderId: "L2" } },
  });
  await sleep(30);
  check("子 frame 的导航不覆盖主 frame URL", (await host.page.url()) === "http://tracked.test/after-nav", String(await host.page.url()));
  await host.close();
  await fake.stop();
}

section("[5] 协议层：waitForLoadState（含探针预算）");
{
  const fake = createFakeCdpServer();
  const { httpEndpoint } = await fake.start();
  let readyState = "complete";
  installDocumentState(fake, { readyState: () => readyState });
  const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });

  const startedAt = Date.now();
  await host.page.waitForLoadState("load", { timeout: 2000 });
  check("已完成 → 立即返回（不等到超时）", Date.now() - startedAt < 300, `${Date.now() - startedAt}ms`);

  readyState = "loading";
  const timeouts = Date.now();
  const err = await expectsError(() => host.page.waitForLoadState("load", { timeout: 200 }));
  const elapsed = Date.now() - timeouts;
  check("未完成 → 抛 TimeoutError", err instanceof HostTimeoutError && err.name === "TimeoutError", String(err));
  check("超时消息含 timed out（引擎 requireWaitTimeout 判据）", /timed out/.test(err?.message || ""), String(err?.message));
  check("超时按 timeout 参数兑现（+0~400ms 容差）", elapsed >= 190 && elapsed < 600, `${elapsed}ms`);
  check("超时错误码不是控制停止（否则上抛成致命错误）", !engineTreatsAsControlStop(err), String(err?.code));

  // 关键：readyState 探针自己卡住时，也必须按等待预算收尾，不能把 250ms 拖成命令超时 30s
  fake.setHandler("Runtime.evaluate", () => ({ __stall: true }));
  const stallAt = Date.now();
  const stallErr = await expectsError(() => host.page.waitForLoadState("load", { timeout: 200 }));
  const stallMs = Date.now() - stallAt;
  check("探针卡住 → 仍按等待预算抛 HostTimeoutError（不放大到 30s 命令超时）", stallErr?.code === "HOST_TIMEOUT" && stallMs < 900, `${stallMs}ms / ${stallErr?.code}`);
  check("探针卡住的错误信息区分了“探针没返回”", /探针/.test(stallErr?.message || ""), String(stallErr?.message));
  await host.close();
  await fake.stop();
}

section("[6] 协议层：goto 必须等新文档提交");
{
  // 6a) 旧文档已经 readyState=complete —— goto 不能据此判成功
  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    fake.setHandler("Page.getFrameTree", () => ({ frameTree: { frame: { id: "F1", loaderId: "L1", url: "about:blank" } } }));
    let committed = false;
    let navigatedAt = 0;
    installDocumentState(fake, {
      readyState: () => "complete", // 旧文档一直是 complete
      href: () => (committed ? "http://nav.test/page" : "about:blank"),
    });
    fake.setHandler("Page.navigate", (msg) => {
      setTimeout(() => {
        committed = true;
        navigatedAt = Date.now();
        fake.broadcast({
          method: "Page.frameNavigated",
          sessionId: "FAKE-SESSION-1",
          params: { frame: { id: "F1", loaderId: "L2", url: msg.params.url } },
        });
      }, 150);
      return { frameId: "F1", loaderId: "L2" };
    });
    const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
    const startedAt = Date.now();
    const result = await host.page.goto("http://nav.test/page", { waitUntil: "load", timeout: 5000 });
    const elapsed = Date.now() - startedAt;
    check("goto 等到新文档提交才返回（旧文档 complete 不算成功）", committed === true && elapsed >= 140, `${elapsed}ms, navigatedAt=${navigatedAt ? navigatedAt - startedAt : "n/a"}`);
    check("goto 先问导航前的 loaderId（Page.getFrameTree）", fake.count("Page.getFrameTree") === 1, String(fake.count("Page.getFrameTree")));
    check("goto 返回最终 URL 与 loaderId", result.url === "http://nav.test/page" && result.loaderId === "L2" && result.sameDocument === false, JSON.stringify(result));
    check("goto 用 Page.navigate 发起（不是只切 readyState）", fake.count("Page.navigate") === 1, String(fake.count("Page.navigate")));
    await host.close();
    await fake.stop();
  }

  // 6b) 导航被浏览器拒绝
  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    installDocumentState(fake);
    fake.setHandler("Page.navigate", () => ({ frameId: "F1", errorText: "net::ERR_NAME_NOT_RESOLVED" }));
    const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
    const err = await expectsError(() => host.page.goto("http://nope.invalid/", { timeout: 2000 }));
    check("导航被拒绝 → HostNavigationError 且带 errorText", err instanceof HostNavigationError && /ERR_NAME_NOT_RESOLVED/.test(err.message), String(err?.message));
    check("导航失败不是控制停止、也不是等待超时", !engineTreatsAsControlStop(err) && !isTimeoutError(err), String(err?.code));
    await host.close();
    await fake.stop();
  }

  // 6c) 新文档始终不提交 → 按 timeout 收尾
  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    installDocumentState(fake);
    fake.setHandler("Page.navigate", () => ({ frameId: "F1", loaderId: "L2" })); // 永不广播 frameNavigated
    const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
    const startedAt = Date.now();
    const err = await expectsError(() => host.page.goto("http://slow.test/", { waitUntil: "load", timeout: 250 }));
    const elapsed = Date.now() - startedAt;
    check("等不到提交 → HostTimeoutError", err?.code === "HOST_TIMEOUT" && /等不到新文档提交/.test(err?.message || ""), String(err?.message));
    check("等提交的超时按 timeout 兑现", elapsed >= 240 && elapsed < 900, `${elapsed}ms`);
    await host.close();
    await fake.stop();
  }

  // 6d) waitUntil: "commit" 只等提交
  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    fake.setHandler("Page.getFrameTree", () => ({ frameTree: { frame: { id: "F1", loaderId: "L1", url: "about:blank" } } }));
    let committed = false;
    installDocumentState(fake, {
      readyState: () => (committed ? "loading" : "complete"), // 提交后一直 loading
      href: () => (committed ? "http://commit.test/" : "about:blank"),
    });
    fake.setHandler("Page.navigate", () => {
      setTimeout(() => {
        committed = true;
        fake.broadcast({ method: "Page.frameNavigated", sessionId: "FAKE-SESSION-1", params: { frame: { id: "F1", loaderId: "L2", url: "http://commit.test/" } } });
      }, 60);
      return { frameId: "F1", loaderId: "L2" };
    });
    const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
    const startedAt = Date.now();
    const result = await host.page.goto("http://commit.test/", { waitUntil: "commit", timeout: 3000 });
    const elapsed = Date.now() - startedAt;
    check('waitUntil:"commit" 提交即返回（不等 loading → complete）', result.waitUntil === "commit" && elapsed < 1200 && elapsed >= 50, `${elapsed}ms`);
    await host.close();
    await fake.stop();
  }

  // 6e) 不支持的 waitUntil 明确拒绝
  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    installDocumentState(fake);
    const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
    const err = await expectsError(() => host.page.goto("http://x.test/", { waitUntil: "networkidle0", timeout: 1000 }));
    check("waitUntil 不支持 → HostCapabilityError（不假装实现 networkidle）", err instanceof HostCapabilityError, String(err?.message));
    check("拒绝时不发起导航", fake.count("Page.navigate") === 0, String(fake.count("Page.navigate")));
    await host.close();
    await fake.stop();
  }

  // 6f) 同文档导航（无 loaderId）：按最终 URL 判定
  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    let href = "http://spa.test/page";
    installDocumentState(fake, { readyState: () => "complete", href: () => href });
    fake.setHandler("Page.navigate", (msg) => {
      href = msg.params.url;
      return { frameId: "F1" }; // 同文档导航：Chrome 不返回 loaderId
    });
    const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
    const result = await host.page.goto("http://spa.test/page#section", { waitUntil: "domcontentloaded", timeout: 2000 });
    check("同文档导航 → sameDocument 标记 + URL 落地", result.sameDocument === true && href === "http://spa.test/page#section", JSON.stringify(result));
    await host.close();
    await fake.stop();
  }
}

section("[7] 协议层：取消（AbortSignal）与取消后的清理");
{
  // 7a) 连接前就取消：一个命令都不该发
  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    const controller = new AbortController();
    controller.abort();
    const err = await expectsError(() => connectCdpHost({ endpoint: httpEndpoint, signal: controller.signal, timeoutMs: 2000 }));
    check("已取消的 signal → 直接 HostAbortError", err instanceof HostAbortError && engineTreatsAsControlStop(err), String(err));
    check("连接前取消 → 不发任何 CDP 命令、不碰 http", fake.state.requests.length === 0 && fake.state.httpRequests.length === 0);
    await fake.stop();
  }

  // 7b) 连接中途取消（attach 挂住）：必须清掉已建的自有 target
  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    fake.setHandler("Target.attachToTarget", () => ({ __stall: true }));
    const controller = new AbortController();
    const pending = connectCdpHost({ endpoint: httpEndpoint, signal: controller.signal, timeoutMs: 5000 });
    await sleep(120);
    controller.abort();
    const err = await expectsError(() => pending);
    check("连接中途取消 → HostAbortError（不挂到命令超时）", err instanceof HostAbortError, String(err));
    await sleep(80);
    check("取消清理：关掉已创建的自有 target", fake.count("Target.closeTarget") === 1, JSON.stringify(fake.state.requests.map((r) => r.method)));
    check("取消清理：不关闭外部浏览器", fake.count("Browser.close") === 0);
    await fake.stop();
  }

  // 7c) 连接成功后取消：page 立即失败（在途命令也立刻拒绝），close 仍然可清理
  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    fake.setHandler("Fake.hang", () => ({ __stall: true }));
    const controller = new AbortController();
    const host = await connectCdpHost({ endpoint: httpEndpoint, signal: controller.signal, timeoutMs: 3000 });
    const inflight = expectsError(() => host.page.cdp("Fake.hang"));
    await sleep(50);
    const abortAt = Date.now();
    controller.abort();
    const inflightErr = await inflight;
    const rejectMs = Date.now() - abortAt;
    check("在途命令在取消时立刻拒绝（不等 30s 命令超时）", inflightErr?.code === "EGO_HOST_ABORTED" && rejectMs < 500, `${rejectMs}ms / ${inflightErr?.code}`);
    const afterErr = await expectsError(() => host.page.evaluate(() => 1));
    check("取消后 page.evaluate → HostAbortError（控制停止，不静默继续）", afterErr?.code === "EGO_HOST_ABORTED", String(afterErr?.code));
    const gotoErr = await expectsError(() => host.page.goto("http://x.test/", { timeout: 1000 }));
    check("取消后 page.goto 同样拒绝", gotoErr?.code === "EGO_HOST_ABORTED", String(gotoErr?.code));
    const closed = await host.close();
    check("取消后 close() 仍能关闭自有 target", closed.targetClosed === true, JSON.stringify(closed));
    check("取消后 close() 发出 Target.closeTarget", fake.count("Target.closeTarget") === 1, JSON.stringify(fake.state.requests.map((r) => r.method)));
    await fake.stop();
  }

  // 7d) 取消发生在 keyDown 与 keyUp 之间：keyUp 只做收尾，不是新副作用
  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    fake.setHandler("Input.dispatchKeyEvent", (msg) => {
      if (msg.params.type === "keyDown" || msg.params.type === "rawKeyDown") {
        return new Promise((resolve) => setTimeout(() => resolve({}), 80));
      }
      return {};
    });
    const controller = new AbortController();
    const host = await connectCdpHost({ endpoint: httpEndpoint, signal: controller.signal, timeoutMs: 3000 });
    const press = expectsError(() => host.page.keyboard.press("Enter"));
    await sleep(30);
    controller.abort();
    const pressErr = await press;
    await sleep(150);
    const keyEvents = fake.requests("Input.dispatchKeyEvent");
    const types = keyEvents.map((r) => r.params.type);
    const downCount = types.filter((t) => t === "keyDown" || t === "rawKeyDown").length;
    check("取消期间按键 → press 以控制停止结束", pressErr?.code === "EGO_HOST_ABORTED", String(pressErr?.code));
    check("keyDown 已派发后仍补发 keyUp（避免页面留一个卡住的按键）", downCount === 1 && types.includes("keyUp"), JSON.stringify(types));
    check("keyUp 之后不再派发新动作", downCount === 1, JSON.stringify(types));
    await host.close();
    await fake.stop();
  }
}

section("[8] 协议层：断连");
{
  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    fake.setHandler("Fake.hang", () => ({ __stall: true }));
    const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
    const inflight = expectsError(() => host.page.cdp("Fake.hang"));
    await sleep(60);
    fake.dropSockets();
    const err = await inflight;
    check("断连时在途请求 → HostDisconnectedError", err?.code === "HOST_DISCONNECTED" && /Fake\.hang/.test(err?.message || ""), String(err?.message));
    const after = await expectsError(() => host.page.evaluate(() => 1));
    check("断连后 page.evaluate → HostDisconnectedError", after?.code === "HOST_DISCONNECTED", String(after?.code));
    check("断连后 close() 不抛错（幂等收尾）", (await expectsError(() => host.close())) === null);
    await fake.stop();
  }

  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
    fake.broadcast({ method: "Target.detachedFromTarget", params: { sessionId: "FAKE-SESSION-1", targetId: "FAKE-TARGET-1" } });
    await sleep(40);
    const err = await expectsError(() => host.page.evaluate(() => 1));
    check("target 被外部关闭 → 后续调用 HostDisconnectedError", err?.code === "HOST_DISCONNECTED", String(err?.code));
    const closed = await host.close();
    check("target 已消失时 close() 视为已关闭（不重复发命令）", closed.targetClosed === true && fake.count("Target.closeTarget") === 0, JSON.stringify({ closed, sends: fake.count("Target.closeTarget") }));
    await fake.stop();
  }
}

section("[9] 协议层：close 归属语义（自有 target / 不关浏览器 / success 如实）");
{
  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
    const closed = await host.close();
    const closeTargets = fake.requests("Target.closeTarget");
    check("默认 close 关闭自有 target", closeTargets.length === 1 && closeTargets[0].params.targetId === "FAKE-TARGET-1", JSON.stringify(closeTargets));
    check("close 结果说明关了 target、没关浏览器", closed.targetClosed === true && closed.browserClosed === false && closed.keptPage === false, JSON.stringify(closed));
    check("从不调用 Browser.close", fake.count("Browser.close") === 0);
    const again = await host.close();
    check("close 幂等（再次调用 alreadyClosed）", again.alreadyClosed === true && fake.requests("Target.closeTarget").length === 1, JSON.stringify(again));
    const afterClose = await expectsError(() => host.page.evaluate(() => 1));
    check("close 之后 page 方法 → HostDisconnectedError", afterClose?.code === "HOST_DISCONNECTED", String(afterClose?.code));
    await fake.stop();
  }

  {
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
    const closed = await host.close({ keepPage: true });
    check("keepPage:true 不发 Target.closeTarget", fake.count("Target.closeTarget") === 0, JSON.stringify(fake.state.requests.map((r) => r.method)));
    check("keepPage:true 结果 keptPage=true / targetClosed=false", closed.keptPage === true && closed.targetClosed === false, JSON.stringify(closed));
    await fake.stop();
  }

  {
    // Chrome 返回 success:false 时必须如实报告，不能报成“已关闭”
    const fake = createFakeCdpServer();
    const { httpEndpoint } = await fake.start();
    fake.setHandler("Target.closeTarget", () => ({ success: false }));
    const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
    const closed = await host.close();
    check("Target.closeTarget 返回 success:false → targetClosed 为 false", closed.targetClosed === false, JSON.stringify(closed));
    check("success:false 会留下可核对的 targetCloseError", typeof closed.targetCloseError === "string" && /success:false/.test(closed.targetCloseError), String(closed.targetCloseError));
    await fake.stop();
  }
}

section("[10] 协议层：能力边界（snapshot / ref 路径显式拒绝）");
{
  const fake = createFakeCdpServer();
  const { httpEndpoint } = await fake.start();
  const host = await connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 3000 });
  const caps = describeHostCapabilities(host.page);
  check("cdp-host 的 page 满足默认 DOM 路径 + 入口路径", caps.domPath === true && caps.entryPath === true && caps.missing.length === 0, JSON.stringify(caps));
  check(
    "page 上有 snapshot 方法，但能力声明仍是不支持（不能靠“有函数”判断）",
    typeof host.page.snapshot === "function" && caps.snapshotPath === false && caps.unsupported.length === SNAPSHOT_PATH_MEMBERS.length,
    JSON.stringify({ hasSnapshot: typeof host.page.snapshot, caps })
  );

  for (const method of SNAPSHOT_PATH_MEMBERS) {
    const before = fake.state.requests.length;
    const err = await expectsError(() => host.page[method]("ref=1"));
    check(`page.${method}() → HostCapabilityError（显式说明不支持）`, err instanceof HostCapabilityError && new RegExp(method).test(err.message), String(err?.message));
    check(`page.${method}() 不产生任何 CDP 请求（不是静默降级）`, fake.state.requests.length === before, `${fake.state.requests.length - before} 条`);
  }
  const keyErr = await expectsError(() => host.page.keyboard.press("Tab"));
  check("未映射按键 → HostCapabilityError（不假装按下）", keyErr instanceof HostCapabilityError, String(keyErr?.message));
  await host.close();
  await fake.stop();
}

section("[11] 运行时不支持：没有 WebSocket 就显式拒绝");
{
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const fake = createFakeCdpServer();
  const { httpEndpoint } = await fake.start();
  let err = null;
  try {
    Object.defineProperty(globalThis, "WebSocket", { value: undefined, configurable: true, writable: true });
    err = await expectsError(() => connectCdpHost({ endpoint: httpEndpoint, timeoutMs: 1000 }));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "WebSocket", descriptor);
    else globalThis.WebSocket = undefined;
  }
  check("没有 WebSocket → HostUnsupportedError", err instanceof HostUnsupportedError && err.code === "HOST_UNSUPPORTED", String(err));
  check("拒绝信息点明需要 Node ≥ 22", new RegExp(`Node ≥ ${MIN_NODE_MAJOR}`).test(err?.message || ""), String(err?.message));
  check("缺运行能力时不发起半残连接", fake.state.requests.length === 0 && fake.state.httpRequests.length === 0, JSON.stringify(fake.state.httpRequests));
  await fake.stop();
}

// ════════════════════════════════════════════════════════════════════════════
// B) 真实外部 Chrome
// ════════════════════════════════════════════════════════════════════════════

function findChromeBinary() {
  const direct = [
    process.env.EGO_CDP_CHROME,
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const candidate of direct) if (existsSync(candidate)) return candidate;

  // 测试缓存里的 Chromium（Playwright / Puppeteer 下载目录）：只在标准缓存目录里找，不猜路径。
  const cacheRoots = [
    process.env.HOME ? join(process.env.HOME, "Library", "Caches", "ms-playwright") : null,
    process.env.HOME ? join(process.env.HOME, ".cache", "ms-playwright") : null,
    process.env.HOME ? join(process.env.HOME, ".cache", "puppeteer") : null,
  ].filter(Boolean);
  const relative = [
    ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ["chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
    ["chrome-linux", "chrome"],
    ["chrome-win", "chrome.exe"],
  ];
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      for (const parts of relative) {
        const candidate = join(root, entry, ...parts);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

const FIXTURE_HTML = (nextUrl) => `<!doctype html>
<html><head><meta charset="utf-8"><title>CDP Host Fixture</title></head>
<body style="font-family:system-ui,sans-serif;margin:24px">
  <h1 id="heading" style="font-size:20px">CDP Host Fixture</h1>
  <form id="form" onsubmit="event.preventDefault(); window.__submitted=(window.__submitted||0)+1">
    <input id="q" name="q" aria-label="查询框" placeholder="查询框" style="width:240px;height:34px;font-size:14px">
  </form>
  <button id="go" type="button" style="width:140px;height:40px;margin-top:12px"
    onclick="window.__clicked=(window.__clicked||0)+1">开始</button>
  <a id="next" href="${nextUrl}" style="display:block;width:140px;height:28px;margin-top:12px">下一页</a>
</body></html>`;

const NEXT_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Second Page</title></head>
<body style="margin:24px"><h1 id="second">Second Page</h1>
<button id="second-btn" style="width:160px;height:40px" onclick="window.__secondClicked=(window.__secondClicked||0)+1">第二页按钮</button>
</body></html>`;

async function startFixtureServer() {
  const server = createServer((req, res) => {
    const port = server.address().port;
    const path = (req.url || "/").split("?")[0];
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (path === "/next.html") res.end(NEXT_HTML);
    else res.end(FIXTURE_HTML(`http://localhost:${port}/next.html`));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    crossSiteUrl: `http://localhost:${port}/next.html`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function launchChrome(binary, { headless = true } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "ego-cdp-host-"));
  const args = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    "--window-size=1280,900",
  ];
  if (headless) args.push("--headless=new");
  args.push("about:blank");
  const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 8000) stderr += String(chunk);
  });
  const activePortFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  let contents = null;
  while (Date.now() < deadline) {
    if (existsSync(activePortFile)) {
      try {
        contents = readFileSync(activePortFile, "utf8");
        if (contents.trim()) break;
      } catch {
        /* 还没写完 */
      }
    }
    if (child.exitCode !== null) break;
    await sleep(50);
  }
  if (!contents) {
    child.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    throw new Error(`Chrome 没能给出 DevToolsActivePort（exit=${child.exitCode}）：${stderr.slice(0, 500)}`);
  }
  return {
    child,
    pid: child.pid,
    profile,
    httpEndpoint: `http://127.0.0.1:${contents.split("\n")[0].trim()}`,
    stderr: () => stderr,
  };
}

async function stopChrome(handle) {
  const { child, pid, profile } = handle;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (!exited()) {
    child.kill("SIGTERM");
    for (let i = 0; i < 100 && !exited(); i += 1) await sleep(50);
    if (!exited()) {
      child.kill("SIGKILL");
      for (let i = 0; i < 60 && !exited(); i += 1) await sleep(50);
    }
  }
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  return { pid, alive, profileRemoved: !existsSync(profile) };
}

const chromeBinary = findChromeBinary();
const headless = process.env.EGO_CDP_HEADFUL !== "1";

if (!chromeBinary) {
  skip("B 段：真实外部 Chrome", "本机没有找到 Chrome/Chromium（可用 EGO_CDP_CHROME=<路径> 指定）");
} else {
  section(`[B] 真实外部 Chrome：${chromeBinary}`);
  const { dispatchClick, runJevAutonomousLoop } = await import(JE);
  const fixture = await startFixtureServer();
  let chrome = null;
  let userTabId = null;
  try {
    chrome = await launchChrome(chromeBinary, { headless });
    console.log(`  chrome pid=${chrome.pid} endpoint=${chrome.httpEndpoint} (headless=${headless})`);
    await sleep(200);

    // ── 用户原有标签页：连接之前就存在，宿主不得碰它 ──
    const openUserTab = async (url) => {
      const target = `${chrome.httpEndpoint}/json/new?${encodeURIComponent(url)}`;
      let res = await fetch(target, { method: "PUT" });
      if (!res.ok) res = await fetch(target);
      const body = await res.json();
      return body?.id ?? null;
    };
    userTabId = await openUserTab(fixture.crossSiteUrl);
    check("（前置）用户原有标签页已创建", typeof userTabId === "string" && userTabId.length > 0, String(userTabId));

    const hostA = await connectCdpHost({ endpoint: chrome.httpEndpoint, timeoutMs: 15_000 });
    check("真实 Chrome：metadata 带浏览器版本", /Chrome|Chromium|Edg/.test(hostA.metadata.browserVersion || ""), String(hostA.metadata.browserVersion));
    check("真实 Chrome：metadata.endpoint 是浏览器级 ws", /^ws/.test(hostA.metadata.endpoint || ""), String(hostA.metadata.endpoint));
    check("真实 Chrome：入口自检通过（含 goto）", describeHostCapabilities(hostA.page).entryPath === true);

    // ── evaluate ──
    const sum = await hostA.page.evaluate((pair) => pair[0] + pair[1], [20, 22]);
    check("真实 evaluate：函数 + JSON 参数往返", sum === 42, String(sum));
    const domInfo = await hostA.page.evaluate(() => ({ href: location.href, ua: navigator.userAgent.slice(0, 20) }));
    check("真实 evaluate：可返回对象", domInfo?.href === "about:blank" && typeof domInfo?.ua === "string", JSON.stringify(domInfo));
    const boom = await expectsError(() => hostA.page.evaluate(() => { throw new Error("boom-real"); }));
    check("真实 evaluate：页面异常冒泡为 HostEvaluationError", /boom-real/.test(boom?.message || ""), String(boom?.message));

    // ── goto：必须等新文档提交（从 about:blank 出发，旧文档也是 complete）──
    const gotoStarted = Date.now();
    const gotoResult = await hostA.page.goto(fixture.url, { waitUntil: "load", timeout: 20_000 });
    const gotoMs = Date.now() - gotoStarted;
    check("真实 goto：落地并返回最终 URL", gotoResult.url === fixture.url, JSON.stringify(gotoResult));
    check("真实 goto：耗时合理", gotoMs > 0 && gotoMs < 20_000, `${gotoMs}ms`);
    check("真实 goto：title 读到新文档（不是旧文档的空标题）", (await hostA.page.title()) === "CDP Host Fixture", String(await hostA.page.title()));
    const documentTitle = await hostA.page.evaluate(() => document.title);
    check("真实 goto 后 DOM 就是新文档", documentTitle === "CDP Host Fixture", String(documentTitle));

    // ── 真实 CDP 鼠标点击（引擎自己的 dispatchClick）──
    const goBox = await hostA.page.evaluate(() => {
      const r = document.getElementById("go").getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await dispatchClick(hostA.page, goBox.x, goBox.y);
    await sleep(120);
    check("真实 CDP 点击：window.__clicked === 1", (await hostA.page.evaluate(() => window.__clicked || 0)) === 1);

    // ── 真实输入（裸 CDP Input.insertText）+ Enter（page.keyboard.press）──
    const qBox = await hostA.page.evaluate(() => {
      const r = document.getElementById("q").getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await dispatchClick(hostA.page, qBox.x, qBox.y);
    await hostA.page.cdp("Input.insertText", { text: "hello-cdp-host" });
    await sleep(80);
    check("真实 CDP 输入：input.value 落地", (await hostA.page.evaluate(() => document.getElementById("q").value)) === "hello-cdp-host");
    await hostA.page.keyboard.press("Enter");
    await sleep(150);
    check("真实 keyboard.press(Enter)：触发表单提交", (await hostA.page.evaluate(() => window.__submitted || 0)) === 1);

    // ── 引擎默认 DOM 路径端到端（注入判定器：不联网、不需要凭证）──
    await hostA.page.goto(fixture.url, { waitUntil: "load", timeout: 20_000 });
    const askPolicy = (op, wantName) => (state, questions) => {
      const answers = {};
      for (const [head, question] of Object.entries(questions)) {
        const keys = Object.keys(question.criteria);
        let choice;
        if (head === "operation") choice = keys.includes(op) ? op : keys.find((k) => k !== "none") ?? keys[0];
        else if (head === "click_target" || head === "type_text_target") {
          choice =
            keys.find((k) => k !== "none" && question.criteria[k].includes(wantName)) ??
            keys.find((k) => k !== "none") ??
            keys[0];
        } else choice = keys.find((k) => k !== "none") ?? keys[0];
        const rest = keys.filter((k) => k !== choice);
        const probabilities = { [choice]: 0.9 };
        for (const k of rest) probabilities[k] = 0.1 / rest.length;
        answers[head] = { choice, confidence: 0.9, probabilities };
      }
      return answers;
    };
    const clickRun = await runJevAutonomousLoop(hostA.page, "点击「开始」按钮", {
      ask: askPolicy("click", "开始"),
      cache: false,
      maxSteps: 3,
      onStep: () => {},
      check: async (page) => (await page.evaluate(() => window.__clicked || 0)) >= 1,
    });
    check("引擎默认 DOM 路径：click 循环达成", clickRun.success === true, JSON.stringify({ success: clickRun.success, reason: clickRun.reason }));
    check(
      "引擎走的是 DOM 观测路径（observeMode=dom，没有回落到 snapshot）",
      (clickRun.history || []).every((h) => h.observeMode === "dom"),
      JSON.stringify((clickRun.history || []).map((h) => h.observeMode))
    );
    check("引擎点击落到真实 DOM", (await hostA.page.evaluate(() => window.__clicked || 0)) === 1);

    const typeRun = await runJevAutonomousLoop(hostA.page, "在「查询框」里填入 engine-typed", {
      ask: askPolicy("type_text", "查询框"),
      text: ["engine-typed"],
      cache: false,
      maxSteps: 3,
      onStep: () => {},
      check: async (page) => (await page.evaluate(() => document.getElementById("q").value)) === "engine-typed",
    });
    check("引擎默认 DOM 路径：type_text 循环达成", typeRun.success === true, JSON.stringify({ success: typeRun.success, reason: typeRun.reason }));
    check("引擎输入落到真实 DOM", (await hostA.page.evaluate(() => document.getElementById("q").value)) === "engine-typed");

    // ── 能力边界在真实宿主里也成立 ──
    const snapshotErr = await expectsError(() => hostA.page.snapshot());
    check("真实宿主：page.snapshot() 显式拒绝（HostCapabilityError）", snapshotErr instanceof HostCapabilityError, String(snapshotErr?.message));

    // ── 真实跨站导航：goto 跨 site + 真实点击链接跳转 ──
    const crossStarted = Date.now();
    await hostA.page.goto(fixture.crossSiteUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    check("真实 goto 跨站：URL 落地", (await hostA.page.url()) === fixture.crossSiteUrl, String(await hostA.page.url()));
    check("真实 goto 跨站：读到新文档标题", (await hostA.page.evaluate(() => document.title)) === "Second Page", String(await hostA.page.evaluate(() => document.title)));
    check("真实 goto 跨站：耗时合理", Date.now() - crossStarted < 20_000, `${Date.now() - crossStarted}ms`);

    await hostA.page.goto(fixture.url, { waitUntil: "load", timeout: 20_000 });
    const nextBox = await hostA.page.evaluate(() => {
      const r = document.getElementById("next").getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await dispatchClick(hostA.page, nextBox.x, nextBox.y);
    await hostA.page.waitForLoadState("load", { timeout: 20_000 });
    check("真实点击链接 → 跨站导航落地", (await hostA.page.url()) === fixture.crossSiteUrl, String(await hostA.page.url()));
    check("跨站导航后 title() 是第二页", (await hostA.page.title()) === "Second Page", String(await hostA.page.title()));
    const secondBox = await hostA.page.evaluate(() => {
      const r = document.getElementById("second-btn").getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await dispatchClick(hostA.page, secondBox.x, secondBox.y);
    await sleep(120);
    check("跨站导航后仍能真实点击", (await hostA.page.evaluate(() => window.__secondClicked || 0)) === 1);

    // ── 真实导航失败要显式报错 ──
    const refused = await expectsError(() => hostA.page.goto("http://127.0.0.1:1/", { timeout: 8_000 }));
    check("真实 goto 到拒绝连接的端口 → HostNavigationError", refused instanceof HostNavigationError, String(refused?.message || refused?.code));

    // ── 关闭归属：自有 page 关掉，用户原有页面不动，浏览器不关 ──
    const closedA = await hostA.close();
    check("真实 close：自有 target 被关闭", closedA.targetClosed === true, JSON.stringify(closedA));
    const listAfterA = await (await fetch(`${chrome.httpEndpoint}/json/list`)).json();
    const pagesAfterA = listAfterA.filter((t) => t.type === "page").map((t) => t.id);
    check("真实 close：自有 target 已从浏览器消失", !pagesAfterA.includes(hostA.metadata.targetId), JSON.stringify(pagesAfterA));
    check("真实 close：用户原有页面仍在", pagesAfterA.includes(userTabId), JSON.stringify({ userTabId, pagesAfterA }));
    check("真实 close：外部浏览器仍存活（不调 Browser.close）", (await fetch(`${chrome.httpEndpoint}/json/version`)).ok === true);

    // ── 外部关闭 target → 断连（真机版 [8]）──
    const hostC = await connectCdpHost({ endpoint: chrome.httpEndpoint, timeoutMs: 15_000 });
    const killOwn = await fetch(`${chrome.httpEndpoint}/json/close/${hostC.metadata.targetId}`);
    check("（前置）外部关闭自有 target", killOwn.ok === true, String(killOwn.status));
    let disconnectErr = null;
    for (let i = 0; i < 40 && !disconnectErr; i += 1) {
      disconnectErr = await expectsError(() => hostC.page.evaluate(() => 1));
      if (!disconnectErr) await sleep(50);
    }
    check("真实断连：target 被外部关闭 → HostDisconnectedError", disconnectErr?.code === "HOST_DISCONNECTED", String(disconnectErr?.code || disconnectErr));
    check("真实断连后 close() 仍能收尾", (await expectsError(() => hostC.close())) === null);

    // ── keepPage: true 留下页面 ──
    const hostB = await connectCdpHost({ endpoint: chrome.httpEndpoint, timeoutMs: 15_000 });
    await hostB.page.goto(fixture.url, { waitUntil: "load", timeout: 20_000 });
    const closedB = await hostB.close({ keepPage: true });
    check("真实 keepPage:true → 只断连接", closedB.keptPage === true && closedB.targetClosed === false, JSON.stringify(closedB));
    const listAfterB = await (await fetch(`${chrome.httpEndpoint}/json/list`)).json();
    const keptPage = listAfterB.find((t) => t.id === hostB.metadata.targetId);
    check("真实 keepPage:true → 页面仍在浏览器里", Boolean(keptPage), JSON.stringify(listAfterB.filter((t) => t.type === "page").map((t) => t.id)));
    check("真实 keepPage:true → 页面仍停留在最后 URL", keptPage?.url === fixture.url, String(keptPage?.url));
    await fetch(`${chrome.httpEndpoint}/json/close/${hostB.metadata.targetId}`);

    if (userTabId) await fetch(`${chrome.httpEndpoint}/json/close/${userTabId}`);
  } finally {
    if (chrome) {
      const stopped = await stopChrome(chrome);
      check("清理：Chrome 进程已退出", stopped.alive === false, JSON.stringify(stopped));
      check("清理：临时 profile 已删除", stopped.profileRemoved === true, String(stopped.profileRemoved));
      if (stopped.alive) console.log(`  ! Chrome pid ${stopped.pid} 仍然存活，需要手动处理`);
    }
    await fixture.stop();
  }
}

// ════════════════════════════════════════════════════════════════════════════
section("汇总");
console.log(`结果: ${pass} 通过 / ${fail} 失败 / ${skips.length} SKIP`);
if (skips.length) {
  console.log("SKIP 明细：");
  for (const line of skips) console.log(`  - ${line}`);
}
process.exitCode = fail ? 1 : 0;
