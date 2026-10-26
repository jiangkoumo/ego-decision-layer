#!/usr/bin/env node
// Node owns orchestration only; both legs import the same task runner and engine.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCdpHost } from '../../scripts/hosts/cdp-host.mjs';
import { runCommonBenchmark } from './suite.mjs';
import { VERSION } from './tasks.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function parseArgs(argv) {
  const args = { hosts: 'both' };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === '--help') { args.help = true; continue; }
    if (!['--hosts', '--endpoint', '--chrome', '--ego', '--out'].includes(name)) throw new Error(`Unknown option: ${name}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${name}`);
    args[name.slice(2)] = value;
  }
  if (!['both', 'ego', 'cdp'].includes(args.hosts)) throw new Error('hosts must be both, ego or cdp');
  return args;
}

// A complete task report is necessary, but owned-resource cleanup must also be confirmed.
export function hostStatus(report, cleanup) {
  const cleaned = cleanup?.taskSpaceFinished === true ||
    (cleanup?.target?.targetClosed === true && (!cleanup.pid || cleanup.processStopped === true));
  return report?.summary.complete === true && report.summary.failed === 0 &&
    report.notRun?.length === 0 && cleaned && !cleanup.error ? 'passed' : 'failed';
}

async function stopChild(child) {
  if (!child?.pid) return;
  const stopped = () => child.exitCode !== null || child.signalCode !== null;
  if (!stopped()) {
    child.kill('SIGTERM');
    const deadline = Date.now() + 5000;
    while (!stopped() && Date.now() < deadline) await sleep(25);
  }
  if (!stopped()) {
    child.kill('SIGKILL');
    await new Promise(r => child.once('close', r));
  }
  try { process.kill(child.pid, 0); }
  catch (err) { if (err.code === 'ESRCH') return; throw err; }
  throw new Error(`Child still alive: ${child.pid}`);
}

async function cdpLeg(args) {
  const chromePath = args.chrome ?? process.env.EGO_CDP_CHROME ?? (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null);
  if (!args.endpoint) {
    if (!chromePath) return { host: 'cdp', status: 'skipped', reason: 'No Chrome path; supply --chrome or --endpoint' };
    try { await access(chromePath); }
    catch (err) {
      if (err.code === 'ENOENT') return { host: 'cdp', status: 'skipped', reason: `Chrome unavailable: ${chromePath}` };
      throw err;
    }
  }
  let child, temp, host, outcome;
  const cleanup = {};
  try {
    let endpoint = args.endpoint;
    if (!endpoint) {
      temp = await mkdtemp(join(tmpdir(), 'ego-p2-bench-'));
      child = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check',
        '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + temp, 'about:blank'],
      { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'] });
      cleanup.pid = child.pid;
      let log = '', launchError;
      child.on('error', err => { launchError = err; });
      child.stderr.on('data', data => { log = (log + data.toString()).slice(-16000); });
      const deadline = Date.now() + 15000;
      while (!endpoint && Date.now() < deadline) {
        if (launchError) throw launchError;
        if (child.exitCode !== null) throw new Error('Chrome exited before CDP was ready');
        endpoint = log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1];
        if (!endpoint) await sleep(50);
      }
      if (!endpoint) throw new Error('Chrome CDP startup timed out');
    }
    host = await connectCdpHost({ endpoint, timeoutMs: 10000, commandTimeoutMs: 15000 });
    const report = await runCommonBenchmark(host.page, { host: 'cdp' });
    outcome = { host: 'cdp', status: report.summary.complete && report.summary.failed === 0 ? 'passed' : 'failed',
      browserVersion: host.metadata?.browserVersion, report };
  } catch (err) { outcome = { host: 'cdp', status: 'failed', reason: err.message }; }
  finally {
    try {
      if (host) {
        cleanup.target = await host.close({ keepPage: false });
        if (cleanup.target.targetClosed !== true) throw new Error('CDP target cleanup not confirmed');
      }
    } catch (err) { cleanup.error = err.message; }
    try { await stopChild(child); if (child?.pid) cleanup.processStopped = true; }
    catch (err) { cleanup.error = err.message; }
    if (temp && (!child?.pid || cleanup.processStopped)) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (cleanup.error) outcome = { ...outcome, status: 'failed' };
  }
  return { ...outcome, ...(outcome.report ? { status: hostStatus(outcome.report, cleanup) } : {}), cleanup };
}

async function stageFiles() {
  const stage = await mkdtemp(join(tmpdir(), 'ego-p2-stage-'));
  const files = ['bench/common-benchmark/suite.mjs', 'bench/common-benchmark/tasks.mjs',
    'bench/host-acceptance/suite.mjs', 'bench/host-acceptance/tasks.mjs', 'scripts/decider-loop.mjs'];
  const copied = [];
  for (const rel of files) {
    const dest = join(stage, rel);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(join(repo, rel), dest);
    const digest = async p => createHash('sha256').update(await readFile(p)).digest('hex');
    const [from, to] = [await digest(join(repo, rel)), await digest(dest)];
    if (from !== to) throw new Error(`Staged copy differs: ${rel}`);
    copied.push({ path: rel, sha256: from });
  }
  return { stage, copied };
}

async function egoLeg(args) {
  const executable = args.ego ?? 'ego-browser';
  // The ego loader stalls when importing modules from this LayerFS workspace path
  // (reproduced: same bytes load instantly from /tmp or ~/LayerFS). Stage a
  // byte-identical copy (sha256 checked) and import that; the staged path is reported.
  let stage;
  try { stage = await stageFiles(); }
  catch (err) { return { host: 'ego', status: 'failed', reason: `Cannot stage benchmark modules: ${err.message}` }; }
  const entry = join(stage.stage, 'bench/common-benchmark/suite.mjs');
  // ASCII bootstrap; module path and result file are absolute. The result goes to a
  // file because the ego runtime truncates very long console lines.
  const resultFile = join(stage.stage, 'result.json');
  const script = `const fs=await import('node:fs/promises');
const {runCommonBenchmark}=await import(${JSON.stringify(entry)});
const space=await taskSpace('ego-p2-common-'+Date.now());
let report;
const cleanup={spaceId:space.spaceId,taskSpaceFinished:false};
try {report=await runCommonBenchmark(space.page('p1'),{host:'ego'});}
finally {await space.finish({keep:[]});cleanup.taskSpaceFinished=true;}
await fs.writeFile(${JSON.stringify(resultFile)},JSON.stringify({report,cleanup}));
console.log('P2_RESULT_WRITTEN');`;
  const child = spawn(executable, ['nodejs'], { cwd: repo, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', combined = '', launchError, timedOut = false;
  // ego-browser writes task output on stderr, so both streams are scanned.
  child.stdout.on('data', data => { stdout += data.toString(); combined = (combined + data.toString()).slice(-200000); });
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-4000); combined = (combined + data.toString()).slice(-200000); });
  child.stdin.on('error', () => {});
  child.on('error', err => { launchError = err; });
  const timer = setTimeout(() => { timedOut = true; stopChild(child).catch(() => {}); }, 150000);
  child.stdin.end(script);
  const code = await new Promise(r => child.once('close', r));
  clearTimeout(timer);
  const staged = { stagedFrom: 'repo root', files: stage.copied, reason: 'ego loader stalls on this workspace path' };
  try {
    if (launchError?.code === 'ENOENT') return { host: 'ego', status: 'skipped', reason: `ego-browser unavailable: ${executable}`, staged };
    const line = combined.split('\n').find(l => l.includes('P2_RESULT_WRITTEN'));
    if (timedOut || launchError || !line || code !== 0) return { host: 'ego', status: 'failed', staged,
      reason: timedOut ? 'Ego process timeout; TaskSpace cleanup unconfirmed' : launchError?.message ?? `No complete result (exit ${code}): ${stderr || combined.slice(-2000)}` };
    let report, cleanup;
    try { ({ report, cleanup } = JSON.parse(await readFile(resultFile, 'utf8'))); }
    catch (err) { return { host: 'ego', status: 'failed', staged, reason: `Unreadable result file: ${err.message}` }; }
    return { host: 'ego', status: hostStatus(report, cleanup),
      report, staged, cleanup };
  } finally { await rm(stage.stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

export async function run(args) {
  const hosts = [];
  // Sequential: both suites fence global fetch and must not race in this process.
  for (const host of ['cdp', 'ego']) {
    if (args.hosts !== 'both' && args.hosts !== host) continue;
    hosts.push(await (host === 'cdp' ? cdpLeg(args) : egoLeg(args)));
  }
  return { schemaVersion: 1, taskSet: VERSION, generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    hosts, complete: hosts.every(h => h.status === 'passed'),
    status: hosts.some(h => h.status === 'failed') ? 'failed' : hosts.some(h => h.status === 'skipped') ? 'incomplete' : 'passed' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) console.log('node bench/common-benchmark/run.mjs [--hosts both|ego|cdp] [--endpoint URL | --chrome PATH] [--ego PATH] [--out FILE]\nExit: 0 all requested hosts passed; 1 failure; 2 skipped/incomplete or usage error');
    else {
      const report = await run(args);
      if (args.out) await writeFile(resolve(args.out), JSON.stringify(report, null, 2) + '\n');
      for (const h of report.hosts) console.log(JSON.stringify({ host: h.host, status: h.status, reason: h.reason, summary: h.report?.summary, cleanup: h.cleanup }));
      process.exitCode = report.status === 'passed' ? 0 : report.status === 'failed' ? 1 : 2;
    }
  } catch (err) { console.error(err.message); process.exitCode = 2; }
}
