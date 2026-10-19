// 真实网络环境实测：测量自适应 Mutation 等待在真实站点（Hacker News、Wikipedia）上的表现与 A/B 对照
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : "/Users/jiangkoumo/Documents/ego-decision-layer";
const { runJevAutonomousLoop } = await import(ROOT + "/scripts/decider-loop.mjs");

console.log("=== 真实网络环境检测开始 ===");
const report = { timestamp: new Date().toISOString(), tasks: [] };

// ── 任务 1：真实 Hacker News 两步导航（自适应 settle 模式） ──
console.log("\n[1] 真实 Hacker News 两步导航 (自适应 settleMode: default)");
{
  const space = await taskSpace(`real-hn-adaptive-${Date.now()}`);
  const page = space.page("p1");
  try {
    await page.goto("https://news.ycombinator.com", { waitUntil: "domcontentloaded", timeout: 25000 });
    const t0 = Date.now();
    const result = await runJevAutonomousLoop(page, "依次点击 new 链接，再点击 comments 链接", {
      maxSteps: 4,
      settleMode: "adaptive",
      check: async (p) => (await p.url()).includes("newcomments"),
    });
    const wallMs = Date.now() - t0;
    const stepsSettle = (result.history || []).map((h) => ({
      step: h.step,
      action: h.action,
      target: h.targetLabel,
      executeMs: h.phases?.executeMs,
      settle: h.settle,
    }));
    console.log(JSON.stringify({ task: "HN-Adaptive", success: result.success, wallMs, steps: result.steps, stepsSettle }, null, 2));
    report.tasks.push({ task: "HN-Adaptive", success: result.success, wallMs, phases: result.phases, stepsSettle });
  } finally {
    await space.finish({ keep: [] });
  }
}

// ── 任务 2：真实 Hacker News 两步导航（旧版 legacy 对照模式） ──
console.log("\n[2] 真实 Hacker News 两步导航 (旧版 legacy 对照模式)");
{
  const space = await taskSpace(`real-hn-legacy-${Date.now()}`);
  const page = space.page("p1");
  try {
    await page.goto("https://news.ycombinator.com", { waitUntil: "domcontentloaded", timeout: 25000 });
    const t0 = Date.now();
    const result = await runJevAutonomousLoop(page, "依次点击 new 链接，再点击 comments 链接", {
      maxSteps: 4,
      settleMode: "legacy",
      check: async (p) => (await p.url()).includes("newcomments"),
    });
    const wallMs = Date.now() - t0;
    const stepsSettle = (result.history || []).map((h) => ({
      step: h.step,
      action: h.action,
      target: h.targetLabel,
      executeMs: h.phases?.executeMs,
      settle: h.settle,
    }));
    console.log(JSON.stringify({ task: "HN-Legacy", success: result.success, wallMs, steps: result.steps, stepsSettle }, null, 2));
    report.tasks.push({ task: "HN-Legacy", success: result.success, wallMs, phases: result.phases, stepsSettle });
  } finally {
    await space.finish({ keep: [] });
  }
}

// ── 任务 3：真实 Wikipedia 搜索（输入 + 导航） ──
console.log("\n[3] 真实维基百科搜索任务 (输入 + 导航复合)");
{
  const space = await taskSpace(`real-wiki-adaptive-${Date.now()}`);
  const page = space.page("p1");
  try {
    await page.goto("https://en.wikipedia.org/wiki/Main_Page", { waitUntil: "domcontentloaded", timeout: 25000 });
    const t0 = Date.now();
    const result = await runJevAutonomousLoop(page, "在搜索框输入 Jev 并提交", {
      maxSteps: 4,
      text: ["Jev"],
      settleMode: "adaptive",
      check: async (p) => (await p.url()).includes("/wiki/Jev"),
    });
    const wallMs = Date.now() - t0;
    const stepsSettle = (result.history || []).map((h) => ({
      step: h.step,
      action: h.action,
      target: h.targetLabel,
      executeMs: h.phases?.executeMs,
      settle: h.settle,
    }));
    console.log(JSON.stringify({ task: "Wikipedia-Search", success: result.success, wallMs, steps: result.steps, stepsSettle }, null, 2));
    report.tasks.push({ task: "Wikipedia-Search", success: result.success, wallMs, phases: result.phases, stepsSettle });
  } finally {
    await space.finish({ keep: [] });
  }
}

console.log("\n=== 真实网络检测报告汇总 ===");
console.log(JSON.stringify(report, null, 2));
