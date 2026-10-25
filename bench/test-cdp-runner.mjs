// 独立 CDP 任务入口（scripts/run-cdp-task.mjs）的行为测试 —— 纯 node：无浏览器 / 无网络 / 无凭证。
//
// 覆盖什么：
//   [1] 配置校验先于适配器加载（错误路径不 import 适配器、不连浏览器），退出码 2 / 3
//   [2] 编排：确定性 check 命中 → verified，close({keepPage:false})，原 CLI 字段原样透传
//   [3] 模型 done 与 until 未命中：verified 与 success 分开，有 until 未命中绝不 success
//   [4] 抽取：操作失败不抽取、抽取成功/失败分别报告
//   [5] 取消：阻止新派发（本轮动作后不再有派发）、finally 释放连接、页面保留
//   [6] 真实引擎不变量（离线）：check 抛 EGO_ABORTED 真的会中断 runJevAutonomousLoop；
//       check 命中真的会给 check_passed（取消设计与 verified 判定都依赖这两条）
//   [7] CLI：--config / --help / 错误退出码；用临时 host+engine 模块跑一次完整 CLI 闭环
//
// 这里**没有**真实浏览器用例：宿主适配器 scripts/hosts/cdp-host.mjs 由另一任务提供，
// 本工作树里尚不存在，因此真实外部 Chrome 的搜索/点击/输入由主控在适配器合入后集成复验。
// 用真实引擎 + 假 page 的用例只证明引擎契约（不碰网络、不碰浏览器）。
//
// 用法: node bench/test-cdp-runner.mjs
const { spawnSync } = await import("node:child_process");
const fs = await import("node:fs");
const os = await import("node:os");
const { dirname, join } = await import("node:path");
const { fileURLToPath, pathToFileURL } = await import("node:url");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(REPO, "scripts", "run-cdp-task.mjs");
const ENGINE = join(REPO, "scripts", "decider-loop.mjs");
const ADAPTER = join(REPO, "scripts", "hosts", "cdp-host.mjs");

let pass = 0;
let fail = 0;
const skips = [];
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};
const skip = (name, why) => { skips.push({ name, why }); console.log(`  SKIP ${name} — ${why}`); };

const runner = await import(pathToFileURL(RUNNER).href).catch((err) => ({ __error: err }));
const runCdpTask = runner.runCdpTask;
const CdpTaskError = runner.CdpTaskError;
const engine = await import(pathToFileURL(ENGINE).href);

// ── 假 page / 假 host / 假 engine（只用于编排测试，明确不是真实浏览器）───────────
function makePage(state = { url: "about:blank", title: "Fake" }) {
  return {
    url: async () => state.url,
    title: async () => state.title,
    goto: async (url) => { state.url = url; },
    waitForTimeout: async () => {},
    evaluate: async () => ({ width: 1280, height: 900 }),
  };
}

function makeHost({ page, metadata = { host: "fake" }, closeImpl } = {}) {
  const calls = { connect: [], close: [] };
  const connectCdpHost = async (args) => {
    calls.connect.push(args);
    return {
      page: page || makePage(),
      metadata,
      close: async (opts) => {
        calls.close.push(opts);
        if (closeImpl) return closeImpl(opts);
        return { keptPage: Boolean(opts && opts.keepPage) };
      },
    };
  };
  return { connectCdpHost, calls };
}

function makeEngine(script) {
  const calls = { loop: [], loopOptions: [], extract: [], extractOptions: [], dispatchCount: 0 };
  const api = {
    calls,
    async runJevAutonomousLoop(page, goal, options = {}) {
      calls.loop.push({ page, goal });
      calls.loopOptions.push(options);
      const counted = { ...options, onStep: (message) => { calls.dispatchCount += 1; if (typeof options.onStep === "function") options.onStep(message); } };
      return script.loop(page, goal, counted, api);
    },
    renderJevSummary: (result) => "SUMMARY " + (result && result.reason),
    async extract(page, instruction, options = {}) {
      calls.extract.push({ page, instruction });
      calls.extractOptions.push(options);
      return script.extract ? script.extract(page, instruction, options) : { success: true, data: { ok: 1 } };
    },
    renderExtractSummary: () => "EXTRACT SUMMARY",
  };
  if (script.loadApiKey) api.loadApiKey = script.loadApiKey;
  return api;
}

/** 与真实引擎相近的循环骨架：每步先跑 check，再“派发”，check 的错误直接向上抛。 */
function loopScript({ steps = 3, result, onDispatch }) {
  return {
    loop: async (page, goal, options) => {
      const history = [];
      for (let step = 1; step <= (options.maxSteps || 10); step++) {
        if (typeof options.check === "function") await options.check(page, step);
        history.push({ action: "click", target: "Go", targetLabel: "Go", changed: true, urlAfter: await page.url() });
        if (typeof options.onStep === "function") options.onStep(`  └─ [Step ${step}] click → Go`);
        if (onDispatch) await onDispatch(step);
      }
      return { success: false, steps: history.length, reason: "max_steps_reached", history };
    },
    ...(result ? { loopOverride: result } : {}),
  };
}

const baseCfg = (extra = {}) => ({ cdpEndpoint: "ws://127.0.0.1:9222/devtools/browser/fake", goal: "点击 Go", steps: 3, ...extra });
const noSignals = { installSignalHandlers: false };

// ── [1] 配置校验先于适配器加载 ────────────────────────────────────────────────
console.log("\n[1] 配置校验（错误路径不加载适配器、不连浏览器）");
{
  check("scripts/run-cdp-task.mjs 可导入并导出 runCdpTask", typeof runCdpTask === "function", runner.__error ? String(runner.__error).slice(0, 300) : String(typeof runCdpTask));
  check("导出 CdpTaskError（带 exitCode）", typeof CdpTaskError === "function" && "exitCode" in new CdpTaskError("x", 2), String(typeof CdpTaskError));

  if (typeof runCdpTask !== "function") {
    fail += 1;
    console.log("  FAIL 后续编排用例无法运行（runCdpTask 未导出）");
  } else {
    // 适配器路径故意指向不存在的文件：配置校验若不先发生，就会报「适配器加载失败」。
    const missHost = { hostModule: join(os.tmpdir(), "definitely-missing-cdp-host.mjs"), ...noSignals };
    const expectConfig = async (name, cfg, deps, needle, code = 2) => {
      try {
        const r = await runCdpTask(cfg, { ...missHost, ...deps });
        check(name, false, "没有抛错：" + JSON.stringify({ success: r.success, reason: r.reason }));
      } catch (err) {
        check(name, err && err.exitCode === code && String(err.message).includes(needle), `exitCode=${err && err.exitCode} message=${err && err.message}`);
      }
    };
    await expectConfig("缺 goal 且缺 extractInstruction → exit 2", { cdpEndpoint: "ws://x/y" }, {}, "goal");
    await expectConfig("缺 cdpEndpoint → exit 2", { goal: "点击 Go" }, {}, "cdpEndpoint");
    await expectConfig("steps=0 → exit 2", baseCfg({ steps: 0 }), {}, "steps");
    await expectConfig("steps 非数字 → exit 2", baseCfg({ steps: "abc" }), {}, "steps");
    await expectConfig("CDP 模式带 spaceId → exit 2", baseCfg({ spaceId: "3" }), {}, "taskSpace");
    await expectConfig("CDP 模式带 keep → exit 2", baseCfg({ keep: "p1" }), {}, "keep");
  }
}

// ── [2] 编排：确定性 verified + 字段透传 ─────────────────────────────────────
if (typeof runCdpTask === "function") {
  console.log("\n[2] 编排：until 命中 → verified / close({keepPage:false}) / 原 CLI 字段透传");
  {
    const state = { url: "https://example.com/start", title: "Example" };
    const page = makePage(state);
    const host = makeHost({ page, metadata: { browser: "fake-chrome", pid: 4242 } });
    const cfgInput = {
      cdpEndpoint: "ws://127.0.0.1:9222/devtools/browser/abc",
      cdpTimeoutMs: 4321,
      goal: "在搜索框输入 Jev 并提交",
      url: "https://example.com/start",
      until: "/wiki/Jev",
      texts: ["Jev", "Ada"],
      steps: 4,
      cache: true,
      cacheFile: "/tmp/fake-cache.json",
      cacheContext: { until: "/wiki/Jev", decider: { kind: "systemone" } },
      batch: false,
      visualFallback: false,
      forceViewport: "1280x900@1",
      strictViewport: true,
      apiKey: "fake-key",
      baseUrl: "https://primary.example",
      fallbackBaseUrl: "https://fallback.example",
      deciderConfig: { kind: "systemone", model: "jev-latest" },
      extractInstruction: "抽取词条首句",
      extractSchema: { type: "string" },
      extractionModel: { baseUrl: "https://text.example/v1", model: "m", apiKey: "k" },
      routeFile: null,
    };
    const fakeEngine = makeEngine({
      loop: async (p, goal, options) => {
        // 假引擎只模拟「提交后落地到目标页」：导航由 page.goto 落在 mock 状态里。
        await p.goto("https://example.com/wiki/Jev");
        const history = [{ action: "type_text_submit", target: "Search", text: "Jev", changed: true, urlAfter: "https://example.com/wiki/Jev", phases: { observeMs: 1, decideMs: 2, executeMs: 3, verifyMs: 4 } }];
        if (typeof options.onStep === "function") options.onStep("  └─ [Step 1] type_text_submit → Search = \"Jev\"");
        if (await options.check(p, 1)) {
          return { success: true, steps: 1, reason: "check_passed_after_step", history, phases: { observeMs: 1, decideMs: 2, executeMs: 3, verifyMs: 4 }, cacheHits: 0, serverModels: ["jev-test"] };
        }
        return { success: false, steps: 1, reason: "guard_rejected", history };
      },
    });
    const r = await runCdpTask(cfgInput, { connectCdpHost: host.connectCdpHost, engine: fakeEngine, ...noSignals });

    check("success/verified/exitCode 一致", r.success === true && r.verified === true && r.exitCode === 0, JSON.stringify({ success: r.success, verified: r.verified, exitCode: r.exitCode }));
    check("确定性原因保留在 stopReason（整体 reason 由抽取结论收尾）", r.stopReason === "check_passed_after_step" && r.reason === "extracted", JSON.stringify({ reason: r.reason, stopReason: r.stopReason }));
    check("给出可核对的最终 URL", r.url === "https://example.com/wiki/Jev", String(r.url));
    check("给出动作记录（意图与已执行分开）", Array.isArray(r.actions) && r.actions.length === 1 && r.actions[0].intent.action === "type_text_submit" && r.actions[0].intent.target === "Search" && r.actions[0].intent.text === "Jev" && r.actions[0].dispatched === true && r.actions[0].outcomeUnknown === false, JSON.stringify(r.actions));
    check("连接参数 = {endpoint, signal, timeoutMs}", host.calls.connect.length === 1 && host.calls.connect[0].endpoint === cfgInput.cdpEndpoint && host.calls.connect[0].timeoutMs === 4321 && host.calls.connect[0].signal instanceof AbortSignal, JSON.stringify({ n: host.calls.connect.length, ep: host.calls.connect[0] && host.calls.connect[0].endpoint }));
    check("成功时 close({keepPage:false})", host.calls.close.length === 1 && host.calls.close[0] && host.calls.close[0].keepPage === false, JSON.stringify(host.calls.close));
    check("结果记录连接已释放", r.connection && r.connection.released === true && r.connection.connected === true && r.connection.keepPage === false, JSON.stringify(r.connection));
    check("结果带 host metadata", r.metadata && r.metadata.browser === "fake-chrome", JSON.stringify(r.metadata));

    const o = fakeEngine.calls.loopOptions[0] || {};
    check("透传 steps/text/apiKey/baseUrl/fallbackBaseUrl", o.maxSteps === 4 && JSON.stringify(o.text) === '["Jev","Ada"]' && o.apiKey === "fake-key" && o.baseUrl === "https://primary.example" && o.fallbackBaseUrl === "https://fallback.example", JSON.stringify({ maxSteps: o.maxSteps, text: o.text }));
    check("透传 cache/cacheFile/cacheContext（原 CLI 字段）", o.cache === true && o.cacheFile === "/tmp/fake-cache.json" && o.cacheContext && o.cacheContext.until === "/wiki/Jev", JSON.stringify({ cache: o.cache, cacheFile: o.cacheFile, cacheContext: o.cacheContext }));
    check("透传 batch/visualFallback（false 不被默认值覆盖）", o.batch === false && o.visualFallback === false, JSON.stringify({ batch: o.batch, visualFallback: o.visualFallback }));
    check("透传 forceViewport 字符串与 strictViewport", o.forceViewport === "1280x900@1" && o.strictViewport === true, JSON.stringify({ forceViewport: o.forceViewport, strictViewport: o.strictViewport }));
    check("透传 deciderConfig", o.deciderConfig && o.deciderConfig.kind === "systemone" && o.deciderConfig.model === "jev-latest", JSON.stringify(o.deciderConfig));
    check("抽取使用 cfg.extractionModel（不重复解析）", fakeEngine.calls.extractOptions[0] && fakeEngine.calls.extractOptions[0].textModel === cfgInput.extractionModel, JSON.stringify(fakeEngine.calls.extractOptions[0] && fakeEngine.calls.extractOptions[0].textModel));
    check("抽取透传 schema", JSON.stringify(fakeEngine.calls.extractOptions[0] && fakeEngine.calls.extractOptions[0].schema) === JSON.stringify({ type: "string" }), JSON.stringify(fakeEngine.calls.extractOptions[0] && fakeEngine.calls.extractOptions[0].schema));
    check("抽取成功的整体结论 = extracted", r.reason === "extracted" && r.extracted === true && r.data && r.data.ok === 1, JSON.stringify({ reason: r.reason, extracted: r.extracted, data: r.data }));
    check("phases 透传（分阶段耗时）", r.phases && r.phases.decideMs === 2, JSON.stringify(r.phases));
    check("serverModels 透传（服务端实际模型）", Array.isArray(r.serverModels) && r.serverModels[0] === "jev-test", JSON.stringify(r.serverModels));
  }

  // ── [3] 模型 done 与 until 未命中 ───────────────────────────────────────────
  console.log("\n[3] 模型 done 与 until 未命中（verified 与 success 分开）");
  {
    const jevDone = {
      loop: async (page, goal, options) => {
        if (typeof options.check === "function") await options.check(page, 1);
        return { success: true, steps: 2, reason: "jev_done", history: [{ action: "click", target: "Next", changed: true, urlAfter: "https://example.com/other" }] };
      },
    };
    const hit = makeHost({ page: makePage({ url: "https://example.com/other", title: "Other" }) });
    const missCfg = baseCfg({ url: "https://example.com/start", until: "/wiki/Jev" });
    const e1 = makeEngine(jevDone);
    const r1 = await runCdpTask(missCfg, { connectCdpHost: hit.connectCdpHost, engine: e1, ...noSignals });
    check("有 until 未命中 → success=false", r1.success === false, JSON.stringify({ success: r1.success, reason: r1.reason }));
    check("有 until 未命中 → reason=until_not_matched", r1.reason === "until_not_matched", String(r1.reason));
    check("模型 done 的原始原因保留在 stopReason", r1.stopReason === "jev_done" && r1.modelDone === true, JSON.stringify({ stopReason: r1.stopReason, modelDone: r1.modelDone }));
    check("有 until 未命中 → verified=false、exitCode=1", r1.verified === false && r1.exitCode === 1, JSON.stringify({ verified: r1.verified, exitCode: r1.exitCode }));
    check("有 until 未命中 → 保留页面但释放连接", hit.calls.close[0] && hit.calls.close[0].keepPage === true && r1.connection.released === true, JSON.stringify(hit.calls.close));

    const noUntilHost = makeHost({ page: makePage({ url: "https://example.com/other", title: "Other" }) });
    const r2 = await runCdpTask(baseCfg({ url: "https://example.com/start" }), { connectCdpHost: noUntilHost.connectCdpHost, engine: makeEngine(jevDone), ...noSignals });
    check("无 until 时 jev_done 可以 success（但仍非 verified）", r2.success === true && r2.verified === false && r2.exitCode === 0, JSON.stringify({ success: r2.success, verified: r2.verified, exitCode: r2.exitCode }));
    check("无 until 时 reason=jev_done", r2.reason === "jev_done", String(r2.reason));
  }

  // ── [4] 抽取门控 ───────────────────────────────────────────────────────────
  console.log("\n[4] 抽取：操作失败不抽取 / 抽取失败不冒充成功");
  {
    const failing = makeEngine({ loop: async () => ({ success: false, steps: 3, reason: "max_steps_reached", history: [{ action: "click", target: "Go", changed: false }] }) });
    const h1 = makeHost();
    const r1 = await runCdpTask(baseCfg({ extractInstruction: "抽取标题" }), { connectCdpHost: h1.connectCdpHost, engine: failing, ...noSignals });
    check("操作失败 → 0 次抽取调用", failing.calls.extract.length === 0, String(failing.calls.extract.length));
    check("操作失败 → extractSkipped=true 且 success=false", r1.extractSkipped === true && r1.success === false, JSON.stringify({ extractSkipped: r1.extractSkipped, success: r1.success }));
    check("操作失败 → reason 保留引擎原因", r1.reason === "max_steps_reached", String(r1.reason));

    const untilMissEngine = makeEngine({ loop: async (p, g, o) => { if (o.check) await o.check(p, 1); return { success: true, steps: 1, reason: "jev_done", history: [] }; } });
    const h2 = makeHost({ page: makePage({ url: "https://example.com/elsewhere", title: "Elsewhere" }) });
    const r2 = await runCdpTask(baseCfg({ until: "/wiki/Jev", extractInstruction: "抽取标题" }), { connectCdpHost: h2.connectCdpHost, engine: untilMissEngine, ...noSignals });
    check("until 未命中 → 同样不抽取（不拿未达成的页面当结果）", untilMissEngine.calls.extract.length === 0 && r2.extractSkipped === true, String(untilMissEngine.calls.extract.length));

    const extractFail = makeEngine({
      loop: async (p, g, o) => { if (o.check) await o.check(p, 1); return { success: true, steps: 1, reason: "jev_done", history: [] }; },
      extract: async () => ({ success: false, reason: "schema_validation_failed", error: "bad shape", data: { nope: 1 } }),
    });
    const h3 = makeHost();
    const r3 = await runCdpTask(baseCfg({ extractInstruction: "抽取标题", extractSchema: { type: "array" } }), { connectCdpHost: h3.connectCdpHost, engine: extractFail, ...noSignals });
    check("抽取失败 → success=false 且 reason=抽取原因", r3.success === false && r3.reason === "schema_validation_failed" && r3.exitCode === 1, JSON.stringify({ success: r3.success, reason: r3.reason, exitCode: r3.exitCode }));
    check("抽取失败 → 保留抽取错误细节", r3.extracted === true && r3.error === "bad shape", JSON.stringify({ extracted: r3.extracted, error: r3.error }));
  }

  // ── [5] 取消 ───────────────────────────────────────────────────────────────
  console.log("\n[5] 取消：阻止新派发 + finally 释放连接");
  {
    const controller = new AbortController();
    const cancelEngine = makeEngine(loopScript({ onDispatch: async (step) => { if (step === 2) controller.abort(); } }));
    const h = makeHost();
    const r = await runCdpTask(baseCfg({ steps: 5 }), { connectCdpHost: h.connectCdpHost, engine: cancelEngine, signal: controller.signal, ...noSignals });
    const dispatched = cancelEngine.calls.dispatchCount;
    check(
      "取消后不再有新的派发（第 2 步后中止，maxSteps=5）",
      dispatched === 2 && Array.isArray(r.stepLog) && r.stepLog.length === 2,
      `dispatched=${dispatched} stepLog=${JSON.stringify(r.stepLog)}`
    );
    check("取消 → cancelled=true / success=false / reason=cancelled", r.cancelled === true && r.success === false && r.reason === "cancelled", JSON.stringify({ cancelled: r.cancelled, success: r.success, reason: r.reason }));
    check("取消 → steps=null（未知）与 outcomeUnknown=true，不拿日志条数当步数", r.steps === null && r.outcomeUnknown === true && r.actions === null, JSON.stringify({ steps: r.steps, outcomeUnknown: r.outcomeUnknown, actions: r.actions }));
    check("取消 → 退出码 130（SIGINT 语义）", r.exitCode === 130, String(r.exitCode));
    check("取消 → finally 里 close({keepPage:true}) 释放连接", h.calls.close.length === 1 && h.calls.close[0].keepPage === true && r.connection.released === true, JSON.stringify({ close: h.calls.close, connection: r.connection }));
    check("取消 → 结果里标明取消信号来源", r.cancelSignal === "external", String(r.cancelSignal));

    const h2 = makeHost();
    const pre = new AbortController();
    pre.abort();
    const r2 = await runCdpTask(baseCfg(), { connectCdpHost: h2.connectCdpHost, engine: makeEngine(loopScript({})), signal: pre.signal, ...noSignals });
    check("连接前已取消 → 0 次连接、0 次派发", h2.calls.connect.length === 0 && r2.cancelled === true && r2.exitCode === 130, JSON.stringify({ connect: h2.calls.connect.length }));
    check("连接前已取消 → connection.released=false（没有连接可释放）", r2.connection && r2.connection.connected === false && r2.connection.released === false, JSON.stringify(r2.connection));

    const h3 = makeHost({ closeImpl: async () => { throw new Error("close boom"); } });
    const r3 = await runCdpTask(baseCfg(), { connectCdpHost: h3.connectCdpHost, engine: makeEngine(loopScript({})), ...noSignals });
    check("close 抛错不掩盖任务结论，只记录 closeError", r3.success === false && r3.connection.closeError === "close boom" && r3.connection.released === false, JSON.stringify({ reason: r3.reason, connection: r3.connection }));
  }

  // ── [6] 适配器/引擎覆盖与失败路径 ───────────────────────────────────────────
  console.log("\n[6] 适配器加载失败与路径覆盖");
  {
    const missing = join(os.tmpdir(), "no-such-cdp-host-" + process.pid + ".mjs");
    try {
      await runCdpTask(baseCfg({ hostModule: missing }), { ...noSignals });
      check("适配器模块不存在 → 抛 CdpTaskError(2)", false, "没有抛错");
    } catch (err) {
      check("适配器模块不存在 → 抛 CdpTaskError(2)", err instanceof CdpTaskError && err.exitCode === 2 && String(err.message).includes("cdp-host.mjs") && String(err.message).includes("EGO_JEV_CDP_HOST"), `${err && err.exitCode} ${err && err.message}`);
    }

    const tmp = fs.mkdtempSync(join(os.tmpdir(), "ego-cdp-runner-"));
    try {
      const blankHost = join(tmp, "blank-host.mjs");
      fs.writeFileSync(blankHost, "export const nothing = 1;\n");
      try {
        await runCdpTask(baseCfg({ hostModule: blankHost }), { ...noSignals });
        check("适配器没有导出 connectCdpHost → CdpTaskError(2)", false, "没有抛错");
      } catch (err) {
        check("适配器没有导出 connectCdpHost → CdpTaskError(2)", err instanceof CdpTaskError && err.exitCode === 2 && String(err.message).includes("connectCdpHost"), `${err && err.exitCode} ${err && err.message}`);
      }

      // 跨 worktree：显式 hostModule 指向一个只导出 connectCdpHost 的模块即可驱动 runner
      const pathHost = join(tmp, "path-host.mjs");
      fs.writeFileSync(
        pathHost,
        `export const seen = [];
export async function connectCdpHost({ endpoint, timeoutMs }) {
  seen.push({ endpoint, timeoutMs });
  const page = { url: async () => "https://example.com/wiki/Jev", title: async () => "Path", goto: async () => {}, waitForTimeout: async () => {}, evaluate: async () => ({ width: 1280, height: 900 }) };
  return { page, metadata: { via: "path" }, close: async (opts) => { seen.push({ close: opts }); return { keptPage: Boolean(opts && opts.keepPage) }; } };
}
`
      );
      const importedHost = await import(pathToFileURL(pathHost).href);
      const fakeEngine = makeEngine({ loop: async (p, g, o) => { if (o.check) await o.check(p, 1); return { success: true, steps: 0, reason: "check_passed", history: [] }; } });
      const r = await runCdpTask(baseCfg({ hostModule: pathHost, url: "https://example.com/" }), { engine: fakeEngine, ...noSignals });
      check("cfg.hostModule 覆盖生效（跨 worktree 路径）", importedHost.seen[0] && importedHost.seen[0].endpoint === baseCfg().cdpEndpoint, JSON.stringify(importedHost.seen));
      check("覆盖模块的 close 收到 keepPage", importedHost.seen.some((s) => s.close && s.close.keepPage === false), JSON.stringify(importedHost.seen));
      check("覆盖模块跑通 → success+verified", r.success === true && r.verified === true && r.metadata && r.metadata.via === "path", JSON.stringify({ success: r.success, verified: r.verified, metadata: r.metadata }));

      // 引擎缺失 → 明确报错，不静默
      try {
        await runCdpTask(baseCfg({ engineModule: join(tmp, "no-engine.mjs") }), { ...noSignals });
        check("cfg.engineModule 不存在 → CdpTaskError(2)", false, "没有抛错");
      } catch (err) {
        check("cfg.engineModule 不存在 → CdpTaskError(2)", err instanceof CdpTaskError && err.exitCode === 2, `${err && err.exitCode} ${err && err.message}`);
      }

      // 缺凭证 → 3，且不连浏览器（用真实引擎的 loadApiKey 契约，注入假引擎）
      const noKeyEngine = makeEngine({ ...loopScript({}), loadApiKey: () => undefined });
      const noKeyHost = makeHost();
      try {
        await runCdpTask(baseCfg(), { connectCdpHost: noKeyHost.connectCdpHost, engine: noKeyEngine, ...noSignals });
        check("缺 Jev 凭证 → exit 3 且不连浏览器", false, "没有抛错");
      } catch (err) {
        check("缺 Jev 凭证 → exit 3 且不连浏览器", err instanceof CdpTaskError && err.exitCode === 3 && noKeyHost.calls.connect.length === 0, `${err && err.exitCode} connect=${noKeyHost.calls.connect.length}`);
      }

      // 非法 extractSchema → 2（用真实引擎的 normalizeExtractionSchema 提前失败）
      try {
        await runCdpTask(baseCfg({ apiKey: "fake-key", extractInstruction: "抽取", extractSchema: { type: "array", items: [{ a: 1 }, { b: 2 }] } }), { engine, ...noSignals });
        check("非法 extractSchema → exit 2", false, "没有抛错");
      } catch (err) {
        check("非法 extractSchema → exit 2", err instanceof CdpTaskError && err.exitCode === 2, `${err && err.exitCode} ${err && err.message}`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// ── [7] 真实引擎不变量（离线、无浏览器、无网络）──────────────────────────────
console.log("\n[7] 真实引擎不变量：check 抛 EGO_ABORTED 会中断循环；check 命中给 check_passed");
{
  const fakePage = { evaluate: async () => ({ width: 1280, height: 900 }) };
  const abortErr = Object.assign(new Error("任务已取消"), { name: "AbortError", code: "EGO_ABORTED" });
  let dispatched = 0;
  let caught = null;
  try {
    await engine.runJevAutonomousLoop(
      { ...fakePage, url: async () => { dispatched++; return "https://example.com/"; }, title: async () => "T", cdp: async () => {} },
      "点击 Go",
      { maxSteps: 3, check: async () => { throw abortErr; }, onStep: () => {} }
    );
  } catch (err) {
    caught = err;
  }
  check("check 抛 EGO_ABORTED → 循环以该错误中断（取消不会被吞）", caught && caught.code === "EGO_ABORTED", String(caught && caught.code));
  check("EGO_ABORTED 在首次观测/派发前生效（0 次页面动作）", dispatched === 0, String(dispatched));

  const ok = await engine.runJevAutonomousLoop(fakePage, "点击 Go", { maxSteps: 3, check: async () => true, onStep: () => {} });
  check("check 命中 → check_passed 且 success", ok.success === true && ok.reason === "check_passed" && ok.steps === 0, JSON.stringify({ success: ok.success, reason: ok.reason, steps: ok.steps }));
  check("真实引擎仍导出 runJevAutonomousLoop/extract/renderJevSummary", ["runJevAutonomousLoop", "extract", "renderJevSummary", "renderExtractSummary", "loadApiKey"].every((k) => typeof engine[k] === "function"), "导出名稳定");
}

// ── [9] 导航：统一消费适配器 goto（不在 runner 里自行实现导航）─────────────────
if (typeof runCdpTask === "function") {
  console.log("\n[9] 导航：只用 host.goto，缺 goto 直接按契约错误失败");
  {
    const state = { url: "about:blank", gotoCalls: [] };
    const gotoPage = {
      url: async () => state.url,
      title: async () => "Goto",
      goto: async (url, opts) => { state.gotoCalls.push({ url, opts }); state.url = url; return { url, waitUntil: opts && opts.waitUntil }; },
      evaluate: async (fn) => (fn && fn.name === "viewportSizeInPage" ? { width: 1280, height: 900 } : null),
    };
    const host = makeHost({ page: gotoPage });
    const fakeEngine = makeEngine({ loop: async (p, g, o) => { if (o.check) await o.check(p, 1); return { success: true, steps: 0, reason: "check_passed", history: [] }; } });
    const r = await runCdpTask(baseCfg({ url: "https://example.com/wiki/Jev", until: "/wiki/Jev" }), { connectCdpHost: host.connectCdpHost, engine: fakeEngine, ...noSignals });
    check("导航走 goto(url, {waitUntil, timeout})", state.gotoCalls.length === 1 && state.gotoCalls[0].url === "https://example.com/wiki/Jev" && state.gotoCalls[0].opts.waitUntil === "domcontentloaded" && typeof state.gotoCalls[0].opts.timeout === "number", JSON.stringify(state.gotoCalls));
    check("导航成功 → success+verified，最终 URL 已核对", r.success === true && r.verified === true && r.url === "https://example.com/wiki/Jev", JSON.stringify({ success: r.success, verified: r.verified, url: r.url }));

    // 契约要求 page.goto：缺失时 fail-closed（exit 2），而不是 runner 自己搭一套导航。
    const noGotoPage = { url: async () => "about:blank", title: async () => "NoGoto", evaluate: async () => ({ width: 1280, height: 900 }) };
    const noGotoHost = makeHost({ page: noGotoPage });
    try {
      await runCdpTask(baseCfg({ url: "https://example.com/" }), { connectCdpHost: noGotoHost.connectCdpHost, engine: makeEngine(loopScript({})), ...noSignals });
      check("适配器缺 goto → 抛 CdpTaskError(2)", false, "没有抛错");
    } catch (err) {
      check("适配器缺 goto → 抛 CdpTaskError(2)（不自行实现导航）", err instanceof CdpTaskError && err.exitCode === 2 && String(err.message).includes("goto"), `${err && err.exitCode} ${err && err.message}`);
    }
    check("缺 goto 失败后仍走 finally 释放连接并保留页面", noGotoHost.calls.close.length === 1 && noGotoHost.calls.close[0].keepPage === true, JSON.stringify(noGotoHost.calls.close));

    const boomPage = { url: async () => "about:blank", title: async () => "Boom", goto: async () => { throw new Error("nav boom"); }, waitForTimeout: async () => {}, evaluate: async () => ({ width: 1280, height: 900 }) };
    const boomHost = makeHost({ page: boomPage });
    const boomEngine = makeEngine({ loop: async () => ({ success: true, steps: 1, reason: "jev_done", history: [] }) });
    const r2 = await runCdpTask(baseCfg({ url: "https://example.com/", extractInstruction: "抽取" }), { connectCdpHost: boomHost.connectCdpHost, engine: boomEngine, ...noSignals });
    check("导航失败 → reason=navigation_failed、exit 1", r2.reason === "navigation_failed" && r2.exitCode === 1 && r2.error === "nav boom", JSON.stringify({ reason: r2.reason, exitCode: r2.exitCode, error: r2.error }));
    check("导航失败 → 保留页面但释放连接（不会因提前 return 丢掉 keepPage）", boomHost.calls.close.length === 1 && boomHost.calls.close[0].keepPage === true && r2.connection.released === true, JSON.stringify(boomHost.calls.close));
    check("导航失败 → 不抽取、不跑操作循环", boomEngine.calls.extract.length === 0 && boomEngine.calls.loop.length === 0, JSON.stringify({ extract: boomEngine.calls.extract.length, loop: boomEngine.calls.loop.length }));

    // host 的导航专用错误码（HOST_NAVIGATION_FAILED）属于导航失败，不是控制停止。
    const hostNavErr = Object.assign(new Error("net::ERR_NAME_NOT_RESOLVED"), { code: "HOST_NAVIGATION_FAILED" });
    const navErrPage = { url: async () => "about:blank", title: async () => "X", goto: async () => { throw hostNavErr; }, evaluate: async () => ({ width: 1280, height: 900 }) };
    const navErrHost = makeHost({ page: navErrPage });
    const r3 = await runCdpTask(baseCfg({ url: "https://nope.invalid/" }), { connectCdpHost: navErrHost.connectCdpHost, engine: makeEngine(loopScript({})), ...noSignals });
    check("HOST_NAVIGATION_FAILED → navigation_failed（不当宿主控制停止）", r3.reason === "navigation_failed" && r3.exitCode === 1, JSON.stringify({ reason: r3.reason, error: r3.error }));
  }

  // ── [10] until 只能用最终 URL 复核 ──────────────────────────────────────────
  console.log("\n[10] until 用最终 URL 复核（不信引擎自报的 check_passed）");
  {
    const state = { url: "https://example.com/wiki/Jev" };
    const page = makePage(state);
    const host = makeHost({ page });
    // 引擎在 check 命中后页面又被重定向走了：只信 check_passed 会误报成功。
    const redirectEngine = makeEngine({
      loop: async (p, g, o) => {
        if (o.check && (await o.check(p, 1))) {
          state.url = "https://example.com/login?next=blocked";
          return { success: true, steps: 1, reason: "check_passed_after_step", history: [{ action: "click", target: "Go", changed: true }] };
        }
        return { success: false, steps: 1, reason: "guard_rejected", history: [] };
      },
    });
    const r = await runCdpTask(baseCfg({ url: "https://example.com/wiki/Jev", until: "/wiki/Jev" }), { connectCdpHost: host.connectCdpHost, engine: redirectEngine, ...noSignals });
    check("check 过了但最终 URL 未命中 → 绝不 success", r.success === false && r.exitCode === 1, JSON.stringify({ success: r.success, exitCode: r.exitCode }));
    check("最终 URL 未命中 → verified=false 且 reason=until_not_matched", r.verified === false && r.reason === "until_not_matched" && r.untilMatched === false, JSON.stringify({ verified: r.verified, reason: r.reason, untilMatched: r.untilMatched }));
    check("结果带上复核后的最终 URL", r.url === "https://example.com/login?next=blocked", String(r.url));
    check("最终 URL 未命中 → 保留页面并释放连接", host.calls.close[0].keepPage === true && r.connection.released === true, JSON.stringify(host.calls.close));
  }

  // ── [11] 动作意图 vs 已执行证据 ───────────────────────────────────────────
  console.log("\n[11] 动作报告：意图 / 已执行 / 观测三段，未知明确标记");
  {
    const host = makeHost({ page: makePage({ url: "https://example.com/end" }) });
    const historyEngine = makeEngine({
      loop: async () => ({
        success: false,
        steps: 4,
        reason: "guard_rejected",
        history: [
          { action: "click", target: "Go", targetLabel: "Go", changed: true, progressed: true, urlAfter: "https://example.com/a", stepDurationMs: 10, phases: {} },
          { action: "click", target: "Hidden", guardRejected: "covered", changed: false, stepDurationMs: 5, phases: {} },
          { action: "click", target: "Flaky", error: "boom", changed: false, stepDurationMs: 7, phases: {} },
          { action: "batch", target: "A", batchSize: 2, executedSubActions: [{ action: "click", target: "A" }, { action: "type_text", target: "B" }], failedSubActionIndex: 1, changed: true, stepDurationMs: 9, phases: {} },
        ],
      }),
    });
    const r = await runCdpTask(baseCfg(), { connectCdpHost: host.connectCdpHost, engine: historyEngine, ...noSignals });
    const a = r.actions || [];
    check("成功派发的一步 → dispatched=true（有 changed 证据）", a[0] && a[0].dispatched === true && a[0].intent.action === "click" && a[0].observed.changed === true, JSON.stringify(a[0]));
    check("守卫拒绝 → dispatched=false（确认 0 派发）", a[1] && a[1].dispatched === false && a[1].skipped.guardRejected === "covered", JSON.stringify(a[1]));
    check("只有 error 没有派发证据 → dispatched=null 且 outcomeUnknown=true", a[2] && a[2].dispatched === null && a[2].outcomeUnknown === true, JSON.stringify(a[2]));
    check("批次 → 报告 executedSubActions 与 failedSubActionIndex", a[3] && a[3].dispatched === true && a[3].executedSubActions.length === 2 && a[3].failedSubActionIndex === 1 && a[3].intent.batchSize === 2, JSON.stringify(a[3]));
    check("history 与 stepLog 分开报告", Array.isArray(r.actions) && Array.isArray(r.stepLog), JSON.stringify({ actions: r.actions.length, stepLog: r.stepLog.length }));

    // 批次中途被拦（前面的子动作已派发）：executedSubActions 有值就不能被 guardRejected 压成「未派发」
    const partialHost = makeHost();
    const partialEngine = makeEngine({
      loop: async () => ({
        success: false,
        steps: 1,
        reason: "guard_rejected",
        history: [{
          action: "batch",
          batchSize: 3,
          executedSubActions: [{ action: "type_text", target: "Name" }],
          failedSubActionIndex: 1,
          guardRejected: "dangerous_action",
          changed: false,
          stepDurationMs: 6,
          phases: {},
        }],
      }),
    });
    const rp = await runCdpTask(baseCfg(), { connectCdpHost: partialHost.connectCdpHost, engine: partialEngine, ...noSignals });
    const ap = (rp.actions || [])[0];
    check("批次部分执行后才被拦 → dispatched=true（不被 guardRejected 覆盖）", Boolean(ap) && ap.dispatched === true && ap.executedSubActions.length === 1, JSON.stringify(ap && { dispatched: ap.dispatched, subs: ap.executedSubActions, skipped: ap.skipped }));
    check("批次部分执行 → batchPartial=true 且 outcomeUnknown=true", Boolean(ap) && ap.batchPartial === true && ap.outcomeUnknown === true && ap.skipped.guardRejected === "dangerous_action", JSON.stringify(ap && { batchPartial: ap.batchPartial, outcomeUnknown: ap.outcomeUnknown }));
  }

  // ── [12] 宿主控制异常 / 抽取阶段取消 ───────────────────────────────────────
  console.log("\n[12] 宿主控制停止与抽取阶段取消");
  {
    const hostAbortEngine = makeEngine({ loop: async () => { const err = new Error("host took control back"); err.code = "EGO_HOST_ABORTED"; throw err; } });
    const h1 = makeHost();
    const r1 = await runCdpTask(baseCfg(), { connectCdpHost: h1.connectCdpHost, engine: hostAbortEngine, ...noSignals });
    check("EGO_HOST_ABORTED（signal 未取消）→ host_control_stop 而不是 cancelled", r1.reason === "host_control_stop" && r1.cancelled === false && r1.outcomeUnknown === true, JSON.stringify({ reason: r1.reason, cancelled: r1.cancelled }));
    check("host_control_stop → exit 1、保留页面并释放连接", r1.exitCode === 1 && h1.calls.close[0].keepPage === true && r1.connection.released === true, JSON.stringify({ exitCode: r1.exitCode, close: h1.calls.close }));

    // 同一个错误码，但本次 signal 已取消 → 这是用户取消，不是宿主取回控制。
    const cHost = new AbortController();
    const abortMatchingEngine = makeEngine({ loop: async () => { cHost.abort(); const err = new Error("aborted"); err.code = "EGO_HOST_ABORTED"; throw err; } });
    const h1b = makeHost();
    const r1b = await runCdpTask(baseCfg(), { connectCdpHost: h1b.connectCdpHost, engine: abortMatchingEngine, signal: cHost.signal, ...noSignals });
    check("EGO_HOST_ABORTED + 本次 signal 已取消 → cancelled/130", r1b.cancelled === true && r1b.reason === "cancelled" && r1b.exitCode === 130, JSON.stringify({ cancelled: r1b.cancelled, reason: r1b.reason, exitCode: r1b.exitCode }));

    const controller = new AbortController();
    const extractAbortEngine = makeEngine({
      loop: async (p, g, o) => { if (o.check) await o.check(p, 1); return { success: true, steps: 0, reason: "check_passed", history: [] }; },
      extract: async () => { controller.abort(); const err = new Error("任务已取消"); err.name = "AbortError"; err.code = "EGO_ABORTED"; throw err; },
    });
    const h2 = makeHost({ page: makePage({ url: "https://example.com/wiki/Jev" }) });
    const r2 = await runCdpTask(baseCfg({ until: "/wiki/Jev", extractInstruction: "抽取" }), { connectCdpHost: h2.connectCdpHost, engine: extractAbortEngine, signal: controller.signal, ...noSignals });
    check("抽取阶段取消 → cancelled（不会被标成 runner_error）", r2.cancelled === true && r2.reason === "cancelled" && r2.exitCode === 130, JSON.stringify({ cancelled: r2.cancelled, reason: r2.reason, exitCode: r2.exitCode }));
    check("抽取阶段取消 → finally 释放连接并保留页面", h2.calls.close.length === 1 && h2.calls.close[0].keepPage === true && r2.connection.released === true, JSON.stringify(h2.calls.close));

    // 取消后抛的是普通错误：外层 catch 也必须按 signal 判为取消，不能标 runner_error。
    const c3 = new AbortController();
    const genericAbortEngine = makeEngine({
      loop: async (p, g, o) => { if (o.check) await o.check(p, 1); return { success: true, steps: 0, reason: "check_passed", history: [] }; },
      extract: async () => { c3.abort(); throw new Error("page closed while extracting"); },
    });
    const h3 = makeHost({ page: makePage({ url: "https://example.com/wiki/Jev" }) });
    const r3 = await runCdpTask(baseCfg({ until: "/wiki/Jev", extractInstruction: "抽取" }), { connectCdpHost: h3.connectCdpHost, engine: genericAbortEngine, signal: c3.signal, ...noSignals });
    check("取消后的普通错误 → cancelled 而不是 runner_error", r3.cancelled === true && r3.reason === "cancelled" && r3.exitCode === 130, JSON.stringify({ cancelled: r3.cancelled, reason: r3.reason }));

    // 连接失败：不调 close（没有连接可释放），reason=connect_failed、exit 1。
    const connectCalls = [];
    const r4 = await runCdpTask(baseCfg(), { connectCdpHost: async (args) => { connectCalls.push(args); throw new Error("ws refused"); }, engine: makeEngine(loopScript({})), ...noSignals });
    check("连接失败 → reason=connect_failed、exit 1、无 close", r4.reason === "connect_failed" && r4.exitCode === 1 && r4.connection.connected === false && r4.connection.released === false && connectCalls.length === 1, JSON.stringify({ reason: r4.reason, connection: r4.connection }));
  }

  // ── [13] 真引擎 + 本入口：确定性命中与取消都走真实引擎 ─────────────────────
  console.log("\n[13] 真实引擎集成（假 page，无浏览器/无网络/无需凭证）");
  {
    const enginePage = (state) => ({
      url: async () => state.url,
      title: async () => state.title,
      evaluate: async (fn) => (fn && fn.name === "viewportSizeInPage" ? { width: 1280, height: 900 } : null),
    });
    const hitPage = enginePage({ url: "https://example.com/wiki/Jev", title: "Jev" });
    const h1 = makeHost({ page: hitPage });
    const r1 = await runCdpTask(baseCfg({ apiKey: "fake-key", until: "/wiki/Jev" }), { connectCdpHost: h1.connectCdpHost, engine, ...noSignals });
    check("真实引擎 + until 命中 → check_passed/verified/exit 0", r1.success === true && r1.verified === true && r1.exitCode === 0 && r1.reason === "check_passed", JSON.stringify({ success: r1.success, verified: r1.verified, reason: r1.reason }));
    check("真实引擎路径里的 close 仍是 keepPage=false", h1.calls.close[0].keepPage === false && r1.connection.released === true, JSON.stringify(h1.calls.close));

    const controller = new AbortController();
    const h2 = makeHost({ page: enginePage({ url: "https://example.com/start", title: "Start" }) });
    controller.abort();
    const r2 = await runCdpTask(baseCfg({ apiKey: "fake-key", steps: 3 }), { connectCdpHost: h2.connectCdpHost, engine, signal: controller.signal, ...noSignals });
    check("真实引擎 + 预取消 → 0 派发、cancelled、exit 130", r2.cancelled === true && r2.exitCode === 130 && h2.calls.connect.length === 0, JSON.stringify({ cancelled: r2.cancelled, exitCode: r2.exitCode, connect: h2.calls.connect.length }));
  }
}

// ── [8] CLI 入口 ────────────────────────────────────────────────────────────
console.log("\n[8] CLI：node scripts/run-cdp-task.mjs --config <file>");
{
  const run = (args) => {
    const r = spawnSync(process.execPath, [RUNNER, ...args], { encoding: "utf8", timeout: 60000 });
    return { code: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
  };
  const noArgs = run([]);
  check("无参数 → exit 2", noArgs.code === 2, `code=${noArgs.code} ${noArgs.stderr.slice(0, 200)}`);
  const help = run(["--help"]);
  check("--help → exit 0 且说明 --config", help.code === 0 && help.stdout.includes("--config"), `code=${help.code}`);
  const missing = run(["--config", join(os.tmpdir(), "definitely-missing-cdp-config.json")]);
  check("配置文件不存在 → exit 2", missing.code === 2 && missing.stderr.includes("配置"), `code=${missing.code} ${missing.stderr.slice(0, 200)}`);

  const tmp = fs.mkdtempSync(join(os.tmpdir(), "ego-cdp-cli-"));
  try {
    const bad = join(tmp, "bad.json");
    fs.writeFileSync(bad, "{ not json");
    const badRun = run(["--config", bad]);
    check("配置不是合法 JSON → exit 2", badRun.code === 2, `code=${badRun.code} ${badRun.stderr.slice(0, 200)}`);

    const badCfg = join(tmp, "bad-cfg.json");
    fs.writeFileSync(badCfg, JSON.stringify({ goal: "点击 Go" }));
    const badCfgRun = run(["--config", badCfg]);
    check("配置缺 cdpEndpoint → exit 2 且不打印结果 JSON", badCfgRun.code === 2 && badCfgRun.stdout.trim() === "", `code=${badCfgRun.code} stdout=${badCfgRun.stdout.slice(0, 120)}`);

    // 完整 CLI 闭环：临时 host + engine 模块（mock，不是真实浏览器），验证 config → JSON → 退出码
    const hostMod = join(tmp, "host.mjs");
    fs.writeFileSync(
      hostMod,
      `export async function connectCdpHost({ endpoint }) {
  const state = { url: "about:blank", title: "Fake" };
  const page = { url: async () => state.url, title: async () => state.title, goto: async (u) => { state.url = u; }, waitForTimeout: async () => {}, evaluate: async () => ({ width: 1280, height: 900 }) };
  return { page, metadata: { mode: "cli-mock", endpoint }, close: async (opts) => ({ keptPage: Boolean(opts && opts.keepPage) }) };
}
`
    );
    const engineMod = join(tmp, "engine.mjs");
    fs.writeFileSync(
      engineMod,
      `export async function runJevAutonomousLoop(page, goal, options = {}) {
  if (typeof options.check === "function" && await options.check(page, 1)) return { success: true, steps: 0, reason: "check_passed", history: [] };
  return { success: true, steps: 1, reason: "jev_done", history: [{ action: "click", target: "Go", changed: true }] };
}
export function renderJevSummary(r) { return "summary:" + r.reason; }
export async function extract() { return { success: true, data: { ok: true }, schema: null, phases: {} }; }
export function renderExtractSummary() { return "extract-summary"; }
`
    );
    const cfgPath = join(tmp, "cfg.json");
    fs.writeFileSync(cfgPath, JSON.stringify({
      cdpEndpoint: "ws://127.0.0.1:9222/devtools/browser/cli",
      hostModule: hostMod,
      engineModule: engineMod,
      goal: "点击 Go",
      url: "https://example.com/wiki/Jev",
      until: "/wiki/Jev",
      steps: 2,
      texts: [],
      cache: true,
      cacheFile: null,
      batch: true,
      visualFallback: true,
      forceViewport: "1280x900@1",
      strictViewport: false,
      deciderConfig: null,
      routeFile: null,
    }));
    const okRun = run(["--config", cfgPath]);
    let parsed = null;
    try { parsed = JSON.parse(okRun.stdout); } catch { parsed = null; }
    check("CLI 成功 → exit 0", okRun.code === 0, `code=${okRun.code} stderr=${okRun.stderr.slice(0, 200)}`);
    check("CLI 成功 → stdout 是可直接解析的结果 JSON", Boolean(parsed) && parsed.success === true && parsed.verified === true, okRun.stdout.slice(0, 200));
    check("CLI 成功 → 结果带 url/reason/actions/connection", Boolean(parsed) && parsed.url === "https://example.com/wiki/Jev" && parsed.reason === "check_passed" && Array.isArray(parsed.actions) && parsed.connection.released === true, JSON.stringify(parsed && { url: parsed.url, reason: parsed.reason, actions: parsed.actions }));
    check("CLI 日志走 stderr，不污染 stdout JSON", okRun.stderr.length > 0 && !okRun.stdout.includes("[cdp-task]"), `stderr=${okRun.stderr.slice(0, 80)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (fs.existsSync(ADAPTER)) {
    skip("真实外部 Chrome 搜索/点击/输入", "适配器已存在；真实浏览器验收由主控集成时执行（本工作树限定文件不含该用例）");
  } else {
    skip("真实外部 Chrome 搜索/点击/输入", "scripts/hosts/cdp-host.mjs 尚未提供（另一任务），真实浏览器验收由主控在适配器合入后执行");
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败 / ${skips.length} SKIP`);
for (const s of skips) console.log(`  SKIP ${s.name}: ${s.why}`);
process.exitCode = fail ? 1 : 0;
