// Offline policy tests for the live benchmark harness.
//
// These do not call Jev, open a browser or touch the network. They test the harness
// contract only: false-success rejection, independent URL+DOM verification, logical ask
// vs HTTP accounting, request/wall-clock budgets, gate behavior, SKIP vs real FAIL,
// cleanup-failure reporting, failure consumption and sanitization.

import assert from 'node:assert/strict';
import { getTask } from './live-benchmark/tasks.mjs';
import { runTrial, runHostTrials, summarizeLive } from './live-benchmark/suite.mjs';
import { parseArgs, preflightHosts, runLiveBenchmark, exitCodeFor, sanitizeText } from './live-benchmark/run.mjs';

const HN_URL = 'https://news.ycombinator.com/newcomments';
const WIKI_URL = 'https://en.wikipedia.org/wiki/Jev';

function fakePage({ url = HN_URL, dom = {}, gotoThrows = false } = {}) {
  const calls = { cdp: 0 };
  return {
    calls,
    async goto() { if (gotoThrows) throw new Error('navigation fixture failure'); },
    async waitForLoadState() {},
    async url() { return url; },
    async title() { return 'fixture'; },
    async evaluate() { return dom; },
    async cdp() { calls.cdp += 1; return {}; },
    async click() {},
    async fill() {},
  };
}

function fakeEngine({ result = { success: true, reason: 'check_passed', steps: 1, history: [], phases: { observeMs: 1, decideMs: 1, executeMs: 1, verifyMs: 1 }, serverModels: ['fake-jev'], usage: { input_tokens: 2, output_tokens: 1 } }, askJev = async () => ({}) } = {}) {
  return {
    askJev,
    async runJevAutonomousLoop() { return result; },
  };
}

const hnOkDom = {
  origin: 'https://news.ycombinator.com',
  pathname: '/newcomments',
  hnMain: true,
  commentTree: true,
  commentRows: 20,
  itemLinks: 20,
  title: 'New Comments',
};
const hnEmptyDom = { ...hnOkDom, hnMain: true, commentTree: false, commentRows: 0, itemLinks: 0 };

// 1) False success: engine says success, independent DOM verifier rejects it.
{
  const task = getTask('hn-navigation');
  const trial = await runTrial(fakePage({ url: HN_URL, dom: hnEmptyDom }), task, {
    host: 'policy', round: 1, engine: fakeEngine(),
  });
  assert.equal(trial.engine.success, true);
  assert.equal(trial.verifier.ok, false);
  assert.equal(trial.falseSuccess, true);
  assert.equal(trial.status, 'FAILED');
  assert.equal(trial.metrics.logicalAskCalls, 0);
}

// 2) URL-only match is not enough for either site.
{
  const task = getTask('wiki-search');
  const trial = await runTrial(fakePage({
    url: WIKI_URL,
    dom: { origin: 'https://en.wikipedia.org', pathname: '/wiki/Jev', heading: 'Jev', content: true, paragraphCount: 0, longParagraphs: 0 },
  }), task, { host: 'policy', round: 1, engine: fakeEngine() });
  assert.equal(trial.verifier.ok, false);
  assert.equal(trial.falseSuccess, true);
}

// 3) Independent verifier can confirm the final DOM even if the engine reports failure,
// but task success also requires a successful engine and a bounded execution.
{
  const task = getTask('hn-navigation');
  const trial = await runTrial(fakePage({ url: HN_URL, dom: hnOkDom }), task, {
    host: 'policy', round: 1, engine: fakeEngine({ result: { success: false, reason: 'max_steps_reached', steps: 5, history: [] } }),
  });
  assert.equal(trial.engine.success, false);
  assert.equal(trial.verifier.ok, true);
  assert.equal(trial.verifierOk, true);
  assert.equal(trial.taskPassed, false);
  assert.equal(trial.falseSuccess, false);
  assert.equal(trial.status, 'FAILED');
  assert.equal(trial.stopReason, 'max_steps_reached');
  assert.ok(trial.execution.reasons.includes('engine_not_successful'));
}

// 4) Logical ask budget stops a broken engine that ignores maxSteps. The budget is
// explicitly logical asks; an injected fetch shows HTTP attempts are counted separately.
{
  const task = { ...getTask('hn-navigation'), budget: { steps: 5, timeMs: 5000, decisionRequests: 1 } };
  let globalFetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    globalFetchCalls += 1;
    return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) };
  };
  const wrappedFetch = globalThis.fetch;
  try {
    const engine = {
      async askJev() {
        await fetch('https://api.typesafe.ai/systemone');
        return {};
      },
      async runJevAutonomousLoop(_page, _goal, options) {
        for (let i = 0; i < 5; i++) await options.ask('', {});
        return { success: false, reason: 'should-not-get-here', steps: 5, history: [] };
      },
    };
    const trial = await runTrial(fakePage({ url: HN_URL, dom: hnOkDom }), task, { host: 'policy', round: 1, engine });
    assert.equal(trial.engine.requestBudgetExceeded, true);
    assert.equal(trial.metrics.logicalAskCalls, 1);
    assert.equal(trial.metrics.httpRequests, 1);
    assert.equal(globalFetchCalls, 1);
    assert.equal(trial.stopReason, 'logical_ask_budget');
    assert.equal(trial.taskPassed, false);
    assert.equal(trial.verifierOk, true);
    assert.equal(trial.status, 'FAILED');
    assert.equal(globalThis.fetch, wrappedFetch);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(globalThis.fetch, originalFetch);
}

// 5) Wall-clock timeout closes both gates: a late engine CDP action and a late logical
// ask are rejected before reaching the host/model, and a DOM match after the timeout is
// verifierOk but not a task PASS.
{
  const task = { ...getTask('hn-navigation'), budget: { steps: 5, timeMs: 50, decisionRequests: 5, settleGraceMs: 1000 } };
  const page = fakePage({ url: HN_URL, dom: hnOkDom });
  let askError = null;
  const engine = {
    async askJev() { return {}; },
    async runJevAutonomousLoop(enginePage, _goal, options) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      try { await options.ask('', {}); } catch (err) { askError = err.code; }
      await enginePage.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased' });
      return { success: true, reason: 'late', steps: 1, history: [] };
    },
  };
  const trial = await runTrial(page, task, { host: 'policy', round: 1, engine });
  assert.equal(trial.engine.timedOut, true);
  assert.equal(trial.stopReason, 'wall_clock_budget');
  assert.equal(trial.metrics.dispatches, 0);
  assert.equal(trial.metrics.lateDispatchAttempts, 1);
  assert.equal(askError, 'EGO_LIVE_HALTED');
  assert.equal(page.calls.cdp, 0);
  assert.equal(trial.verifierOk, true);
  assert.equal(trial.taskPassed, false);
  assert.equal(trial.status, 'FAILED');
}

// 5b) Step-budget overflow is a task failure even when the final DOM matches.
{
  const task = getTask('hn-navigation');
  const engine = fakeEngine({ result: { success: true, reason: 'jev_done', steps: 9, history: [] } });
  const trial = await runTrial(fakePage({ url: HN_URL, dom: hnOkDom }), task, { host: 'policy', round: 1, engine });
  assert.equal(trial.verifierOk, true);
  assert.equal(trial.engine.stepBudgetExceeded, true);
  assert.equal(trial.taskPassed, false);
  assert.ok(trial.execution.reasons.includes('step_budget_exceeded'));
}

// 5c) Navigation failure cannot become task success just because the current DOM matches.
{
  const task = getTask('hn-navigation');
  const trial = await runTrial(fakePage({ url: HN_URL, dom: hnOkDom, gotoThrows: true }), task, {
    host: 'policy', round: 1, engine: fakeEngine(),
  });
  assert.ok(trial.engine.navigationError);
  assert.equal(trial.verifierOk, true);
  assert.equal(trial.taskPassed, false);
  assert.ok(trial.execution.reasons.includes('navigation_failed'));
}

// 5d) An engine that never settles after timeout blocks the next trial and is recorded
// as NOT_RUN, not silently skipped or overlapping.
{
  const task = { ...getTask('hn-navigation'), budget: { steps: 5, timeMs: 50, decisionRequests: 5, settleGraceMs: 100 } };
  const page = fakePage({ url: HN_URL, dom: hnOkDom });
  const engine = {
    async askJev() { return {}; },
    async runJevAutonomousLoop() { return new Promise(() => {}); },
  };
  const plan = [{ taskId: 'hn-navigation', round: 1 }, { taskId: 'hn-navigation', round: 2 }];
  const run = await runHostTrials({ host: 'policy', page, engine, plan });
  assert.equal(run.trials.length, 1);
  assert.equal(run.trials[0].unsettled, true);
  assert.equal(run.notRun.length, 1);
  assert.equal(run.notRun[0].status, 'NOT_RUN');
  assert.equal(run.notRun[0].reason.includes('did not settle'), true);
  const summary = summarizeLive(run.trials, {
    hosts: [{ host: 'policy', status: 'completed', cleanup: { ok: true }, notRun: run.notRun }],
    expectedTrials: 2,
  });
  assert.equal(summary.notRun, 1);
  assert.equal(summary.complete, false);
  assert.equal(summary.verified, 0);
}

// 6) Summary: false successes, median latency, failure consumption and cleanup failures.
{
  const base = {
    host: 'cdp', taskId: 'hn-navigation', verifier: { ok: true }, verifierOk: true, taskPassed: true,
    engine: { success: true }, falseSuccess: false,
    metrics: { engineLatencyMs: 100, latencyMs: 120, logicalAskCalls: 1, httpRequests: 1, inputTokens: 10, outputTokens: 2 },
  };
  const failed = {
    ...base, trialId: 'cdp/wiki-search/r1', taskId: 'wiki-search',
    verifier: { ok: false }, verifierOk: false, taskPassed: false, engine: { success: true }, falseSuccess: true,
    metrics: { engineLatencyMs: 300, latencyMs: 340, logicalAskCalls: 2, httpRequests: 3, inputTokens: 20, outputTokens: 4 },
  };
  const summary = summarizeLive([{ ...base, trialId: 'cdp/hn-navigation/r1' }, failed], {
    hosts: [{ host: 'cdp', status: 'completed', cleanup: { ok: false, errors: ['target close not confirmed'] } }],
    expectedTrials: 2,
    order: ['cdp/hn-navigation/r1', 'cdp/wiki-search/r1'],
  });
  assert.equal(summary.total, 2);
  assert.equal(summary.verified, 1);
  assert.equal(summary.failedTrials, 1);
  assert.equal(summary.falseSuccess, 1);
  assert.equal(summary.cleanupFailures.length, 1);
  assert.equal(summary.complete, true);
  assert.equal(summary.byHostTask.length, 2);
  assert.equal(summary.failureConsumption.logicalAskCalls, 2);
  assert.equal(summary.failureConsumption.inputTokens, 20);
  assert.equal(summary.failureConsumption.costUsd, null);
}

// 7) Preflight distinguishes missing environment (SKIP) from a launch/run failure.
{
  const missing = preflightHosts({ hosts: ['cdp', 'ego'], credentialOk: false });
  assert.deepEqual(missing.map((item) => item.status), ['skipped', 'skipped']);
  assert.ok(missing.every((item) => item.reason.includes('credentials')));

  const noBrowser = preflightHosts({ hosts: ['cdp', 'ego'], credentialOk: true, chromeAvailable: false, egoAvailable: false });
  assert.deepEqual(noBrowser.map((item) => item.status), ['skipped', 'skipped']);

  const external = preflightHosts({ hosts: ['cdp'], credentialOk: true, chromeAvailable: false, endpoint: 'http://127.0.0.1:9222' });
  assert.equal(external[0].status, 'ready');

  const ready = preflightHosts({ hosts: ['cdp', 'ego'], credentialOk: true, chromeAvailable: true, egoAvailable: true });
  assert.ok(ready.every((item) => item.status === 'ready'));
}

// 8) Orchestration: skipped host => incomplete/2; ready but broken launch => failed/1.
{
  const args = parseArgs(['--live', '--hosts', 'cdp', '--tasks', 'hn-navigation', '--rounds', '1']);
  const skippedEnv = { credentialOk: false, egoAvailable: false, chromeAvailable: true, chromePath: '/fake', egoVersion: null, endpoint: null };
  const skipped = await runLiveBenchmark(args, {
    resolveEnv: async () => skippedEnv,
    gitHead: 'test',
    runnerInfo: { node: 'test' },
  });
  assert.equal(skipped.status, 'incomplete');
  assert.equal(skipped.summary.total, 0);
  assert.equal(exitCodeFor(skipped), 2);

  const readyEnv = { ...skippedEnv, credentialOk: true };
  const failed = await runLiveBenchmark(args, {
    resolveEnv: async () => readyEnv,
    runHost: async () => ({ status: 'failed', reason: 'launch failed', cleanup: { ok: false, errors: ['launch failed'] }, trials: [] }),
    gitHead: 'test',
    runnerInfo: { node: 'test' },
  });
  assert.equal(failed.status, 'failed');
  assert.equal(exitCodeFor(failed), 1);
  assert.equal(failed.summary.cleanupFailures.length, 1);
}

// 9) A complete, verified synthetic host reports passed/0 and never emits the raw key.
{
  const args = parseArgs(['--live', '--hosts', 'cdp', '--tasks', 'hn-navigation', '--rounds', '1']);
  const env = { credentialOk: true, egoAvailable: false, chromeAvailable: true, chromePath: '/fake', egoVersion: null, endpoint: null };
  const trial = {
    trialId: 'cdp/hn-navigation/r1', host: 'cdp', taskId: 'hn-navigation', round: 1, status: 'VERIFIED',
    engine: { success: true, reason: 'check_passed', steps: 1, thrown: null, timedOut: false, requestBudgetExceeded: false },
    verifier: { ok: true, detail: 'fixture', observed: {} }, verifierOk: true, taskPassed: true, falseSuccess: false,
    metrics: { latencyMs: 10, engineLatencyMs: 8, logicalAskCalls: 1, httpRequests: 1, inputTokens: 1, outputTokens: 1, dispatches: 1, latePageCalls: 0, lateDispatchAttempts: 0, phases: {} },
    model: { serverModels: ['fake'], usage: { input_tokens: 1, output_tokens: 1 } },
  };
  const passed = await runLiveBenchmark(args, {
    resolveEnv: async () => env,
    runHost: async () => ({ status: 'completed', cleanup: { ok: true, targetClosed: true }, trials: [trial] }),
    gitHead: 'test',
    runnerInfo: { node: 'test' },
  });
  assert.equal(passed.status, 'passed');
  assert.equal(exitCodeFor(passed), 0);
  const text = sanitizeText(`Authorization: Bearer secret-token TYPESAFE_API_KEY=secret-value ${process.cwd()}`);
  assert.ok(!text.includes('secret-token'));
  assert.ok(!text.includes('secret-value'));
  assert.ok(text.includes('<repo>'));
}

assert.throws(() => parseArgs(['--hosts', 'invalid']));
assert.throws(() => parseArgs(['--rounds', '0']));
assert.throws(() => parseArgs(['--unknown']));
assert.equal(parseArgs([]).live, false);
assert.equal(parseArgs(['--live', '--rounds', '3']).rounds, 3);

console.log('PASS: live benchmark policy (false success, URL+DOM verifiers, logical ask vs HTTP, budgets, gate, failure consumption, SKIP vs FAIL, cleanup, sanitization)');
