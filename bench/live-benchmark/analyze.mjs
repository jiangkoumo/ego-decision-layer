#!/usr/bin/env node
// Offline only: node bench/live-benchmark/analyze.mjs RAW.json [RAW.json ...]
// Never imports the runner/engine, opens a browser, calls a model, or rewrites raw.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeLive } from './suite.mjs';

const finiteMs = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function distribution(values) {
  const sorted = values.filter(finiteMs).sort((a, b) => a - b);
  const at = (p) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  const mid = Math.floor(sorted.length / 2);
  return {
    count: sorted.length, unknown: values.length - sorted.length,
    minMs: sorted[0] ?? null,
    medianMs: sorted.length ? sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2 : null,
    p95Ms: at(0.95), maxMs: sorted.at(-1) ?? null,
  };
}

// Observed failure categories, not inferred root causes. Multiple observations
// can describe the same failed trial and must not be summed as unique failures.
function failureModes(trial) {
  if (trial.status === 'NOT_RUN') return ['not_run'];
  if (trial.taskPassed === true) return [];
  const modes = [];
  if (trial.falseSuccess) modes.push('engine_success_verifier_rejected');
  if (trial.engine?.navigationError) modes.push('navigation_error');
  if (trial.engine?.timedOut) modes.push('wall_clock_budget');
  if (trial.engine?.unsettled || trial.unsettled) modes.push('engine_inflight_at_report');
  if (trial.engine?.requestBudgetExceeded) modes.push('logical_ask_budget');
  if (trial.engine?.stepBudgetExceeded) modes.push('step_budget');
  if (trial.engine?.thrown) modes.push('exception');
  if (trial.verifierOk === false || trial.verifier?.ok === false) modes.push('verifier_rejected');
  if (trial.history?.some((step) => step.guardRejected)) modes.push('guard_rejected');
  if (trial.history?.some((step) => step.staleTarget || step.targetMissing)) modes.push('target_unavailable');
  if (trial.history?.some((step) => step.error)) modes.push('step_error');
  if (trial.history?.length && trial.history.every((step) => !step.changed)) modes.push('no_observed_progress');
  if (!modes.length) modes.push('engine_not_successful_or_unknown');
  return modes;
}

function timing(rows) {
  const known = rows.filter((row) => row.diagnostics?.version === 1);
  const asks = known.flatMap((row) => row.diagnostics.asks ?? []);
  const calls = known.flatMap((row) => row.diagnostics.browserCalls ?? []);
  const completedDuration = (row) => row.status === 'inflight' ? null : row.durationMs;
  const methods = [...new Set(calls.map((call) => `${call.scope}/${call.method}`))].sort();
  return {
    total: distribution(rows.map((row) => row.metrics?.latencyMs)),
    engine: distribution(rows.map((row) => row.metrics?.engineLatencyMs)),
    navigation: distribution(rows.map((row) => row.metrics?.navigationMs)),
    verifier: distribution(rows.map((row) => row.metrics?.verifyMs)),
    diagnostics: {
      availableTrials: known.length, unknownTrials: rows.length - known.length,
      droppedAsks: known.reduce((sum, row) => sum + (row.diagnostics.dropped?.asks ?? 0), 0),
      droppedBrowserCalls: known.reduce((sum, row) => sum + (row.diagnostics.dropped?.browserCalls ?? 0), 0),
      recorderErrors: known.reduce((sum, row) => sum + (row.diagnostics.errors ?? 0), 0),
      modelAsk: distribution(asks.map(completedDuration)),
      browserCall: distribution(calls.map(completedDuration)),
      inflightAsks: asks.filter((row) => row.status === 'inflight').length,
      inflightBrowserCalls: calls.filter((row) => row.status === 'inflight').length,
      byBrowserMethod: methods.map((method) => ({
        method, ...distribution(calls.filter((call) => `${call.scope}/${call.method}` === method).map(completedDuration)),
      })),
      settleMs: null,
    },
  };
}

export function analyzeReport(raw) {
  const rows = Array.isArray(raw.trials) ? raw.trials : [];
  const notRun = (raw.hosts ?? []).flatMap((host) => host.notRun ?? []);
  const summary = summarizeLive(rows, {
    hosts: raw.hosts ?? [], expectedTrials: raw.summary?.expectedTrials ?? rows.length + notRun.length,
    order: raw.order ?? [],
  });
  const modes = new Map();
  for (const row of [...rows, ...notRun]) {
    for (const mode of failureModes(row)) modes.set(mode, (modes.get(mode) ?? 0) + 1);
  }
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.host}/${row.taskId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return {
    analysisVersion: 1,
    scope: 'Only the supplied recorded trials; not a site-wide or population success rate. Failure modes are overlapping observations, not proven causes.',
    timingNote: 'Model asks and public page/CDP calls are inclusive elapsed intervals, may overlap each other and engine phases, and cannot be added. Model asks include fallback/HTTP/response handling. Inflight duration, unmeasured waits and settle remain unknown; capped samples are partial.',
    outcomes: {
      total: summary.total, verified: summary.verified, verifierOk: summary.verifierOk,
      failedTrials: summary.failedTrials, falseSuccess: summary.falseSuccess, notRun: summary.notRun,
    },
    cleanup: (raw.hosts ?? []).map((host) => ({
      host: host.host, ok: host.cleanup?.ok ?? null,
      targetClosed: host.cleanup?.targetClosed ?? null,
      processStopped: host.cleanup?.processStopped ?? null,
      profileRemoved: host.cleanup?.profileRemoved ?? null,
      taskSpaceFinished: host.cleanup?.taskSpaceFinished ?? null,
      stageRemoved: host.cleanup?.stageRemoved ?? null,
    })),
    failureModes: [...modes].sort(([a], [b]) => a.localeCompare(b)).map(([mode, count]) => ({ mode, count })),
    timing: timing(rows),
    byHostTask: [...groups].map(([hostTask, group]) => ({ hostTask, trials: group.length, timing: timing(group) })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 1 && files[0] === '--help') {
    console.log('Usage: node bench/live-benchmark/analyze.mjs RAW.json [RAW.json ...]\nOffline analysis only; source files are never changed.');
  } else if (!files.length || files.some((file) => file.startsWith('-'))) {
    console.error('Usage: node bench/live-benchmark/analyze.mjs RAW.json [RAW.json ...]');
    process.exitCode = 2;
  } else {
    try {
      const analyses = [];
      for (const file of files) analyses.push(analyzeReport(JSON.parse(await readFile(resolve(file), 'utf8'))));
      console.log(JSON.stringify(analyses.length === 1 ? analyses[0] : analyses, null, 2));
    } catch {
      // JSON parse errors may quote sensitive source text. Never echo them.
      console.error('FAIL: unable to read or analyze the supplied raw JSON.');
      process.exitCode = 1;
    }
  }
}
