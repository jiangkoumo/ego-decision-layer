#!/usr/bin/env node
// Live dual-host benchmark runner: real ego-browser TaskSpace and real external Chrome
// (CDP), same tasks, same engine, same budgets, real Jev decisions.
//
// This file only orchestrates. It never injects decisions and never retries a failed
// trial. `--live` is required so a normal test run cannot accidentally hit the network.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as engine from '../../scripts/decider-loop.mjs';
import { selectTasks, VERSION as TASK_VERSION } from './tasks.mjs';
import { runHostTrials, summarizeLive } from './suite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const SLEEP = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const DEFAULT_CHROME = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : null;

const USAGE = `Usage: node bench/live-benchmark/run.mjs --live [options]

Explicit live run (network + Jev credentials + browser required):
  --live                     required; without it the runner refuses to start
  --hosts both|ego|cdp       default both, executed in the order cdp then ego
  --tasks all|id[,id]        default all (hn-navigation, wiki-search)
  --rounds N                 default 3; fixed at 3 for the first measured batch
  --out FILE                 raw JSON path; default bench/live-benchmark/raw/live-<stamp>.json
  --chrome PATH              Chrome executable (default macOS Chrome or EGO_CDP_CHROME)
  --ego PATH                 ego-browser executable (default ego-browser on PATH)
  --endpoint URL             use an existing Chrome CDP endpoint instead of launching one
  --help

Exit codes: 0 all requested trials verified and cleanup confirmed; 1 any trial failed,
host/setup/cleanup failed; 2 usage error, missing browser/credentials, or incomplete.`;

export function parseArgs(argv) {
  const args = { live: false, hosts: 'both', tasks: 'all', rounds: 3 };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--help' || name === '-h') {
      args.help = true;
      continue;
    }
    if (name === '--live') {
      args.live = true;
      continue;
    }
    const takesValue = ['--hosts', '--tasks', '--rounds', '--out', '--chrome', '--ego', '--endpoint'];
    if (!takesValue.includes(name)) throw new Error(`unknown option: ${name}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value: ${name}`);
    args[name.slice(2)] = value;
  }
  if (!['both', 'ego', 'cdp'].includes(args.hosts)) throw new Error('hosts must be both, ego or cdp');
  const rounds = Number(args.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 50) throw new Error('rounds must be an integer from 1 to 50');
  args.rounds = rounds;
  // Validate task ids early; this does not touch the network.
  selectTasks(args.tasks);
  if (args.endpoint) {
    try {
      new URL(args.endpoint);
    } catch {
      throw new Error(`invalid --endpoint URL: ${args.endpoint}`);
    }
  }
  return args;
}

export function selectHosts(value) {
  if (value === 'both') return ['cdp', 'ego'];
  return [value];
}

export function preflightHosts({ hosts, endpoint = null, chromeAvailable = false, egoAvailable = false, credentialOk = false }) {
  return hosts.map((host) => {
    if (!credentialOk) {
      return { host, status: 'skipped', reason: 'missing Jev credentials in the file credential chain (no value read or reported)' };
    }
    if (host === 'cdp' && !endpoint && !chromeAvailable) {
      return { host, status: 'skipped', reason: 'Chrome executable unavailable; supply --chrome, EGO_CDP_CHROME, or --endpoint' };
    }
    if (host === 'ego' && !egoAvailable) {
      return { host, status: 'skipped', reason: 'ego-browser unavailable; supply --ego or install ego lite' };
    }
    return { host, status: 'ready', reason: null };
  });
}

function isMainModule() {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

function resolveUserPath(value) {
  if (!value) return value;
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return resolve(value);
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function stopChild(child, graceMs = 5000) {
  return new Promise((resolveStop) => {
    if (!child?.pid) {
      resolveStop({ stopped: true, pid: null, exitCode: null, signal: null });
      return;
    }
    const done = () => child.exitCode !== null || child.signalCode !== null;
    const finish = async () => {
      const deadline = Date.now() + graceMs;
      while (!done() && Date.now() < deadline) await SLEEP(25);
      if (!done()) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        const killDeadline = Date.now() + 5000;
        while (!done() && Date.now() < killDeadline) await SLEEP(25);
      }
      let alive = true;
      try {
        process.kill(child.pid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') alive = false;
      }
      resolveStop({ stopped: !alive, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode });
    };
    if (done()) {
      finish();
      return;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    finish();
  });
}

function runCommand(command, args, timeoutMs = 10000, cwd = REPO) {
  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolveRun({ code: null, stdout: '', stderr: '', error: String(err?.message || err), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({ code: null, stdout, stderr, error: 'command timeout', timedOut: true });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-20000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-20000);
    });
    child.once('error', (err) => finish({ code: null, stdout, stderr, error: String(err?.message || err), timedOut: false }));
    child.once('close', (code) => finish({ code, stdout, stderr, error: null, timedOut: false }));
  });
}

async function resolveEnvironment(args) {
  const chromePath = args.chrome ? resolveUserPath(args.chrome) : (process.env.EGO_CDP_CHROME || DEFAULT_CHROME);
  const chromeAvailable = Boolean(chromePath) && await exists(chromePath);
  const egoPath = args.ego ? resolveUserPath(args.ego) : 'ego-browser';
  const version = await runCommand(egoPath, ['--version'], 10000);
  const versionText = version.code === 0 ? (version.stdout || version.stderr).trim() : '';
  const egoVersion = versionText ? (versionText.split('\n')[0] || null) : null;
  let credentialOk = false;
  try {
    credentialOk = Boolean(engine.loadApiKey({}));
  } catch {
    credentialOk = false;
  }
  return {
    credentialOk,
    egoAvailable: egoVersion !== null,
    egoVersion,
    egoPath,
    chromePath,
    chromeAvailable,
    endpoint: args.endpoint ?? null,
  };
}

async function stageLiveFiles() {
  const stage = await mkdtemp(join(tmpdir(), 'ego-p2-live-stage-'));
  const files = [
    'bench/live-benchmark/suite.mjs',
    'bench/live-benchmark/tasks.mjs',
    'bench/live-benchmark/verifiers.mjs',
    'scripts/decider-loop.mjs',
  ];
  const copied = [];
  for (const rel of files) {
    const dest = join(stage, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(REPO, rel), dest);
    const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
    const from = await digest(join(REPO, rel));
    const to = await digest(dest);
    if (from !== to) throw new Error(`staged copy differs: ${rel}`);
    copied.push({ path: rel, sha256: from });
  }
  return { stage, copied };
}

function formatTrial(trial) {
  const model = trial.model?.serverModels?.length ? trial.model.serverModels.join(',') : 'unknown';
  return `[${trial.host} ${trial.taskId} r${trial.round}] ${trial.status}` +
    ` engine=${trial.engine?.success ?? 'null'} reason=${trial.stopReason ?? 'null'}` +
    ` latency=${trial.metrics?.latencyMs ?? '?'}ms asks=${trial.metrics?.logicalAskCalls ?? '?'}` +
    ` http=${trial.metrics?.httpRequests ?? 'null'} model=${model}`;
}

async function launchChrome(chromePath) {
  const profile = await mkdtemp(join(tmpdir(), 'ego-p2-live-profile-'));
  let child = null;
  const cleanupLaunchFailure = async (cause) => {
    let stopped = { stopped: true };
    if (child) {
      try {
        stopped = await stopChild(child);
      } catch {
        stopped = { stopped: false };
      }
    }
    let removed = false;
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removed = !(await exists(profile));
    } catch {
      removed = false;
    }
    const err = cause instanceof Error ? cause : new Error(String(cause));
    err.cleanup = { processStopped: stopped.stopped, profileRemoved: removed, ok: stopped.stopped && removed };
    return err;
  };
  try {
    child = spawn(chromePath, [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ], { cwd: REPO, stdio: ['ignore', 'ignore', 'pipe'] });
    let log = '';
    let launchError = null;
    child.on('error', (err) => {
      launchError = err;
    });
    child.stderr?.on('data', (chunk) => {
      log = (log + chunk.toString()).slice(-32000);
    });
    const deadline = Date.now() + 20000;
    let endpoint = null;
    while (!endpoint && Date.now() < deadline) {
      if (launchError) throw new Error(`Chrome launch failed: ${launchError.message}`);
      if (child.exitCode !== null) throw new Error('Chrome exited before CDP became ready');
      endpoint = log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1] ?? null;
      if (!endpoint) await SLEEP(50);
    }
    if (!endpoint) throw new Error('Chrome CDP startup timed out');
    return { child, profile, endpoint };
  } catch (err) {
    throw await cleanupLaunchFailure(err);
  }
}

export async function runCdpLeg({ args, plan, env }) {
  const cleanup = {
    ok: true,
    ownedBrowser: !args.endpoint,
    targetClosed: null,
    processStopped: null,
    profileRemoved: null,
    externalBrowserPreserved: Boolean(args.endpoint),
    errors: [],
  };
  let chrome = null;
  let host = null;
  let trials = [];
  let notRun = [];
  let status = 'completed';
  let reason = null;
  let hostVersion = null;
  try {
    let endpoint = args.endpoint;
    if (!endpoint) {
      chrome = await launchChrome(env.chromePath);
      endpoint = chrome.endpoint;
    }
    host = await engineConnect(endpoint);
    hostVersion = host.metadata?.browserVersion ?? null;
    const run = await runHostTrials({
      host: 'cdp',
      page: host.page,
      engine,
      plan,
      onTrial: (trial) => console.log(formatTrial(trial)),
    });
    trials = run.trials;
    notRun = run.notRun ?? [];
    if (trials.length + notRun.length !== plan.length) {
      status = 'failed';
      reason = `expected ${plan.length} trials, completed ${trials.length}, notRun ${notRun.length}`;
    }
  } catch (err) {
    status = 'failed';
    reason = String(err?.message || err);
    if (err?.cleanup) {
      cleanup.processStopped = err.cleanup.processStopped ?? cleanup.processStopped;
      cleanup.profileRemoved = err.cleanup.profileRemoved ?? cleanup.profileRemoved;
      if (err.cleanup.ok === false) {
        cleanup.ok = false;
        cleanup.errors.push('Chrome launch cleanup not confirmed');
      }
    }
  } finally {
    if (host) {
      try {
        const closed = await host.close({ keepPage: false });
        cleanup.targetClosed = closed?.targetClosed === true;
        if (!cleanup.targetClosed) {
          cleanup.ok = false;
          cleanup.errors.push('CDP target cleanup not confirmed');
        }
      } catch (err) {
        cleanup.ok = false;
        cleanup.targetClosed = false;
        cleanup.errors.push(`CDP close failed: ${String(err?.message || err)}`);
      }
    }
    if (chrome) {
      const stopped = await stopChild(chrome.child);
      cleanup.processStopped = stopped.stopped;
      if (!stopped.stopped) {
        cleanup.ok = false;
        cleanup.errors.push('temporary Chrome process still alive');
      }
      if (stopped.stopped) {
        try {
          await rm(chrome.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          cleanup.profileRemoved = !(await exists(chrome.profile));
        } catch (err) {
          cleanup.profileRemoved = false;
          cleanup.ok = false;
          cleanup.errors.push(`temporary profile removal failed: ${String(err?.message || err)}`);
        }
      } else {
        cleanup.profileRemoved = false;
        cleanup.errors.push('temporary profile kept because Chrome did not stop');
      }
      if (cleanup.profileRemoved === false) cleanup.ok = false;
    }
  }
  return { host: 'cdp', status, reason, hostVersion, trials, notRun, cleanup };
}

// Imported lazily so the offline policy test can import this module without opening any
// browser or evaluating the CDP host implementation.
async function engineConnect(endpoint) {
  const { connectCdpHost } = await import('../../scripts/hosts/cdp-host.mjs');
  return connectCdpHost({ endpoint, timeoutMs: 15000, commandTimeoutMs: 20000 });
}

export async function runEgoLeg({ args, plan, env }) {
  let staged = null;
  const cleanup = {
    ok: true,
    ownedTaskSpace: true,
    taskSpaceFinished: false,
    pagesBeforeFinish: [],
    childExitCode: null,
    childTimedOut: false,
    stageRemoved: null,
    errors: [],
  };
  let status = 'completed';
  let reason = null;
  let trials = [];
  let notRun = [];
  let report = null;
  try {
    staged = await stageLiveFiles();
    const resultFile = join(staged.stage, 'result.json');
    const spaceName = `ego-p2-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const suiteUrl = join(staged.stage, 'bench/live-benchmark/suite.mjs');
    const engineUrl = join(staged.stage, 'scripts/decider-loop.mjs');
    const script = [
      "const fs = await import('node:fs/promises');",
      `const suite = await import(${JSON.stringify(suiteUrl)});`,
      `const engine = await import(${JSON.stringify(engineUrl)});`,
      `const plan = ${JSON.stringify(plan)};`,
      `const spaceName = ${JSON.stringify(spaceName)};`,
      'let space = null;',
      'const cleanup = { ok: true, taskSpaceFinished: false, pagesBeforeFinish: [], errors: [] };',
      'let report = null;',
      'try {',
      '  space = await taskSpace(spaceName);',
      '  const pages = await space.pages();',
      '  cleanup.pagesBeforeFinish = pages.map((p) => p.label);',
      '  const page = space.page("p1");',
      '  report = await suite.runHostTrials({ host: "ego", page, engine, plan,',
      '    onTrial: (trial) => console.log("LIVE_TRIAL " + JSON.stringify({',
      '      trialId: trial.trialId, status: trial.status, engine: trial.engine.success,',
      '      reason: trial.stopReason, latencyMs: trial.metrics.latencyMs,',
      '      logicalAskCalls: trial.metrics.logicalAskCalls, httpRequests: trial.metrics.httpRequests,',
      '      serverModels: trial.model.serverModels })) });',
      '} catch (err) {',
      '  cleanup.ok = false;',
      '  cleanup.errors.push(String(err?.message || err));',
      '} finally {',
      '  if (space) {',
      '    try { await space.finish({ keep: [] }); cleanup.taskSpaceFinished = true; }',
      '    catch (err) { cleanup.ok = false; cleanup.errors.push("finish: " + String(err?.message || err)); }',
      '  } else { cleanup.ok = false; cleanup.errors.push("taskSpace was not created"); }',
      '}',
      `await fs.writeFile(${JSON.stringify(resultFile)}, JSON.stringify({ report, cleanup }));`,
      'console.log("LIVE_RESULT_WRITTEN");',
    ].join('\n');

    const child = spawn(env.egoPath, ['nodejs'], { cwd: REPO, stdio: ['pipe', 'pipe', 'pipe'] });
    let combined = '';
    let streamBuffer = '';
    const timeoutMs = Math.max(180000, plan.length * (Math.max(...plan.map(() => 30000)) + 30000) + 120000);
    const timer = setTimeout(() => {
      cleanup.childTimedOut = true;
      stopChild(child).catch(() => {});
    }, timeoutMs);
    const consume = (chunk) => {
      const text = chunk.toString();
      combined = (combined + text).slice(-300000);
      streamBuffer += text;
      let newline;
      while ((newline = streamBuffer.indexOf('\n')) >= 0) {
        const line = streamBuffer.slice(0, newline);
        streamBuffer = streamBuffer.slice(newline + 1);
        if (line.startsWith('LIVE_TRIAL ')) {
          try {
            const info = JSON.parse(line.slice('LIVE_TRIAL '.length));
            const model = info.serverModels?.length ? info.serverModels.join(',') : 'unknown';
            console.log(`[ego ${info.trialId?.split('/')?.[1] ?? '?'} r${info.trialId?.split('/')?.[2] ?? '?'}] ${info.status}` +
              ` engine=${info.engine ?? 'null'} reason=${info.reason ?? 'null'} latency=${info.latencyMs ?? '?'}ms` +
              ` asks=${info.logicalAskCalls ?? '?'} http=${info.httpRequests ?? 'null'} model=${model}`);
          } catch {
            /* ignore malformed progress line; raw result is authoritative */
          }
        }
      }
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.stdin.on('error', () => {});
    child.stdin.end(script);
    const code = await new Promise((resolveCode) => child.once('close', resolveCode));
    clearTimeout(timer);
    cleanup.childExitCode = code;
    if (cleanup.childTimedOut) {
      status = 'failed';
      reason = 'ego child timed out; TaskSpace cleanup unconfirmed';
      cleanup.ok = false;
      cleanup.errors.push(reason);
    }
    let data = null;
    try {
      data = JSON.parse(await readFile(resultFile, 'utf8'));
    } catch (err) {
      throw new Error(`unreadable ego result (exit ${code}): ${String(err?.message || err)}; tail=${combined.slice(-1500)}`);
    }
    report = data?.report ?? null;
    const childCleanup = data?.cleanup ?? {};
    cleanup.taskSpaceFinished = childCleanup.taskSpaceFinished === true;
    cleanup.pagesBeforeFinish = childCleanup.pagesBeforeFinish ?? [];
    if (childCleanup.errors?.length) cleanup.errors.push(...childCleanup.errors);
    if (childCleanup.ok === false || !cleanup.taskSpaceFinished) {
      cleanup.ok = false;
      if (!cleanup.errors.length) cleanup.errors.push('TaskSpace cleanup not confirmed');
    }
    if (code !== 0) {
      cleanup.ok = false;
      cleanup.errors.push(`ego child exited ${code}`);
    }
    if (!report || !Array.isArray(report.trials)) {
      throw new Error('ego result has no trial report');
    }
    trials = report.trials;
    notRun = report.notRun ?? [];
    if (trials.length + notRun.length !== plan.length) {
      status = 'failed';
      reason = `expected ${plan.length} trials, completed ${trials.length}, notRun ${notRun.length}`;
    }
    if (cleanup.ok === false) {
      status = 'failed';
      reason = reason ?? cleanup.errors.join('; ');
    }
  } catch (err) {
    status = 'failed';
    reason = String(err?.message || err);
    cleanup.ok = false;
    cleanup.errors.push(reason);
  } finally {
    if (staged) {
      try {
        await rm(staged.stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        cleanup.stageRemoved = !(await exists(staged.stage));
      } catch (err) {
        cleanup.stageRemoved = false;
        cleanup.ok = false;
        cleanup.errors.push(`staged files removal failed: ${String(err?.message || err)}`);
      }
      if (cleanup.stageRemoved === false) cleanup.ok = false;
    }
  }
  return { host: 'ego', status, reason, hostVersion: env.egoVersion, trials, notRun, cleanup };
}

function normalizeOutcome(outcome, host, plan) {
  const trials = Array.isArray(outcome?.trials) ? outcome.trials : [];
  const notRun = Array.isArray(outcome?.notRun) ? outcome.notRun : [];
  const cleanup = outcome?.cleanup ?? { ok: true, errors: [] };
  const complete = trials.length + notRun.length === plan.length;
  let status = outcome?.status ?? 'completed';
  if (!complete) status = 'failed';
  if (cleanup?.ok === false) status = 'failed';
  const reason = outcome?.reason ?? (complete ? null : `expected ${plan.length} trials, completed ${trials.length}, notRun ${notRun.length}`);
  return {
    host,
    status,
    reason,
    hostVersion: outcome?.hostVersion ?? null,
    cleanup,
    trialIds: trials.map((trial) => trial.trialId),
    notRunIds: notRun.map((trial) => trial.trialId),
    trials,
    notRun,
  };
}

async function computeGitHead() {
  const result = await runCommand('git', ['rev-parse', 'HEAD'], 10000);
  return result.code === 0 ? result.stdout.trim() : null;
}

async function computeRunnerInfo() {
  const files = [
    'bench/live-benchmark/run.mjs',
    'bench/live-benchmark/suite.mjs',
    'bench/live-benchmark/tasks.mjs',
    'bench/live-benchmark/verifiers.mjs',
    'scripts/decider-loop.mjs',
  ];
  const hashes = [];
  for (const rel of files) {
    const abs = join(REPO, rel);
    if (!(await exists(abs))) continue;
    hashes.push({ path: rel, sha256: createHash('sha256').update(await readFile(abs)).digest('hex') });
  }
  return { node: process.version, platform: process.platform, arch: process.arch, files: hashes };
}

export async function runLiveBenchmark(args, deps = {}) {
  if (!args?.live) throw new Error('live benchmark requires explicit --live');
  const hosts = selectHosts(args.hosts);
  const tasks = selectTasks(args.tasks);
  const plan = hosts.flatMap((host) =>
    tasks.flatMap((task) => Array.from({ length: args.rounds }, (_, index) => ({ host, taskId: task.id, round: index + 1 })))
  );
  const env = await (deps.resolveEnv ?? resolveEnvironment)(args);
  const readiness = preflightHosts({
    hosts,
    endpoint: env.endpoint,
    chromeAvailable: env.chromeAvailable,
    egoAvailable: env.egoAvailable,
    credentialOk: env.credentialOk,
  });
  const ready = new Set(readiness.filter((item) => item.status === 'ready').map((item) => item.host));
  const order = plan.filter((item) => ready.has(item.host)).map((item) => `${item.host}/${item.taskId}/r${item.round}`);
  const hostOutcomes = [];
  const runner = deps.runHost ?? (async (host, ctx) => (host === 'ego' ? runEgoLeg(ctx) : runCdpLeg(ctx)));

  for (const host of hosts) {
    const pre = readiness.find((item) => item.host === host);
    if (pre?.status !== 'ready') {
      hostOutcomes.push({
        host,
        status: 'skipped',
        reason: pre?.reason ?? 'host is not ready',
        hostVersion: null,
        cleanup: { ok: true, skipped: true, errors: [] },
        trialIds: [],
        trials: [],
      });
      continue;
    }
    const hostPlan = plan.filter((item) => item.host === host);
    let outcome;
    try {
      outcome = normalizeOutcome(await runner(host, { args, plan: hostPlan, env, engine }), host, hostPlan);
    } catch (err) {
      outcome = normalizeOutcome({
        status: 'failed',
        reason: String(err?.message || err),
        cleanup: { ok: false, errors: [String(err?.message || err)] },
        trials: [],
      }, host, hostPlan);
    }
    hostOutcomes.push(outcome);
  }

  const trials = hostOutcomes.flatMap((outcome) => outcome.trials ?? []);
  const summary = summarizeLive(trials, { hosts: hostOutcomes, expectedTrials: plan.length, order });
  const harnessFailed = hostOutcomes.some((outcome) => outcome.status === 'failed') || summary.cleanupFailures.length > 0;
  const skipped = hostOutcomes.some((outcome) => outcome.status === 'skipped');
  const status = harnessFailed || summary.failedTrials > 0
    ? 'failed'
    : skipped || summary.notRun > 0 || !summary.complete
      ? 'incomplete'
      : 'passed';
  const generatedAt = new Date().toISOString();
  const repoHead = deps.gitHead ?? (await computeGitHead());
  const runnerInfo = deps.runnerInfo ?? (await computeRunnerInfo());
  const report = {
    schemaVersion: 1,
    suiteVersion: TASK_VERSION,
    generatedAt,
    status,
    complete: summary.complete,
    repoHead,
    runner: runnerInfo,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      egoBrowserVersion: env.egoVersion ?? null,
      chromePath: env.chromePath ?? null,
      chromeAvailable: Boolean(env.chromeAvailable),
      externalEndpoint: Boolean(env.endpoint),
      credentialPresent: Boolean(env.credentialOk),
      credentialSource: 'file chain; value never read into the report',
    },
    order,
    hosts: hostOutcomes.map(({ trials: _trials, ...rest }) => rest),
    trials,
    summary,
    limitations: [
      `Small first batch: ${tasks.length} tasks x ${hosts.length} hosts x ${args.rounds} rounds = ${plan.length} requested trials; this is not a population success rate.`,
      'Wikipedia has historically been variable under a 5-step budget. Wiki failures are retained in the raw file and are not retried or re-budgeted.',
      'The logical ask budget counts wrapper calls, not HTTP attempts; backend fallback can produce more than one HTTP request per ask, reported separately as httpRequests.',
      'Engine wall-clock timeout is enforced by a harness gate: after the timeout every later page/CDP call is rejected before dispatch, and host cleanup still runs.',
      'Initial navigation is outside the engine wall-clock budget but included in total latency.',
      'costUsd and humanTakeover are null: no pricing is asserted and takeover is not instrumented in this batch.',
      'Only the local macOS environment (ego lite / headless Chrome) was measured; Windows and Linux hosts were not verified.',
      'Condition fields in the task manifest stay unknown; the verifier records observed password/captcha/region markers, and absence of a marker is not proof of absence.',
    ],
  };
  return report;
}

export function exitCodeFor(report) {
  if (!report) return 2;
  if (report.status === 'passed') return 0;
  if (report.status === 'failed') return 1;
  return 2;
}

export function sanitizeText(value) {
  let text = String(value ?? '');
  text = text.replaceAll(REPO, '<repo>');
  text = text.replaceAll(homedir(), '~');
  text = text.replace(/\/var\/folders\/[^\s"'<>]+/g, '<tmp>');
  text = text.replace(/\/tmp\/[^\s"'<>]+/g, '<tmp>');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer <redacted>');
  text = text.replace(/TYPESAFE_API_KEY\s*=\s*[^\s"'<>]+/gi, 'TYPESAFE_API_KEY=<redacted>');
  text = text.replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*")[^"]+/gi, '$1<redacted>');
  return text;
}

function sanitizeValue(value) {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = sanitizeValue(child);
    return out;
  }
  return value;
}

function printReport(report) {
  for (const host of report.hosts) {
    console.log(`HOST ${host.host} status=${host.status} version=${host.hostVersion ?? 'unknown'}` +
      (host.reason ? ` reason=${host.reason}` : '') +
      ` cleanup=${host.cleanup?.ok === false ? 'FAILED' : 'ok'}`);
  }
  const summary = report.summary;
  console.log(`SUMMARY trials=${summary.total}/${summary.expectedTrials} verified=${summary.verified}` +
    ` verifierOk=${summary.verifierOk} notRun=${summary.notRun} failed=${summary.failedTrials}` +
    ` falseSuccess=${summary.falseSuccess}` +
    ` engineSuccess=${summary.engineSuccessRate == null ? 'null' : summary.engineSuccessRate.toFixed(3)}` +
    ` verifiedRate=${summary.verifiedRate == null ? 'null' : summary.verifiedRate.toFixed(3)}`);
  for (const row of summary.byHostTask) {
    console.log(`  ${row.host}/${row.taskId}: ${row.verified}/${row.rounds} passed` +
      ` verifierOk=${row.verifierOk}` +
      ` medianEngine=${row.medianEngineLatencyMs ?? 'null'}ms medianTotal=${row.medianTotalMs ?? 'null'}ms` +
      ` asks=${row.logicalAskCalls} http=${row.httpRequests ?? 'null'}`);
  }
  if (summary.notRunIds.length) console.log(`NOT_RUN ${summary.notRunIds.join(',')}`);
  console.log(`FAILURE_CONSUMPTION ${JSON.stringify(summary.failureConsumption)}`);
  if (summary.falseSuccessTrials.length) console.log(`FALSE_SUCCESS_TRIALS ${summary.falseSuccessTrials.join(',')}`);
  if (summary.cleanupFailures.length) console.log(`CLEANUP_FAILURES ${JSON.stringify(summary.cleanupFailures)}`);
  if (summary.skippedHosts.length) console.log(`SKIPPED_HOSTS ${JSON.stringify(summary.skippedHosts)}`);
  console.log(`STATUS ${report.status} (${report.complete ? 'complete' : 'incomplete'})`);
}

if (isMainModule()) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(USAGE);
      process.exitCode = 0;
    } else if (!args.live) {
      console.error('REFUSED: live benchmark requires explicit --live (network + credentials + browser).');
      console.log(USAGE);
      process.exitCode = 2;
    } else {
      const report = await runLiveBenchmark(args);
      const out = args.out
        ? resolveUserPath(args.out)
        : join(REPO, 'bench/live-benchmark/raw', `live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(sanitizeValue(report), null, 2)}\n`);
      printReport(report);
      console.log(`RAW ${out}`);
      process.exitCode = exitCodeFor(report);
    }
  } catch (err) {
    console.error(`FAIL: ${sanitizeText(err?.stack || err?.message || err)}`);
    process.exitCode = 2;
  }
}
