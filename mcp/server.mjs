#!/usr/bin/env node
// Optional stdio boundary. Browser execution and cleanup stay in the P1 runner.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { format } from 'node:util';
import { runCdpTask, CdpTaskError } from '../scripts/run-cdp-task.mjs';

const idSchema = { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,128}$' };
const taskSchema = {
  type: 'object', additionalProperties: false, required: ['url', 'goal', 'until'],
  properties: {
    url: { type: 'string', minLength: 1, maxLength: 8192 },
    goal: { type: 'string', minLength: 1, maxLength: 16000 },
    until: { type: 'string', minLength: 1, maxLength: 8192 },
    text: { anyOf: [{ type: 'string', maxLength: 16000 }, { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 16000 } }] },
    taskId: idSchema,
  },
};
const lookupSchema = { type: 'object', additionalProperties: false, required: ['taskId'], properties: { taskId: idSchema } };
const tools = [
  { name: 'browser_task', description: 'Run a bounded browser task on a NEW owned page. until is a final URL substring, not a model judgment. Supply a stable taskId before starting so cancellation/retry can query the same record. Same id never reruns in this server process; new ids MAY repeat side effects.', inputSchema: taskSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
  { name: 'browser_task_status', description: 'Read a task record without browser calls. Unknown means no record in THIS process, not proof that an earlier process did nothing.', inputSchema: lookupSchema, annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
  { name: 'browser_task_cancel', description: 'Request cooperative cancellation. Query status until finished; cancellation does not roll back dispatched actions. This response is not proof of connection release.', inputSchema: lookupSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];
const invalid = message => { throw new McpError(ErrorCode.InvalidParams, message); };
function validate(args, task = false) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) invalid('arguments must be an object');
  const allowed = task ? Object.keys(taskSchema.properties) : ['taskId'];
  if (Object.keys(args).some(key => !allowed.includes(key))) invalid('unknown argument');
  if ((!task || args.taskId !== undefined) && (typeof args.taskId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(args.taskId))) invalid('invalid taskId');
  if (!task) return args;
  for (const [key, max] of [['url', 8192], ['goal', 16000], ['until', 8192]]) {
    if (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > max) invalid(`invalid ${key}`);
  }
  let url;
  try { url = new URL(args.url); } catch { invalid('url must be absolute'); }
  if (!['http:', 'https:'].includes(url.protocol) && args.url !== 'about:blank') invalid('url must be http(s) or about:blank');
  if (url.username || url.password) invalid('url must not contain credentials');
  const texts = args.text === undefined ? [] : typeof args.text === 'string' ? [args.text] : args.text;
  if (!Array.isArray(texts) || texts.length > 50 || texts.some(t => typeof t !== 'string' || t.length > 16000)) invalid('invalid text');
  return { url: args.url, goal: args.goal.trim(), until: args.until, texts };
}

// Config comes from the server operator, never from tool arguments.
export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('config must be an object');
  const allowed = ['cdpEndpoint', 'cdpTimeoutMs', 'steps', 'deciderConfig', 'forceViewport'];
  if (Object.keys(config).some(key => !allowed.includes(key))) throw new Error('unsupported MCP config field');
  let endpoint;
  try { endpoint = new URL(config.cdpEndpoint); } catch { throw new Error('config needs cdpEndpoint'); }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('invalid cdpEndpoint');
  if (config.steps !== undefined && (!Number.isSafeInteger(config.steps) || config.steps < 1 || config.steps > 200)) throw new Error('steps must be 1..200');
  if (config.cdpTimeoutMs !== undefined && (!Number.isSafeInteger(config.cdpTimeoutMs) || config.cdpTimeoutMs < 1 || config.cdpTimeoutMs > 60000)) throw new Error('cdpTimeoutMs must be 1..60000');
  if (config.deciderConfig !== undefined && (!config.deciderConfig || typeof config.deciderConfig !== 'object' || Array.isArray(config.deciderConfig))) throw new Error('invalid deciderConfig');
  if (config.forceViewport !== undefined && (typeof config.forceViewport !== 'string' || !/^\d+x\d+(@\d+(\.\d+)?)?$/.test(config.forceViewport))) throw new Error('invalid forceViewport');
  return { ...config };
}
function reply(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError };
}

export async function createBrowserTaskServer(config, { runner = runCdpTask, runnerDeps = {}, maxRecords = 100 } = {}) {
  config = validateConfig(config);
  const version = (await readFile(new URL('../SKILL.md', import.meta.url), 'utf8')).match(/version:\s*"([^"]+)"/)?.[1];
  if (!version) throw new Error('SKILL.md metadata.version missing');
  const server = new Server({ name: 'ego-decision-layer', version }, { capabilities: { tools: {} } });
  const instanceId = randomUUID();
  const records = new Map();
  let closing = false;
  const snapshot = (record, replayed = false) => ({
    instanceId, taskId: record.taskId, state: record.result ? 'finished' : 'running',
    cancelRequested: record.controller.signal.aborted, replayed,
    retry: { scope: 'this_process_only', automaticRerun: false, inspectBeforeNewTask: true },
    result: record.result ?? null,
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.task) invalid('MCP task augmentation is not supported; use browser_task_status');
    const { name, arguments: args } = request.params;
    if (!tools.some(tool => tool.name === name)) invalid('unknown tool');
    const input = validate(args, name === 'browser_task');
    if (name !== 'browser_task') {
      const record = records.get(args.taskId);
      if (!record) return reply({ instanceId, taskId: args.taskId, state: 'unknown', reason: 'task_not_found', safeToRetry: false }, true);
      if (name === 'browser_task_cancel' && !record.result) record.controller.abort('explicit_cancel');
      return reply(snapshot(record));
    }
    const taskId = args.taskId ?? randomUUID();
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const previous = records.get(taskId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return reply({ instanceId, taskId, reason: 'task_id_conflict', safeToRetry: false }, true);
      return reply(snapshot(previous, true), previous.result?.success === false);
    }
    if (closing) return reply({ instanceId, taskId, reason: 'server_closing', safeToRetry: false }, true);
    // Never evict idempotency records silently: refuse more work when full.
    if (records.size >= maxRecords) return reply({ instanceId, taskId, reason: 'task_capacity_reached', safeToRetry: false }, true);
    const record = { taskId, fingerprint, controller: new AbortController(), result: null, pending: null };
    records.set(taskId, record);
    const abort = () => record.controller.abort('mcp_request_cancelled');
    if (extra.signal.aborted) abort();
    else extra.signal.addEventListener('abort', abort, { once: true });
    record.pending = (async () => {
      try {
        const result = await runner({ ...config, ...input, cache: false, keepPage: false }, {
          ...runnerDeps, signal: record.controller.signal, installSignalHandlers: false,
          onLog: () => {}, // Engine logs can include entered text; keep them out of the transport.
        });
        // MCP success always requires the runner's deterministic final-URL verification.
        record.result = { ...result, success: result.success === true && result.verified === true };
      } catch (error) {
        const preflight = error instanceof CdpTaskError;
        record.result = {
          success: false, verified: false, reason: preflight ? 'preflight_error' : 'runner_exception',
          exitCode: preflight ? error.exitCode : 1, cancelled: record.controller.signal.aborted,
          actions: null, outcomeUnknown: !preflight,
          error: preflight ? 'Runner configuration or credentials rejected before execution.' : 'Runner threw; inspect browser before retry.',
          connection: { connected: null, released: null },
        };
      } finally {
        extra.signal.removeEventListener('abort', abort);
      }
    })();
    await record.pending;
    return reply(snapshot(record), !record.result.success);
  });
  const shutdown = async () => {
    closing = true;
    for (const record of records.values()) if (!record.result) record.controller.abort('server_shutdown');
    await Promise.allSettled([...records.values()].map(record => record.pending));
  };
  server.onclose = () => { void shutdown(); };
  return { server, shutdown };
}

export async function serveStdio(config, options) {
  // Some existing engine diagnostics use console.log. Protocol stdout must stay pure.
  console.log = (...args) => process.stderr.write(format(...args) + '\n');
  const app = await createBrowserTaskServer(config, options);
  let stopping;
  const stop = () => stopping ??= (async () => {
    await app.shutdown();
    await app.server.close();
  })().catch(() => { process.stderr.write('MCP shutdown failed\n'); process.exitCode = 1; });
  process.stdin.once('end', stop);
  process.stdin.once('close', stop);
  process.stdout.once('error', stop);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await app.server.connect(new StdioServerTransport());
  return { ...app, stop };
}

if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('usage: node mcp/server.mjs --config /absolute/path/mcp.json');
    const config = JSON.parse(await readFile(process.argv[3], 'utf8'));
    await serveStdio(config);
  } catch {
    process.stderr.write('MCP startup rejected. Use --config with valid JSON containing cdpEndpoint; see docs/MCP.md.\n');
    process.exitCode = 2;
  }
}
