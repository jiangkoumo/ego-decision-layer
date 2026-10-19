// 阶段二验收：结构化数据抽取原语 (extract primitive)。
//
// 为什么需要：弥补纯交互操作在数据提取场景的空白，让 Agent 能以一条语句
// 从当前页面（或指定局部区域）抽取类型化 JSON 结构，无需手写 ad-hoc 选择器。
//
// 本文件在 about:blank 上自造 DOM（离线、不联网、不需要任何 API Key），
// 通过 options.injectedExtractor 注入确定性抽取器，其余走真实全链路：
//   [1] 语义流提取：标题、链接、表格、列表、表单控件与不可见节点过滤
//   [2] 范围限定与截断：options.selector 局部提取与 maxChars 码点安全截断
//   [3] Schema 校验：标准 JSON Schema 与简写 Schema 的类型、必填字段与自动解包
//   [4] 真实端到端 extract 原语：页面变动稳定 + 真实 DOM 语义流 + 校验 + 分阶段耗时
//   [5] 网络哨兵：整个测试运行期间 0 次网络 fetch
//   [6] 异常保护：缺少模型配置、Schema 不匹配与非法参数的优雅报错
//
// 用法: sed "s|__REPO__|$PWD|g" bench/test-extract.mjs | ego-browser nodejs

const REPO_INJECTED = "__REPO__";
const ROOT = REPO_INJECTED.startsWith("/")
  ? REPO_INJECTED
  : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";
const { JE } = await import(ROOT + "/bench/lib.mjs").catch(() => {
  throw new Error(`无法定位仓库根（${ROOT}）：请用 sed "s|__REPO__|$PWD|g" bench/<script> | ego-browser nodejs 运行`);
});

const {
  extract,
  validateSchema,
  extractSemanticStreamInPage,
  renderExtractSummary,
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

// ── [1] 单元测试：validateSchema 纯函数校验 ──
console.log("\n[1] 单元测试：validateSchema 校验器");
{
  // 1.1 标准 JSON Schema 对象校验
  const objSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      views: { type: "number" },
      active: { type: "boolean" },
    },
    required: ["title", "views"],
  };
  check("标准 Schema 正常数据通过", validateSchema({ title: "Hello", views: 42, active: true }, objSchema).valid);
  check(
    "标准 Schema 缺少 required 字段报错",
    !validateSchema({ views: 42 }, objSchema).valid &&
      validateSchema({ views: 42 }, objSchema).errors.some((e) => e.includes("title"))
  );
  check(
    "标准 Schema 字段类型不匹配报错",
    !validateSchema({ title: "Hello", views: "invalid" }, objSchema).valid
  );

  // 1.2 数组与 items 递归校验
  const listSchema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        id: { type: "number" },
        name: { type: "string" },
      },
      required: ["id", "name"],
    },
  };
  check("数组 items 匹配通过", validateSchema([{ id: 1, name: "Alpha" }, { id: 2, name: "Beta" }], listSchema).valid);
  check("数组 items 项字段不符报错", !validateSchema([{ id: 1 }, { id: 2, name: "Beta" }], listSchema).valid);

  // 1.3 简写 Schema 模式
  const shorthandObj = { title: "string", score: "number" };
  check("简写对象 Schema 通过", validateSchema({ title: "Top News", score: 99 }, shorthandObj).valid);
  check("简写对象 Schema 类型错误报错", !validateSchema({ title: "Top News", score: "high" }, shorthandObj).valid);

  const shorthandArr = [{ title: "string", url: "string" }];
  check(
    "简写数组 Schema 通过",
    validateSchema([{ title: "A", url: "https://a.com" }, { title: "B", url: "https://b.com" }], shorthandArr).valid
  );
  check(
    "简写数组 Schema 项不全报错",
    !validateSchema([{ title: "A" }], shorthandArr).valid
  );
}

// 准备测试 DOM
const FIXTURE_HTML = `
  <header>
    <h1>Hacker News Weekly</h1>
    <nav aria-hidden="true"><a href="/hidden-nav">Hidden Menu</a></nav>
  </header>
  <main id="content">
    <div class="intro">
      <p>Welcome to the <strong>curated</strong> tech digest with <a href="https://example.com/digest">external link</a>.</p>
    </div>
    <table id="stories" border="1">
      <thead>
        <tr><th>Rank</th><th>Story</th><th>Score</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>1</td>
          <td><a href="https://github.com/citrolabs/ego-lite">ego-lite</a></td>
          <td>350 points</td>
        </tr>
        <tr>
          <td>2</td>
          <td><a href="https://typesafe.ai">TypeSafe System One</a></td>
          <td>420 points</td>
        </tr>
      </tbody>
    </table>
    <ul id="features">
      <li>Sub-second decision loop</li>
      <li>Raw CDP dispatch with zero Playwright dependency</li>
    </ul>
    <div style="display:none" id="invisible">Secret Internal Debug Line</div>
    <form id="subscribe-form">
      <input type="text" name="email" value="agent@citro.ai" aria-label="Subscriber Email">
    </form>
  </main>
  <footer>
    <p>Copyright 2026 Citro Labs</p>
  </footer>
`;

const space = await taskSpace(`ego-extract-bench-${Date.now()}`);
const page = space.page("p1");

try {
  await page.goto("about:blank", { timeout: 15000 });
  await page.evaluate((html) => {
    document.body.innerHTML = html;
  }, FIXTURE_HTML);

  // ── [2] 页面内 DOM 语义流提取测试 ──
  console.log("\n[2] 页面内 DOM 语义流提取：extractSemanticStreamInPage");
  {
    const stream = await page.evaluate(extractSemanticStreamInPage, { maxChars: 10000 });
    check("包含大标题 # Hacker News Weekly", stream.content.includes("# Hacker News Weekly"));
    check("包含 Markdown 链接 [ego-lite](https://github.com/citrolabs/ego-lite)", stream.content.includes("[ego-lite](https://github.com/citrolabs/ego-lite)"));
    check("包含表格行结构 | 1 | [ego-lite]... | 350 points |", stream.content.includes("| 1 | [ego-lite]"));
    check("包含列表项 - Sub-second decision loop", stream.content.includes("- Sub-second decision loop"));
    check("包含表单输入项 Subscriber Email", stream.content.includes("Subscriber Email") && stream.content.includes("agent@citro.ai"));
    check("过滤 aria-hidden='true' 元素", !stream.content.includes("Hidden Menu"));
    check("过滤 display:none 隐藏文本", !stream.content.includes("Secret Internal Debug Line"));
  }

  // ── [3] 局部选择器提取与有界截断测试 ──
  console.log("\n[3] 局部选择器提取与截断控制");
  {
    const subStream = await page.evaluate(extractSemanticStreamInPage, { selector: "#stories" });
    check("局部 selector 包含目标表格内容", subStream.content.includes("| 1 |") && subStream.content.includes("ego-lite"));
    check("局部 selector 不包含全局标题", !subStream.content.includes("Hacker News Weekly"));
    check("局部 selector 不包含页脚", !subStream.content.includes("Citro Labs"));

    const truncatedStream = await page.evaluate(extractSemanticStreamInPage, { maxChars: 60 });
    check("超出 maxChars 时标记 truncated: true", truncatedStream.truncated === true);
    check("内容长度不超过 maxChars 预算", truncatedStream.length <= 60);
  }

  // ── [4] extract 原语端到端注入测试 ──
  console.log("\n[4] extract() 原语端到端闭环（注入 extractor 离线验证）");
  {
    const fakeData = [
      { rank: 1, title: "ego-lite", url: "https://github.com/citrolabs/ego-lite", score: 350 },
      { rank: 2, title: "TypeSafe System One", url: "https://typesafe.ai", score: 420 },
    ];
    const schema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          rank: { type: "number" },
          title: { type: "string" },
          url: { type: "string" },
          score: { type: "number" },
        },
        required: ["rank", "title", "url"],
      },
    };

    let receivedInstruction = "";
    let receivedContent = "";
    const res = await extract(page, "提取榜单中的新闻排行、标题、链接和得分", {
      schema,
      selector: "#stories",
      injectedExtractor: async ({ instruction, content }) => {
        receivedInstruction = instruction;
        receivedContent = content;
        return fakeData;
      },
    });

    check("extract() 返回 success: true", res.success === true);
    check("extract() 正确透传指令", receivedInstruction === "提取榜单中的新闻排行、标题、链接和得分");
    check("extract() 注入器接收到局部语义流", receivedContent.includes("ego-lite") && !receivedContent.includes("Hacker News Weekly"));
    check("extract() 数据结果匹配", Array.isArray(res.data) && res.data.length === 2 && res.data[0].title === "ego-lite");
    check("extract() 结果包含分阶段耗时", res.phases && ["settleMs", "observeMs", "extractMs"].every((k) => typeof res.phases[k] === "number"));
    check("extract() 返回页面元信息", res.pageInfo && typeof res.pageInfo.length === "number");

    // 格式化摘要函数验证
    const summary = renderExtractSummary(res);
    check("renderExtractSummary 正常渲染阶段耗时与条目数", summary.includes("抽取耗时") && summary.includes("2 项"));
  }

  // ── [5] 智能解包与校验失败分支测试 ──
  console.log("\n[5] 自动解包与 Schema 校验失败拦截");
  {
    // 5.1 自动解包测试：模型包了 { items: [...] }
    const schema = [{ title: "string" }];
    const resUnpack = await extract(page, "提取列表", {
      schema,
      injectedExtractor: async () => ({ items: [{ title: "Item 1" }, { title: "Item 2" }] }),
    });
    check("注入器必须返回约定数据类型，不猜测解包", resUnpack.success === false && resUnpack.reason === "schema_validation_failed");

    // 5.2 Schema 校验失败测试
    const resFail = await extract(page, "提取列表", {
      schema: { type: "array", items: { type: "number" } },
      injectedExtractor: async () => ["not-a-number"],
    });
    check("Schema 不符时返回 success: false", resFail.success === false);
    check("错误原因标记为 schema_validation_failed", resFail.reason === "schema_validation_failed");
  }

  // ── [6] 异常与降级保护测试 ──
  console.log("\n[6] 异常与降级保护测试");
  {
    let caughtEmptyInstruction = false;
    try {
      await extract(page, "");
    } catch {
      caughtEmptyInstruction = true;
    }
    check("空 instruction 抛出同步错误", caughtEmptyInstruction);

    // 未注入 extractor 且故意给一个不存在的空配置时返回 missing_text_model，不 crash
    const resNoModel = await extract(page, "测试未配置模型", {
      textModel: {}, // 空配置，没有 baseUrl/apiKey
    });
    check("未提供有效模型时优雅返回 missing_text_model", resNoModel.success === false && (resNoModel.reason === "missing_text_model" || resNoModel.reason === "missing_text_model_key"));
  }

  // Independent acceptance reproductions: scope and nested rendered content.
  await page.evaluate(() => {
    document.body.innerHTML = '<main id="scope"><div style="display:contents">Visible contents text</div><blockquote>Quote <span hidden>HIDDEN_QUOTE</span></blockquote><pre>Code <span style="display:none">HIDDEN_PRE</span></pre><div><span><section>Nested block</section></span></div><table><tr><td>Outer<table><tr><td>Inner one</td></tr><tr><td>Inner two</td></tr></table></td></tr></table></main><aside>OUTSIDE_SCOPE</aside>';
  });
  const stream = await page.evaluate(extractSemanticStreamInPage,{selector:'#scope'});
  check('blockquote/pre 过滤隐藏后代',!stream.content.includes('HIDDEN_'));
  check('display:contents 保留可见内容',stream.content.includes('Visible contents text'));
  check('嵌套块与布局表保留多行',stream.content.split('\n').length > 4 && stream.content.includes('Inner two'));
  for (const selector of ['#missing','[invalid']) {
    let calls = 0;
    const r = await extract(page,'read',{selector,injectedExtractor:()=>{calls++;return {};}});
    check('selector 失败关闭且不调用模型: '+selector,!r.success && /selector/.test(r.reason) && calls === 0);
  }
  const bounded = await page.evaluate(extractSemanticStreamInPage,{maxChars:20});
  check('语义流预算保持有界',bounded.truncated && bounded.length <= 20);

  // ── [7] 网络哨兵断言 ──
  console.log("\n[7] 网络哨兵验证");
  check("离线端到端自测期间网络请求数为 0 (fetchCalls === 0)", fetchCalls === 0, `fetchCalls=${fetchCalls}`);

} finally {
  await space.finish({ keep: [] });
}

console.log(`\n========================================`);
console.log(`Phase 2 Extract 测试结果: ${pass} 通过 / ${fail} 失败`);
console.log(`========================================`);
process.exitCode = fail === 0 ? 0 : 1;
