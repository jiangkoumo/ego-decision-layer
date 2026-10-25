import assert from 'node:assert/strict';
import { TASKS_V1, SITE_CANDIDATES } from './common-benchmark/tasks.mjs';
import { summarize, runCommonBenchmark } from './common-benchmark/suite.mjs';
import { parseArgs, run } from './common-benchmark/run.mjs';

assert.equal(TASKS_V1.length, 10);
assert.equal(new Set(TASKS_V1.map(t => t.id)).size, 10);
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

// Deliberately broken engine: request cap must stop it even when it ignores maxSteps.
// A fake page here tests harness policy only; browser behavior is exercised by run.mjs.
const originalFetch = globalThis.fetch;
const fakePage = { goto: async () => {}, evaluate: async () => null };
let calls = 0;
const engine = { async runJevAutonomousLoop(_page, _goal, opts) {
  assert.equal(opts.maxSteps > 0, true);
  for (let i = 0; i < 20; i++) { await opts.ask('', {}); calls++; }
  throw new Error('request cap not enforced');
} };
const budgetReport = await runCommonBenchmark(fakePage, { engine, host: 'policy-test' });
assert.equal(calls, TASKS_V1.reduce((n, t) => n + t.budget.decisionRequests, 0));
assert.ok(budgetReport.results.every(r => !r.metrics.budgetPassed && !r.metrics.taskPassed));
assert.equal(globalThis.fetch, originalFetch);
const networkReport = await runCommonBenchmark(fakePage, { host: 'policy-test', engine: {
  async runJevAutonomousLoop() { await fetch('https://must-not-be-requested.invalid'); }
} });
assert.equal(networkReport.summary.networkRequests, 10);
assert.equal(networkReport.summary.passed, 0);
assert.equal(globalThis.fetch, originalFetch);

const skipped = await run({ hosts: 'both', chrome: '/nonexistent/ego-p2-chrome', ego: '/nonexistent/ego-p2-browser' });
assert.equal(skipped.status, 'incomplete');
assert.equal(skipped.complete, false);
assert.ok(skipped.hosts.every(h => h.status === 'skipped' && h.reason));
// Existing but non-browser executable: broken launch must FAIL, never become SKIP.
const broken = await run({ hosts: 'cdp', chrome: process.execPath });
assert.equal(broken.status, 'failed');
assert.equal(broken.hosts[0].cleanup.processStopped, true);
console.log('PASS: task manifest, metric denominators, failure consumption, request/network budgets, restoration, SKIP and launch failure cleanup');
