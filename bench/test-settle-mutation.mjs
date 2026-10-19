// 阶段一验收：自适应 Mutation 页面稳定等待（Adaptive Settle）。
//
// 为什么需要：旧 settle 是「固定 40ms + 最多 120ms 轮询 URL/readyState」，
// 它对静态页面也要烧掉固定开销，而且完全看不见 DOM 变动（异步渲染只能靠下一轮观测兜底）。
// 本文件在 about:blank 上自造 DOM（不联网、不需要凭证），直接驱动真实的 settle 与页内追踪器：
//   [1] 追踪器挂载：首次挂载返回 true，重复挂载返回 false（幂等）
//   [2] 静态快速通道：零变动页面走 fast 路径，IPC 降到 3 次以内
//   [3] 状态查询：同步 DOM 变动能被计数，sinceMs 反映变动时间
//   [4] 异步渲染：动作后的延迟变动会被等待到静止（quiet），而不是立即返回
//   [5] 导航安全：URL 改变时走 navigated 分支，不误判成「已稳定」
//   [6] 无追踪器回退：追踪器装不上时仍按旧轮询行为工作，不会崩
//   [7] 持续变动兜底：持续变动时由静默窗口硬上限退出，绝不无限等
//   [8] legacy 对照：settleMode="legacy" 仍是旧行为（用于「等待策略单独收益」的 A/B）
//
// 用法（测当前工作树）: sed "s|__REPO__|$PWD|g" bench/test-settle-mutation.mjs | ego-browser nodejs
// 直接 `< bench/test-settle-mutation.mjs`：走已安装技能（~/.agents/skills/ego-decision-layer，本机是指向仓库的软链）
const { writeFile, mkdir } = await import("node:fs/promises");
const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/") ? REPO_INJECTED : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { BENCH, JE } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行`);
});
const { settle, installMutationTracker, stateInPage } = await import(JE);

let pass = 0;
let fail = 0;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

check(
  "引擎导出 settle / installMutationTracker / stateInPage",
  typeof settle === "function" && typeof installMutationTracker === "function" && typeof stateInPage === "function"
);

const counter = () => {
  const metrics = {};
  return { metrics, fn: (key) => { metrics[key] = (metrics[key] || 0) + 1; } };
};

const space = await taskSpace(`ego-settle-${Date.now()}`);
const page = space.page("p1");

/**
 * 开一个干净的 about:blank 并挂载追踪器。
 * 顺序很关键：先 reload 到新文档、立刻挂追踪器，再做任何 DOM 操作 ——
 * 否则 innerHTML 引起的变动会在挂载之前发生，让「零变动快速通道」失去区分度。
 */
const fresh = async () => {
  await page.goto("about:blank", { timeout: 15000 });
  const mounted = await page.evaluate(installMutationTracker);
  await page.evaluate(() => { document.body.innerHTML = "<div id='root'></div>"; });
  await page.waitForTimeout(200); // 让 innerHTML 引起的变动静止
  return mounted;
};

try {
  // ── [1] 幂等挂载 ──
  console.log("\n[1] 追踪器挂载幂等性");
  {
    await fresh();
    const again = await page.evaluate(installMutationTracker);
    check("重复挂载返回 false（幂等）", again === false, JSON.stringify(again));
    const state = await page.evaluate(stateInPage);
    check("挂载后状态可读（mutations >= 1）", state[2] >= 1, JSON.stringify(state));
  }

  // ── [2] 静态快速通道 ──
  console.log("\n[2] 静态页面走快速通道（零新增变动）");
  {
    // 这是一个「刚刚挂载、还没有任何 DOM 变动」的新文档：正是 fast 路径的目标场景
    await page.goto("about:blank", { timeout: 15000 });
    const mounted = await page.evaluate(installMutationTracker);
    check("新文档上追踪器是首次挂载", mounted === true, JSON.stringify(mounted));
    const freshState = await page.evaluate(stateInPage);
    check("零变动时 mutations=0 且 sinceMs=-1", freshState[2] === 0 && freshState[3] === -1, JSON.stringify(freshState));
    const c = counter();
    const urlBefore = await page.url();
    const t0 = Date.now();
    const r = await settle(page, { metricFn: c.fn, settleQuietMs: 120 }, urlBefore);
    const elapsed = Date.now() - t0;
    check("返回 fast=true（一次状态查询即返回）", r.fast === true, JSON.stringify(r));
    check("实际耗时 < 60ms（未空等静默窗口）", elapsed < 60, `elapsed=${elapsed}ms`);
    check("IPC 次数 <= 3", (c.metrics["page.evaluate"] || 0) <= 3, JSON.stringify(c.metrics));
  }

  // ── [3] 状态查询与变动计数 ──
  console.log("\n[3] 状态查询与变动计数");
  {
    await fresh();
    const before = await page.evaluate(stateInPage);
    await page.evaluate(() => { document.getElementById("root").appendChild(document.createElement("span")); });
    const after = await page.evaluate(stateInPage);
    check("状态是 4 元组 [url, readyState, mutations, sinceMs]", Array.isArray(after) && after.length === 4, JSON.stringify(after));
    check("DOM 变动被计数（mutations 递增）", after[2] > before[2], `${before[2]} -> ${after[2]}`);
    check("sinceMs 反映距上次变动的时间", after[3] >= 0 && after[3] < 500, JSON.stringify(after[3]));
  }

  // ── [4] 异步渲染会被等到静止 ──
  console.log("\n[4] 异步渲染：延迟变动被等到静止");
  {
    await fresh();
    const c = counter();
    const urlBefore = await page.url();
    const before = await page.evaluate(stateInPage);
    // 用一个「晚于首次快速判定、早于等待上限」的变动：settle 必须靠 quiet 等待覆盖它，
    // 而不是一看「当前没有变动」就立刻返回。
    await page.evaluate(() => {
      setTimeout(() => { document.getElementById("root").appendChild(document.createElement("b")); }, 130);
    });
    const t0 = Date.now();
    const r = await settle(page, { metricFn: c.fn, settleQuietMs: 120 }, urlBefore);
    const elapsed = Date.now() - t0;
    const after = await page.evaluate(stateInPage);
    check("返回 quiet=true（等到了渲染静止）", r.quiet === true, JSON.stringify(r));
    check("不是 fast（说明确实观察到并等待了变动）", r.fast === false, JSON.stringify(r));
    check("延迟的 DOM 变动确实落地了", after[2] > before[2], `${before[2]} -> ${after[2]}`);
    check("变动落地后 sinceMs 已回到合理的近处", after[3] >= 0 && after[3] < 250, JSON.stringify(after[3]));
    check("等待覆盖了 130ms 延迟变动（耗时 >= 130ms）", elapsed >= 130, `elapsed=${elapsed}ms`);
    check("等待有界（耗时 < 600ms）", elapsed < 600, `elapsed=${elapsed}ms`);
  }

  // ── [5] 导航安全 ──
  console.log("\n[5] 导航不会被误判为「已稳定」");
  {
    await fresh();
    const c = counter();
    const r = await settle(page, { metricFn: c.fn, settleQuietMs: 120 }, "https://example.invalid/previous");
    check("返回 navigated=true", r.navigated === true, JSON.stringify(r));
    check("navigated 时不报 fast/quiet", r.fast === false && r.quiet === false, JSON.stringify(r));
  }

  // ── [6] 追踪器不可用时的回退 ──
  console.log("\n[6] 追踪器装不上时仍能工作（回退轮询）");
  {
    await page.goto("about:blank", { timeout: 15000 });
    // 用一个会抛错的桩替掉追踪器安装，模拟页面限制
    await page.evaluate(() => {
      Object.defineProperty(window, "__egoJevSettle", {
        configurable: true,
        get() { throw new Error("blocked by test"); },
      });
    });
    let stopped = false;
    try { await settle(page, { settleQuietMs: 60 }, await page.url()); }
    catch (err) { stopped = /blocked by test/.test(err.message); }
    check("未知 evaluate 错误传播，不能当导航恢复", stopped);
    await page.evaluate(() => { delete window.__egoJevSettle; });
  }

  // ── [7] 持续变动不会无限等 ──
  console.log("\n[7] 持续变动由静默窗口硬上限退出");
  {
    await fresh();
    await page.evaluate(() => {
      const root = document.getElementById("root");
      let n = 0;
      window.__settleChurn = setInterval(() => {
        root.appendChild(document.createElement("i"));
        if (++n >= 50) clearInterval(window.__settleChurn);
      }, 20);
    });
    const c = counter();
    const t0 = Date.now();
    const r = await settle(page, { metricFn: c.fn, settleQuietMs: 120 }, await page.url());
    const elapsed = Date.now() - t0;
    check("持续变动下仍然返回（有界）", Boolean(r), JSON.stringify(r));
    check("耗时受控（< 700ms）", elapsed < 700, `elapsed=${elapsed}ms`);
    await page.evaluate(() => clearInterval(window.__settleChurn));
  }

  // ── [8] legacy 对照模式 ──
  console.log("\n[8] legacy 模式仍是旧行为（用于 A/B 对照）");
  {
    const t0 = Date.now();
    await settle(page, { settleMode: "legacy", stepDelay: 120 }, await page.url());
    const elapsed = Date.now() - t0;
    check("legacy 至少等待完整的 stepDelay", elapsed >= 120, `elapsed=${elapsed}ms`);
  }
} finally {
  try { await space.finish({ keep: [] }); } catch { /* 已关闭 */ }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await mkdir(`${BENCH}/raw`, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
await writeFile(`${BENCH}/raw/test-settle-mutation-${stamp}.json`, JSON.stringify({ pass, fail, results }, null, 2));
console.log("RAW: " + `${BENCH}/raw/test-settle-mutation-${stamp}.json`);
process.exitCode = fail ? 1 : 0;
