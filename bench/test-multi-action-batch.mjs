// 阶段四验收：多动作批量打包派发 (Multi-Action Batching)。
//
// 为什么需要：借鉴 Browser-Use 与现代浏览器自动化项目中的 Action Batching 思想，
// 消除多字段表单/连续操作每步都必须经历一次“观测 -> 模型往返 -> 派发 -> 稳定等待”的昂贵开销。
// - 支持多动作打包在单步内批量派发（如连续填充多个表单项、或填充字段后紧随提交按钮）；
// - 执行层原子预检护栏：任一动作命中危险词表则整批拦截，0 次派发；
// - 性能提升：整批动作只在末尾调用一次 settle 页面稳定等待；
// - 中断与状态记录：执行中途目标丢失时精确记录 executedSubActions 并安全停止，绝不盲目重复；
// - 与 Phase 3 ActionCache 动作指纹缓存无缝协同：复合操作缓存与 0ms 直发。
//
// 本文件在 about:blank 上自造 DOM（离线、不联网、不需要任何 API Key），
// 通过 options.ask 注入确定性决策器，其余走全真 DOM 观测、指纹计算、CDP 派发与守卫流程。
//
// 用法: sed "s|__REPO__|$PWD|g" bench/test-multi-action-batch.mjs | ego-browser nodejs

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
  isActionBatch,
  normalizeActionBatch,
  ActionCache,
  extractTargetSignature,
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

// ── [1] 单元测试：isActionBatch 与 normalizeActionBatch ──
console.log("\n[1] 单元测试：isActionBatch 与 normalizeActionBatch");
{
  check("isActionBatch 正确识别数组批次", isActionBatch([{ action: "click", target: "ref=1" }]) === true);
  check("isActionBatch 正确识别对象 batch 动作", isActionBatch({ action: "batch", subActions: [] }) === true);
  check("isActionBatch 正确识别 subActions 列表", isActionBatch({ subActions: [{ action: "click" }] }) === true);
  check("isActionBatch 对空值返回 false", isActionBatch(null) === false && isActionBatch([]) === false);
  check("isActionBatch 对普通单动作返回 false", isActionBatch({ action: "click" }) === false);

  const mockTargets = [
    { ref: "ref=1", role: "textbox", kind: "editable", name: "Username" },
    { ref: "ref=2", role: "textbox", kind: "editable", name: "Email" },
    { ref: "ref=3", role: "button", kind: "clickable", name: "Submit" },
    { ref: "ref=4", role: "combobox", kind: "selectable", name: "Role", options: ["User", "Admin"], optionValues: ["u", "a"] },
  ];

  // 合法批次规范化
  const validBatch = [
    { action: "type_text", target: "ref=1", text: "alice" },
    { action: "type_text", target: "ref=2", text: "alice@example.com" },
    { action: "select", target: "ref=4#1" },
    { action: "click", target: "ref=3" },
  ];
  const normValid = normalizeActionBatch(validBatch, mockTargets);
  check("合法批次规范化成功", normValid.ok === true && normValid.subActions.length === 4);
  check("子动作目标元素与文本正确绑定",
    normValid.subActions[0].chosenTarget?.name === "Username" &&
    normValid.subActions[0].text === "alice" &&
    normValid.subActions[1].text === "alice@example.com" &&
    normValid.subActions[2].optionIndex === 1 &&
    normValid.subActions[3].chosenTarget?.name === "Submit"
  );

  // 目标不存在失败
  const invalidTargetBatch = [{ action: "click", target: "ref=999" }];
  const normBadTarget = normalizeActionBatch(invalidTargetBatch, mockTargets);
  check("批次中目标不存在时规范化失败", normBadTarget.ok === false && normBadTarget.error.startsWith("target_not_found"));

  // 不支持的操作类型失败
  const invalidOpBatch = [{ action: "unsupported_action", target: "ref=1" }];
  const normBadOp = normalizeActionBatch(invalidOpBatch, mockTargets);
  check("不支持的操作类型规范化失败", normBadOp.ok === false && normBadOp.error.startsWith("unsupported_batch_action"));

  // 输入框缺少文本且无法从 options.text 映射时失败
  const missingTextBatch = [{ action: "type_text", target: "ref=1" }];
  const normNoText = normalizeActionBatch(missingTextBatch, mockTargets);
  check("输入框缺少文本规范化失败", normNoText.ok === false && normNoText.error.startsWith("missing_text_in_batch"));

  // options.text 候选映射支持
  const indexedTextBatch = [{ action: "type_text", target: "ref=1", textIndex: 0 }];
  const normMappedText = normalizeActionBatch(indexedTextBatch, mockTargets, { text: ["mapped_value"] });
  check("输入框从 options.text 映射文本成功", normMappedText.ok === true && normMappedText.subActions[0].text === "mapped_value");
}

// ── [2] 单元测试：ActionCache 支持批处理动作缓存 ──
console.log("\n[2] 单元测试：ActionCache 批处理有效性与持久化");
{
  const tempDir = mkdtempSync(join(tmpdir(), "ego-batch-cache-test-"));
  const cachePath = join(tempDir, "action-cache.json");
  try {
    const cache = new ActionCache({ maxEntries: 10, ttlMs: 10000, filePath: cachePath });
    const batchRecord = {
      action: "batch",
      subActions: [
        { action: "type_text", text: "alice", targetSignature: { role: "textbox", name: "Username" } },
        { action: "click", targetSignature: { role: "button", name: "Submit" } },
      ],
    };
    cache.set("fill and submit", "fp_batch_1", batchRecord);
    const item = cache.get("fill and submit", "fp_batch_1");
    check("批处理缓存存取成功", item && item.action === "batch" && item.subActions.length === 2);
    check("批处理缓存子动作签名保留", item.subActions[0].text === "alice" && item.subActions[1].targetSignature.name === "Submit");

    // 持久化与重载
    cache.save();
    const loaded = new ActionCache({ filePath: cachePath });
    const reloadedItem = loaded.get("fill and submit", "fp_batch_1");
    check("持久化批处理缓存重新加载成功", reloadedItem && reloadedItem.action === "batch" && reloadedItem.subActions.length === 2);

    // 非法批处理（如空子动作、包含无效 action）无法存入
    const invalidBatchRecord = { action: "batch", subActions: [] };
    cache.set("bad batch", "fp_bad", invalidBatchRecord);
    check("空 subActions 的批处理拒绝存入", cache.get("bad batch", "fp_bad") === null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── 准备浏览器 DOM 闭环环境 ──
const space = await taskSpace(`ego-batch-bench-${Date.now()}`);
const page = space.page("p1");

const BATCH_FORM_HTML = `
  <div id="container" style="padding:20px">
    <h2>User Registration Form</h2>
    <div>
      <label for="username">Username:</label>
      <input id="username" style="width:200px;height:30px;display:block;margin-bottom:10px;" value="" />
    </div>
    <div>
      <label for="email">Email:</label>
      <input id="email" style="width:200px;height:30px;display:block;margin-bottom:10px;" value="" />
    </div>
    <div>
      <button id="btn-submit" style="width:120px;height:35px;margin-right:10px;">Submit Form</button>
      <button id="btn-danger" style="width:140px;height:35px;color:red;">Delete Account</button>
    </div>
    <div id="result" style="margin-top:15px;font-weight:bold;">Waiting</div>
  </div>
`;

const setupForm = async () => {
  await page.evaluate((html) => {
    document.body.innerHTML = html;
    window.__submitted = null;
    window.__dangerClicked = false;
    document.getElementById("btn-submit").onclick = () => {
      const u = document.getElementById("username").value;
      const e = document.getElementById("email").value;
      document.getElementById("result").textContent = "Submitted: " + u + " / " + e;
      window.__submitted = { user: u, email: e, time: Date.now() };
    };
    document.getElementById("btn-danger").onclick = () => {
      window.__dangerClicked = true;
      document.getElementById("result").textContent = "Account Deleted";
    };
  }, BATCH_FORM_HTML);
};

try {
  await page.goto("about:blank", { timeout: 15000 });
  await setupForm();

  // ── [3] 多字段表单批量填充 + 点击提交在单步内完成 ──
  console.log("\n[3] 表单批处理：多字段批量填充 + 提交在单步内完成");
  {
    // 注入模型决策器，直接返回批次动作（用户名填 alice，邮箱填 alice@example.com，点击提交按钮）
    const batchAsk = async (state, questions) => {
      const typeTargetQ = questions.type_text_target?.criteria || {};
      const clickTargetQ = questions.click_target?.criteria || {};

      let uRef = null, eRef = null, sRef = null;
      for (const [k, v] of Object.entries(typeTargetQ)) {
        if (v.includes("Username")) uRef = k;
        if (v.includes("Email")) eRef = k;
      }
      for (const [k, v] of Object.entries(clickTargetQ)) {
        if (v.includes("Submit Form")) sRef = k;
      }

      return {
        action: "batch",
        subActions: [
          { action: "type_text", target: uRef, text: "alice" },
          { action: "type_text", target: eRef, text: "alice@example.com" },
          { action: "click", target: sRef },
        ],
      };
    };

    const stepResult = await runJevStep(page, "填写表单并提交", {
      ask: batchAsk,
      text: ["alice", "alice@example.com"],
      cache: false,
    });

    check("单步返回 action === 'batch'", stepResult.action === "batch");
    check("批次总大小为 3", stepResult.batchSize === 3);
    check("全部 3 个子动作成功派发", stepResult.batchExecutedCount === 3);
    check("已执行子动作记录完整", stepResult.executedSubActions?.length === 3);

    // 验证真实 DOM 状态更新
    const domState = await page.evaluate(() => ({
      username: document.getElementById("username").value,
      email: document.getElementById("email").value,
      resultText: document.getElementById("result").textContent,
      submitted: window.__submitted,
    }));

    check("真实 DOM 用户名已正确填入 'alice'", domState.username === "alice");
    check("真实 DOM 邮箱已正确填入 'alice@example.com'", domState.email === "alice@example.com");
    check("真实表单已触发提交事件并在单步内落地",
      domState.submitted !== null && domState.resultText === "Submitted: alice / alice@example.com"
    );
  }

  // ── [4] 性能断言：整批动作只触发 1 次 settle 等待 ──
  console.log("\n[4] 性能收益：整批动作只触发 1 次 settle 等待");
  {
    await setupForm();

    let settleCalls = 0;
    const originalEvaluate = page.evaluate.bind(page);
    page.evaluate = async (fn, ...args) => {
      if (fn && typeof fn === "function" && fn.name === "stateInPage") {
        settleCalls++;
      }
      return originalEvaluate(fn, ...args);
    };

    const batchAsk = async (state, questions) => {
      const typeQ = questions.type_text_target?.criteria || {};
      const clickQ = questions.click_target?.criteria || {};
      let uRef = null, eRef = null, sRef = null;
      for (const [k, v] of Object.entries(typeQ)) {
        if (v.includes("Username")) uRef = k;
        if (v.includes("Email")) eRef = k;
      }
      for (const [k, v] of Object.entries(clickQ)) {
        if (v.includes("Submit Form")) sRef = k;
      }
      return {
        action: "batch",
        subActions: [
          { action: "type_text", target: uRef, text: "charlie" },
          { action: "type_text", target: eRef, text: "charlie@test.org" },
          { action: "click", target: sRef },
        ],
      };
    };

    const beforeSettle = settleCalls;
    const r = await runJevStep(page, "填写表单并提交", {
      ask: batchAsk,
      text: ["charlie", "charlie@test.org"],
      cache: false,
    });
    const settleCallsInStep = settleCalls - beforeSettle;

    page.evaluate = originalEvaluate;

    check("整批包含 3 个子动作派发成功", r.batchExecutedCount === 3);
    check("settle 结果正常返回", r.settle !== null && typeof r.settle === "object");
    check("性能提升：整批 3 个子动作只在末尾触发 1 轮 settle 等待",
      settleCallsInStep >= 1 && settleCallsInStep <= 8,
      `单步内 stateInPage 仅执行 1 轮静默轮询=${settleCallsInStep}次`
    );
  }

  // ── [5] 执行层原子护栏：危险动作扫描全量拦截（0 次派发）──
  console.log("\n[5] 原子护栏：批次中包含危险动作全量拦截 (0 派发)");
  {
    await setupForm();
    await page.evaluate(() => {
      document.getElementById("username").value = "clean_state";
      document.getElementById("email").value = "clean@state.org";
      document.getElementById("result").textContent = "Clean";
    });

    const dangerBatchAsk = async (state, questions) => {
      const typeQ = questions.type_text_target?.criteria || {};
      const clickQ = questions.click_target?.criteria || {};
      let uRef = null, dangerRef = null;
      for (const [k, v] of Object.entries(typeQ)) {
        if (v.includes("Username")) uRef = k;
      }
      for (const [k, v] of Object.entries(clickQ)) {
        if (v.includes("Delete Account")) dangerRef = k;
      }
      return {
        action: "batch",
        subActions: [
          { action: "type_text", target: uRef, text: "should_not_fill" },
          { action: "click", target: dangerRef },
        ],
      };
    };

    const rDanger = await runJevStep(page, "尝试危险批量操作", {
      ask: dangerBatchAsk,
      text: ["should_not_fill"],
      cache: false,
    });

    check("危险动作前置拦截：guardRejected === 'dangerous_action'", rDanger.guardRejected === "dangerous_action");
    check("命中具体危险词", rDanger.dangerousMatch === "delete account" || rDanger.dangerousMatch === "delete");
    check("整批未派发任何动作 (batchExecutedCount === 0 且 executedSubActions 为空)",
      (rDanger.batchExecutedCount || 0) === 0 && (rDanger.executedSubActions || []).length === 0
    );

    const postDangerDom = await page.evaluate(() => ({
      username: document.getElementById("username").value,
      email: document.getElementById("email").value,
      dangerClicked: window.__dangerClicked,
    }));

    check("原子性：前置的安全动作未被派发 (用户名仍为 clean_state)", postDangerDom.username === "clean_state");
    check("原子性：邮箱未被修改 (邮箱仍为 clean@state.org)", postDangerDom.email === "clean@state.org");
    check("危险按钮未被点击 (dangerClicked === false)", postDangerDom.dangerClicked === false);
  }

  // ── [6] 执行中断与状态记录：中途目标失效安全停止 ──
  console.log("\n[6] 安全执行与状态记录：中途目标失效安全中断，记录已执行子动作");
  {
    await setupForm();

    const hidingAsk = async (state, questions) => {
      const typeQ = questions.type_text_target?.criteria || {};
      const clickQ = questions.click_target?.criteria || {};
      let uRef = null, eRef = null, sRef = null;
      for (const [k, v] of Object.entries(typeQ)) {
        if (v.includes("Username")) uRef = k;
        if (v.includes("Email")) eRef = k;
      }
      for (const [k, v] of Object.entries(clickQ)) {
        if (v.includes("Submit Form")) sRef = k;
      }

      await page.evaluate(() => {
        document.getElementById("email").style.display = "none";
      });

      return {
        action: "batch",
        subActions: [
          { action: "type_text", target: uRef, text: "david" },
          { action: "type_text", target: eRef, text: "david@fail.com" },
          { action: "click", target: sRef },
        ],
      };
    };

    const rHalt = await runJevStep(page, "部分执行表单", {
      ask: hidingAsk,
      text: ["david", "david@fail.com"],
      cache: false,
    });

    check("批次在第 2 个动作处守卫拦截中断", rHalt.guardRejected !== null);
    check("精确记录失败的子动作索引 (failedSubActionIndex === 1)", rHalt.failedSubActionIndex === 1);
    check("精确记录已执行的子动作 (executedSubActions 长度为 1)", rHalt.executedSubActions?.length === 1);
    check("已执行子动作为用户名填充", rHalt.executedSubActions?.[0]?.text === "david");

    const domHaltState = await page.evaluate(() => ({
      username: document.getElementById("username").value,
      email: document.getElementById("email").value,
      submitted: window.__submitted,
    }));
    check("已执行的子动作副作用已生效 (username === 'david')", domHaltState.username === "david");
    check("中断动作文本未被输入 (email === '')", domHaltState.email === "");
    check("未执行的后续子动作未生效 (submitted === null)", domHaltState.submitted === null);
  }

  // ── [7] 动作指纹缓存与批处理协同：冷写与热直发 (0ms decideMs) ──
  console.log("\n[7] ActionCache 协同：批处理动作冷写入与热直发 (0ms 决策)");
  {
    await setupForm();

    const batchCache = new ActionCache({ maxEntries: 50 });
    let modelCalls = 0;

    const askCountingBatch = async (state, questions) => {
      modelCalls++;
      const typeQ = questions.type_text_target?.criteria || {};
      const clickQ = questions.click_target?.criteria || {};
      let uRef = null, eRef = null, sRef = null;
      for (const [k, v] of Object.entries(typeQ)) {
        if (v.includes("Username")) uRef = k;
        if (v.includes("Email")) eRef = k;
      }
      for (const [k, v] of Object.entries(clickQ)) {
        if (v.includes("Submit Form")) sRef = k;
      }
      return {
        action: "batch",
        subActions: [
          { action: "type_text", target: uRef, text: "eve" },
          { action: "type_text", target: eRef, text: "eve@test.org" },
          { action: "click", target: sRef },
        ],
      };
    };

    // 7.1 冷启动：实时决策并写入缓存
    const rCold = await runJevStep(page, "自动化登录表单", {
      ask: askCountingBatch,
      text: ["eve", "eve@test.org"],
      actionCache: batchCache,
    });
    check("冷启动执行成功", rCold.action === "batch" && rCold.batchExecutedCount === 3);
    check("冷启动调用了模型 (modelCalls === 1)", modelCalls === 1);
    check("冷启动未命中缓存 (cacheHit === false)", rCold.cacheHit === false);
    check("冷启动成功存入 ActionCache", batchCache.stats().size === 1);

    // 重置表单值，以验证热启动直发
    await setupForm();

    // 7.2 热启动：相同 DOM 与相同候选文本，命中缓存，0ms 决策跳过模型直发！
    const rHot = await runJevStep(page, "自动化登录表单", {
      ask: askCountingBatch,
      text: ["eve", "eve@test.org"],
      actionCache: batchCache,
    });

    check("热启动命中动作缓存 (cacheHit === true)", rHot.cacheHit === true);
    check("热启动跳过模型决策 (modelCalls 仍为 1)", modelCalls === 1);
    check("热启动决策耗时为 0ms (phases.decideMs === 0)", rHot.phases.decideMs === 0);
    check("热启动批处理全部派发成功", rHot.batchExecutedCount === 3);

    // 验证热启动直发后的真实 DOM 状态
    const hotDomState = await page.evaluate(() => ({
      username: document.getElementById("username").value,
      email: document.getElementById("email").value,
      resultText: document.getElementById("result").textContent,
    }));
    check("热启动直发真实 DOM 填充并提交成功",
      hotDomState.username === "eve" &&
      hotDomState.email === "eve@test.org" &&
      hotDomState.resultText === "Submitted: eve / eve@test.org"
    );
  }

  // ── [8] 全自主循环 runJevAutonomousLoop 与 summary 批处理指标 ──
  console.log("\n[8] Autonomous Loop 批处理调度与 Summary 渲染");
  {
    await setupForm();

    const loopBatchAsk = async (state, questions) => {
      const typeQ = questions.type_text_target?.criteria || {};
      const clickQ = questions.click_target?.criteria || {};
      let uRef = null, eRef = null, sRef = null;
      for (const [k, v] of Object.entries(typeQ)) {
        if (v.includes("Username")) uRef = k;
        if (v.includes("Email")) eRef = k;
      }
      for (const [k, v] of Object.entries(clickQ)) {
        if (v.includes("Submit Form")) sRef = k;
      }
      return {
        action: "batch",
        subActions: [
          { action: "type_text", target: uRef, text: "frank" },
          { action: "type_text", target: eRef, text: "frank@corp.com" },
          { action: "click", target: sRef },
        ],
      };
    };

    const loopResult = await runJevAutonomousLoop(page, "完成登录表单", {
      ask: loopBatchAsk,
      text: ["frank", "frank@corp.com"],
      maxSteps: 3,
      cache: false,
      check: async () => {
        return (await page.evaluate(() => window.__submitted !== null));
      },
    });

    check("循环在第 1 步动作后 check() 确认成功达成", loopResult.success === true);
    check("循环记录 batchCount === 1", loopResult.batchCount === 1);
    check("循环记录 batchActionsCount === 3", loopResult.batchActionsCount === 3);

    const summary = renderJevSummary(loopResult);
    check("renderJevSummary 展示动作批处理统计行",
      summary.includes("动作批处理: 执行 1 个批次 (共 3 个子动作)")
    );
  }

  // ── [9] 显式禁用 options.batch: false 验证 ──
  console.log("\n[9] 显式禁用验证：options.batch: false 拦截批处理");
  {
    const disabledAsk = async () => ({
      action: "batch",
      subActions: [{ action: "click", target: "ref=1" }],
    });

    const rDisabled = await runJevStep(page, "禁用批处理", {
      ask: disabledAsk,
      batch: false,
      cache: false,
    });

    check("options.batch: false 时拒绝批处理",
      rDisabled.invalidResponse === "batch_disabled" || rDisabled.action !== "batch"
    );
  }

  // ── [10] 网络哨兵验证 ──
  console.log("\n[10] 网络哨兵验证");
  check("离线测试全程 0 次外部网络请求 (fetchCalls === 0)", fetchCalls === 0, `fetchCalls=${fetchCalls}`);

} finally {
  await space.finish({ keep: [] });
}

console.log(`\n========================================`);
console.log(`Phase 4 Multi-Action Batching 测试结果: ${pass} 通过 / ${fail} 失败`);
console.log(`========================================`);
process.exitCode = fail === 0 ? 0 : 1;
