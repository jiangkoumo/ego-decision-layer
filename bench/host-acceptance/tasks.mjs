// 双宿主验收任务集（ROADMAP P1/P2 的首批 12 个可复跑任务）。
//
// 边界（务必连同 docs/HOST-ACCEPTANCE.md 一起读）：
//   * 这里全部是**合成受控 DOM**（about:blank + 注入 fixture），不是线上站点；
//   * 判定器是**注入的确定性实现**（options.ask），不是真实 Jev——
//     因此这里的结果是「引擎 + 宿主」的机制回归，**不能**当成模型成功率；
//   * fixture 注入只准备环境，不代替被测动作；每项任务的结论都由动作执行后的**真实 DOM/URL** 断言给出。
//
// 任务形状（suite.mjs 消费）：
//   id/title/source/goal/fixture   基本描述与初始 DOM
//   setup(page)                    可选：环境准备（如准备 blob: 目标页），不改被测元素的最终答案
//   text/maxSteps/validate         传给引擎的输入与预算
//   decision                       注入判定器的选择依据（见 suite.mjs 的 buildAsk）
//   check(page)                    引擎的确定性成功条件（推荐路径）
//   verify(page, ctx)              断言真实 DOM/URL/派发记录，返回 { ok, detail, observed }
//   controlStop                    「用户接管/控制停止」注入点（包装 page，见 suite.mjs）
//
// 任务 id 会出现在报告里，改动 id 等于改报告口径，别随手重命名。

/** 所有任务都是合成受控 DOM；报告里与线上站点任务分开统计。 */
export const SOURCE = "controlled-dom";

const page2 = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Page Two</title></head>
<body style="font:16px system-ui;padding:12px"><h1 id="next">Page Two</h1></body></html>`;

export const TASKS = [
  {
    id: "click-button",
    title: "点击按钮：真实 CDP 鼠标派发命中 onclick",
    goal: "点击「Start」按钮",
    fixture: `<div style="font:14px system-ui;padding:8px">
      <button id="go" aria-label="Start" style="width:180px;height:44px;font-size:15px"
        onclick="window.__clicked=(window.__clicked||0)+1">Start</button>
    </div>`,
    decision: { operation: "click", target: "Start" },
    maxSteps: 3,
    expect: "goal",
    check: async (page) => (await page.evaluate(() => window.__clicked || 0)) === 1,
    verify: async (page, ctx) => {
      const clicked = await page.evaluate(() => window.__clicked || 0);
      const step = (ctx.history || [])[0] || {};
      return {
        ok: clicked === 1 && step.action === "click" && !step.guardRejected,
        detail: "期望 window.__clicked === 1 且首步 action=click 无守卫拒绝",
        observed: {
          clicked,
          action: step.action ?? null,
          target: step.target ?? null,
          targetLabel: step.targetLabel ?? null,
          guardRejected: step.guardRejected ?? null,
        },
      };
    },
  },

  {
    id: "click-link-nav",
    title: "点击链接导航：真实跳转后 URL 与文档都换了",
    goal: "点击「Next page」链接",
    fixture: `<div style="font:14px system-ui;padding:8px">
      <a id="go" href="#" aria-label="Next page" style="display:block;width:200px;height:32px">Next page</a>
    </div>`,
    // 目标页用 blob: URL 生成：真实导航（文档被替换），且不联网、不依赖外部站点。
    setup: async (page, html) => {
      await page.evaluate((content) => {
        const url = URL.createObjectURL(new Blob([content], { type: "text/html" }));
        document.getElementById("go").href = url;
      }, html);
    },
    setupArgs: page2,
    decision: { operation: "click", target: "Next page" },
    maxSteps: 3,
    expect: "goal",
    check: async (page) => (await page.url()).startsWith("blob:"),
    verify: async (page, ctx) => {
      const url = await page.url();
      const title = await page.title();
      const hasNext = await page.evaluate(() => Boolean(document.getElementById("next")));
      return {
        ok: url.startsWith("blob:") && hasNext === true && title === "Page Two",
        detail: "期望 URL 变成 blob: 且新文档含 #next、title=Page Two",
        observed: { urlStart: url.slice(0, 12), title, hasNext, dispatches: ctx.dispatches.length },
      };
    },
  },

  {
    id: "type-text",
    title: "输入文本：真实 CDP 派发写入 input.value",
    goal: "在「Query field」里填入 hello-acceptance",
    fixture: `<div style="font:14px system-ui;padding:8px">
      <input id="q" aria-label="Query field" style="width:260px;height:34px;font-size:15px">
    </div>`,
    text: ["hello-acceptance"],
    decision: { operation: "type_text", target: "Query field", text: "hello-acceptance" },
    maxSteps: 3,
    expect: "goal",
    check: async (page) => (await page.evaluate(() => document.getElementById("q").value)) === "hello-acceptance",
    verify: async (page, ctx) => {
      const value = await page.evaluate(() => document.getElementById("q").value);
      const step = (ctx.history || [])[0] || {};
      return {
        ok: value === "hello-acceptance" && step.text === "hello-acceptance",
        detail: "期望 input.value 与决策文本一致",
        observed: { value, text: step.text ?? null, dispatches: ctx.dispatches.slice() },
      };
    },
  },

  {
    id: "search-submit",
    title: "搜索提交：type_text_submit 输入并回车触发表单 submit",
    goal: "在「Search field」里填入 acceptance 并提交",
    fixture: `<form id="f" style="font:14px system-ui;padding:8px">
      <input id="q" aria-label="Search field" style="width:260px;height:34px;font-size:15px">
      <button id="go" type="submit" aria-label="Search" style="width:100px;height:34px">Search</button>
      <div id="out"></div>
    </form>`,
    // innerHTML 插入的 <script> 不会执行，所以提交监听必须在 setup 里用 page.evaluate 安装。
    setup: async (page) => {
      await page.evaluate(() => {
        document.getElementById("f").addEventListener("submit", (event) => {
          event.preventDefault();
          window.__submitted = document.getElementById("q").value;
          document.getElementById("out").textContent = "submitted: " + window.__submitted;
        });
      });
    },
    expect: "goal",
    text: ["acceptance"],
    decision: { operation: "type_text_submit", target: "Search field", text: "acceptance" },
    maxSteps: 3,
    check: async (page) => (await page.evaluate(() => window.__submitted || null)) === "acceptance",
    verify: async (page, ctx) => {
      const observed = await page.evaluate(() => ({
        submitted: window.__submitted ?? null,
        value: document.getElementById("q").value,
        out: document.getElementById("out").textContent,
      }));
      const pressedEnter = ctx.dispatches.includes("keyboard.press:Enter");
      return {
        ok: observed.submitted === "acceptance" && observed.value === "acceptance" && pressedEnter,
        detail: "期望表单 submit 事件收到 acceptance，且真的派发了 Enter",
        observed: { ...observed, pressedEnter, dispatches: ctx.dispatches.slice() },
      };
    },
  },

  {
    id: "select-native",
    title: "原生下拉：改选后 DOM 选中值与 change 事件都对",
    goal: "把「Country」改选为 Denmark",
    fixture: `<div style="font:14px system-ui;padding:8px">
      <select id="c" aria-label="Country" style="width:200px;height:34px;font-size:15px"
        onchange="window.__chosen=this.value">
        <option value="ch">Switzerland</option>
        <option value="dk">Denmark</option>
        <option value="de">Germany</option>
      </select>
    </div>`,
    decision: { operation: "select", option: "Denmark" },
    maxSteps: 3,
    expect: "goal",
    check: async (page) => (await page.evaluate(() => document.getElementById("c").value)) === "dk",
    verify: async (page, ctx) => {
      const observed = await page.evaluate(() => {
        const el = document.getElementById("c");
        return {
          value: el.value,
          label: el.options[el.selectedIndex]?.textContent ?? null,
          changed: window.__chosen ?? null,
        };
      });
      return {
        ok: observed.value === "dk" && observed.changed === "dk",
        detail: "期望 select.value=dk 且 change 事件带出 dk",
        observed,
      };
    },
  },

  {
    id: "checkbox-toggle",
    title: "复选框：点击后 checked 与 change 事件都对",
    goal: "勾选「Subscribe newsletter」",
    fixture: `<div style="font:14px system-ui;padding:8px">
      <label style="display:inline-flex;align-items:center;gap:8px;width:260px;height:36px">
        <input id="cb" type="checkbox" aria-label="Subscribe newsletter" style="width:20px;height:20px"
          onchange="window.__checked=this.checked">
        <span>Subscribe newsletter</span>
      </label>
    </div>`,
    decision: { operation: "click", target: "Subscribe newsletter" },
    maxSteps: 3,
    expect: "goal",
    check: async (page) => (await page.evaluate(() => Boolean(document.getElementById("cb").checked))) === true,
    verify: async (page, ctx) => {
      const observed = await page.evaluate(() => ({
        checked: document.getElementById("cb").checked,
        changed: window.__checked ?? null,
      }));
      return {
        ok: observed.checked === true && observed.changed === true,
        detail: "期望 checkbox.checked=true 且 change 事件收到 true",
        observed: { ...observed, dispatches: ctx.dispatches.slice() },
      };
    },
  },

  {
    id: "covered-target",
    title: "遮挡：overlay 盖住按钮 → covered 拒绝且零派发",
    goal: "点击「Covered Button」",
    fixture: `<div style="font:14px system-ui;padding:8px;position:relative;width:320px;height:120px">
      <button id="go" aria-label="Covered Button"
        style="position:absolute;left:0;top:0;width:240px;height:60px;font-size:15px"
        onclick="window.__clicked=(window.__clicked||0)+1">Covered Button</button>
      <div id="veil" style="position:absolute;left:0;top:0;width:240px;height:60px;
        background:rgba(0,0,0,0.55);z-index:9"></div>
    </div>`,
    decision: { operation: "click", target: "Covered Button" },
    maxSteps: 3,
    // 引擎的 goal 本来就该是 false：这条任务验的是「护栏拒绝且零派发」。
    expect: "guard",
    verify: async (page, ctx) => {
      const clicked = await page.evaluate(() => window.__clicked || 0);
      const rejections = (ctx.history || []).map((h) => h.guardRejected).filter(Boolean);
      return {
        ok: clicked === 0 && rejections.length > 0 && rejections.every((r) => r === "covered") && ctx.dispatches.length === 0,
        detail: "期望 window.__clicked 保持 0、守卫理由是 covered、派发次数 0",
        observed: {
          clicked,
          rejections,
          dispatches: ctx.dispatches.length,
          stopReason: ctx.result?.reason ?? null,
        },
      };
    },
  },

  {
    id: "stale-ref",
    title: "陈旧 ref：判定器引用不存在的 ref → 零派发",
    goal: "点击「Start」按钮",
    fixture: `<div style="font:14px system-ui;padding:8px">
      <button id="go" aria-label="Start" style="width:180px;height:44px;font-size:15px"
        onclick="window.__clicked=(window.__clicked||0)+1">Start</button>
    </div>`,
    // 复现「判定器看的是上一次观测的元素表」：直接返回一个当前表里不存在的 ref。
    // 响应校验必须关闭，否则引擎会先以 choice_not_offered 拒收（那是另一条路径）。
    decision: { operation: "click", targetRef: "ref=999" },
    validate: false,
    maxSteps: 2,
    expect: "guard",
    verify: async (page, ctx) => {
      const clicked = await page.evaluate(() => window.__clicked || 0);
      const stale = (ctx.history || []).map((h) => h.staleTarget).filter(Boolean);
      return {
        ok: clicked === 0 && stale.length > 0 && stale.every((s) => s === "ref=999") && ctx.dispatches.length === 0,
        detail: "期望每步都记 staleTarget=ref=999、window.__clicked=0、派发 0",
        observed: {
          clicked,
          staleTargets: stale,
          dispatches: ctx.dispatches.length,
          stopReason: ctx.result?.reason ?? null,
        },
      };
    },
  },

  {
    id: "danger-action",
    title: "危险动作：命中「删除」词表 → 零派发并立即停",
    goal: "点击「Delete account」按钮",
    fixture: `<div style="font:14px system-ui;padding:8px">
      <button id="del" aria-label="Delete account" style="width:200px;height:44px;font-size:15px"
        onclick="window.__deleted=(window.__deleted||0)+1">Delete account</button>
    </div>`,
    decision: { operation: "click", target: "Delete account" },
    maxSteps: 3,
    expect: "guard",
    verify: async (page, ctx) => {
      const deleted = await page.evaluate(() => window.__deleted || 0);
      const step = (ctx.history || [])[0] || {};
      return {
        ok:
          deleted === 0 &&
          ctx.dispatches.length === 0 &&
          step.guardRejected === "dangerous_action" &&
          Boolean(step.dangerousMatch),
        detail: "期望 guardRejected=dangerous_action、dangerousMatch 非空、零派发、window.__deleted=0",
        observed: {
          deleted,
          guardRejected: step.guardRejected ?? null,
          dangerousMatch: step.dangerousMatch ?? null,
          dangerousKind: step.dangerousKind ?? null,
          dispatches: ctx.dispatches.length,
          stopReason: ctx.result?.reason ?? null,
        },
      };
    },
  },

  {
    id: "control-stop",
    title: "控制停止：动作已派发后接管 → 立即抛出且无后续派发",
    goal: "点击「Start」按钮",
    fixture: `<div style="font:14px system-ui;padding:8px">
      <button id="go" aria-label="Start" style="width:180px;height:44px;font-size:15px"
        onclick="window.__clicked=(window.__clicked||0)+1">Start</button>
    </div>`,
    decision: { operation: "click", target: "Start" },
    maxSteps: 5,
    // 包装 page 注入控制异常：第一次派发之后，下一次页面调用抛 EGO_CONTROL_LOST。
    // 这模拟「用户在动作落地后立刻接管」，用来断言引擎不重试、不再派发任何动作。
    controlStop: { afterDispatch: 1 },
    expect: "guard",
    verify: async (page, ctx) => {
      const clicked = await page.evaluate(() => window.__clicked || 0);
      const code = ctx.thrown?.code ?? null;
      const noStraggler = ctx.dispatches.length === ctx.stopIndex;
      const noRetry = ctx.postStopCalls === 0;
      return {
        ok:
          Boolean(ctx.thrown) &&
          code === "EGO_CONTROL_LOST" &&
          ctx.stopIndex >= 1 &&
          noStraggler &&
          noRetry &&
          clicked === 1,
        detail:
          "期望抛出 code=EGO_CONTROL_LOST；停止后既有派发数不再增长，且引擎没有再做任何页面调用（postStopCalls=0）；window.__clicked=1",
        observed: {
          thrownCode: code,
          thrownMessage: ctx.thrown?.message ?? null,
          stopIndex: ctx.stopIndex,
          dispatchesAfterStop: ctx.dispatches.length - ctx.stopIndex,
          postStopCalls: ctx.postStopCalls,
          clicked,
        },
      };
    },
  },

  {
    id: "no-text-source",
    title: "缺文本来源：判定器没选候选且无生成模型 → no_text_source 且零派发",
    goal: "在「Query field」里填入文本",
    fixture: `<div style="font:14px system-ui;padding:8px">
      <input id="q" aria-label="Query field" style="width:260px;height:34px;font-size:15px">
    </div>`,
    text: ["acceptance"],
    // 候选存在但判定器对 input_text 选 none；suite 统一传 textModel: null（不联网、不用本机文本模型）。
    decision: { operation: "type_text", target: "Query field", inputText: "none" },
    maxSteps: 2,
    expect: "guard",
    verify: async (page, ctx) => {
      const value = await page.evaluate(() => document.getElementById("q").value);
      return {
        ok: value === "" && ctx.result?.reason === "no_text_source" && ctx.dispatches.length === 0,
        detail: "期望 reason=no_text_source、input.value 未变、派发 0",
        observed: { value, stopReason: ctx.result?.reason ?? null, dispatches: ctx.dispatches.length },
      };
    },
  },

  {
    id: "batch-two-fields",
    title: "多动作批处理：两字段 + 提交在单步内完成",
    goal: "填写用户名与邮箱并提交",
    fixture: `<form id="f" style="font:14px system-ui;padding:8px">
      <input id="username" aria-label="Username" style="width:240px;height:32px;font-size:15px">
      <input id="email" aria-label="Email" style="width:240px;height:32px;font-size:15px">
      <button id="go" type="submit" aria-label="Submit Form" style="width:140px;height:34px">Submit Form</button>
      <div id="out"></div>
    </form>`,
    // 同上：提交监听用 page.evaluate 装，不能指望 innerHTML 里的 <script> 执行。
    setup: async (page) => {
      await page.evaluate(() => {
        document.getElementById("f").addEventListener("submit", (event) => {
          event.preventDefault();
          window.__submitted =
            document.getElementById("username").value + " / " + document.getElementById("email").value;
          document.getElementById("out").textContent = "Submitted: " + window.__submitted;
        });
      });
    },
    // 批处理子动作的文本必须同时在候选列表里（引擎只回放调用方给的候选文本）。
    text: ["alice", "alice@example.com"],
    expect: "goal",
    decision: {
      kind: "batch",
      steps: [
        { action: "type_text", target: "Username", text: "alice" },
        { action: "type_text", target: "Email", text: "alice@example.com" },
        { action: "click", target: "Submit Form" },
      ],
    },
    maxSteps: 2,
    check: async (page) =>
      (await page.evaluate(() => window.__submitted || null)) === "alice / alice@example.com",
    verify: async (page, ctx) => {
      const observed = await page.evaluate(() => ({
        username: document.getElementById("username").value,
        email: document.getElementById("email").value,
        submitted: window.__submitted ?? null,
        out: document.getElementById("out").textContent,
      }));
      const step = (ctx.history || [])[0] || {};
      return {
        ok:
          observed.username === "alice" &&
          observed.email === "alice@example.com" &&
          observed.submitted === "alice / alice@example.com" &&
          step.batchExecutedCount === 3,
        detail: "期望两个字段都落地、表单已提交、批次执行 3/3 个子动作",
        observed: {
          ...observed,
          batchSize: step.batchSize ?? null,
          batchExecutedCount: step.batchExecutedCount ?? null,
          dispatches: ctx.dispatches.length,
        },
      };
    },
  },
];

export const TASK_IDS = TASKS.map((task) => task.id);

export function selectTasks(taskIds) {
  if (!taskIds) return TASKS.slice();
  const wanted = Array.isArray(taskIds)
    ? taskIds
    : String(taskIds)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
  const unknown = wanted.filter((id) => !TASK_IDS.includes(id));
  if (unknown.length) throw new Error(`未知任务 id: ${unknown.join(", ")}（可用: ${TASK_IDS.join(", ")}）`);
  return TASKS.filter((task) => wanted.includes(task.id));
}
