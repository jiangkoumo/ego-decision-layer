// 双宿主验收套件：同一个任务集、同一份输入与预算，跑两种宿主（ego lite / 外部 Chrome CDP）。
//
// 为什么这样设计：
//   * 任务定义（tasks.mjs）与宿主无关，两个入口复用同一个 runHostAcceptance；
//   * 引擎默认取**当前工作树**的 scripts/decider-loop.mjs，但允许显式覆盖（跨 worktree 复验时不复制代码）；
//   * 判定器走引擎既有契约 options.ask（注入确定性实现），观测 / locate / 裸 CDP 派发 / DOM 断言
//     全是真实路径；因此结果只说明「引擎 + 宿主」的机制，不是模型成功率；
//   * 每项任务都记录：成功/错误成功（引擎说成功但 DOM 断言失败）/延迟/决策请求数/护栏拒绝/停止原因；
//     费用、token、人工接管这类当前测不到的量一律写 null，不猜。
//
// 用法见 docs/HOST-ACCEPTANCE.md；两个入口：run-ego.mjs（ego lite）与 run-cdp.mjs（外部 Chrome）。

import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TASKS, TASK_IDS, SOURCE, selectTasks } from "./tasks.mjs";

export { TASKS, TASK_IDS, SOURCE };

/** 默认引擎：当前工作树的 decider-loop.mjs（跨 worktree 复验时显式覆盖即可）。 */
const DEFAULT_ENGINE_URL = new URL("../../scripts/decider-loop.mjs", import.meta.url);
export const DEFAULT_ENGINE_PATH = fileURLToPath(DEFAULT_ENGINE_URL);

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/**
 * 解析引擎模块。
 * options.engine 允许三种形态：模块对象（已 import 好的命名空间）、文件路径、file: URL。
 */
export async function resolveEngine(explicit) {
  if (explicit && typeof explicit === "object" && typeof explicit.runJevAutonomousLoop === "function") return explicit;
  let url = DEFAULT_ENGINE_URL;
  if (typeof explicit === "string" && explicit.trim()) {
    const value = explicit.trim();
    url = value.startsWith("file:") ? new URL(value) : pathToFileURL(resolve(value));
  }
  const mod = await import(url.href);
  if (typeof mod.runJevAutonomousLoop !== "function") {
    throw new Error(`引擎模块没有导出 runJevAutonomousLoop：${url.href}`);
  }
  return mod;
}

/** 从 criteria（key → 描述文本）里按子串挑一个 key。 */
function pickKeyByText(criteria, needle) {
  if (!needle) return null;
  const lower = String(needle).toLowerCase();
  for (const [key, text] of Object.entries(criteria || {})) {
    if (key === "none") continue;
    if (String(text).toLowerCase().includes(lower)) return key;
  }
  return null;
}

/** 组装一个通过 validateChoice 的 choice 头（概率归一、choice 为 argmax）。 */
function choiceHead(criteria, pick) {
  const keys = Object.keys(criteria || {});
  if (!keys.length) return null;
  const picked = typeof pick === "function" ? pick(keys) : pick;
  const choice = picked && typeof picked === "string" ? picked : keys.find((k) => k !== "none") ?? keys[0];
  const rest = keys.filter((k) => k !== choice);
  if (!rest.length) return { choice, confidence: 1, probabilities: { [choice]: 1 } };
  const probabilities = { [choice]: 0.9 };
  for (const key of rest) probabilities[key] = 0.1 / rest.length;
  return { choice, confidence: 0.9, probabilities };
}

/**
 * 注入的确定性判定器：只看 questions 的 criteria（像真实判定器一样读候选表，不读 DOM）。
 * 返回 { ask, stats }，stats.calls 就是本次任务的「决策请求数」。
 */
export function buildAsk(decision = {}) {
  const stats = { calls: 0, batchCalls: 0 };
  const ask = async (_state, questions = {}) => {
    stats.calls += 1;

    if (decision.kind === "batch") {
      stats.batchCalls += 1;
      const pickRef = (head, needle) => {
        const criteria = questions[head]?.criteria || {};
        return pickKeyByText(criteria, needle);
      };
      const subActions = (decision.steps || []).map((step) => {
        const head = step.action === "click" ? "click_target" : "type_text_target";
        const ref = pickRef(head, step.target);
        if (!ref) throw new Error(`注入判定器找不到目标「${step.target}」（${head}）`);
        return { action: step.action, target: ref, ...(step.text ? { text: step.text } : {}) };
      });
      return { action: "batch", subActions };
    }

    const answers = {};
    for (const [head, question] of Object.entries(questions)) {
      if (head === "operation") {
        answers[head] = choiceHead(question.criteria, (keys) =>
          decision.operation && keys.includes(decision.operation) ? decision.operation : null
        );
      } else if (head === "click_target" || head === "type_text_target") {
        if (decision.targetRef) {
          // 复现「引用上一轮观测的 ref」：validate:false 下引擎会把它记成 staleTarget。
          answers[head] = { choice: decision.targetRef, confidence: 0.9, probabilities: { [decision.targetRef]: 0.9, none: 0.1 } };
        } else {
          answers[head] = choiceHead(question.criteria, () => pickKeyByText(question.criteria, decision.target));
        }
      } else if (head === "select_target") {
        answers[head] = choiceHead(question.criteria, () => pickKeyByText(question.criteria, decision.option));
      } else if (head === "input_text") {
        answers[head] = choiceHead(question.criteria, () => {
          if (decision.inputText === "none") return "none";
          return pickKeyByText(question.criteria, decision.inputText ?? decision.text);
        });
      } else {
        answers[head] = choiceHead(question.criteria, () => null);
      }
    }
    return answers;
  };
  return { ask, stats };
}

/**
 * 包装宿主 page：
 *   * 记录真实派发（鼠标/键盘/文本/下拉），供「零派发」「错误成功」这类断言使用；
 *   * 可选注入控制停止（模拟用户接管）：第 N 个动作派发完成后，下一次页面调用抛 EGO_CONTROL_LOST，
 *     并记录「停止之后引擎还尝试了几次页面调用」（postStopCalls 必须为 0，证明没有重试派发）。
 */
export function instrumentPage(page, controlStop = null) {
  const dispatches = [];
  const state = {
    dispatches,
    actions: 0,
    stopIndex: null,
    postStopCalls: 0,
    thrown: null,
    armed: Boolean(controlStop),
    pending: false,
  };
  const triggerAfter = controlStop?.afterDispatch ?? Number.POSITIVE_INFINITY;

  const controlError = () => {
    const err = new Error("user took control of the page (injected control stop)");
    err.code = "EGO_CONTROL_LOST";
    err.executionStopped = true;
    return err;
  };

  const noteAction = () => {
    state.actions += 1;
    if (state.armed && !state.pending && state.actions >= triggerAfter) state.pending = true;
  };

  const guard = (kind) => {
    if (state.halted) {
      state.postStopCalls += 1;
      throw Object.assign(new Error("host acceptance harness halted (task timed out)"), { code: "HARNESS_HALTED" });
    }
    if (state.thrown) {
      state.postStopCalls += 1;
      throw state.thrown;
    }
    if (state.pending) {
      state.thrown = controlError();
      state.stopIndex = dispatches.length;
      throw state.thrown;
    }
    return kind;
  };

  const call = async (kind, fn) => {
    guard(kind);
    return fn();
  };

  const real = page;
  const wrapped = new Proxy(real, {
    get(target, prop) {
      if (prop === "__hostAcceptance") {
        return { dispatches, state, disarm: () => { state.armed = false; state.pending = false; } };
      }
      if (prop === "evaluate") {
        return (...args) => call("evaluate", () => target.evaluate(...args));
      }
      if (prop === "cdp") {
        return async (method, params, opts) => {
          const result = await call(`cdp:${method}`, () => target.cdp(method, params, opts));
          if (method === "Input.dispatchMouseEvent" && params?.type) {
            dispatches.push(`mouse:${params.type}`);
            if (params.type === "mouseReleased") noteAction();
          } else if (method === "Input.insertText") {
            dispatches.push("insertText");
            noteAction();
          } else if (method === "Input.dispatchKeyEvent" && params?.type === "keyDown") {
            dispatches.push(`key:${params.key ?? ""}`);
          }
          return result;
        };
      }
      if (prop === "keyboard" && target.keyboard) {
        const keyboard = target.keyboard;
        return new Proxy(keyboard, {
          get(kbTarget, kbProp) {
            if (kbProp === "press") {
              return async (key, opts) => {
                const result = await call(`keyboard.press:${key}`, () => kbTarget.press(key, opts));
                dispatches.push(`keyboard.press:${key}`);
                noteAction();
                return result;
              };
            }
            const value = kbTarget[kbProp];
            return typeof value === "function" ? value.bind(kbTarget) : value;
          },
        });
      }
      if (["click", "fill", "press", "selectOption", "snapshot", "url", "title", "info", "events", "waitForLoadState", "waitForURL", "waitForSelector", "waitForFunction"].includes(prop)) {
        return (...args) =>
          call(prop, async () => {
            const result = await target[prop](...args);
            if (["click", "fill", "press", "selectOption"].includes(prop)) {
              dispatches.push(`page.${prop}`);
              noteAction();
            }
            return result;
          });
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    page: wrapped,
    dispatches,
    get actions() { return state.actions; },
    get stopIndex() { return state.stopIndex; },
    get postStopCalls() { return state.postStopCalls; },
    get thrown() { return state.thrown; },
    disarm() { state.armed = false; state.pending = false; },
    // 超时后关闸：仍在跑的引擎循环下一次触碰 page 就抛错，不会继续派发污染下一个 fixture。
    halt() { state.armed = false; state.pending = false; state.halted = true; },
  };
}

function compactHistory(history = []) {
  return history.map((step, index) => ({
    step: index + 1,
    action: step.action ?? null,
    target: step.target ?? null,
    targetLabel: step.targetLabel ?? null,
    option: step.option ?? null,
    text: step.text ?? null,
    changed: Boolean(step.changed),
    guardRejected: step.guardRejected ?? null,
    staleTarget: step.staleTarget ?? null,
    textError: step.textError ?? null,
    targetMissing: Boolean(step.targetMissing),
    batchSize: step.batchSize ?? null,
    batchExecutedCount: step.batchExecutedCount ?? null,
    stepDurationMs: step.stepDurationMs ?? null,
    phases: step.phases ?? null,
  }));
}

function rejectionList(history = []) {
  const out = [];
  history.forEach((step, index) => {
    if (step.guardRejected) out.push({ step: index + 1, kind: step.guardRejected, dangerousMatch: step.dangerousMatch ?? null });
    if (step.staleTarget) out.push({ step: index + 1, kind: "stale_ref", ref: step.staleTarget });
  });
  return out;
}

async function runTask(page, task, ctx) {
  await page.goto("about:blank", { timeout: 15000 });
  await page.evaluate((html) => {
    document.body.innerHTML = html;
  }, task.fixture);
  if (task.setup) await task.setup(page, task.setupArgs);

  const inst = instrumentPage(page, task.controlStop ?? null);
  const { ask, stats } = buildAsk(task.decision);
  const started = Date.now();
  let result = null;
  let thrown = null;
  let timedOut = false;

  const engineOptions = {
    ask,
    text: task.text,
    textModel: null, // 显式禁用文本生成：整轮验收不联网、不读本机文本模型配置
    cache: false,    // 不动用户动作缓存，请求数才是可解释的
    maxSteps: task.maxSteps ?? 3,
    onStep: () => {},
    ...(task.check ? { check: (p) => task.check(p) } : {}),
    ...(task.validate === false ? { validate: false } : {}),
  };

  try {
    let timer = null;
    const timeoutMs = ctx.taskTimeoutMs ?? 60000;
    try {
      result = await Promise.race([
        ctx.runJevAutonomousLoop(inst.page, task.goal, engineOptions),
        new Promise((_, reject) => {
          // 可清 timer：不然 sleep 自己会把进程留住（验收脚本要能自己退出）。
          timer = setTimeout(() => {
            timedOut = true;
            reject(Object.assign(new Error(`task timeout after ${timeoutMs}ms`), { code: "TASK_TIMEOUT" }));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  } catch (err) {
    thrown = err;
  }
  inst.disarm();
  // 超时说明引擎循环可能仍在跑：关闸，让它下一次页面调用立即失败，不会派发到下个 fixture。
  if (timedOut) inst.halt();
  const latencyMs = Date.now() - started;

  // 给「停止后还在偷偷重试」留一个观察窗口：派发记录应保持不动
  if (thrown) await sleep(250);

  const verifyCtx = {
    result,
    history: result?.history ?? [],
    dispatches: inst.dispatches,
    stopIndex: inst.stopIndex,
    postStopCalls: inst.postStopCalls,
    thrown,
    timedOut,
  };
  let verification;
  try {
    verification = await task.verify(page, verifyCtx);
  } catch (err) {
    verification = { ok: false, detail: `验证函数抛错: ${err?.message || err}`, observed: { error: String(err?.message || err) } };
  }

  const engineSuccess = result ? result.success === true : null;
  const expectation = task.expect ?? "goal";
  // 两种口径都要满足才算本任务通过：机制断言（verify） + 「引擎 goal 是否该成功」。
  // guard 任务里引擎报告 success=true 反而是可疑信号，必须判失败。
  const expectationSatisfied = expectation === "goal" ? engineSuccess === true : engineSuccess !== true;
  const taskPassed = verification.ok === true && expectationSatisfied;
  const record = {
    id: task.id,
    title: task.title,
    source: SOURCE,
    goal: task.goal,
    decider: "injected",
    // expect=goal：引擎 goal 应当成功；expect=guard：引擎 goal 应当**失败**（护栏/停止），
    // 两者都由 verify 的真实 DOM/URL 断言给出 taskPassed，不能把 goal=false 直接算成失败率。
    expect: expectation,
    timedOut,
    metrics: {
      taskPassed,
      expectationSatisfied,
      engineGoalSuccess: engineSuccess,
      falseSuccess: engineSuccess === true && verification.ok !== true,
      stopReason: thrown ? `thrown:${thrown.code || thrown.name}` : result?.reason ?? null,
      steps: result?.steps ?? null,
      decisionRequests: stats.calls,
      latencyMs,
      phases: result?.phases ?? null,
      guardrailRejections: rejectionList(result?.history),
      dispatches: inst.dispatches.length,
      postStopPageCalls: thrown ? inst.postStopCalls : null,
      cacheHits: result?.cacheHits ?? null,
      costUsd: null,       // 注入判定器不走服务端，费用不可比，标 null 而不是 0
      tokens: null,
      humanTakeover: null, // 未测，标 null
    },
    engine: result
      ? { success: result.success === true, reason: result.reason ?? null, steps: result.steps ?? null }
      : { success: null, reason: null, steps: null, thrown: thrown ? { code: thrown.code ?? null, message: String(thrown.message || thrown) } : null },
    verification: {
      ok: verification.ok === true,
      detail: verification.detail ?? null,
      observed: verification.observed ?? null,
    },
    history: compactHistory(result?.history),
  };
  if (ctx.onTask) ctx.onTask(record);
  return record;
}

/**
 * 跑完整个任务集。
 *
 * options：
 *   engine        模块对象 / 文件路径 / file: URL（默认当前工作树引擎）
 *   host          宿主标签，只用于报告（如 "ego-lite" / "cdp-external"）
 *   taskIds       数组或逗号分隔字符串；不传 = 全部 12 项
 *   taskTimeoutMs 单任务上限（默认 60000）
 *   onTask        (record) => void，可用于边跑边打印
 */
export async function runHostAcceptance(page, options = {}) {
  const engine = await resolveEngine(options.engine);
  const tasks = selectTasks(options.taskIds);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const ctx = {
    runJevAutonomousLoop: engine.runJevAutonomousLoop,
    taskTimeoutMs: options.taskTimeoutMs,
    onTask: options.onTask,
  };
  const results = [];
  const notRun = [];
  let halted = false;
  for (const task of tasks) {
    if (halted) {
      notRun.push(task.id);
      continue;
    }
    const record = await runTask(page, task, ctx);
    results.push(record);
    // 超时后不再跑下一项：仍在跑的引擎循环已被关闸，但整套验收应停下并如实报告未完成任务。
    if (record.timedOut) halted = true;
  }
  const enginePath =
    typeof options.engine === "string" && options.engine.trim() ? options.engine.trim() : DEFAULT_ENGINE_PATH;
  return {
    host: options.host ?? "unknown",
    source: SOURCE,
    decider: "injected",
    enginePath,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalMs: Date.now() - started,
    results,
    summary: summarize(results, { notRun, halted, expectedTotal: tasks.length }),
  };
}

/** 汇总：只做加减与「哪些指标未知」，不做统计推断。 */
export function summarize(results = [], meta = {}) {
  const notRun = meta.notRun ?? [];
  const expectedTotal = typeof meta.expectedTotal === "number" ? meta.expectedTotal : results.length;
  const goalTasks = results.filter((r) => r.expect === "goal");
  const guardTasks = results.filter((r) => r.expect === "guard");
  const passed = results.filter((r) => r.metrics.taskPassed).length;
  const sum = (key, subset = results) =>
    subset.reduce((acc, r) => acc + (typeof r.metrics[key] === "number" ? r.metrics[key] : 0), 0);
  return {
    total: results.length,
    expectedTotal,
    notRun,
    halted: Boolean(meta.halted),
    complete: results.length === expectedTotal && notRun.length === 0,
    taskPassed: passed,
    taskFailed: results.length - passed,
    // 两种口径分开报：机制是否按预期工作（taskPassed）≠ 引擎认定目标达成（engineGoalSuccess）。
    goalTasks: {
      total: goalTasks.length,
      taskPassed: goalTasks.filter((r) => r.metrics.taskPassed).length,
      engineGoalSuccess: goalTasks.filter((r) => r.metrics.engineGoalSuccess === true).length,
    },
    guardTasks: {
      total: guardTasks.length,
      taskPassed: guardTasks.filter((r) => r.metrics.taskPassed).length,
      // 护栏任务的引擎 goal 本来就应当为 false；这里若 >0 反而是可疑信号。
      engineSucceededAnyway: guardTasks.filter((r) => r.metrics.engineGoalSuccess === true).length,
      stopReasons: [...new Set(guardTasks.map((r) => r.metrics.stopReason).filter(Boolean))],
    },
    falseSuccesses: results.filter((r) => r.metrics.falseSuccess).map((r) => r.id),
    decisionRequests: sum("decisionRequests"),
    dispatches: sum("dispatches"),
    latencyMs: sum("latencyMs"),
    guardrailRejections: results.reduce((acc, r) => acc + r.metrics.guardrailRejections.length, 0),
    unknownMetrics: ["costUsd", "tokens", "humanTakeover"],
    disclaimer:
      "合成受控 DOM + 注入判定器（options.ask）：只证明引擎与宿主机制的一致性，不是模型成功率，也不是线上站点成功率。",
  };
}
