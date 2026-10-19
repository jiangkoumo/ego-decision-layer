// 阶段三验收：动作指纹缓存与自愈回放 (Action Cache & Fast Replay)。
//
// 为什么需要：借鉴 Stagehand v4 的 Action Cache 理念，结合 System One 超低延迟架构：
// 相同意图与 DOM 指纹下 0ms 免模型请求直发动作；遇到结构漂移、元素不可用、守卫拒绝或
// 动作无进展时立即作废缓存并无缝自愈回退到实时 Jev 决策。
//
// 本文件在 about:blank 上自造 DOM（离线、不联网、不需要任何 API Key），
// 通过 options.ask 注入确定性决策器，其余走全真 DOM 观测、指纹计算、CDP 派发与守卫流程：
//   [1] 指纹确定性与 DOM 变动敏感度
//   [2] 目标语义签名提取与跨轮匹配
//   [3] ActionCache 缓存管理原语（LRU、TTL、作废与文件容错）
//   [4] 0ms 缓存命中：跳过模型请求（decideMs = 0，decider 调用数为 0）
//   [5] 自愈回退：目标漂移、元素不可见/陈旧时自动作废缓存并回退实时决策
//   [6] 危险动作守卫：缓存动作同样受 assessDanger 拦截并自动作废
//   [7] 网络哨兵：整个测试运行期间 0 次网络 fetch
//
// 用法: sed "s|__REPO__|$PWD|g" bench/test-action-cache.mjs | ego-browser nodejs

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
  computeDomFingerprint,
  extractTargetSignature,
  matchTargetBySignature,
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

// ── [1] DOM 结构指纹计算确定性与敏感度测试 ──
console.log("\n[1] 单元测试：DOM 结构指纹 computeDomFingerprint");
{
  const targetsA = [
    { ref: "ref=1", role: "button", kind: "clickable", name: "Submit", url: null },
    { ref: "ref=2", role: "textbox", kind: "editable", name: "Search", url: null },
  ];
  const fp1 = computeDomFingerprint(targetsA, { url: "https://example.com/page", title: "Test Page" });
  const fp2 = computeDomFingerprint(targetsA, { url: "https://example.com/page", title: "Test Page" });
  check("确定性：相同 DOM 结构产生完全一致的指纹", fp1 === fp2 && typeof fp1 === "string" && fp1.length === 16);

  // 变更按钮名称
  const targetsB = [
    { ref: "ref=1", role: "button", kind: "clickable", name: "Cancel", url: null },
    { ref: "ref=2", role: "textbox", kind: "editable", name: "Search", url: null },
  ];
  const fpB = computeDomFingerprint(targetsB, { url: "https://example.com/page", title: "Test Page" });
  check("敏感度：修改元素名称引起指纹变化", fpB !== fp1);

  // 增减元素
  const targetsC = targetsA.slice(0, 1);
  const fpC = computeDomFingerprint(targetsC, { url: "https://example.com/page", title: "Test Page" });
  check("敏感度：增减元素引起指纹变化", fpC !== fp1);

  // 改变 URL 路径
  const fpD = computeDomFingerprint(targetsA, { url: "https://example.com/other", title: "Test Page" });
  check("敏感度：页面 URL 路径改变引起指纹变化", fpD !== fp1);
  check('origin 隔离',computeDomFingerprint(targetsA,{url:'https://a.example/page'}) !== computeDomFingerprint(targetsA,{url:'https://b.example/page'}));
  check('长查询参数不截断',computeDomFingerprint(targetsA,{url:'https://a.example/?'+ 'x'.repeat(80)+'a'}) !== computeDomFingerprint(targetsA,{url:'https://a.example/?'+ 'x'.repeat(80)+'b'}));
}

// ── [2] 目标语义签名提取与匹配测试 ──
console.log("\n[2] 单元测试：目标语义签名 extractTargetSignature & matchTargetBySignature");
{
  const target = { ref: "ref=5", role: "button", kind: "clickable", name: "Confirm Order", url: null };
  const sig = extractTargetSignature(target);
  check("签名提取包含核心属性", sig.role === "button" && sig.kind === "clickable" && sig.name === "Confirm Order");

  // 匹配：即使 ref 变了（由于页面动态编号变化），依靠语义特征精准匹配
  const newTargets = [
    { ref: "ref=10", role: "link", kind: "clickable", name: "Back", url: "/back" },
    { ref: "ref=11", role: "button", kind: "clickable", name: "Confirm Order", url: null },
  ];
  const matched = matchTargetBySignature(newTargets, sig);
  check("语义特征精准匹配当前重新编号的元素", matched && matched.ref === "ref=11");

  // 元素缺失
  const missing = matchTargetBySignature([{ ref: "ref=1", role: "button", name: "Other" }], sig);
  check("元素丢失时返回 null", missing === null);
  check('重复语义目标拒绝匹配',matchTargetBySignature([target,{...target,ref:'ref=6'}],sig) === null);
  check('kind 不兼容拒绝匹配',matchTargetBySignature([{...target,kind:'editable'}],sig) === null);
  check('URL 不兼容拒绝匹配',matchTargetBySignature([{...target,url:'https://evil.example'}],sig) === null);
}

// ── [3] ActionCache 缓存管理原语测试 ──
console.log("\n[3] 单元测试：ActionCache 原语（存储、TTL、LRU、作废与持久化）");
{
  const tempDir = mkdtempSync(join(tmpdir(), "ego-cache-test-"));
  const cachePath = join(tempDir, "action-cache.json");
  try {
    const cache = new ActionCache({ maxEntries: 2, ttlMs: 1000, filePath: cachePath });
    cache.set("click submit", "fp12345678901234", { action: "click", targetSignature: { name: "Submit" } });
    const item = cache.get("click submit", "fp12345678901234");
    check("缓存写入与命中读取", item && item.action === "click" && item.targetSignature.name === "Submit");
    check("缓存统计计数递增", cache.stats().hits === 1 && cache.stats().misses === 0);

    // 未命中
    check("未命中返回 null", cache.get("other goal", "fp12345678901234") === null);

    // 作废条目
    const invalidated = cache.invalidate("click submit", "fp12345678901234");
    check("条目作废成功", invalidated === true && cache.get("click submit", "fp12345678901234") === null);
    check("自愈作废计数递增", cache.stats().heals === 1);

    // LRU 淘汰测试（容量为 2）
    cache.set("g1", "fp1", { action: "click" });
    cache.set("g2", "fp2", { action: "click" });
    cache.set("g3", "fp3", { action: "click" }); // 此时应淘汰最旧的 g1::fp1
    check("LRU 超过容量淘汰最旧条目", cache.get("g1", "fp1") === null && cache.get("g3", "fp3") !== null);

    // 持久化同步保存与重载
    cache.save();
    const loadedCache = new ActionCache({ filePath: cachePath });
    check("持久化文件重新加载成功", loadedCache.get("g3", "fp3") !== null);

    // Read must refresh recency, and TTL expires exactly at its deadline.
    let now = 100;
    const lru = new ActionCache({ maxEntries:2,ttlMs:10,now:()=>now });
    lru.set('a','fp',{action:'click'});lru.set('b','fp',{action:'click'});
    lru.get('a','fp');lru.set('c','fp',{action:'click'});
    check('LRU 命中 a 后淘汰 b',!!lru.get('a','fp') && lru.get('b','fp') === null);
    now=109;check('TTL 到期前可读',!!lru.get('a','fp'));
    now=110;check('TTL 边界过期',lru.get('a','fp') === null);
    const many = new ActionCache({maxEntries:10});
    for(let i=0;i<6;i++)many.set('g'+i,'fp',{action:'click'});
    writeFileSync(cachePath,JSON.stringify({version:2,entries:[...many.entries.values(),{key:'bad',action:'click'}]}));
    const bounded = new ActionCache({maxEntries:2,filePath:cachePath});
    check('加载容量有界并丢弃非法条目',bounded.stats().size === 2 && !!bounded.get('g5','fp'));
    writeFileSync(cachePath,' '.repeat(2000001));
    check('超大持久文件不加载',new ActionCache({filePath:cachePath}).stats().size === 0);

    // 损坏文件容错
    writeFileSync(cachePath, "{ corrupt json");
    const corruptCache = new ActionCache({ filePath: cachePath });
    check("损坏文件加载容错不崩溃", corruptCache.stats().size === 0);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ── 准备浏览器 DOM 闭环环境 ──
const space = await taskSpace(`ego-cache-bench-${Date.now()}`);
const page = space.page("p1");

const FIXTURE_HTML = `
  <div id="container">
    <button id="btn-count" style="width:120px;height:40px" onclick="window.__clicks = (window.__clicks || 0) + 1; document.getElementById('status').textContent = window.__clicks;">Increment</button>
    <output id="status">0</output>
    <button id="btn-pay" style="width:120px;height:40px">立即支付</button>
    <input id="inp-text" aria-label="Query" style="width:200px;height:32px" value="">
    <div id="hidden-box" style="display:none">
      <button id="btn-covered">Covered Action</button>
    </div>
  </div>
`;

try {
  await page.goto("about:blank", { timeout: 15000 });
  await page.evaluate((html) => {
    document.body.innerHTML = html;
    window.__clicks = 0;
  }, FIXTURE_HTML);

  const localCache = new ActionCache({ maxEntries: 100 });

  let deciderCalls = 0;
  const mockAsk = (actionChoice, targetName) => async (state, questions) => {
    deciderCalls++;
    const answers = {};
    for (const [head, q] of Object.entries(questions)) {
      const keys = Object.keys(q.criteria);
      let choice;
      if (head === "operation") {
        choice = keys.includes(actionChoice) ? actionChoice : keys[0];
      } else if (head.endsWith('_target')) {
        choice = keys.find((k) => k !== "none" && q.criteria[k].includes(targetName)) || keys[0];
      } else {
        choice = keys.find(k=>k !== 'none') || keys[0];
      }
      const rest = keys.filter((k) => k !== choice);
      const probabilities = { [choice]: 0.9 };
      for (const k of rest) probabilities[k] = 0.1 / Math.max(1, rest.length);
      answers[head] = { choice, confidence: 0.9, probabilities };
    }
    return answers;
  };

  // ── [4] 冷启动写入与热启动 0ms 缓存命中测试 ──
  console.log("\n[4] 缓存生命周期：冷启动写入 → 热启动 0ms 命中跳过模型");
  {
    // 4.1 冷启动：未命中缓存，调用 decider 决策并执行
    const rCold = await runJevStep(page, "点击递增按钮", {
      ask: mockAsk("click", "Increment"),
      actionCache: localCache,
    });
    const clicksAfterCold = await page.evaluate(() => window.__clicks);
    check("冷启动执行成功", rCold.action === "click" && clicksAfterCold === 1);
    check("冷启动未命中缓存 (cacheHit = false)", rCold.cacheHit === false);
    check("冷启动调用了模型 (deciderCalls = 1)", deciderCalls === 1);
    check("冷启动将动作存入了缓存", localCache.stats().size >= 1);

    // 4.2 热启动：相同 DOM 与相同目标，命中指纹缓存，0ms 直发动作！
    const rHot = await runJevStep(page, "点击递增按钮", {
      ask: mockAsk("click", "Increment"),
      actionCache: localCache,
    });
    const clicksAfterHot = await page.evaluate(() => window.__clicks);
    check("热启动执行成功", rHot.action === "click" && clicksAfterHot === 2);
    check("热启动命中缓存 (cacheHit = true)", rHot.cacheHit === true);
    check("热启动跳过模型 (deciderCalls 保持为 1 未增加)", deciderCalls === 1);
    check("热启动决策耗时为 0ms (phases.decideMs = 0)", rHot.phases.decideMs === 0);
  }

  // ── [5] 自愈回退：目标漂移或不可见时自动作废缓存并无缝回退实时 Jev ──
  console.log("\n[5] 自愈机制：DOM 漂移 / 元素不可用时作废缓存并退回模型决策");
  {
    // 获取当前真实页面的指纹
    const probe = await runJevStep(page, "探查指纹", { ask: mockAsk("wait", ""), cache: false });
    const currentFp = probe.fingerprint;

    // 设定目标为已被移除的 DeleteItem
    localCache.set("删除项目", currentFp, {
      action: "click",
      targetSignature: { role: "button", kind: "clickable", name: "NonExistentButton" },
    });

    const callsBeforeHeal = deciderCalls;
    const rHeal = await runJevStep(page, "删除项目", {
      ask: mockAsk("click", "Increment"), // 模型兜底动作
      actionCache: localCache,
    });
    check("自愈触发：标记 cacheHealed = true", rHeal.cacheHealed === true);
    const updated = localCache.get("删除项目", currentFp);
    check("自愈回退：陈旧动作已被有效自愈动作更新", updated && updated.targetSignature.name === "Increment");
    check("自愈无缝退回模型决策执行", deciderCalls > callsBeforeHeal);
  }

  // ── [6] 危险动作拦截：缓存动作同样受 assessDanger 守卫拦截并作废 ──
  console.log("\n[6] 安全守卫：缓存动作命中危险拦截时立即拒绝并作废");
  {
    const probe = await runJevStep(page, "探查指纹", { ask: mockAsk("wait", ""), cache: false });
    const fpPay = probe.fingerprint;

    // 假设恶意或过期的缓存诱导点击支付按钮
    localCache.set("确认提交", fpPay, {
      action: "click",
      targetSignature: { role: "button", kind: "clickable", name: "立即支付" },
    });

    const rDanger = await runJevStep(page, "确认提交", {
      ask: mockAsk("click", "立即支付"),
      actionCache: localCache,
    });
    check("执行前守卫拒绝 dangerous_action", rDanger.guardRejected === "dangerous_action");
    check("命中危险词表 '支付'", rDanger.dangerousMatch === "支付" && rDanger.dangerousKind === "payment");
    check("危险缓存被立即作废", localCache.get("确认提交", fpPay) === null);
  }

  // ── [7] runJevAutonomousLoop 闭环与 renderJevSummary 展示 ──
  console.log("\n[7] Autonomous Loop 闭环统计与摘要渲染");
  {
    // 清空缓存进行一次完整循环
    localCache.clear();
    const rLoop1 = await runJevAutonomousLoop(page, "点击递增按钮", {
      ask: mockAsk("click", "Increment"),
      actionCache: localCache,
      maxSteps: 1,
      check: async () => false,
    });
    check("第 1 轮冷启动完成 (cacheHits = 0)", rLoop1.cacheHits === 0);

    // 第 2 轮热启动
    const rLoop2 = await runJevAutonomousLoop(page, "点击递增按钮", {
      ask: mockAsk("click", "Increment"),
      actionCache: localCache,
      maxSteps: 1,
      check: async () => false,
    });
    check("第 2 轮热启动命中缓存 (cacheHits >= 1)", rLoop2.cacheHits >= 1);

    const summary = renderJevSummary(rLoop2);
    check("renderJevSummary 展示动作缓存命中信息", summary.includes("动作缓存") && summary.includes("命中 1 次"));
  }

  // Current input, explicit disable and side-effect-safe recovery regressions.
  {
    const inputs = new ActionCache();
    const fill = text => runJevStep(page,'fill',{text:[text],textModel:null,ask:mockAsk('type_text','Query'),actionCache:inputs});
    await fill('alpha');
    await fill('beta');
    check('当前候选 beta 覆盖旧 alpha',await page.evaluate(()=>document.querySelector('input').value) === 'beta');
    let before=deciderCalls;
    const off=await runJevStep(page,'fill',{cache:false,text:['gamma'],textModel:null,ask:mockAsk('type_text','Query'),actionCache:inputs});
    check('cache:false 最高优先级',!off.cacheHit && deciderCalls === before+1 && await page.evaluate(()=>document.querySelector('input').value) === 'gamma');
    before=deciderCalls;
    await runJevAutonomousLoop(page,'fill',{cache:false,text:['delta'],textModel:null,ask:mockAsk('type_text','Query'),actionCache:inputs,maxSteps:1,onStep:()=>{}});
    check('loop 禁用缓存同样生效',deciderCalls === before+1 && await page.evaluate(()=>document.querySelector('input').value) === 'delta');
    const contexts = new ActionCache();
    const contextRun = extra=>runJevStep(page,'context',{ask:mockAsk('click','Increment'),actionCache:contexts,...extra});
    await contextRun({});
    for(const extra of [{progress:['finished step']},{deciderConfig:{model:'other-model'}},{cacheContext:{tenant:'other'}}]) {
      const before=deciderCalls;const result=await contextRun(extra);
      check('任务/后端上下文隔离 '+JSON.stringify(extra),!result.cacheHit && deciderCalls === before+1);
    }
    // Hide the target after observation but before cached execution. No dispatch yet:
    // one fresh observation/live decision is safe and must not click the hidden target.
    const hiddenCache=new ActionCache();
    let hidden=false;
    const hiddenPolicy=(state,questions)=>mockAsk(hidden ? 'wait' : 'click','Increment')(state,questions);
    await runJevStep(page,'hidden',{ask:hiddenPolicy,actionCache:hiddenCache});
    const hidingPage={evaluate:async(fn,arg)=>{
      const value=arg === undefined ? await page.evaluate(fn) : await page.evaluate(fn,arg);
      if(fn.name === 'observeDom' && !hidden){hidden=true;await page.evaluate(()=>document.querySelector('button').style.display='none');}
      return value;
    },url:page.url.bind(page),title:page.title.bind(page),cdp:page.cdp.bind(page)};
    const healed=await runJevStep(hidingPage,'hidden',{ask:hiddenPolicy,actionCache:hiddenCache});
    check('不可见回放目标重新观测后只回退一次',healed.cacheHealed && healed.cacheRecovery === 'reobserved_before_dispatch' && healed.action === 'wait');
    await page.evaluate(()=>document.querySelector('button').style.display='');
    const same = new ActionCache();
    await runJevStep(page,'noop',{ask:mockAsk('click','Increment'),actionCache:same});
    await page.evaluate(()=>{document.querySelector('button').onclick=()=>{window.__clicks++;};});
    const countBefore=await page.evaluate(()=>window.__clicks);
    const noop=await runJevAutonomousLoop(page,'noop',{ask:mockAsk('click','Increment'),actionCache:same,maxSteps:5,onStep:()=>{}});
    check('无 DOM 进展回放作废且 loop 停止',noop.reason === 'cache_replay_unverified' && same.stats().size === 0);
    check('已可能生效的动作只派发一次',await page.evaluate(()=>window.__clicks) === countBefore+1);
    // Restore an observable action, warm it, then fail after partial CDP dispatch.
    await page.evaluate(()=>{document.querySelector('button').onclick=()=>{document.getElementById('status').textContent=String(++window.__clicks);};});
    const partialCache=new ActionCache();
    await runJevStep(page,'partial',{ask:mockAsk('click','Increment'),actionCache:partialCache});
    let cdpCalls=0;
    const wrapped={evaluate:page.evaluate.bind(page),url:page.url.bind(page),title:page.title.bind(page),cdp:async(...args)=>{cdpCalls++;await page.cdp(...args);throw new Error('transport interrupted after dispatch');}};
    const partial=await runJevStep(wrapped,'partial',{ask:mockAsk('click','Increment'),actionCache:partialCache});
    check('部分派发错误停止且不重放',partial.cacheRecovery === 'action_outcome_unknown' && partialCache.stats().size === 0 && cdpCalls === 1);
  }

  // ── [8] 网络哨兵验证 ──
  console.log("\n[8] 网络哨兵验证");
  check("离线测试全程 0 次外部网络请求 (fetchCalls === 0)", fetchCalls === 0, `fetchCalls=${fetchCalls}`);

} finally {
  await space.finish({ keep: [] });
}

console.log(`\n========================================`);
console.log(`Phase 3 Action Cache 测试结果: ${pass} 通过 / ${fail} 失败`);
console.log(`========================================`);
process.exitCode = fail === 0 ? 0 : 1;
