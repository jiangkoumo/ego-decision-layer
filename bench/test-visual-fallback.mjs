// 阶段五验收：无语义界面视觉兜底通道 (Visual Grounding Fallback)。
//
// 为什么需要：借鉴 Midscene.js 视觉驱动定位思想，解决复杂 Web 应用中 Canvas、
// 富 SVG、无无障碍属性的自定义图形控件导致 DOM 元素表为空（连续 no_targets 甚至提前失败退出）的痛点：
// - 页面内几何扫描器 scanVisualRegionsInPage() 提取 <canvas>、<svg> 与图形容器的视口几何中心与可读标签；
// - 坐标执行层严格护栏 (Fail-Closed)：视口越界拦截 (coordinates_out_of_bounds) 与危险动作扫描拦截；
// - 自适应视觉兜底与可插拔 visualGrounder 调度；
// - 坐标动作在 ActionCache 中的冷写与 0ms 热直发；
// - 全自主循环 runJevAutonomousLoop 调度与 renderJevSummary 统计渲染。
//
// 本文件在 about:blank 上自造 DOM（离线、不联网、不需要任何 API Key），
// 通过 options.visualGrounder / options.ask 注入确定性决策器，其余走全真几何观测、CDP 派发与守卫流程。
//
// 用法: sed "s|__REPO__|$PWD|g" bench/test-visual-fallback.mjs | ego-browser nodejs

const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");

const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/")
  ? REPO_INJECTED
  : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { JE } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行`);
});

const {
  validateCoordinates,
  scanVisualRegionsInPage,
  ActionCache,
  runJevStep,
  runJevAutonomousLoop,
  renderJevSummary,
} = await import(JE);

let pass = 0;
let fail = 0;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

// ── 网络哨兵：整个用例必须 0 次 fetch（证明离线、无需外部模型凭证）──
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (...args) => {
  fetchCalls += 1;
  return realFetch(...args);
};

// ── [1] 单元测试：坐标边界严格校验 validateCoordinates (Fail-Closed) ──
console.log("\n[1] 单元测试：validateCoordinates 坐标边界校验");
{
  const vp = { width: 1280, height: 900 };

  check("合法视口内坐标通过", validateCoordinates(100, 200, vp).ok === true);
  check("视口左上原点 (0, 0) 通过", validateCoordinates(0, 0, vp).ok === true);
  check("视口右下边界点 (1280, 900) 通过", validateCoordinates(1280, 900, vp).ok === true);

  // 负数坐标拦截
  const negX = validateCoordinates(-1, 50, vp);
  check("负数 X 坐标立即拦截", negX.ok === false && negX.reason === "coordinates_out_of_bounds");
  const negY = validateCoordinates(50, -5, vp);
  check("负数 Y 坐标立即拦截", negY.ok === false && negY.reason === "coordinates_out_of_bounds");

  // 超出视口宽高坐标拦截
  const overX = validateCoordinates(1281, 50, vp);
  check("超出视口宽度坐标拦截", overX.ok === false && overX.reason === "coordinates_out_of_bounds");
  const overY = validateCoordinates(100, 901, vp);
  check("超出视口高度坐标拦截", overY.ok === false && overY.reason === "coordinates_out_of_bounds");

  // 非数字 / NaN / Infinity 拦截
  check("NaN 坐标拦截", validateCoordinates(NaN, 100, vp).reason === "coordinates_not_finite");
  check("Infinity 坐标拦截", validateCoordinates(100, Infinity, vp).reason === "coordinates_not_finite");
  check("非数字类型坐标拦截", validateCoordinates("100", 200, vp).reason === "coordinates_not_finite");
}

// ── [2] 单元测试：ActionCache 支持坐标动作 ──
console.log("\n[2] 单元测试：ActionCache 坐标动作存取");
{
  const tempDir = mkdtempSync(join(tmpdir(), "ego-visual-cache-test-"));
  const cachePath = join(tempDir, "action-cache.json");
  try {
    const cache = new ActionCache({ maxEntries: 10, ttlMs: 10000, filePath: cachePath });
    cache.set("click canvas chart", "fp_vis_1", {
      action: "click_at",
      x: 350,
      y: 220,
      label: "Sales Chart Canvas",
    });

    const item = cache.get("click canvas chart", "fp_vis_1");
    check("视觉坐标缓存存取成功", item && item.action === "click_at" && item.x === 350 && item.y === 220);

    // 持久化与重载
    cache.save();
    const loaded = new ActionCache({ filePath: cachePath });
    const reloaded = loaded.get("click canvas chart", "fp_vis_1");
    check("持久化坐标动作重新加载成功", reloaded && reloaded.action === "click_at" && reloaded.x === 350);

    // 非数字坐标拒绝存入
    cache.set("bad coord", "fp_bad", { action: "click_at", x: "invalid", y: 100 });
    check("非法坐标无法存入缓存", cache.get("bad coord", "fp_bad") === null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── 准备浏览器 DOM 闭环环境 ──
const space = await taskSpace(`ego-visual-bench-${Date.now()}`);
const page = space.page("p1");

const CANVAS_PAGE_HTML = `
  <div id="container" style="padding:20px;">
    <h2>Interactive Canvas Board</h2>
    <!-- 纯图形应用：没有任何 button、a、input 等常规可交互 DOM 元素 -->
    <canvas id="game-canvas" width="400" height="300" style="border:1px solid #333;display:block;background:#f0f0f0;"
            aria-label="Game Board Canvas"></canvas>
    <div id="status" style="margin-top:10px;font-weight:bold;">No Click Yet</div>
  </div>
`;

try {
  await page.goto("about:blank", { timeout: 15000 });
  await page.evaluate((html) => {
    document.body.innerHTML = html;
    window.__clickedPoint = null;
    const canvas = document.getElementById("game-canvas");
    canvas.addEventListener("click", (e) => {
      const rect = canvas.getBoundingClientRect();
      const clickX = Math.round(e.clientX);
      const clickY = Math.round(e.clientY);
      window.__clickedPoint = { x: clickX, y: clickY, time: Date.now() };
      document.getElementById("status").textContent = "Clicked at " + clickX + "," + clickY;
    });
  }, CANVAS_PAGE_HTML);

  // ── [3] 页面内几何扫描器 scanVisualRegionsInPage ──
  console.log("\n[3] 几何扫描器：scanVisualRegionsInPage 提取 Canvas/SVG 中心锚点");
  {
    const scanResult = await page.evaluate(scanVisualRegionsInPage);
    check("成功扫描到视觉区域", Array.isArray(scanResult.regions) && scanResult.regions.length >= 1);

    const canvasRegion = scanResult.regions.find((r) => r.tag === "canvas");
    check("正确识别 canvas 标签", canvasRegion !== undefined);
    check("提取到 aria-label 标签", canvasRegion?.label === "Game Board Canvas");
    check("中心锚点坐标在合理尺寸内",
      canvasRegion?.center?.x > 0 && canvasRegion?.center?.y > 0 &&
      canvasRegion?.center?.x < scanResult.viewport.width &&
      canvasRegion?.center?.y < scanResult.viewport.height
    );
  }

  // ── [4] 纯图形页面自适应激活视觉兜底并在单步内完成点击 ──
  console.log("\n[4] 视觉定位兜底：无常规 DOM 元素时自适应激活视觉通道派发点击");
  {
    // 重置点击记录
    await page.evaluate(() => {
      window.__clickedPoint = null;
      document.getElementById("status").textContent = "No Click Yet";
    });

    // 注入自定义视觉定位器 visualGrounder（模拟视觉模型返回目标坐标）
    let grounderCalled = false;
    const customVisualGrounder = async (p, goal, ctx) => {
      grounderCalled = true;
      const target = ctx.visualRegions.find((r) => r.label.includes("Game Board"));
      if (target) {
        return {
          action: "click_at",
          x: target.center.x,
          y: target.center.y,
          label: target.label,
        };
      }
      return null;
    };

    const stepResult = await runJevStep(page, "点击游戏画板中心", {
      visualGrounder: customVisualGrounder,
      cache: false,
    });

    check("自适应切换至视觉模式 (observeMode === 'visual')", stepResult.observeMode === "visual");
    check("标记 visualFallback === true", stepResult.visualFallback === true);
    check("视觉定位器被成功调用", grounderCalled === true);
    check("动作类型为 click_at", stepResult.action === "click_at");
    check("执行成功且无报错", stepResult.error === null && stepResult.guardRejected === null);

    // 验证真实 Canvas DOM 事件落地与命中坐标
    const clickedPoint = await page.evaluate(() => window.__clickedPoint);
    check("真实 Canvas 成功接收到裸 CDP 点击事件", clickedPoint !== null);
    check("点击坐标与视觉定位器中心锚点精确吻合",
      clickedPoint && clickedPoint.x === stepResult.x && clickedPoint.y === stepResult.y
    );
  }

  // ── [5] 坐标执行层严格护栏 (Fail-Closed) 越界拦截 ──
  console.log("\n[5] 执行层严格护栏：超出视口坐标被绝对拦截 (0 派发)");
  {
    await page.evaluate(() => {
      window.__clickedPoint = null;
    });

    // 视觉定位器返回了越界坐标 (如 x: 9999, y: 9999)
    const outOfBoundsGrounder = async () => ({
      action: "click_at",
      x: 9999,
      y: 9999,
      label: "Offscreen Target",
    });

    const rOutOfBounds = await runJevStep(page, "点击越界目标", {
      visualGrounder: outOfBoundsGrounder,
      cache: false,
    });

    check("越界坐标执行前守卫拒绝 (guardRejected === 'coordinates_out_of_bounds')",
      rOutOfBounds.guardRejected === "coordinates_out_of_bounds"
    );

    // 负数坐标拦截
    const negativeGrounder = async () => ({
      action: "click_at",
      x: -50,
      y: 100,
      label: "Negative Target",
    });

    const rNegative = await runJevStep(page, "点击负数坐标目标", {
      visualGrounder: negativeGrounder,
      cache: false,
    });

    check("负数坐标执行前守卫拒绝 (guardRejected === 'coordinates_out_of_bounds')",
      rNegative.guardRejected === "coordinates_out_of_bounds"
    );

    // 确认页面没有收到任何越界 CDP 鼠标事件
    const pointAfterRejection = await page.evaluate(() => window.__clickedPoint);
    check("越界拦截期间 0 次 CDP 事件派发 (clickedPoint === null)", pointAfterRejection === null);
  }

  // ── [6] 危险视觉标签前置拦截 (assessDanger) ──
  console.log("\n[6] 原子护栏：危险视觉区域前置拦截 (0 派发)");
  {
    await page.evaluate(() => {
      window.__clickedPoint = null;
    });

    // 视觉定位器返回了一个携带危险动作名称的坐标
    const dangerGrounder = async (p, goal, ctx) => {
      const target = ctx.visualRegions[0];
      return {
        action: "click_at",
        x: target.center.x,
        y: target.center.y,
        label: "Delete All Records Canvas", // 触发 deletion 危险词
      };
    };

    const rDanger = await runJevStep(page, "危险视觉操作", {
      visualGrounder: dangerGrounder,
      cache: false,
    });

    check("危险视觉标签被前置拦截 (guardRejected === 'dangerous_action')",
      rDanger.guardRejected === "dangerous_action"
    );
    check("命中具体危险词", rDanger.dangerousMatch === "delete");

    const pointAfterDanger = await page.evaluate(() => window.__clickedPoint);
    check("危险拦截期间 0 次点击派发", pointAfterDanger === null);
  }

  // ── [7] 视觉动作在 ActionCache 中的冷写与热直发 (0ms decideMs) ──
  console.log("\n[7] ActionCache 协同：视觉动作冷写入与热直发 (0ms 决策)");
  {
    await page.evaluate(() => {
      window.__clickedPoint = null;
      document.getElementById("status").textContent = "No Click Yet";
    });

    const visualCache = new ActionCache({ maxEntries: 20 });
    let grounderCallCount = 0;

    const countingGrounder = async (p, goal, ctx) => {
      grounderCallCount++;
      const target = ctx.visualRegions[0];
      return {
        action: "click_at",
        x: target.center.x,
        y: target.center.y,
        label: "Cached Canvas Target",
      };
    };

    // 7.1 冷启动：调用 visualGrounder 定位并写入缓存
    const rCold = await runJevStep(page, "视觉画板交互", {
      visualGrounder: countingGrounder,
      actionCache: visualCache,
    });

    check("冷启动视觉派发成功", rCold.action === "click_at" && rCold.observeMode === "visual");
    check("冷启动调用了定位器 (grounderCallCount === 1)", grounderCallCount === 1);
    check("冷启动未命中缓存 (cacheHit === false)", rCold.cacheHit === false);
    check("冷启动将视觉动作写入 ActionCache", visualCache.stats().size === 1);

    // 重置页面点击状态
    await page.evaluate(() => {
      window.__clickedPoint = null;
      document.getElementById("status").textContent = "No Click Yet";
    });

    // 7.2 热启动：相同图形 DOM 结构，0ms 命中指纹缓存，跳过定位器直发！
    const rHot = await runJevStep(page, "视觉画板交互", {
      visualGrounder: countingGrounder,
      actionCache: visualCache,
    });

    check("热启动命中视觉动作缓存 (cacheHit === true)", rHot.cacheHit === true);
    check("热启动跳过视觉定位器调用 (grounderCallCount 仍为 1)", grounderCallCount === 1);
    check("热启动决策耗时为 0ms (phases.decideMs === 0)", rHot.phases.decideMs === 0);
    check("热启动点击坐标完全一致", rHot.x === rCold.x && rHot.y === rCold.y);

    const pointAfterHot = await page.evaluate(() => window.__clickedPoint);
    check("热启动直发真实 Canvas 收到点击", pointAfterHot !== null && pointAfterHot.x === rHot.x);
  }

  // ── [8] 全自主循环 runJevAutonomousLoop 与 Summary 视觉统计 ──
  console.log("\n[8] Autonomous Loop 视觉兜底与 Summary 渲染");
  {
    await page.evaluate(() => {
      window.__clickedPoint = null;
      document.getElementById("status").textContent = "No Click Yet";
    });

    const loopGrounder = async (p, goal, ctx) => {
      const target = ctx.visualRegions[0];
      return {
        action: "click_at",
        x: target.center.x,
        y: target.center.y,
        label: "Loop Canvas Target",
      };
    };

    const loopResult = await runJevAutonomousLoop(page, "在画布上完成初始点击", {
      visualGrounder: loopGrounder,
      maxSteps: 3,
      cache: false,
      check: async () => {
        return (await page.evaluate(() => window.__clickedPoint !== null));
      },
    });

    check("循环在第 1 步视觉动作后 check() 确认成功达成", loopResult.success === true);
    check("循环记录激活视觉兜底 (visualStepsCount === 1)", loopResult.visualStepsCount === 1);

    const summary = renderJevSummary(loopResult);
    check("renderJevSummary 展示视觉兜底统计行",
      summary.includes("视觉兜底: 激活 1 次视觉坐标定位")
    );
  }

  // ── [9] 显式禁用 options.visualFallback: false 验证 ──
  console.log("\n[9] 显式禁用验证：options.visualFallback: false 保持原有 no_targets");
  {
    const rDisabled = await runJevStep(page, "禁用视觉兜底", {
      visualFallback: false,
      cache: false,
    });

    check("禁用视觉兜底时返回 no_targets", rDisabled.reason === "no_targets");
    check("禁用视觉兜底时不触发视觉模式", rDisabled.observeMode !== "visual");
  }

  // ── [10] 网络哨兵验证 ──
  console.log("\n[10] 网络哨兵验证");
  check("离线测试全程 0 次外部网络请求 (fetchCalls === 0)", fetchCalls === 0, `fetchCalls=${fetchCalls}`);

} finally {
  await space.finish({ keep: [] });
}

console.log(`\n========================================`);
console.log(`Phase 5 Visual Grounding Fallback 测试结果: ${pass} 通过 / ${fail} 失败`);
console.log(`========================================`);
process.exitCode = fail === 0 ? 0 : 1;
