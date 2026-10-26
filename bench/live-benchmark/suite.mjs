// Shared trial runner for the live dual-host benchmark.
//
// One trial = fresh start URL, real engine, real Jev ask, independent URL+DOM verifier.
// No decision is injected: options.ask is a thin counting/budget wrapper around the
// engine's real askJev. The engine result and the verifier result are recorded separately
// so a "Jev said done" false success cannot be reported as a task success.

import { getTask } from './tasks.mjs';
import { getVerifier } from './verifiers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stopError(message, code) {
  return Object.assign(new Error(message), { code, executionStopped: true });
}

/** Run a promise with a wall-clock cut-off; the timer is always cleared. */
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(stopError(`${label} exceeded ${ms}ms`, 'EGO_LIVE_TIMEOUT')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function median(values) {
  const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!finite.length) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function safeEndpoint(value) {
  try {
    const url = new URL(String(value));
    return `${url.origin}${url.pathname}`;
  } catch {
    return '<unparseable-url>';
  }
}

/**
 * Wrap a page for one engine invocation.
 *
 * The gate is the important part: after a wall-clock timeout (or an explicit halt), every
 * later page/CDP call throws before reaching the real host. Promise.race alone would leave
 * the engine free to keep dispatching actions after the trial was declared over.
 */
export function instrumentPage(page, gate = { halted: false, lateCalls: 0, lateDispatchAttempts: 0 }) {
  const dispatches = [];
  const real = page;
  const haltError = () => stopError('live benchmark gate is closed after timeout', 'EGO_LIVE_HALTED');
  const checkOpen = (method) => {
    if (!gate.halted) return;
    gate.lateCalls += 1;
    if (/^Input\./.test(String(method))) gate.lateDispatchAttempts += 1;
    throw haltError();
  };
  const noteDispatch = (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') dispatches.push('mouse:mouseReleased');
    else if (method === 'Input.insertText') dispatches.push('insertText');
    else if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyDown') dispatches.push(`key:${params.key ?? ''}`);
  };

  const wrapped = new Proxy(real, {
    get(target, prop) {
      if (prop === '__liveGate') return { gate, dispatches };
      if (prop === 'cdp') {
        return async (method, params, opts) => {
          checkOpen(method);
          const result = await target.cdp(method, params, opts);
          noteDispatch(method, params);
          return result;
        };
      }
      if (prop === 'keyboard' && target.keyboard) {
        const keyboard = target.keyboard;
        return new Proxy(keyboard, {
          get(kbTarget, kbProp) {
            const value = kbTarget[kbProp];
            if (typeof value !== 'function') return value;
            return async (...args) => {
              checkOpen(`keyboard.${String(kbProp)}`);
              const result = await value.apply(kbTarget, args);
              dispatches.push(`keyboard.${String(kbProp)}`);
              return result;
            };
          },
        });
      }
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return async (...args) => {
        checkOpen(String(prop));
        const result = await value.apply(target, args);
        if (['click', 'fill', 'press', 'selectOption'].includes(prop)) dispatches.push(`page.${String(prop)}`);
        return result;
      };
    },
  });
  return { page: wrapped, dispatches, gate };
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
    targetMissing: Boolean(step.targetMissing),
    error: step.error ?? null,
    stepDurationMs: step.stepDurationMs ?? null,
    phases: step.phases ?? null,
  }));
}

const TOKEN_FIELDS = { inputTokens: 'input_tokens', outputTokens: 'output_tokens' };
const validTokens = (value) => Number.isSafeInteger(value) && value >= 0;

// The engine initializes its usage aggregate to zero even if the backend omitted
// usage. Only individual, settled ask receipts can establish observed token counts.
function trialUsage(asks) {
  const usage = {};
  const usageReasons = {};
  for (const [metric, field] of Object.entries(TOKEN_FIELDS)) {
    const reasons = [];
    let total = 0;
    asks.forEach((ask, index) => {
      const prefix = `ask ${index + 1}`;
      if (!ask.settled) reasons.push(`${prefix}: request not settled at report time`);
      else if (ask.httpAttempts > 1) reasons.push(`${prefix}: earlier HTTP attempt usage unavailable (fallback/retry)`);
      else if (!validTokens(ask.usage?.[field])) reasons.push(`${prefix}: backend did not return valid ${field}`);
      else total += ask.usage[field];
    });
    usage[field] = reasons.length ? null : total;
    usageReasons[metric] = reasons.length ? reasons.join('; ') : null;
  }
  return { usage, usageReasons, usageSource: asks.length ? 'ask-receipts' : 'no-model-requests' };
}

function unknownUsage(reason, usageSource) {
  return {
    usage: { input_tokens: null, output_tokens: null },
    usageReasons: { inputTokens: reason, outputTokens: reason },
    usageSource,
  };
}

function summarizeTokens(rows) {
  const totals = {};
  const usageReasons = {};
  for (const metric of Object.keys(TOKEN_FIELDS)) {
    const missing = rows.filter((row) => !validTokens(row.metrics?.[metric]));
    totals[metric] = missing.length ? null : rows.reduce((sum, row) => sum + row.metrics[metric], 0);
    usageReasons[metric] = missing.length ? missing.map((row) =>
      `${row.trialId}: ${row.metrics?.usageReasons?.[metric] ?? 'token usage unavailable'}`
    ).join('; ') : null;
  }
  return { ...totals, usageReasons };
}

function emptyMetrics(usageInfo) {
  return {
    latencyMs: 0,
    navigationMs: 0,
    engineLatencyMs: 0,
    verifyMs: 0,
    logicalAskCalls: 0,
    httpRequests: 0,
    decisionRequests: 0,
    dispatches: 0,
    latePageCalls: 0,
    lateDispatchAttempts: 0,
    phases: { observeMs: 0, decideMs: 0, executeMs: 0, verifyMs: 0 },
    inputTokens: usageInfo.usage.input_tokens,
    outputTokens: usageInfo.usage.output_tokens,
    usageSource: usageInfo.usageSource,
    usageReasons: usageInfo.usageReasons,
    modelErrors: 0,
  };
}

/** Unexpected harness failure: accounting may be unavailable; never a SKIP. */
export function failedTrial(task, ctx, error, extra = {}) {
  const message = String(error?.message || error);
  // An unexpected harness exception does not establish whether model work occurred.
  const usageInfo = unknownUsage('harness error: request/usage accounting unavailable', 'unavailable');
  return {
    trialId: `${ctx.host}/${task.id}/r${ctx.round}`,
    host: ctx.host,
    taskId: task.id,
    round: ctx.round,
    status: 'FAILED',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    budget: { ...task.budget },
    engine: {
      success: null,
      reason: null,
      steps: null,
      thrown: { code: error?.code ?? null, message },
      timedOut: false,
      requestBudgetExceeded: false,
    },
    verifier: { ok: false, detail: `trial harness error: ${message}`, observed: { error: message } },
    verifierOk: false,
    taskPassed: false,
    falseSuccess: false,
    unsettled: false,
    execution: { ok: false, reasons: [`trial harness error: ${message}`] },
    metrics: emptyMetrics(usageInfo),
    model: { serverModels: [], serverEndpoints: [], ...usageInfo },
    history: [],
    ...extra,
  };
}

/**
 * Run one trial.
 *
 * ctx: { host, round, engine } where engine is the real decider-loop module.
 * The only injected part is the counting ask wrapper; decisions come from the real model.
 */
export async function runTrial(page, task, ctx) {
  if (!task || !task.budget || !task.verifier) throw new Error('invalid live task');
  if (!ctx?.engine || typeof ctx.engine.runJevAutonomousLoop !== 'function') throw new Error('engine module missing');
  const verifier = getVerifier(task.verifier);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const trialId = `${ctx.host}/${task.id}/r${ctx.round}`;
  const gate = { halted: false, lateCalls: 0, lateDispatchAttempts: 0 };
  const inst = instrumentPage(page, gate);

  let navigationError = null;
  const navStarted = Date.now();
  try {
    await page.goto(task.startUrl, { timeout: 15000 });
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 });
    } catch (err) {
      // A slow load state is not fatal: the engine observes the live DOM itself.
    }
  } catch (err) {
    navigationError = String(err?.message || err);
  }
  const navigationMs = Date.now() - navStarted;

  let result = null;
  let thrown = null;
  let timedOut = false;
  let engineSettled = true;
  let unsettled = false;
  let engineLatencyMs = 0;
  let requestBudgetExceeded = false;
  let askClosed = false;
  let logicalAskCalls = 0;
  let httpRequests = 0;
  let httpUnmeasuredReason = null;
  const httpAttempts = [];
  const modelErrors = [];
  const serverModels = new Set();
  const serverEndpoints = new Set();
  const asks = [];
  const logLines = [];

  const recordReceipt = (receipt) => {
    if (receipt?.model) serverModels.add(receipt.model);
    if (receipt?.endpoint) serverEndpoints.add(receipt.endpoint);
  };

  const ask = async (state, questions, options = {}) => {
    if (askClosed) {
      throw stopError('live benchmark ask gate is closed after timeout', 'EGO_LIVE_HALTED');
    }
    if (logicalAskCalls >= task.budget.decisionRequests) {
      requestBudgetExceeded = true;
      throw stopError(
        `logical ask budget exhausted (${task.budget.decisionRequests})`,
        'EGO_LIVE_BUDGET'
      );
    }
    logicalAskCalls += 1;
    const askRecord = { settled: false, usage: null, httpAttempts: 0 };
    asks.push(askRecord);
    // A fresh receipt prevents an earlier answer's usage from surviving a failed
    // request when the engine reuses its receipt object within one step.
    const receipt = {};
    const originalFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : null;
    if (!originalFetch) httpUnmeasuredReason = 'global fetch unavailable in this host runtime';
    let fetchWrapper = null;
    if (originalFetch) {
      fetchWrapper = async (...fetchArgs) => {
        // askJev may try another endpoint inside the same logical ask after a slow
        // failure. Check at the HTTP boundary before dispatching/counting that attempt.
        if (askClosed || gate.halted) {
          throw stopError('live benchmark HTTP gate is closed after timeout', 'EGO_LIVE_HALTED');
        }
        // Count dispatch immediately: an in-flight request must remain visible even
        // when its ask never settles before the trial report is captured.
        httpRequests += 1;
        askRecord.httpAttempts += 1;
        let attempt = { url: safeEndpoint(fetchArgs[0]), status: null, ok: null, error: null };
        if (httpAttempts.length < 20) httpAttempts.push(attempt);
        try {
          const response = await originalFetch(...fetchArgs);
          attempt.status = response?.status ?? null;
          attempt.ok = response?.ok ?? null;
          return response;
        } catch (err) {
          attempt.error = String(err?.message || err);
          throw err;
        }
      };
      globalThis.fetch = fetchWrapper;
    }
    try {
      const answers = await ctx.engine.askJev(state, questions, { ...options, receipt });
      recordReceipt(receipt);
      return answers;
    } catch (err) {
      recordReceipt(receipt);
      modelErrors.push({ code: err?.code ?? null, message: String(err?.message || err) });
      throw err;
    } finally {
      askRecord.usage = receipt.usage ? { ...receipt.usage } : null;
      askRecord.settled = true;
      if (options.receipt) Object.assign(options.receipt, receipt, { usage: receipt.usage ?? null });
      // Only the owner of the current wrapper restores it. If an old, unsettled ask is
      // superseded, it must not clobber a newer trial's wrapper.
      if (fetchWrapper && globalThis.fetch === fetchWrapper) globalThis.fetch = originalFetch;
    }
  };

  const engineOptions = {
    ask,
    text: Array.isArray(task.text) ? [...task.text] : task.text ? [task.text] : [],
    textModel: null, // explicitly disable the local text-model configuration
    cache: false, // no user or cross-trial action cache
    maxSteps: task.budget.steps,
    onStep: (line) => {
      if (logLines.length < 80) logLines.push(String(line));
    },
    // Engine-side exit condition is deliberately URL-only; the verifier below adds DOM.
    check: async (p) => {
      try {
        const url = new URL(await p.url());
        return url.origin === task.expected.origin && url.pathname === task.expected.pathname;
      } catch {
        return false;
      }
    },
  };

  if (!navigationError) {
    const elapsed = Date.now() - started;
    const remaining = task.budget.timeMs - elapsed;
    if (remaining <= 0) {
      timedOut = true;
      thrown = stopError(`task wall-clock budget exhausted before engine start`, 'EGO_LIVE_TIMEOUT');
    } else {
      const engineStarted = Date.now();
      engineSettled = false;
      const enginePromise = ctx.engine.runJevAutonomousLoop(inst.page, task.goal, engineOptions);
      // Attach a handler immediately: after a timeout the race rejects while this promise
      // may still be in flight and its later gate error must not become unhandled.
      enginePromise.catch(() => {});
      try {
        result = await withTimeout(enginePromise, remaining, 'engine loop');
        engineSettled = true;
      } catch (err) {
        thrown = err;
        if (err?.code === 'EGO_LIVE_TIMEOUT') {
          timedOut = true;
          gate.halted = true;
          askClosed = true;
        } else {
          engineSettled = true;
        }
      }
      engineLatencyMs = Date.now() - engineStarted;
      if (timedOut) {
        // Close the gate before waiting: no later page/CDP call and no later logical ask
        // can reach the host/model. Only after the engine promise settles (or the grace
        // period expires) may the next trial start; an unresolved one becomes notRun.
        gate.halted = true;
        askClosed = true;
        const graceMs = task.budget.settleGraceMs ?? 5000;
        await Promise.race([
          enginePromise.then(() => { engineSettled = true; }, () => { engineSettled = true; }),
          sleep(graceMs),
        ]);
        unsettled = !engineSettled;
      }
    }
  }

  const verifyStarted = Date.now();
  let verification;
  try {
    verification = await withTimeout(Promise.resolve(verifier(page)), 10000, 'verifier');
  } catch (err) {
    verification = { ok: false, detail: `verifier error: ${String(err?.message || err)}`, observed: { error: String(err?.message || err) } };
  }
  const verifyMs = Date.now() - verifyStarted;
  const finished = Date.now();

  const engineSuccess = result ? result.success === true : null;
  const verifierOk = verification?.ok === true;
  const stepBudgetExceeded = typeof result?.steps === 'number' && result.steps > task.budget.steps;
  const executionReasons = [];
  if (navigationError) executionReasons.push('navigation_failed');
  if (timedOut) executionReasons.push('wall_clock_budget');
  if (unsettled) executionReasons.push('engine_unsettled');
  if (requestBudgetExceeded) executionReasons.push('logical_ask_budget');
  if (stepBudgetExceeded) executionReasons.push('step_budget_exceeded');
  if (thrown) executionReasons.push(`thrown:${thrown.code || thrown.name}`);
  if (engineSuccess !== true) executionReasons.push('engine_not_successful');
  const executionOk = executionReasons.length === 0;
  // Verifier truth and task success are deliberately separate. A DOM match obtained
  // after a timeout, navigation failure, step/request budget stop, or an engine error
  // is still recorded as verifierOk, but it is not a task PASS.
  const taskPassed = verifierOk && executionOk;
  const falseSuccess = engineSuccess === true && !verifierOk;
  const stopReason = timedOut
    ? 'wall_clock_budget'
    : requestBudgetExceeded
      ? 'logical_ask_budget'
      : thrown
        ? `thrown:${thrown.code || thrown.name}`
        : result?.reason ?? (navigationError ? 'navigation_failed' : null);
  const { usage, usageSource, usageReasons } = trialUsage(asks);

  return {
    trialId,
    host: ctx.host,
    taskId: task.id,
    round: ctx.round,
    status: taskPassed ? 'VERIFIED' : 'FAILED',
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    budget: { ...task.budget },
    expected: { ...task.expected },
    engine: {
      success: engineSuccess,
      reason: result?.reason ?? null,
      steps: result?.steps ?? null,
      thrown: thrown ? { code: thrown.code ?? null, message: String(thrown.message || thrown) } : null,
      timedOut,
      unsettled,
      settled: engineSettled,
      requestBudgetExceeded,
      stepBudgetExceeded,
      navigationError,
    },
    verifier: {
      ok: verifierOk,
      detail: verification?.detail ?? null,
      observed: verification?.observed ?? null,
    },
    verifierOk,
    taskPassed,
    unsettled,
    execution: { ok: executionOk, reasons: executionReasons },
    falseSuccess,
    metrics: {
      latencyMs: finished - started,
      navigationMs,
      engineLatencyMs,
      verifyMs,
      logicalAskCalls,
      // Backend fallback can turn one logical ask into two HTTP attempts, so this is
      // reported separately from logicalAskCalls instead of being conflated with it.
      httpRequests: httpUnmeasuredReason ? null : httpRequests,
      httpUnmeasuredReason,
      httpAttempts: httpAttempts.slice(),
      decisionRequests: logicalAskCalls,
      dispatches: inst.dispatches.length,
      latePageCalls: gate.lateCalls,
      lateDispatchAttempts: gate.lateDispatchAttempts,
      stepBudgetExceeded,
      settlement: engineSettled ? 'settled' : 'unsettled',
      phases: result?.phases ?? null,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      usageSource,
      usageReasons,
      modelErrors: modelErrors.length,
    },
    model: {
      requested: 'jev-latest',
      serverModels: [...serverModels],
      serverEndpoints: [...serverEndpoints],
      usage: { ...usage },
      usageSource,
      usageReasons,
      errors: modelErrors.slice(),
    },
    stopReason,
    history: compactHistory(result?.history),
    engineLog: logLines,
  };
}

export function notRunTrial(task, ctx, reason) {
  const usageInfo = unknownUsage('trial not run; token measurement not applicable', 'not-run');
  return {
    trialId: `${ctx.host}/${task.id}/r${ctx.round}`,
    host: ctx.host,
    taskId: task.id,
    round: ctx.round,
    status: 'NOT_RUN',
    startedAt: null,
    finishedAt: null,
    budget: { ...task.budget },
    engine: { success: null, reason: null, steps: null, thrown: null, timedOut: false, unsettled: false, requestBudgetExceeded: false, stepBudgetExceeded: false, navigationError: null },
    verifier: { ok: null, detail: null, observed: null },
    verifierOk: null,
    taskPassed: false,
    execution: { ok: false, reasons: ['not_run'] },
    falseSuccess: false,
    reason,
    metrics: emptyMetrics(usageInfo),
    model: { serverModels: [], serverEndpoints: [], ...usageInfo },
    history: [],
  };
}

/** Sequentially run the planned trials for one host; never retries a failed trial. */
export async function runHostTrials({ host, page, engine, plan, onTrial }) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const trials = [];
  const notRun = [];
  let halted = false;
  for (const item of plan) {
    const task = getTask(item.taskId);
    if (!task) throw new Error(`unknown task in plan: ${item.taskId}`);
    if (halted) {
      notRun.push(notRunTrial(task, { host, round: item.round }, 'previous trial engine did not settle; next trial not started'));
      continue;
    }
    let trial;
    try {
      trial = await runTrial(page, task, { host, round: item.round, engine });
    } catch (err) {
      trial = failedTrial(task, { host, round: item.round }, err);
    }
    trials.push(trial);
    if (onTrial) onTrial(trial);
    // A timed-out engine that is still running must not overlap the next trial: its
    // ask/fetch wrapper and page gate are still live. Remaining trials are notRun.
    if (trial.unsettled || trial.engine?.unsettled) halted = true;
  }
  return { host, startedAt, finishedAt: new Date().toISOString(), totalMs: Date.now() - started, trials, notRun };
}

function groupByHostTask(trials) {
  const groups = new Map();
  for (const trial of trials) {
    const key = `${trial.host}/${trial.taskId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trial);
  }
  return groups;
}

export function summarizeLive(trials = [], meta = {}) {
  const hosts = meta.hosts ?? [];
  const notRun = meta.notRun ?? hosts.flatMap((host) => host.notRun ?? []);
  const expectedTrials = typeof meta.expectedTrials === 'number' ? meta.expectedTrials : trials.length + notRun.length;
  // PASS requires the independent verifier AND a bounded, successfully completed engine
  // run. verifierOk is kept separately so a late DOM match after a budget stop is visible.
  const verified = trials.filter((trial) => trial.taskPassed === true);
  const verifierOk = trials.filter((trial) => trial.verifier?.ok === true);
  const failed = trials.filter((trial) => trial.taskPassed !== true);
  const falseSuccesses = trials.filter((trial) => trial.falseSuccess === true);
  const engineSuccess = trials.filter((trial) => trial.engine?.success === true);
  const skippedHosts = hosts.filter((host) => host.status === 'skipped');
  const harnessFailures = hosts.filter((host) => host.status === 'failed');
  const cleanupFailures = hosts
    .filter((host) => host.cleanup && host.cleanup.ok === false)
    .map((host) => ({ host: host.host, cleanup: host.cleanup }));

  const byHostTask = [];
  for (const [key, rows] of groupByHostTask(trials)) {
    const [host, taskId] = key.split('/');
    const usage = summarizeTokens(rows);
    byHostTask.push({
      host,
      taskId,
      rounds: rows.length,
      verified: rows.filter((row) => row.taskPassed === true).length,
      verifierOk: rows.filter((row) => row.verifier?.ok === true).length,
      engineSuccess: rows.filter((row) => row.engine?.success === true).length,
      falseSuccess: rows.filter((row) => row.falseSuccess === true).length,
      medianEngineLatencyMs: median(rows.map((row) => row.metrics?.engineLatencyMs)),
      medianTotalMs: median(rows.map((row) => row.metrics?.latencyMs)),
      logicalAskCalls: rows.reduce((sum, row) => sum + (row.metrics?.logicalAskCalls || 0), 0),
      httpRequests: rows.every((row) => typeof row.metrics?.httpRequests === 'number')
        ? rows.reduce((sum, row) => sum + row.metrics.httpRequests, 0)
        : null,
      ...usage,
    });
  }

  const failureConsumption = {
    trials: failed.length,
    engineLatencyMs: failed.reduce((sum, row) => sum + (row.metrics?.engineLatencyMs || 0), 0),
    totalLatencyMs: failed.reduce((sum, row) => sum + (row.metrics?.latencyMs || 0), 0),
    logicalAskCalls: failed.reduce((sum, row) => sum + (row.metrics?.logicalAskCalls || 0), 0),
    httpRequests: failed.every((row) => typeof row.metrics?.httpRequests === 'number')
      ? failed.reduce((sum, row) => sum + row.metrics.httpRequests, 0)
      : null,
    ...summarizeTokens(failed),
    costUsd: null,
    costUsdReason: 'no pricing asserted; usage is recorded but not converted to dollars',
  };

  return {
    expectedTrials,
    total: trials.length,
    notRun: notRun.length,
    notRunIds: notRun.map((trial) => trial.trialId),
    complete: notRun.length === 0 && trials.length + notRun.length === expectedTrials && skippedHosts.length === 0,
    verified: verified.length,
    verifierOk: verifierOk.length,
    failedTrials: failed.length,
    verifiedRate: trials.length ? verified.length / trials.length : null,
    verifierOkRate: trials.length ? verifierOk.length / trials.length : null,
    engineSuccessRate: trials.length ? engineSuccess.length / trials.length : null,
    falseSuccess: falseSuccesses.length,
    falseSuccessRate: trials.length ? falseSuccesses.length / trials.length : null,
    falseSuccessTrials: falseSuccesses.map((row) => row.trialId),
    failedTrialIds: failed.map((row) => row.trialId),
    byHostTask,
    failureConsumption,
    cleanupFailures,
    harnessFailures: harnessFailures.map((host) => ({ host: host.host, reason: host.reason ?? null })),
    skippedHosts: skippedHosts.map((host) => ({ host: host.host, reason: host.reason ?? null })),
    order: meta.order ?? [],
    unknownMetrics: {
      costUsd: 'null: no pricing asserted',
      humanTakeover: 'null: not instrumented in this batch',
      tokens: summarizeTokens(trials).usageReasons,
      httpRequests: trials.every((row) => typeof row.metrics?.httpRequests === 'number')
        ? null
        : 'null where the host runtime exposed no global fetch',
    },
  };
}
