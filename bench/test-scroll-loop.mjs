// Deterministic regressions for reveal/scroll oscillation. No browser or network.
import assert from "node:assert/strict";
import { runJevAutonomousLoop } from "../scripts/decider-loop.mjs";

const URL = "https://example.com/list";
function fixture({ content = () => "same content", moves = true, stopAt = null, clickChanges = false } = {}) {
  let y = 0, revision = 0;
  const calls = { reveals: 0, asks: 0, dispatches: 0, observations: 0 };
  const page = {
    calls,
    async evaluate(fn, arg) {
      const name = fn.name;
      if (name === "viewportSizeInPage") return { width: 1280, height: 600 };
      if (name === "revealScrollInPage") {
        calls.reveals++;
        if (stopAt === calls.reveals) throw Object.assign(new Error("user has taken control"), { code: "EGO_NOT_IN_CONTROL" });
        const from = y;
        if (moves) y += arg.direction === "up" ? -arg.delta : arg.delta;
        return { moved: y !== from, from, to: y };
      }
      if (name === "observeDom") {
        calls.observations++;
        const text = `${content(y, calls.observations)}:${revision}`;
        return { url: URL, title: "List", text, newCount: 1,
          scroll: { y, height: 100000, viewportH: 600, canScrollDown: true, canScrollUp: y > 0 },
          targets: [{ ref: "ref=1", role: "button", kind: "clickable", name: text,
            guard: [1, "button", text, false, null, null] }] };
      }
      if (name === "scrollInPage") {
        const from = y;
        if (moves) y = Math.max(0, y + arg);
        return { moved: y !== from, y };
      }
      if (name === "readScrollY") return y;
      if (name === "locateForInput") return { ok: true, x: 10, y: 20, url: URL, disabled: false };
      if (name === "cacheProgressInPage") return `${URL}:${revision}`;
      if (String(fn).includes("readyState")) return [URL, "complete"];
      return null;
    },
    async cdp(_method, arg) {
      calls.dispatches++;
      if (clickChanges && arg.type === "mouseReleased") revision++;
    },
    async url() { return URL; },
    async title() { return "List"; },
    async waitForLoadState() {},
  };
  const logs = [];
  const run = (actions, options = {}) => runJevAutonomousLoop(page, "find the requested item", {
    cache: false, textModel: null, maxSteps: 30, maxTargetMissing: 1,
    revealSettleMs: 0, settleMode: "legacy", stepDelay: 0,
    onStep: (line) => logs.push(line),
    ask: async (_state, questions) => {
      const selected = actions(calls.asks++);
      const answers = {};
      for (const [head, q] of Object.entries(questions)) {
        const keys = Object.keys(q.criteria);
        const choice = head === "operation" ? (selected === "missing" ? "click" : selected)
          : selected === "missing" ? "none" : keys.find(k => k !== "none") ?? keys[0];
        assert.ok(keys.includes(choice), `fixture choice ${head}=${choice} is supported`);
        const others = keys.filter(k => k !== choice);
        answers[head] = { choice, confidence: 0.9,
          probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 0.9 : 0.1 / others.length])) };
      }
      return answers;
    },
    ...options,
  });
  return { page, calls, logs, run };
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (err) { failed++; console.log(`FAIL ${name}: ${err.message}`); }
}

await test("missing → reveal down → scroll up returning to old state stops early", async () => {
  const f = fixture();
  const r = await f.run(i => i % 2 ? "scroll_up" : "missing");
  assert.equal(r.success, false);
  assert.equal(r.reason, "stuck");
  assert.ok(r.steps < 15, `steps=${r.steps}`);
  assert.ok(f.calls.reveals <= 4, `reveals=${f.calls.reveals}`);
  assert.equal(f.calls.dispatches, 0, "missing clicks never dispatch");
  const attempts = f.logs.filter(l => l.includes("/4 次"));
  assert.ok(attempts[1]?.includes("第 2/4"), JSON.stringify(attempts));
});

for (const action of ["wait", "click", "scroll_up"]) {
  await test(`${action} without new content cannot refill reveal quota`, async () => {
    const f = fixture({ moves: action !== "scroll_up" });
    const r = await f.run(i => i % 2 ? action : "missing", { maxReveals: 1 });
    assert.equal(r.success, false);
    assert.equal(f.calls.reveals, 1);
    assert.ok(r.steps < 10, `steps=${r.steps}`);
  });
}

await test("model up/down oscillation stops even when every scroll moves", async () => {
  const f = fixture();
  const r = await f.run(i => i % 2 ? "scroll_up" : "scroll_down");
  assert.equal(r.reason, "stuck");
  assert.ok(r.steps < 15);
  assert.ok(r.history.every(h => h.scrollMoved === true));
});

await test("continuous scrolling through new positions retains step budget", async () => {
  const f = fixture();
  const r = await f.run(() => "scroll_down", { maxSteps: 10 });
  assert.equal(r.reason, "max_steps_reached");
  assert.equal(r.steps, 10);
  assert.ok(r.history.every(h => h.scrollMoved === true));
});

await test("new content at the same position can recover instead of false loop stop", async () => {
  const f = fixture({ content: (_y, n) => `fresh-${Math.floor((n - 1) / 4)}` });
  const r = await f.run(i => i % 2 ? "scroll_up" : "scroll_down", { maxSteps: 12 });
  assert.equal(r.reason, "max_steps_reached");
  assert.equal(r.steps, 12);
});

await test("automatic reveals remain capped even while exposing new content", async () => {
  const f = fixture({ content: y => `section-${y}` });
  const r = await f.run(() => "missing", { maxReveals: 4 });
  assert.equal(f.calls.reveals, 4);
  assert.equal(r.reason, "target_missing");
});

await test("verified DOM action progress restores reveal quota", async () => {
  const f = fixture({ clickChanges: true });
  const r = await f.run(i => ["missing", "click", "missing", "blocked"][i], {
    maxReveals: 1, cache: true, cacheStorage: "memory",
  });
  assert.equal(f.calls.reveals, 2);
  assert.equal(r.reason, "blocked");
  assert.equal(r.history[1].progressed, true);
});

await test("step and reveal budgets remain hard boundaries", async () => {
  const f = fixture();
  const r = await f.run(i => i % 2 ? "scroll_up" : "missing", { maxSteps: 2, maxReveals: 1 });
  assert.equal(r.reason, "max_steps_reached");
  assert.equal(r.steps, 2);
  assert.equal(f.calls.asks, 2);
  assert.equal(f.calls.reveals, 1);
});

await test("control stop during reveal propagates without further observation or dispatch", async () => {
  const f = fixture({ stopAt: 1 });
  await assert.rejects(f.run(() => "missing"), { code: "EGO_NOT_IN_CONTROL" });
  assert.equal(f.calls.asks, 1);
  assert.equal(f.calls.observations, 1);
  assert.equal(f.calls.dispatches, 0);
});

await test("dynamic clock/timestamp does not bypass oscillation detection or refill reveals", async () => {
  // Pre-fix: unnormalized timestamps in pageText/targets caused endless newObservation,
  // running all 20 steps, triggering 10 reveals despite maxReveals: 2, ending in max_steps_reached.
  const f = fixture({ content: (_y, n) => `10:00:${String(n).padStart(2, "0")}` });
  const r = await f.run(i => i % 2 ? "scroll_up" : "missing", { maxReveals: 2, maxSteps: 20 });
  assert.equal(r.success, false);
  assert.ok(f.calls.reveals <= 2, `reveals=${f.calls.reveals} should be <= 2`);
  assert.equal(r.reason, "stuck");
  assert.ok(r.steps < 10, `steps=${r.steps} should stop early on oscillation`);
});

await test("maxSameAction: 1 does not kill first scroll on step 1 (requires >= 2 visits)", async () => {
  // Pre-fix: maxSameAction: 1 stopped on step 1 visit 1 with reason: "stuck".
  // Loop detection requires at least 2 visits to establish an oscillation.
  const f = fixture();
  const r = await f.run(() => "scroll_down", { maxSameAction: 1, maxSteps: 4 });
  assert.ok(r.steps >= 2, `steps=${r.steps} must survive initial visit on step 1`);
});

await test("snapshot observation mode detects scroll oscillation and isolates URL", async () => {
  // Pre-fix: observe:"snapshot" had scrollInfo=null and urlBefore="", bypassing
  // scroll oscillation detection and running all steps to max_steps_reached without URL isolation.
  let y = 0, asks = 0;
  const page = {
    async snapshot() { return '- button "Item" [ref=1]'; },
    async evaluate(fn, arg) {
      if (fn?.name === "scrollInPage") { y = Math.max(0, y + arg); return { moved: true, y }; }
      if (fn?.name === "readScrollY") return y;
      if (String(fn).includes("readyState")) return [URL, "complete"];
      return null;
    },
    async cdp() {},
    async url() { return URL; },
    async title() { return "List"; },
    async waitForLoadState() {},
  };
  const r = await runJevAutonomousLoop(page, "find item", {
    observe: "snapshot", enrich: false, cache: false, textModel: null, maxSteps: 10,
    settleMode: "legacy", stepDelay: 0, onStep: () => {},
    ask: async (_state, questions) => {
      const answers = {};
      for (const [head, q] of Object.entries(questions)) {
        const keys = Object.keys(q.criteria);
        const choice = head === "operation" ? (asks % 2 ? "scroll_up" : "scroll_down") : "none";
        const others = keys.filter(k => k !== choice);
        answers[head] = { choice, confidence: 0.9,
          probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 0.9 : 0.1 / (others.length || 1)])) };
      }
      asks++;
      return answers;
    },
  });
  assert.equal(r.success, false);
  assert.equal(r.reason, "stuck");
  assert.ok(r.steps < 10, `steps=${r.steps} should detect oscillation early in snapshot mode`);
  assert.ok(r.history[0].observationFingerprint, "observationFingerprint should be present");
});

console.log(`RESULT ${passed} PASS / ${failed} FAIL`);
process.exitCode = failed ? 1 : 0;
