import assert from 'node:assert/strict';
import { TASKS_V1, TASKS_V2, VERSION, VERSION_V1, SITE_CANDIDATES } from './common-benchmark/tasks.mjs';
import { summarize, runCommonBenchmark } from './common-benchmark/suite.mjs';
import { parseArgs, run, hostStatus } from './common-benchmark/run.mjs';

assert.equal(TASKS_V1.length, 10);
assert.equal(new Set(TASKS_V1.map(t => t.id)).size, 10);
assert.equal(VERSION_V1, 'p2-controlled-v1');
assert.equal(VERSION, 'p2-controlled-v2');
assert.equal(TASKS_V2.length, 12);
assert.equal(new Set(TASKS_V2.map(t => t.id)).size, 12);
assert.deepEqual(TASKS_V2.slice(0, 10).map(({ expectedRejectionKind, ...t }) => t), TASKS_V1);
assert.ok(SITE_CANDIDATES.every(t => t.status === 'candidate-unverified'));
assert.throws(() => parseArgs(['--hosts', 'invalid']));
assert.throws(() => parseArgs(['--endpoint']));
assert.throws(() => parseArgs(['--unknown']));
const row = (expect, passed, extra = {}) => ({ expect, definition: { expectedRejection: expect === 'guard' },
  metrics: { taskPassed: passed, falseSuccess: false, guardrailRejections: [], latencyMs: 10,
    decisionRequests: 2, networkRequests: 0, dispatches: 0, postStopPageCalls: null, ...extra } });
const summary = summarize([row('goal', false, { falseSuccess: true }),
  row('guard', true, { guardrailRejections: [{ kind: 'covered' }] }), row('guard', true)], 4);
assert.equal(summary.successRate, 2 / 3);
assert.equal(summary.goalSuccessRate, 0);
assert.equal(summary.falseSuccessRate, 1 / 3);
assert.equal(summary.guardrailRejectionRate, 1 / 2);
assert.equal(summary.rejectionMatches, 2);
assert.equal(summary.zeroDispatchGuardTasks, 2);
assert.equal(summary.guardExpectationPassRate, 1);
assert.equal(summary.complete, false);
assert.deepEqual(summary.failureConsumption, { tasks: 1, latencyMs: 10, decisionRequests: 2, costUsd: null });
assert.equal(summary.costUsd, null);
assert.equal(summarize([]).successRate, null);

const refusal = (id, metrics = {}) => ({ ...row('guard', true, metrics), id,
  definition: TASKS_V2.find(t => t.id === id) });
const missingText = refusal('no-text-source', { stopReason: 'no_text_source' });
const typedSummary = summarize([missingText,
  refusal('danger-action', { guardrailRejections: [{ kind: 'dangerous_action' }] }),
  refusal('control-stop', { stopReason: 'thrown:EGO_CONTROL_LOST', postStopPageCalls: 0, dispatches: 1 }),
  row('goal', true)], 4);
assert.equal(typedSummary.rejectionMatches, 4);
assert.equal(typedSummary.expectedRejectionTasks, 3);
assert.equal(typedSummary.expectedRejectionRate, 1);
assert.equal(typedSummary.guardrailRejectionRate, 1);
assert.equal(typedSummary.rejectionRateAllTasks, 3 / 4);
assert.deepEqual(typedSummary.rejectionKinds, { no_text_source: 1, dangerous_action: 1, control_stop: 1 });
assert.deepEqual(missingText.metrics.guardrailRejections, []);
assert.equal(summarize([missingText], 1).guardrailRejectionRate, null);
// A different refusal must not match the expected kind, even if both are refusals.
assert.equal(summarize([refusal('no-text-source', {
  guardrailRejections: [{ kind: 'dangerous_action' }],
})], 1).rejectionMatches, 0);
for (const stopReason of ['thrown:EGO_BENCH_BUDGET', 'thrown:TASK_TIMEOUT', 'thrown:Error']) {
  const unexpected = row('goal', false, { stopReason, postStopPageCalls: 0 });
  assert.equal(summarize([unexpected], 1).rejectionObservedAny, 0);
}


// Deliberately broken engine: request cap must stop it even when it ignores maxSteps.
// A fake page here tests harness policy only; browser behavior is exercised by run.mjs.
const originalFetch = globalThis.fetch;
const fakePage = { goto: async () => {}, evaluate: async () => null };
let calls = 0;
const engine = { async runJevAutonomousLoop(_page, _goal, opts) {
  assert.equal(opts.maxSteps > 0, true);
  const questions = {
    type_text_target: { criteria: { 'ref=1': 'Username', 'ref=2': 'Email' } },
    click_target: { criteria: { 'ref=3': 'Submit Form' } },
  };
  for (let i = 0; i < 20; i++) { await opts.ask('', questions); calls++; }
  throw new Error('request cap not enforced');
} };
const budgetReport = await runCommonBenchmark(fakePage, { engine, host: 'policy-test' });
assert.equal(calls, TASKS_V2.reduce((n, t) => n + t.budget.decisionRequests, 0));
assert.equal(budgetReport.taskSet, VERSION);
assert.deepEqual(budgetReport.notRun, []);
assert.equal(budgetReport.summary.rejectionObservedAny, 0);
assert.ok(budgetReport.results.every(r => !r.metrics.budgetPassed && !r.metrics.taskPassed));
assert.equal(globalThis.fetch, originalFetch);
const networkReport = await runCommonBenchmark(fakePage, { host: 'policy-test', engine: {
  async runJevAutonomousLoop() { await fetch('https://must-not-be-requested.invalid'); }
} });
assert.equal(networkReport.summary.networkRequests, 12);
assert.equal(networkReport.summary.passed, 0);
assert.equal(globalThis.fetch, originalFetch);

// P1 decisions and verifiers still run: an engine's success claim is insufficient.
// This page supplies observations only; the real DOM path is covered by the two-host run.
const batch = TASKS_V2.find(t => t.id === 'batch-two-fields');
const noText = TASKS_V2.find(t => t.id === 'no-text-source');
const policyPage = { goto: async () => {}, evaluate: async (_fn, html) => html ? undefined : '' };
let batchDecision, textDecision;
const behaviorReport = await runCommonBenchmark(policyPage, { host: 'policy-test', engine: {
  async runJevAutonomousLoop(_p, goal, opts) {
    if (goal === noText.goal) {
      textDecision = await opts.ask('', { input_text: { criteria: { acceptance: 'acceptance', none: 'none' } } });
      return { success: false, reason: 'no_text_source', steps: noText.budget.steps + 1, history: [] };
    }
    if (goal === batch.goal) {
      batchDecision = await opts.ask('', {
        type_text_target: { criteria: { 'ref=1': 'Username', 'ref=2': 'Email', none: 'none' } },
        click_target: { criteria: { 'ref=3': 'Submit Form', none: 'none' } },
      });
      return { success: true, reason: 'check_passed_after_step', steps: 1,
        history: [{ action: 'batch', batchSize: 3, batchExecutedCount: 3 }] };
    }
    return { success: false, reason: 'blocked', steps: 1, history: [] };
  },
} });
const textRecord = behaviorReport.results.find(r => r.id === noText.id);
assert.equal(textDecision.input_text.choice, 'none');
assert.equal(textRecord.verification.ok, true);
assert.deepEqual(textRecord.verification.observed, { value: '', stopReason: 'no_text_source', dispatches: 0 });
assert.deepEqual(textRecord.metrics.rejectionKinds, ['no_text_source']);
assert.deepEqual(textRecord.metrics.guardrailRejections, []);
assert.equal(textRecord.metrics.decisionRequests, 1);
assert.equal(textRecord.metrics.budgetPassed, false);
assert.equal(textRecord.metrics.taskPassed, false);
assert.deepEqual(batchDecision.subActions, [
  { action: 'type_text', target: 'ref=1', text: 'alice' },
  { action: 'type_text', target: 'ref=2', text: 'alice@example.com' },
  { action: 'click', target: 'ref=3' },
]);
const batchRecord = behaviorReport.results.find(r => r.id === batch.id);
assert.equal(batchRecord.verification.ok, false);
assert.equal(batchRecord.metrics.falseSuccess, true);
assert.equal(batchRecord.metrics.taskPassed, false);
assert.equal(behaviorReport.summary.falseSuccessRate, 1 / 12);
assert.equal(behaviorReport.summary.failureConsumption.tasks, 12);

// Time exhaustion stops the suite, preserving unrun task IDs and restoring fetch.
const first = TASKS_V2[0];
const originalTime = first.budget.timeMs;
let timeoutReport;
try {
  first.budget.timeMs = 5;
  timeoutReport = await runCommonBenchmark(fakePage, { host: 'policy-test', engine: {
    async runJevAutonomousLoop() { return new Promise(() => {}); },
  } });
} finally { first.budget.timeMs = originalTime; }
assert.equal(timeoutReport.results.length, 1);
assert.equal(timeoutReport.results[0].timedOut, true);
assert.equal(timeoutReport.results[0].metrics.stopReason, 'thrown:TASK_TIMEOUT');
assert.equal(timeoutReport.results[0].metrics.budgetPassed, false);
assert.equal(timeoutReport.results[0].metrics.taskPassed, false);
assert.equal(timeoutReport.summary.complete, false);
assert.equal(timeoutReport.summary.rejectionObservedAny, 0);
assert.deepEqual(timeoutReport.notRun, TASKS_V2.slice(1).map(t => t.id));
assert.equal(globalThis.fetch, originalFetch);

const completeReport = { summary: { complete: true, failed: 0 }, notRun: [] };
assert.equal(hostStatus(completeReport, { taskSpaceFinished: true }), 'passed');
assert.equal(hostStatus(completeReport, { target: { targetClosed: true }, pid: 123, processStopped: true }), 'passed');
for (const cleanup of [{}, { taskSpaceFinished: false }, { target: { targetClosed: false } },
  { target: { targetClosed: true }, pid: 123, processStopped: false },
  { taskSpaceFinished: true, error: 'finish failed' }]) {
  assert.equal(hostStatus(completeReport, cleanup), 'failed');
}
assert.equal(hostStatus({ ...completeReport, notRun: ['batch-two-fields'] }, { taskSpaceFinished: true }), 'failed');
assert.equal(hostStatus({ summary: { complete: true, failed: 1 }, notRun: [] }, { taskSpaceFinished: true }), 'failed');
assert.equal(hostStatus({ summary: { complete: false, failed: 0 }, notRun: [] }, { taskSpaceFinished: true }), 'failed');

const skipped = await run({ hosts: 'both', chrome: '/nonexistent/ego-p2-chrome', ego: '/nonexistent/ego-p2-browser' });
assert.equal(skipped.taskSet, VERSION);
assert.equal(skipped.status, 'incomplete');
assert.equal(skipped.complete, false);
assert.ok(skipped.hosts.every(h => h.status === 'skipped' && h.reason));
// Existing but non-browser executable: broken launch must FAIL, never become SKIP.
const broken = await run({ hosts: 'cdp', chrome: process.execPath });
assert.equal(broken.status, 'failed');
assert.equal(broken.hosts[0].cleanup.processStopped, true);
console.log('PASS: versioned manifests, typed refusals, P1 decisions/verifiers, false success, request/step/time/network budgets, notRun, restoration, SKIP and launch cleanup');
