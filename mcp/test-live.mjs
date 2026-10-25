// Live smoke: node mcp/test-live.mjs
// Real Chrome + real P1 host/engine + real Jev. Needs Chrome and Jev credentials; skips otherwise.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const chromePath = process.env.EGO_CDP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
try { await access(chromePath); await access(join(homedir(), '.config/typesafe/api_key')); }
catch { console.log('SKIP live MCP smoke: Chrome or ~/.config/typesafe/api_key missing'); process.exit(0); }
const temp = await mkdtemp(join(tmpdir(), 'ego-mcp-live-'));
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url.startsWith('/done')) res.end('<title>Submitted</title><h1 id="done">Submission complete</h1>');
  else res.end('<!doctype html><title>Search fixture</title><form action="/done"><label>Query <input name="q" aria-label="Query"></label><button type="submit">Search</button></form>');
});
let chrome; let client;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const fixture = `http://127.0.0.1:${server.address().port}/`;
  chrome = spawn(chromePath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${join(temp, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  chrome.stderr.on('data', chunk => { log += chunk.toString(); });
  let endpoint;
  const deadline = Date.now() + 15000;
  while (!endpoint && Date.now() < deadline) { endpoint = log.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]; if (!endpoint) await sleep(50); }
  assert.ok(endpoint, 'Chrome DevTools endpoint');
  // Sentinel is a second owned page; MCP tasks must neither touch nor close it.
  const { connectCdpHost } = await import('../scripts/hosts/cdp-host.mjs');
  const sentinel = await connectCdpHost({ endpoint });
  await sentinel.page.goto('about:blank');
  await sentinel.page.evaluate(() => { window.__sentinel = 42; });
  const transport = new StdioClientTransport({ command: process.execPath, args: [here + 'server.mjs', '--config', join(temp, 'mcp.json')], cwd: here, stderr: 'pipe' });
  await writeFile(join(temp, 'mcp.json'), JSON.stringify({ cdpEndpoint: endpoint, steps: 5, forceViewport: '1280x900' }));
  client = new Client({ name: 'mcp-live-smoke', version: '1' });
  await client.connect(transport);
  const result = await client.callTool({ name: 'browser_task', arguments: { url: fixture, goal: 'type hello into the Query field and submit the Search form', until: '/done?q=hello', text: 'hello', taskId: 'live-smoke' } });
  const r = JSON.parse(result.content[0].text);
  console.log(JSON.stringify({ success: r.result?.success, verified: r.result?.verified, reason: r.result?.reason, url: r.result?.url, steps: r.result?.steps, models: r.result?.serverModels, released: r.result?.connection?.released, receipt: r.result?.connection?.receipt, actions: r.result?.actions?.map(a => ({ intent: a.intent.action, dispatched: a.dispatched })) }));
  if (!r.result?.success) throw new Error('live task did not verify: ' + JSON.stringify({ reason: r.result?.reason, url: r.result?.url, error: r.result?.error }));
  assert.equal(r.result.verified, true, 'final URL verified');
  assert.ok(r.result.url.includes('/done?q=hello'), 'landed on submitted page');
  assert.equal(r.result.connection.released, true, 'connection released');
  assert.equal(await sentinel.page.evaluate(() => window.__sentinel), 42, 'unrelated page untouched');
  await sentinel.close({ keepPage: false });
  console.log(JSON.stringify({ event: 'live_smoke_passed', pageOwnership: 'unrelated page preserved', release: 'released' }));
} finally {
  try { await client?.close(); } catch {}
  try { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); } catch {}
  if (chrome?.pid && chrome.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(5000)]);
    if (chrome.exitCode === null) chrome.kill('SIGKILL');
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
