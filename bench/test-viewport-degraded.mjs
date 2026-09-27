// bench/test-viewport-degraded.mjs — 视口 0×0（本机新建 space 的常态）时的回归测试。
//
// 背景：本机 ego lite 0.5.1.13 上，taskSpace 新建的标签页在未导航 / domcontentloaded / load
// 之后 innerWidth/innerHeight 都是 0×0，page.info() 也拿不到尺寸。元素表按视口可见性构建，
// 0×0 时恒为空。0.4.2 曾把它当异常直接失败（viewport_degraded）——那在本机正常路径上就是回归；
// 0.4.3 改为**默认自动撑起**（setDeviceMetricsOverride 1280x900@1）后照常跑，只有撑不起来
// （CDP 报错）或显式 --no-force-viewport / strictViewport 时才失败。
//
// 纯 node、stub page、stub fetch：无浏览器、无网络、无凭证。退出码 0/1。
// 用法: node bench/test-viewport-degraded.mjs
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// 默认 decider.json 指向一个不存在的路径：保证「未配置」分支不受本机已有配置影响。
const TMP = mkdtempSync(join(tmpdir(), "ego-decision-layer-viewport-"));
process.env.EGO_JEV_DECIDER_FILE = join(TMP, "nonexistent-decider.json");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const JE = join(REPO, "scripts", "decider-loop.mjs");
const CLI = join(REPO, "scripts", "ego-decision-layer");
const { runJevAutonomousLoop, parseViewportSpec, DEFAULT_VIEWPORT } = await import(JE);

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// ── stub fetch：计数；被真正问到 Jev 时返回一个合法的 System One「done」回答 ──────
let fetchCalls = 0;
const systemOneAnswers = (questions, prefer = {}) => {
  const answers = {};
  for (const [head, q] of Object.entries(questions)) {
    const keys = Object.keys(q.criteria);
    const want = prefer[head];
    const choice = want && keys.includes(want) ? want : keys.find((k) => k !== "none") ?? keys[0];
    const rest = keys.filter((k) => k !== choice);
    const probabilities = { [choice]: 0.9 };
    for (const k of rest) probabilities[k] = 0.1 / rest.length;
    answers[head] = { choice, confidence: 0.9, probabilities };
  }
  return answers;
};
globalThis.fetch = async (url, init) => {
  fetchCalls += 1;
  const body = JSON.parse(init.body);
  return {
    ok: true,
    async json() {
      return { model: "jev-stub", answers: systemOneAnswers(body.questions, { operation: "done" }), usage: { input_tokens: 1, output_tokens: 1 } };
    },
  };
};

// 观测结果与 test-decider-backend 同款（有 kind 与结构指纹，走真实 DOM 观测路径的形状）
const observation = {
  url: "https://example.com/",
  title: "Example",
  text: "hello",
  targets: [
    { ref: "ref=1", role: "link", kind: "clickable", name: "Next", guard: [1, "link", "Next", false, null, "/next"] },
  ],
};

/**
 * stub page：
 *   viewport     初始视口
 *   afterOverride 覆盖生效后的视口（模拟 setDeviceMetricsOverride 生效）
 *   cdpThrows    true = setDeviceMetricsOverride 抛错（模拟撑不起来）
 */
const makePage = ({ viewport = { width: 1280, height: 900 }, afterOverride = null, cdpThrows = false } = {}) => {
  const state = { width: viewport.width, height: viewport.height };
  const calls = { cdp: 0, cdpMethods: [], setDeviceCalls: [], clearCalls: 0, evaluate: 0, click: 0 };
  return {
    calls,
    state,
    async evaluate(fn) {
      calls.evaluate += 1;
      const src = String(fn);
      if (src.includes("viewportSizeInPage")) return { width: state.width, height: state.height };
      if (src.includes("observeDom") || src.includes("document.querySelectorAll")) return observation;
      if (src.includes("locateForInput")) return { ok: true, x: 10, y: 20, url: observation.url, disabled: false, ariaDisabled: null, href: "/next" };
      if (src.includes("location.href")) return observation.url;
      if (src.includes("scrollInPage") || src.includes("scrollY")) return { moved: true, y: 600 };
      return null;
    },
    async url() { return observation.url; },
    async title() { return observation.title; },
    async cdp(method, params) {
      calls.cdp += 1;
      calls.cdpMethods.push(method);
      if (method === "Emulation.setDeviceMetricsOverride") {
        if (cdpThrows) throw new Error("stub: setDeviceMetricsOverride failed");
        calls.setDeviceCalls.push(params);
        if (afterOverride) { state.width = afterOverride.width; state.height = afterOverride.height; }
      }
      if (method === "Emulation.clearDeviceMetricsOverride") {
        calls.clearCalls += 1;
        state.width = viewport.width; state.height = viewport.height;
      }
    },
    async click() { calls.click += 1; },
    async fill() {},
    async press() {},
    async selectOption() {},
    async waitForLoadState() {},
    async events() { return []; },
    async waitForTimeout() {},
  };
};

const run = async (page, options) => {
  const logs = [];
  fetchCalls = 0;
  const r = await runJevAutonomousLoop(page, "点 Next", { textModel: null, maxSteps: 10, onStep: (m) => logs.push(m), ...options });
  return { r, logs, fetchCalls };
};

// ── [1] 视口 0×0 + 不传 forceViewport → 默认自动撑起，不失败 ──────────────────
console.log("\n[1] 视口 0×0 不传 forceViewport → 自动撑起 1280×900，循环继续");
{
  const page = makePage({ viewport: { width: 0, height: 0 }, afterOverride: { width: 1280, height: 900 } });
  const { r, logs, fetchCalls: fc } = await run(page, {});
  const setCall = page.calls.setDeviceCalls[0];
  check("reason ≠ viewport_degraded（不再硬失败）", r.reason !== "viewport_degraded", JSON.stringify(r.reason));
  check("循环正常推进（jev_done / success）", r.success === true && r.reason === "jev_done", JSON.stringify({ success: r.success, reason: r.reason }));
  check("调用了 Emulation.setDeviceMetricsOverride", page.calls.cdpMethods.includes("Emulation.setDeviceMetricsOverride"), JSON.stringify(page.calls.cdpMethods));
  check("自动尺寸 = 1280×900@1", Boolean(setCall) && setCall.width === 1280 && setCall.height === 900 && setCall.deviceScaleFactor === 1, JSON.stringify(setCall));
  check("日志有自动撑起说明", logs.join("\n").includes("已自动撑起"), logs.join("\n").slice(0, 160));
  check("日志提到 --no-force-viewport", logs.join("\n").includes("--no-force-viewport"), logs.join("\n").slice(0, 200));
  check("撑起后确实问了模型（fetch ≥ 1）", fc >= 1, String(fc));
  check("返回值带 viewportOverride", r.viewportOverride && r.viewportOverride.width === 1280, JSON.stringify(r.viewportOverride));
}

// ── [2] 视口 0×0 + strictViewport → 直接失败，零 CDP / 零模型请求 ───────────
console.log("\n[2] 视口 0×0 + strictViewport → viewport_degraded（strict）");
{
  const page = makePage({ viewport: { width: 0, height: 0 } });
  const { r, logs, fetchCalls: fc } = await run(page, { strictViewport: true });
  check("reason=viewport_degraded", r.reason === "viewport_degraded", JSON.stringify(r.reason));
  check("success=false", r.success === false, JSON.stringify(r.success));
  check("steps=0（没有空转）", r.steps === 0, String(r.steps));
  check("没有任何 CDP 调用（不含覆盖调用）", page.calls.cdp === 0, JSON.stringify(page.calls.cdpMethods));
  check("没有发出任何 Jev 请求", fc === 0, String(fc));
  check("没有派发点击", page.calls.click === 0, String(page.calls.click));
  check("hint 含 --force-viewport", typeof r.hint === "string" && r.hint.includes("--force-viewport"), String(r.hint));
  check("hint 说明是 strict 要求直接失败", typeof r.hint === "string" && (r.hint.includes("strictViewport") || r.hint.includes("--no-force-viewport")), String(r.hint));
  check("hint 也进了日志", logs.join("\n").includes("--force-viewport"), logs.join("\n").slice(0, 160));
  check("viewportOverride 为空", r.viewportOverride === null, JSON.stringify(r.viewportOverride));
}

// ── [3] 视口 0×0 + 覆盖调用失败 → viewport_degraded + hint ──────────────────
console.log("\n[3] 视口 0×0 + CDP 撑不起来 → viewport_degraded + hint");
{
  const page = makePage({ viewport: { width: 0, height: 0 }, cdpThrows: true });
  const { r, logs, fetchCalls: fc } = await run(page, {});
  check("reason=viewport_degraded", r.reason === "viewport_degraded", JSON.stringify(r.reason));
  check("steps=0", r.steps === 0, String(r.steps));
  check("没有发出任何 Jev 请求", fc === 0, String(fc));
  check("hint 含 --force-viewport", typeof r.hint === "string" && r.hint.includes("--force-viewport"), String(r.hint));
  check("hint 说明自动撑起失败（含报错）", typeof r.hint === "string" && r.hint.includes("自动撑起失败") && r.hint.includes("stub:"), String(r.hint));
  check("日志有失败提示", logs.join("\n").includes("自动撑起失败"), logs.join("\n").slice(0, 160));
}

// ── [4] 视口正常 → 零覆盖调用，行为与改前一致 ──────────────────────────────
console.log("\n[4] 视口正常（1280×900）→ 零额外 CDP");
{
  const page = makePage({ viewport: { width: 1280, height: 900 } });
  const { r, fetchCalls: fc } = await run(page, { maxSteps: 3 });
  check("reason=jev_done", r.reason === "jev_done", JSON.stringify(r.reason));
  check("没有调用 Emulation.setDeviceMetricsOverride", !page.calls.cdpMethods.includes("Emulation.setDeviceMetricsOverride"), JSON.stringify(page.calls.cdpMethods));
  check("完全没有 CDP 调用（零额外 CDP）", page.calls.cdp === 0, JSON.stringify(page.calls.cdpMethods));
  check("照常问模型（fetch ≥ 1）", fc >= 1, String(fc));
  check("viewportOverride 为空", r.viewportOverride === null, JSON.stringify(r.viewportOverride));
  check("没有 hint / viewport 退化字段", r.hint === undefined && r.viewport === undefined, JSON.stringify({ hint: r.hint, viewport: r.viewport }));
}

// ── [5] --force-viewport 显式值优先于自动默认值 ────────────────────────────
console.log("\n[5] forceViewport 显式值优先于自动 1280×900");
{
  const page = makePage({ viewport: { width: 0, height: 0 }, afterOverride: { width: 1024, height: 768 } });
  const { r } = await run(page, { forceViewport: "1024x768@2", maxSteps: 3 });
  const setCall = page.calls.setDeviceCalls[0];
  check("用显式 1024×768@2（不是 1280×900）", Boolean(setCall) && setCall.width === 1024 && setCall.height === 768 && setCall.deviceScaleFactor === 2, JSON.stringify(setCall));
  check("循环正常推进", r.success === true && r.reason === "jev_done", JSON.stringify({ reason: r.reason }));
  check("viewportOverride 记录显式值", r.viewportOverride && r.viewportOverride.width === 1024, JSON.stringify(r.viewportOverride));
}

// ── [6] 确定性：两次运行输出字节一致 ────────────────────────────────────────
console.log("\n[6] 确定性");
{
  const mk = () => run(makePage({ viewport: { width: 0, height: 0 } }), { strictViewport: true });
  const a = await mk(), b = await mk();
  const shape = (x) => JSON.stringify({ reason: x.r.reason, hint: x.r.hint, viewport: x.r.viewport, steps: x.r.steps, logs: x.logs });
  check("两次 strict 失败输出逐字节一致", shape(a) === shape(b), "输出不同");
}

// ── [7] parseViewportSpec / DEFAULT_VIEWPORT ───────────────────────────────
console.log("\n[7] parseViewportSpec / DEFAULT_VIEWPORT");
{
  check("DEFAULT_VIEWPORT = 1280×900@1", JSON.stringify(DEFAULT_VIEWPORT) === JSON.stringify({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }), JSON.stringify(DEFAULT_VIEWPORT));
  check("1280x900 → {1280,900,1}", JSON.stringify(parseViewportSpec("1280x900")) === JSON.stringify({ width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }), JSON.stringify(parseViewportSpec("1280x900")));
  check("1280x900@2 → scale=2", parseViewportSpec("1280x900@2")?.deviceScaleFactor === 2, JSON.stringify(parseViewportSpec("1280x900@2")));
  check("对象 {width,height,deviceScaleFactor} 可用", parseViewportSpec({ width: 1280, height: 900, deviceScaleFactor: 2 })?.width === 1280, JSON.stringify(parseViewportSpec({ width: 1280, height: 900, deviceScaleFactor: 2 })));
  for (const bad of ["", "bogus", "1280", "0x900", "1280x0", "1280x900@", "1280x900@.5", "1280x900@5.", "1280X900", null, {}]) {
    check(`非法输入 ${JSON.stringify(bad)} → null`, parseViewportSpec(bad) === null, JSON.stringify(parseViewportSpec(bad)));
  }
}

// ── [8] CLI：--force-viewport 校验 + --no-force-viewport 被识别 ────────────
console.log("\n[8] CLI 参数");
{
  const env = { ...process.env, EGO_JEV_NO_WIRE: "1" };
  const runCli = (...args) => spawnSync("bash", [CLI, ...args], { env, encoding: "utf8" });
  const bad = runCli("--force-viewport", "bogus");
  check("--force-viewport 非法 → exit 2", bad.status === 2, `exit=${bad.status}`);
  check("错误信息说明期望格式", /宽.*高|WxH/.test(`${bad.stdout}${bad.stderr}`), `${bad.stdout}${bad.stderr}`);
  check("--force-viewport 缺参 → exit 2", runCli("--force-viewport").status === 2);
  const good = runCli("--force-viewport", "1280x900");
  check("--force-viewport 合法 → 不报格式错（仍是缺目标的 exit 2）", good.status === 2 && !/参数非法/.test(`${good.stdout}${good.stderr}`), `exit=${good.status} ${good.stdout}${good.stderr}`);
  const strict = runCli("--no-force-viewport");
  check("--no-force-viewport 被识别（缺目标 exit 2，不是未知选项）", strict.status === 2 && /请提供目标描述/.test(`${strict.stdout}${strict.stderr}`), `exit=${strict.status} ${strict.stdout}${strict.stderr}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
