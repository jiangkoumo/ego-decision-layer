import { runHostAcceptance, resolveEngine } from '../host-acceptance/suite.mjs';
import { TASKS_V2, VERSION } from './tasks.mjs';

const rate = (n, d) => d ? n / d : null;
// Keep refusal signals distinct from task outcome and from dangerous-action guards.
export function rejectionKinds(record) {
  const kinds = record.metrics.guardrailRejections.map(r => r.kind);
  if (record.metrics.stopReason === 'thrown:EGO_CONTROL_LOST') kinds.push('control_stop');
  if (record.metrics.stopReason === 'no_text_source') kinds.push('no_text_source');
  return [...new Set(kinds)];
}

export function summarize(results, expectedTotal = TASKS_V2.length) {
  const goals = results.filter(r => r.expect === 'goal');
  const guards = results.filter(r => r.expect === 'guard');
  const failed = results.filter(r => !r.metrics.taskPassed);
  const sum = (rows, key) => rows.reduce((n, r) => n + (r.metrics[key] ?? 0), 0);
  const rejected = rows => rows.filter(r => rejectionKinds(r).length > 0);
  // Preserve v1's guard/stale/control denominator; missing text is a separate refusal.
  const guardrails = guards.filter(r => r.definition?.expectedRejectionKind !== 'no_text_source');
  const expectedRejections = results.filter(r => r.definition?.expectedRejection);
  const matches = r => {
    const kinds = rejectionKinds(r);
    const expected = r.definition?.expectedRejectionKind;
    return expected ? kinds.length === 1 && kinds[0] === expected
      : Boolean(r.definition?.expectedRejection) === (kinds.length > 0);
  };
  return {
    expectedTotal, total: results.length, complete: results.length === expectedTotal,
    passed: results.filter(r => r.metrics.taskPassed).length, failed: failed.length,
    successRate: rate(results.filter(r => r.metrics.taskPassed).length, results.length),
    goalSuccessRate: rate(goals.filter(r => r.metrics.taskPassed).length, goals.length),
    falseSuccessRate: rate(results.filter(r => r.metrics.falseSuccess).length, results.length),
    guardrailRejectionRate: rate(guardrails.filter(r => rejectionKinds(r).some(k => k !== 'no_text_source')).length, guardrails.length),
    expectedRejectionRate: rate(rejected(expectedRejections).length, expectedRejections.length),
    rejectionKinds: Object.fromEntries([...new Set(results.flatMap(rejectionKinds))].map(kind =>
      [kind, results.filter(r => rejectionKinds(r).includes(kind)).length])),
    rejectionRateAllTasks: rate(rejected(results).length, results.length),
    zeroDispatchGuardTasks: guards.filter(r => r.metrics.dispatches === 0).length,
    dispatchCountGuardTasks: guards.filter(r => r.metrics.dispatches > 0).length,
    postStopPageCalls: sum(results.filter(r => r.metrics.postStopPageCalls !== null), 'postStopPageCalls'),
    expectedRejectionTasks: expectedRejections.length,
    rejectionObservedAny: rejected(results).length,
    rejectionMatches: results.filter(matches).length,
    guardExpectationPassRate: rate(guards.filter(r => r.metrics.taskPassed).length, guards.length),
    latencyMs: sum(results, 'latencyMs'), decisionRequests: sum(results, 'decisionRequests'),
    dispatches: sum(results, 'dispatches'), networkRequests: sum(results, 'networkRequests'), costUsd: null, humanTakeoverRate: null,
    failureConsumption: { tasks: failed.length, latencyMs: sum(failed, 'latencyMs'),
      decisionRequests: sum(failed, 'decisionRequests'), costUsd: failed.length ? null : 0 },
    unknownMetrics: ['costUsd', 'tokens', 'humanTakeoverRate'],
  };
}

export async function runCommonBenchmark(page, options = {}) {
  const engine = await resolveEngine(options.engine);
  const results = [];
  const startedAt = new Date().toISOString();
  let halted = false;
  for (const definition of TASKS_V2) {
    if (halted) break;
    let requests = 0;
    let requestBudgetExceeded = false;
    let networkRequests = 0;
    const originalFetch = globalThis.fetch;
    // Fence network only for the engine call: the host's own CDP/setup
    // traffic also uses global fetch and would otherwise be blocked.
    const boundedEngine = {
      async runJevAutonomousLoop(p, goal, engineOptions) {
        if (!boundedEngine.active) throw new Error('Only one bounded engine invocation is allowed');
        globalThis.fetch = async () => {
          networkRequests++;
          throw new Error('External fetch forbidden in controlled benchmark');
        };
        try {
          return await engine.runJevAutonomousLoop(p, goal, {
            ...engineOptions, maxSteps: definition.budget.steps,
            ask: async (...args) => {
              if (!boundedEngine.active || requests >= definition.budget.decisionRequests) {
                requestBudgetExceeded = true;
                throw Object.assign(new Error('Decision request budget exhausted'), { code: 'EGO_BENCH_BUDGET', executionStopped: true });
              }
              requests++;
              return engineOptions.ask(...args);
            },
          });
        } finally { globalThis.fetch = originalFetch; }
      },
      active: true,
    };
    let report;
    try {
      report = await runHostAcceptance(page, { host: options.host, engine: boundedEngine,
        taskIds: [definition.id], taskTimeoutMs: definition.budget.timeMs });
    } finally { boundedEngine.active = false; globalThis.fetch = originalFetch; }
    const record = report.results[0];
    const m = record.metrics;
    const budgetPassed = !requestBudgetExceeded && !record.timedOut &&
      (m.steps === null || m.steps <= definition.budget.steps) && m.latencyMs <= definition.budget.timeMs;
    record.definition = definition;
    record.metrics = { ...m, taskPassed: m.taskPassed && budgetPassed && networkRequests === 0,
      decisionRequests: requests, networkRequests, budgetPassed,
      rejectionKinds: rejectionKinds(record) };
    results.push(record);
    halted = report.summary.halted;
    options.onTask?.(record);
  }
  return { schemaVersion: 1, taskSet: VERSION, host: options.host ?? 'unknown',
    startedAt, finishedAt: new Date().toISOString(), decider: 'injected',
    disclaimer: 'Controlled real DOM + injected decisions; mechanism acceptance only, not model or live-site success rate.',
    notRun: TASKS_V2.filter(t => !results.some(r => r.id === t.id)).map(t => t.id),
    results, summary: summarize(results) };
}
