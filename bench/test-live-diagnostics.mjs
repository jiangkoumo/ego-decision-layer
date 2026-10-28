// Offline behavioral coverage; no credentials, model, browser or network needed.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createDiagnostics, DIAGNOSTIC_LIMITS, measureBrowserCall } from './live-benchmark/diagnostics.mjs';
import { analyzeReport, distribution } from './live-benchmark/analyze.mjs';
import { runTrial, runHostTrials, summarizeLive } from './live-benchmark/suite.mjs';
import { parseArgs, runLiveBenchmark, resolveTaskSet } from './live-benchmark/run.mjs';
import { getTask } from './live-benchmark/tasks.mjs';
import * as taskModule from './live-benchmark/tasks.mjs';
import { VERIFIERS } from './live-benchmark/verifiers.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secret = 'private-password-token';
const questions = Object.freeze({
  operation: Object.freeze({ criteria: Object.freeze({ click: secret, done: secret }) }),
  click_target: Object.freeze({ criteria: Object.freeze({ none: secret, 'ref=2': secret }) }),
  input_text: Object.freeze({ criteria: Object.freeze({ t0: secret }) }),
  // Unknown heads and arbitrary text must not be serialized or traversed.
  authorization: { get criteria() { throw new Error('must not inspect extra heads'); } },
});
const answers = Object.freeze({
  operation: Object.freeze({ choice: 'click' }),
  click_target: Object.freeze({ choice: 'ref=2' }),
  input_text: Object.freeze({ choice: 't0' }),
  body: secret, headers: { Authorization: secret },
});
const sensitiveState = `goal ${secret}\nhttps://user:password@example.test/search?q=${secret}#${secret}\nbody ${secret}`;

// 1) Bounded capacity and metadata-only redaction, even for large input or keys.
{
  const recorder = createDiagnostics();
  const largeCriteria = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`ref=${i}`, secret]));
  largeCriteria[secret] = secret;
  const state = sensitiveState + 'x'.repeat(DIAGNOSTIC_LIMITS.stateScanChars);
  for (let i = 0; i < DIAGNOSTIC_LIMITS.asks + 3; i++) {
    const token = recorder.beginAsk(state, { ...questions, click_target: { criteria: largeCriteria } });
    recorder.endAsk(token, { ...answers, click_target: { choice: 'ref=99' } }, 'fulfilled');
  }
  for (let i = 0; i < DIAGNOSTIC_LIMITS.browserCalls + 2; i++) {
    const token = recorder.beginBrowser('cdp.Input.insertText', 'engine');
    recorder.endBrowser(token, 'fulfilled');
  }
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.asks.length, DIAGNOSTIC_LIMITS.asks);
  assert.equal(snapshot.browserCalls.length, DIAGNOSTIC_LIMITS.browserCalls);
  assert.deepEqual(snapshot.dropped, { asks: 3, browserCalls: 2 });
  assert.equal(snapshot.asks[0].input.stateChars, state.length);
  assert.equal(snapshot.asks[0].input.scannedChars, DIAGNOSTIC_LIMITS.stateScanChars);
  assert.equal(snapshot.asks[0].input.truncated, true);
  const head = snapshot.asks[0].heads.find((entry) => entry.head === 'click_target');
  assert.equal(head.candidates.length, DIAGNOSTIC_LIMITS.candidates);
  assert.equal(head.truncated, true);
  assert.equal(head.selected, 'ref=99');
  assert.equal(head.selectedInCandidates, null, 'not sampled is unknown, not an invalid model choice');
  assert.equal(snapshot.timing.settleMs, null);
  assert.match(snapshot.timing.note, /overlap/);
  const text = JSON.stringify(snapshot);
  for (const forbidden of [secret, 'https:', 'password', 'headers', 'Authorization', 'goal', 'body']) assert.ok(!text.includes(forbidden), forbidden);
  assert.ok(text.length < 150000, 'bounded serialized evidence');

  const redact = createDiagnostics();
  const token = redact.beginAsk('', { click_target: { criteria: { [secret]: secret } } });
  redact.endAsk(token, { click_target: { choice: secret } }, 'fulfilled');
  assert.ok(!JSON.stringify(redact.snapshot()).includes(secret));
}

// 2) Failed diagnostic accessors are contained; no input or answer mutation.
{
  const recorder = createDiagnostics();
  const broken = { get operation() { throw new Error(secret); } };
  assert.equal(recorder.beginAsk(sensitiveState, broken), null);
  assert.equal(recorder.snapshot().errors, 1);
  const token = recorder.beginAsk(sensitiveState, questions);
  recorder.endAsk(token, answers, 'fulfilled');
  assert.equal(recorder.snapshot().asks[0].heads[0].selected, 'click');
  assert.equal(answers.click_target.choice, 'ref=2');
  const pending = recorder.beginAsk('', questions);
  const atReport = recorder.snapshot();
  assert.equal(atReport.asks[1].status, 'inflight');
  assert.equal(atReport.asks[1].durationMs, null);
  recorder.endAsk(pending, answers, 'fulfilled');
  assert.equal(atReport.asks[1].status, 'inflight', 'saved report does not track late results');
}

// 3) Instrumentation failure cannot alter host calls, return identity or errors.
{
  let calls = 0;
  const result = {};
  const error = new Error('real host failure');
  const broken = { beginBrowser() { throw new Error('diagnostic failure'); }, endBrowser() { throw new Error('diagnostic failure'); } };
  assert.equal(await measureBrowserCall(broken, 'page.evaluate', 'engine', () => { calls++; return result; }), result);
  await assert.rejects(measureBrowserCall(broken, 'page.cdp', 'engine', () => { calls++; throw error; }), (caught) => caught === error);
  assert.equal(calls, 2);
}

function fixturePage(calls, cdp = async () => ({})) {
  return {
    async goto(...args) { calls.push(['goto', args]); },
    async waitForLoadState(...args) { calls.push(['waitForLoadState', args]); },
    async evaluate(...args) { calls.push(['evaluate', args]); return { marker: true }; },
    async cdp(...args) { calls.push(['cdp', args]); return cdp(...args); },
    keyboard: { async press(...args) { calls.push(['keyboard.press', args]); } },
  };
}

// 4) Full harness transparency: original state/questions, selection and one real
// ask; exactly the requested page/CDP calls, plus the existing nav/verifier calls.
{
  const calls = [];
  const page = fixturePage(calls);
  let verifierTask;
  let asks = 0;
  const task = {
    ...getTask('hn-navigation'), verifier: 'diagnosticFixture', taskSetVersion: 'fixture-v2',
    goal: 'fixture selected-manifest goal',
    expected: { ...getTask('hn-navigation').expected, search: '', heading: 'fixture', domKind: 'fixture' },
  };
  const payload = { text: secret };
  const evalFn = () => ({ marker: true });
  VERIFIERS.diagnosticFixture = async (p, receivedTask) => {
    verifierTask = receivedTask;
    assert.equal(receivedTask.taskSetVersion, 'fixture-v2');
    assert.deepEqual(receivedTask.expected, task.expected);
    assert.deepEqual(await p.evaluate(evalFn), { marker: true });
    return { ok: true };
  };
  try {
    const engine = {
      async askJev(state, receivedQuestions, options) {
        asks++;
        assert.equal(state, sensitiveState);
        assert.equal(receivedQuestions, questions);
        options.receipt.usage = { input_tokens: 1, output_tokens: 0 };
        return answers;
      },
      async runJevAutonomousLoop(p, goal, options) {
        assert.equal(goal, task.goal);
        assert.equal(options.maxSteps, task.budget.steps);
        assert.equal(options.cache, false);
        const selected = await options.ask(sensitiveState, questions);
        assert.equal(selected, answers);
        await p.evaluate(evalFn);
        await p.cdp('Input.insertText', payload);
        await p.keyboard.press('Enter');
        return { success: true, reason: 'check_passed', steps: 1, history: [] };
      },
    };
    // An ID shared by manifests must use the selected definition, including the
    // verifier and goal, rather than re-resolving the default task by ID.
    const run = await runHostTrials({ host: 'fixture', page, engine, plan: [{ taskId: task.id, task, round: 1 }] });
    const trial = run.trials[0];
    assert.equal(verifierTask, task, 'verifier(page, task) passes the original task');
    assert.equal(asks, 1);
    assert.deepEqual(calls.map(([method]) => method), ['goto', 'waitForLoadState', 'evaluate', 'cdp', 'keyboard.press', 'evaluate']);
    assert.equal(calls[3][1][1], payload);
    assert.equal(calls[2][1][0], evalFn);
    assert.equal(trial.taskPassed, true);
    assert.equal(trial.metrics.logicalAskCalls, 1);
    assert.equal(trial.metrics.dispatches, 2);
    assert.equal(trial.diagnostics.asks.length, 1);
    assert.equal(trial.diagnostics.asks[0].status, 'fulfilled');
    assert.deepEqual(trial.diagnostics.browserCalls.map((row) => row.scope), ['navigation', 'navigation', 'engine', 'engine', 'engine', 'verifier']);
    assert.ok(trial.diagnostics.browserCalls.every((row) => row.durationMs >= 0));
    assert.ok(!JSON.stringify(trial.diagnostics).includes(secret));
    const raw = { trials: [trial] };
    const summary = summarizeLive(raw.trials);
    const analysis = analyzeReport(raw);
    for (const [key, value] of Object.entries(analysis.outcomes)) assert.equal(value, summary[key]);
    assert.equal(analysis.timing.diagnostics.modelAsk.count, 1);
    assert.equal(analysis.timing.diagnostics.browserCall.count, 6);
  } finally { delete VERIFIERS.diagnosticFixture; }
}

// 5) Backend/host exceptions retain their original behavior and are timed without
// retaining their potentially sensitive error messages.
{
  VERIFIERS.diagnosticFixture = async () => ({ ok: false });
  try {
    const task = { ...getTask('hn-navigation'), verifier: 'diagnosticFixture' };
    const error = new Error(secret);
    const trial = await runTrial(fixturePage([], async () => { throw error; }), task, { host: 'fixture', round: 1, engine: {
      async askJev() { throw error; },
      async runJevAutonomousLoop(p, _goal, options) {
        await assert.rejects(p.cdp('Input.insertText', { text: secret }), (caught) => caught === error);
        await options.ask(sensitiveState, questions);
      },
    } });
    assert.equal(trial.taskPassed, false);
    assert.equal(trial.diagnostics.asks[0].status, 'rejected');
    assert.equal(trial.diagnostics.browserCalls.at(-1).status, 'rejected');
    assert.ok(!JSON.stringify(trial.diagnostics).includes(secret));
    assert.ok(analyzeReport({ trials: [trial] }).failureModes.some((row) => row.mode === 'exception'));
  } finally { delete VERIFIERS.diagnosticFixture; }
}

// 6) Both model and host can remain in flight at a timeout. Their final durations
// stay unknown, and releasing them later cannot mutate the captured trial.
{
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const originalFetch = globalThis.fetch;
  const task = { ...getTask('hn-navigation'), verifier: 'diagnosticFixture', budget: { steps: 5, timeMs: 25, decisionRequests: 5, settleGraceMs: 5 } };
  VERIFIERS.diagnosticFixture = async () => ({ ok: true });
  try {
    const trial = await runTrial(fixturePage([], () => pending), task, { host: 'fixture', round: 1, engine: {
      async askJev() { await pending; return answers; },
      async runJevAutonomousLoop(p, _goal, options) {
        await Promise.all([options.ask(sensitiveState, questions), p.cdp('Input.insertText', { text: secret })]);
        return { success: true };
      },
    } });
    assert.equal(trial.engine.timedOut, true);
    assert.equal(trial.engine.unsettled, true);
    assert.equal(trial.taskPassed, false);
    assert.equal(trial.diagnostics.asks[0].status, 'inflight');
    assert.equal(trial.diagnostics.asks[0].durationMs, null);
    assert.equal(trial.diagnostics.browserCalls.at(-1).status, 'inflight');
    const saved = JSON.stringify(trial.diagnostics);
    const timing = analyzeReport({ trials: [trial] }).timing.diagnostics;
    assert.equal(timing.inflightAsks, 1);
    assert.equal(timing.inflightBrowserCalls, 1);
    assert.equal(timing.modelAsk.count, 0);
    assert.equal(timing.modelAsk.unknown, 1);
    assert.equal(timing.settleMs, null);
    release();
    await sleep(0);
    assert.equal(JSON.stringify(trial.diagnostics), saved);
  } finally {
    release();
    await sleep(0);
    delete VERIFIERS.diagnosticFixture;
  }
  assert.equal(globalThis.fetch, originalFetch);
}

// 7) Preserved legacy raw stays byte-identical, summary accounting is unchanged,
// and missing diagnostic timing remains explicitly unknown rather than zero.
{
  const source = new URL('./live-benchmark/raw/live-2026-10-26T08-52-43-090Z.json', import.meta.url);
  const before = await readFile(source);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const raw = JSON.parse(before);
  const frozen = JSON.stringify(raw);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('offline analysis must never use network'); };
  let analysis;
  try { analysis = analyzeReport(raw); } finally { globalThis.fetch = originalFetch; }
  assert.equal(JSON.stringify(raw), frozen);
  assert.equal(analysis.outcomes.total, 12);
  assert.equal(analysis.outcomes.verified, 10);
  for (const [key, value] of Object.entries(analysis.outcomes)) assert.equal(value, raw.summary[key]);
  assert.equal(analysis.timing.diagnostics.availableTrials, 0);
  assert.equal(analysis.timing.diagnostics.unknownTrials, 12);
  assert.equal(analysis.timing.diagnostics.modelAsk.medianMs, null);
  assert.equal(analysis.timing.diagnostics.browserCall.medianMs, null);
  const result = spawnSync(process.execPath, [new URL('./live-benchmark/analyze.mjs', import.meta.url).pathname, source.pathname], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), analysis);
  assert.equal(hash(await readFile(source)), hash(before));

  // CLI parameter validation and sensitive content containment on parse error
  const invalidFlag = spawnSync(process.execPath, [new URL('./live-benchmark/analyze.mjs', import.meta.url).pathname, '--unknown'], { encoding: 'utf8' });
  assert.equal(invalidFlag.status, 2);
  const brokenJson = spawnSync(process.execPath, [new URL('./live-benchmark/analyze.mjs', import.meta.url).pathname, '/dev/null'], { encoding: 'utf8' });
  assert.equal(brokenJson.status, 1);
  assert.ok(brokenJson.stderr.includes('FAIL: unable to read or analyze the supplied raw JSON.'));
  assert.ok(!brokenJson.stderr.includes('/dev/null'));
}

assert.deepEqual(distribution([null, 0, 2, 4, 6, NaN]), { count: 4, unknown: 2, minMs: 0, medianMs: 3, p95Ms: 6, maxMs: 6 });
assert.equal(analyzeReport({ trials: [] }).timing.total.medianMs, null);

// 8) The orchestrator transports exactly the task objects resolved for this run;
// ego stages the same JSON plan, so neither host reselects versioned task data.
{
  const args = parseArgs(['--live', '--hosts', 'cdp', '--tasks', 'hn-navigation', '--rounds', '1']);
  const set = resolveTaskSet(args.tasks);
  const report = await runLiveBenchmark(args, {
    resolveEnv: async () => ({ credentialOk: true, chromeAvailable: true }),
    gitHead: 'fixture', runnerInfo: {},
    runHost: async (_host, { plan }) => {
      assert.deepEqual(plan[0].task, set.tasks[0]);
      assert.equal(plan[0].taskId, set.tasks[0].id);
      assert.equal(plan[0].task.verifier, set.tasks[0].verifier);
      return { status: 'completed', cleanup: { ok: true }, trials: [], notRun: [] };
    },
  });
  assert.equal(report.suiteVersion, set.version);
}

// 8b) v2 manifest contract: when a v2 manifest is resolved, suiteVersion uses the v2 tag,
// neither host flattens tasks to IDs alone, and shared IDs (hn-navigation, wiki-search)
// retain strict v2 verifiers and expected definitions without falling back to v1 getTask(id).
{
  const v2Tasks = [
    {
      ...getTask('hn-navigation'),
      taskSetVersion: 'p2-live-v2',
      verifier: 'hackerNewsPage',
      expected: { origin: 'https://news.ycombinator.com', pathname: '/newcomments', search: '', heading: '', domKind: 'hackerNewsPage' },
    },
    {
      ...getTask('wiki-search'),
      taskSetVersion: 'p2-live-v2',
      verifier: 'wikipediaArticle',
      expected: { origin: 'https://en.wikipedia.org', pathname: '/wiki/Jev', search: '', heading: 'Jev', domKind: 'wikipediaArticle' },
    },
  ];
  const v2Manifest = { version: 'p2-live-v2', tasks: v2Tasks };
  const args = parseArgs(['--live', '--hosts', 'both', '--tasks', 'all', '--rounds', '1']);
  const executedHosts = [];
  const report = await runLiveBenchmark(args, {
    resolveTaskSet: () => v2Manifest,
    resolveEnv: async () => ({ credentialOk: true, chromeAvailable: true, egoAvailable: true }),
    gitHead: 'fixture',
    runnerInfo: {},
    runHost: async (host, { plan, taskVersion }) => {
      executedHosts.push(host);
      assert.equal(taskVersion, 'p2-live-v2');
      assert.equal(plan.length, 2);
      for (const [i, item] of plan.entries()) {
        assert.deepEqual(item.task, v2Tasks[i]);
        assert.equal(item.task.taskSetVersion, 'p2-live-v2');
        assert.notEqual(item.task.verifier, getTask(item.taskId).verifier, 'must not revert to v1 verifier');
        assert.deepEqual(item.task.expected, v2Tasks[i].expected);
      }
      return { status: 'completed', cleanup: { ok: true }, trials: [], notRun: [] };
    },
  });
  assert.equal(report.suiteVersion, 'p2-live-v2', 'report metadata uses the resolved v2 version');
  assert.deepEqual(executedHosts, ['cdp', 'ego']);

  // Also verify runHostTrials preserves the v2 task and passes it to verifier(page, task)
  const invokedVerifiers = [];
  VERIFIERS.hackerNewsPage = async (page, receivedTask) => {
    invokedVerifiers.push({ name: 'hackerNewsPage', task: receivedTask });
    return { ok: true };
  };
  VERIFIERS.wikipediaArticle = async (page, receivedTask) => {
    invokedVerifiers.push({ name: 'wikipediaArticle', task: receivedTask });
    return { ok: true };
  };
  try {
    const fakeEngine = {
      async askJev() { return { operation: { choice: 'done' } }; },
      async runJevAutonomousLoop() { return { success: true, steps: 1, history: [] }; },
    };
    const hostRun = await runHostTrials({
      host: 'fixture',
      page: fixturePage([]),
      engine: fakeEngine,
      plan: v2Tasks.map((task) => ({ taskId: task.id, task, round: 1 })),
    });
    assert.equal(hostRun.trials.length, 2);
    assert.equal(invokedVerifiers.length, 2);
    assert.equal(invokedVerifiers[0].name, 'hackerNewsPage');
    assert.equal(invokedVerifiers[0].task.taskSetVersion, 'p2-live-v2');
    assert.equal(invokedVerifiers[0].task.verifier, 'hackerNewsPage');
    assert.notEqual(invokedVerifiers[0].task.verifier, getTask('hn-navigation').verifier);
    assert.equal(invokedVerifiers[1].name, 'wikipediaArticle');
    assert.equal(invokedVerifiers[1].task.taskSetVersion, 'p2-live-v2');
    assert.equal(invokedVerifiers[1].task.verifier, 'wikipediaArticle');
    assert.notEqual(invokedVerifiers[1].task.verifier, getTask('wiki-search').verifier);
  } finally {
    delete VERIFIERS.hackerNewsPage;
    delete VERIFIERS.wikipediaArticle;
  }
}

// 9) Executable integration check for C's real manifest. This branch intentionally
// does not copy C's task definitions or invent missing API exports/IDs.
if (typeof taskModule.resolveTaskSet === 'function') {
  const selected = taskModule.resolveTaskSet('v2');
  const args = parseArgs(['--live', '--hosts', 'both', '--tasks', 'v2', '--rounds', '1']);
  const seen = [];
  const report = await runLiveBenchmark(args, {
    resolveEnv: async () => ({ credentialOk: true, chromeAvailable: true, egoAvailable: true }),
    gitHead: 'fixture', runnerInfo: {},
    runHost: async (host, { plan }) => {
      seen.push(host);
      assert.deepEqual(plan.map((item) => item.taskId), selected.tasks.map((task) => task.id));
      for (const [i, item] of plan.entries()) {
        assert.deepEqual(item.task, selected.tasks[i]);
        assert.equal(item.task.taskSetVersion, selected.tasks[i].taskSetVersion);
        assert.deepEqual(item.task.expected, selected.tasks[i].expected);
        assert.equal(item.task.verifier, selected.tasks[i].verifier);
        if (['hn-navigation', 'wiki-search'].includes(item.taskId)) {
          assert.notEqual(item.task.verifier, getTask(item.taskId).verifier, 'v2 old IDs must retain strict v2 verifier');
        }
      }
      return { status: 'completed', cleanup: { ok: true }, trials: [], notRun: [] };
    },
  });
  assert.deepEqual(seen, ['cdp', 'ego']);
  assert.equal(report.suiteVersion, selected.version);
  assert.equal(report.suiteVersion, taskModule.VERSION_V2);
  console.log('PASS: integrated v2 version and complete task/verifier/expected transport to both hosts');
} else {
  console.log('SKIP: C v2 manifest absent in independent B branch; rerun node bench/test-live-diagnostics.mjs after integration');
}
console.log('PASS: live diagnostics (bounded/redacted, transparent calls/choices, exceptions, timeout/inflight, frozen snapshots, offline legacy raw and unchanged summary)');
