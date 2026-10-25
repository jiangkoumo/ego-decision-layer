import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const here = fileURLToPath(new URL('.', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
async function start(extra = []) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [here + 'test-fixture.mjs', ...extra], cwd: here, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', data => { stderr += data.toString(); });
  const client = new Client({ name: 'mcp-offline-test', version: '1' });
  await client.connect(transport);
  const call = async (name, args, options) => {
    const r = await client.callTool({ name, arguments: args }, undefined, options);
    assert.deepEqual(r.structuredContent, JSON.parse(r.content[0].text));
    return { ...r.structuredContent, isError: r.isError };
  };
  return { client, transport, call, logs: () => stderr };
}
async function until(fn) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(20); }
  assert.fail('condition exceeded 4s budget');
}
const args = { url: 'about:blank', goal: 'verify blank', until: 'about:blank', text: ['sample'], taskId: 'normal' };
const app = await start();
try {
  const list = await app.client.listTools();
  check(list.tools.map(t => t.name).join(',') === 'browser_task,browser_task_status,browser_task_cancel', 'tool discovery');
  for (const invalid of [null, {}, { ...args, goal: '' }, { ...args, until: '' }, { ...args, url: 'file:///etc/passwd' }, { ...args, text: [7] }, { ...args, taskId: '' }, { ...args, keepPage: true }, { ...args, url: 'https://u:p@example.com' }]) {
    // The SDK's own schema rejects a null argument map before our handler; both are protocol errors.
    await assert.rejects(app.call('browser_task', invalid), e => e.code === -32602 || (invalid === null && e.code === -32603)); checks++;
  }
  await assert.rejects(app.call('no_such_tool', {}), e => e.code === -32602); checks++;
  check(!app.logs().includes('fixture:connect'), 'invalid arguments cause zero connections');
  const normal = await app.call('browser_task', args);
  check(normal.result.success && normal.result.verified && normal.result.untilVerification === 'final_url', 'verified result via actual P1 runner');
  check(normal.result.connection.released && normal.result.connection.receipt.targetClosed, 'success closes owned page and releases connection');
  check(Array.isArray(normal.result.actions) && normal.result.actions.length === 0, 'empty executed action list is explicit');
  const repeat = await app.call('browser_task', args);
  check(repeat.replayed && repeat.taskId === normal.taskId && repeat.instanceId === normal.instanceId, 'retry reuses prior record');
  const conflict = await app.call('browser_task', { ...args, goal: 'changed' });
  check(conflict.isError && conflict.reason === 'task_id_conflict', 'same id with different input rejected');
  check(app.logs().split('fixture:connect').length - 1 === 1, 'retry and conflict do not reconnect');
  const unknown = await app.call('browser_task_status', { taskId: 'unknown' });
  check(unknown.isError && unknown.safeToRetry === false, 'missing id is not safe-to-retry evidence');
  for (const goal of ['model_done', 'miss', 'partial', 'throw']) {
    const value = await app.call('browser_task', { ...args, goal, until: 'never-match', taskId: goal });
    check(value.isError && !value.result.success && !value.result.verified, goal + ' fails closed');
    check(value.result.connection.released && value.result.connection.keepPage, goal + ' releases connection while retaining evidence page');
    if (goal === 'partial') check(value.result.actions[0].dispatched && value.result.actions[0].batchPartial && value.result.outcomeUnknown, 'partial dispatched evidence retained');
    if (goal === 'throw') check(value.result.outcomeUnknown && value.result.actions === null, 'lost execution history remains unknown');
  }
  const pending = app.call('browser_task', { ...args, goal: 'wait', taskId: 'explicit-cancel' });
  await until(() => app.logs().includes('fixture:waiting'));
  const duplicate = await app.call('browser_task', { ...args, goal: 'wait', taskId: 'explicit-cancel' });
  check(duplicate.state === 'running' && duplicate.replayed, 'duplicate in-flight call never starts another execution');
  const cancel = await app.call('browser_task_cancel', { taskId: 'explicit-cancel' });
  check(cancel.cancelRequested, 'explicit cancel acknowledged');
  const cancelled = await pending;
  check(cancelled.result.cancelled && cancelled.result.outcomeUnknown && cancelled.result.connection.released, 'cancel stops and finally releases with unknown side effects');
  const controller = new AbortController();
  const before = app.logs().split('fixture:waiting').length;
  const protocolPending = app.call('browser_task', { ...args, goal: 'wait', taskId: 'protocol-cancel' }, { signal: controller.signal }).then(() => null, e => e);
  await until(() => app.logs().split('fixture:waiting').length > before);
  controller.abort();
  check(await protocolPending instanceof Error, 'MCP notification cancellation rejects client request');
  const final = await until(async () => {
    const state = await app.call('browser_task_status', { taskId: 'protocol-cancel' });
    return state.state === 'finished' ? state : null;
  });
  check(final.result.cancelled && final.result.connection.released, 'status recovers final evidence after protocol cancellation');
  const cancelAgain = await app.call('browser_task_cancel', { taskId: 'protocol-cancel' });
  check(cancelAgain.state === 'finished', 'cancel finished task is idempotent');
  const noKey = await start(['--missing-key']);
  try {
    const rejected = await noKey.call('browser_task', args);
    check(rejected.isError && rejected.result.reason === 'preflight_error' && rejected.result.exitCode === 3, 'missing credentials fail closed');
    check(!noKey.logs().includes('fixture:connect'), 'missing credentials never connects');
  } finally { await noKey.client.close(); }
  const eof = await start();
  try {
    const childPid = eof.transport.pid;
    const inflight = eof.call('browser_task', { ...args, goal: 'wait', taskId: 'eof' }).catch(e => e);
    await until(() => eof.logs().includes('fixture:waiting'));
    await eof.client.close();
    await inflight;
    check(eof.logs().includes('fixture:released:true'), 'stdio EOF cancels task and releases connection');
    let alive = true; try { process.kill(childPid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    check(!alive, 'stdio server process exits after EOF');
  } finally { await eof.client.close(); }
  for (let i = 0; i < 5; i++) await app.call('browser_task', { ...args, taskId: 'capacity-' + i });
  const full = await app.call('browser_task', { ...args, taskId: 'over-capacity' });
  check(full.isError && full.reason === 'task_capacity_reached', 'capacity refuses work instead of evicting retry evidence');
  check((await app.call('browser_task', args)).replayed, 'old id remains protected at capacity');
} finally { await app.client.close(); }
console.log(`MCP stdio: ${checks} passed, 0 failed (offline injected host/engine; no real browser/model)`);
