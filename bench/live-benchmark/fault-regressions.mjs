// Offline fresh-review regressions. Each case runs in its own Node process so builtin
// and protocol fault injection cannot affect the other cases or the benchmark runtime.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function runFaultRegressions() {
  let failed = 0;
  for (const name of ['timeout-fallback', 'ego-spawn', 'stage-failure', 'partial-cdp']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 10000,
    });
    if (child.status !== 0) failed++;
    const detail = `${child.stdout || ''}${child.stderr || ''}`.trim().split('\n')
      .filter((line) => /AssertionError|Error:|Unhandled|actual:|expected:/.test(line)).slice(0, 4).join(' ');
    console.log(`${child.status === 0 ? 'PASS' : 'FAIL'} ${name} exit=${child.status ?? child.error?.code} ${detail}`);
  }
  return failed;
}

async function memoryStage(mode = 'ok') {
  const fs = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const state = { allocated: [], removed: [], exists: false };
  fs.mkdtemp = async () => { state.exists = true; state.allocated.push('/offline-stage-fixture'); return '/offline-stage-fixture'; };
  fs.mkdir = async () => { if (mode === 'mkdir') throw new Error('mkdir EACCES fixture'); };
  fs.copyFile = async () => { if (mode === 'copy') throw new Error('copy EACCES fixture'); };
  fs.readFile = async (path) => {
    if (mode === 'read') throw new Error('hash read EIO fixture');
    return mode === 'hash' && String(path).startsWith('/offline-stage-fixture') ? 'different' : 'same bytes';
  };
  fs.access = async () => { if (!state.exists) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  fs.rm = async (path) => {
    state.removed.push(path);
    if (mode === 'cleanup') throw new Error('rm EACCES fixture');
    state.exists = false;
  };
  syncBuiltinESMExports();
  return state;
}

async function timeoutFallback() {
  const { runTrial } = await import('./suite.mjs');
  const { askJev } = await import('../../scripts/decider-loop.mjs');
  const { getTask } = await import('./tasks.mjs');
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (String(url).includes('primary')) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ok: false, status: 503, text: async () => 'offline delayed 503' };
    }
    return { ok: true, status: 200, json: async () => ({ answers: {}, model: 'fixture', usage: { input_tokens: 9, output_tokens: 1 } }) };
  };
  const task = { ...getTask('hn-navigation'), budget: { steps: 5, timeMs: 25, decisionRequests: 5, settleGraceMs: 500 } };
  const page = { goto: async () => {}, waitForLoadState: async () => {}, url: async () => 'about:blank', title: async () => '', evaluate: async () => ({}) };
  const trial = await runTrial(page, task, { host: 'fault', round: 1, engine: {
    askJev: (state, questions, options) => askJev(state, questions, {
      ...options, apiKey: 'offline-not-a-credential', baseUrl: 'https://primary.invalid/v1', fallbackBaseUrl: 'https://fallback.invalid/v1',
    }),
    async runJevAutonomousLoop(_page, _goal, options) { await options.ask('', {}); return { success: true }; },
  } });
  assert.equal(trial.engine.timedOut, true);
  assert.equal(requests.length, 1, 'fallback must never reach real fetch after timeout');
  assert.equal(trial.metrics.httpRequests, 1, 'count only dispatched HTTP attempts');
  assert.equal(trial.metrics.inputTokens, null, 'in-flight primary without usage is unknown, never zero');
  assert.ok(trial.metrics.usageReasons.inputTokens);

  // An unresolved request was still dispatched: retain its HTTP count and unknown
  // tokens at report time rather than waiting for ask finally to count it as one.
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  globalThis.fetch = async () => {
    await pending;
    return { ok: false, status: 503, text: async () => 'offline pending' };
  };
  const pendingFetch = globalThis.fetch;
  const pendingTrial = await runTrial(page, { ...task, budget: { ...task.budget, settleGraceMs: 10 } }, {
    host: 'fault', round: 2, engine: {
      askJev: (state, questions, options) => askJev(state, questions, {
        ...options, apiKey: 'offline-not-a-credential', baseUrl: 'https://primary.invalid/v1', fallbackBaseUrl: 'https://fallback.invalid/v1',
      }),
      async runJevAutonomousLoop(_page, _goal, options) { await options.ask('', {}); return {}; },
    },
  });
  try {
    assert.equal(pendingTrial.engine.unsettled, true);
    assert.equal(pendingTrial.metrics.httpRequests, 1);
    assert.equal(pendingTrial.metrics.inputTokens, null);
    assert.match(pendingTrial.metrics.usageReasons.inputTokens, /not settled/);
  } finally {
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(globalThis.fetch, pendingFetch);
}

async function egoSpawn() {
  const memory = await memoryStage();
  const runner = await import('./run.mjs');
  const args = runner.parseArgs(['--live', '--hosts', 'both', '--tasks', 'hn-navigation', '--rounds', '1']);
  const report = await runner.runLiveBenchmark(args, {
    resolveEnv: async () => ({ credentialOk: true, chromeAvailable: true, egoAvailable: true, egoPath: '/nonexistent-issue15-ego', egoVersion: 'offline' }),
    runHost: async (host, ctx) => host === 'ego' ? runner.runEgoLeg(ctx) : ({ status: 'completed', cleanup: { ok: true }, trials: [
      { trialId: 'cdp/hn-navigation/r1', host: 'cdp', taskId: 'hn-navigation', taskPassed: true, verifier: { ok: true }, metrics: { inputTokens: 0, outputTokens: 0 } },
    ] }),
    gitHead: 'offline', runnerInfo: {},
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.trials.length, 1, 'completed CDP result survives ego launch error');
  assert.match(report.hosts[1].reason, /ENOENT/);
  assert.equal(report.hosts[1].cleanup.stageRemoved, true);
  assert.deepEqual(memory.removed, memory.allocated);

  // Deterministic EACCES EventEmitter error, isolated from the real process launcher.
  const cp = (await import('node:child_process')).default;
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { syncBuiltinESMExports } = await import('node:module');
  cp.spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    queueMicrotask(() => {
      child.emit('error', Object.assign(new Error('spawn fixture EACCES'), { code: 'EACCES' }));
      child.emit('close', -13);
    });
    return child;
  };
  syncBuiltinESMExports();
  const outcome = await runner.runEgoLeg({ args, plan: [], env: { egoPath: '/offline-denied', egoVersion: 'offline' } });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.reason, /EACCES/);
  assert.equal(outcome.cleanup.stageRemoved, true);
}

async function stageFailure() {
  for (const mode of ['mkdir', 'copy', 'read', 'hash', 'cleanup']) {
    const memory = await memoryStage(mode);
    // In cleanup mode, fail the copy then fail the attempt to remove its stage.
    if (mode === 'cleanup') {
      const fs = (await import('node:fs/promises')).default;
      fs.copyFile = async () => { throw new Error('copy EACCES fixture'); };
      (await import('node:module')).syncBuiltinESMExports();
    }
    const { runEgoLeg } = await import('./run.mjs');
    const outcome = await runEgoLeg({ args: {}, plan: [], env: {} });
    assert.equal(outcome.status, 'failed');
    assert.deepEqual(memory.removed, memory.allocated, `${mode}: allocated stage must enter cleanup`);
    assert.equal(outcome.cleanup.stageRemoved, mode !== 'cleanup', `${mode}: removal evidence`);
    assert.equal(outcome.cleanup.ok, false);
    if (mode === 'cleanup') assert.match(outcome.cleanup.errors.join(';'), /rm EACCES/);
  }
}

async function partialCdp() {
  const methods = [];
  let socketClosed = false;
  class FakeWebSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(raw) {
      const message = JSON.parse(raw);
      methods.push(message.method);
      const result = message.method === 'Target.createTarget' ? { targetId: 'owned-fixture' } : { success: false };
      const reply = message.method === 'Target.attachToTarget'
        ? { id: message.id, error: { code: -1, message: 'fixture attach failed' } }
        : { id: message.id, result };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(reply) })));
    }
    close() { socketClosed = true; this.dispatchEvent(new Event('close')); }
  }
  globalThis.WebSocket = FakeWebSocket;
  const { runCdpLeg } = await import('./run.mjs');
  const outcome = await runCdpLeg({ args: { endpoint: 'ws://offline.invalid/devtools/browser/fault' }, plan: [], env: {} });
  assert.equal(outcome.status, 'failed');
  assert.deepEqual(methods, ['Target.createTarget', 'Target.attachToTarget', 'Target.closeTarget']);
  assert.equal(socketClosed, true);
  assert.equal(outcome.cleanup.ok, false, 'partial target close failure cannot be reported as clean');
  assert.match(outcome.cleanup.errors.join(';'), /success:false/);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cases = { 'timeout-fallback': timeoutFallback, 'ego-spawn': egoSpawn, 'stage-failure': stageFailure, 'partial-cdp': partialCdp };
  if (process.argv[2]) await cases[process.argv[2]]();
  else process.exitCode = runFaultRegressions() ? 1 : 0;
}
