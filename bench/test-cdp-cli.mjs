// Isolated CLI integration: real Bash parsing/config serialization, injected task process.
// Browser behavior is exercised separately by the dual-host acceptance suite.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'ego-cdp-cli-'));
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok ' + name); }
try {
  const scripts = join(root, 'scripts');
  const home = join(root, 'home');
  const temp = join(root, 'temp');
  for (const dir of [scripts, home, temp]) mkdirSync(dir);
  const cli = join(scripts, 'ego-decision-layer');
  copyFileSync(join(repo, 'scripts', 'ego-decision-layer'), cli);
  writeFileSync(join(scripts, 'decider-loop.mjs'), `
export const loadApiKey = () => 'test-key';
export const loadDeciderConfig = () => null;
export const normalizeExtractionSchema = () => {};
export const resolveExtractionModel = () => ({kind:'openai-compatible',baseUrl:'http://localhost:99/v1',model:'fixture'});
`);
  writeFileSync(join(scripts, 'wire-agent-skills.sh'), '#!/bin/bash\nif [ "$1" != "--status-json" ]; then exit 98; fi\nprintf \'null\\n\'\n');
  writeFileSync(join(scripts, 'run-cdp-task.mjs'), `
import { readFileSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(process.argv[3], 'utf8'));
console.log(JSON.stringify({cfg,argv:process.argv.slice(2),configFile:process.argv[3]}));
process.exitCode = cfg.goal === 'fail' ? 1 : 0;
`);
  const env = {...process.env, HOME: home, TMPDIR: temp, EGO_BROWSER_BIN: join(root, 'missing-ego'),
    EGO_JEV_LIB: '', EGO_JEV_NO_WIRE: '', EGO_JEV_NO_HEAL: '', TYPESAFE_API_KEY_FILE: join(home, 'no-key'),
    EGO_JEV_CACHE_FILE: join(home, 'cache.json'), TYPESAFE_BASE_URL: '', TYPESAFE_FALLBACK_BASE_URL: ''};
  const run = (...args) => spawnSync('bash', [cli, ...args], {env, encoding:'utf8', timeout:10000});
  const parse = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  check('CDP runs without ego-browser and does not invoke route healing', () => {
    const {cfg, argv} = parse(run('--cdp-endpoint', 'http://127.0.0.1:9222', '--url', 'https://example.com', '--until', '/done', '--steps', '4', '--text', 'hello', 'search'));
    assert.equal(cfg.cdpEndpoint, 'http://127.0.0.1:9222');
    assert.equal(cfg.url, 'https://example.com');
    assert.equal(cfg.until, '/done');
    assert.equal(cfg.steps, 4);
    assert.deepEqual(cfg.texts, ['hello']);
    assert.equal(cfg.goal, 'search');
    assert.equal(realpathSync(cfg.engineModule), realpathSync(join(scripts, 'decider-loop.mjs')));
    assert.equal(argv[0], '--config');
  });
  check('special characters and repeated text survive config transport', () => {
    const text = '中文 "quote" $HOME `literal`\nnext';
    const {cfg} = parse(run('--cdp-endpoint', 'ws://localhost:9222/devtools/browser/test', '--text', text, '--text', 'second', '--', text));
    assert.equal(cfg.goal, text);
    assert.deepEqual(cfg.texts, [text, 'second']);
  });
  check('execution options and decider overrides reach Node', () => {
    const {cfg} = parse(run('--cdp-endpoint', 'https://chrome.example', '--keep-space', '--no-cache', '--no-batch', '--no-visual-fallback', '--force-viewport', '800x600@2', '--decider', 'openai-compatible', '--base-url', 'http://localhost:99/v1', '--model', 'fixture', 'task'));
    assert.equal(cfg.keepSpace, true);
    assert.equal(cfg.cache, false);
    assert.equal(cfg.cacheFile, null);
    assert.equal(cfg.batch, false);
    assert.equal(cfg.visualFallback, false);
    assert.equal(cfg.forceViewport, '800x600@2');
    assert.deepEqual(cfg.deciderConfig, {kind:'openai-compatible',baseUrl:'http://localhost:99/v1',model:'fixture'});
  });
  check('pure extraction preserves schema and resolved text backend', () => {
    const {cfg} = parse(run('--cdp-endpoint', 'http://localhost:9222', '--extract', 'get titles', '--schema', '[{"title":"string"}]'));
    assert.equal(cfg.goal, null);
    assert.equal(cfg.extractInstruction, 'get titles');
    assert.equal(cfg.extractSchema, '[{"title":"string"}]');
    assert.equal(cfg.extractionModel.model, 'fixture');
  });
  for (const args of [[], [''], ['file:///tmp/chrome'], ['invalid'], ['http://localhost:9222', '--space', '1'], ['http://localhost:9222', '--keep', 'p1']]) {
    check('invalid CDP arguments exit 2: ' + JSON.stringify(args), () => {
      const r = run('--cdp-endpoint', ...args);
      assert.equal(r.status, 2, r.stderr);
    });
  }
  check('task failure exit status propagates', () => assert.equal(run('--cdp-endpoint', 'http://localhost:9222', 'fail').status, 1));
  check('temporary config directories are removed after success and failure', () => assert.deepEqual(readdirSync(temp), []));
  check('default ego mode still requires its browser binary', () => {
    const r = run('task');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /ego lite/);
  });
  check('missing Node reports runtime requirement before URL validation', () => {
    const bin = join(root, 'no-node-bin');
    mkdirSync(bin);
    // These tools run before argument validation; deliberately omit Node from this isolated PATH.
    for (const name of ['dirname', 'uname', 'tr']) {
      const resolved = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'probe', name], {encoding:'utf8'}).stdout.trim();
      symlinkSync(resolved, join(bin, name));
    }
    const r = spawnSync('/bin/bash', [cli, '--cdp-endpoint', 'http://localhost:9222', 'task'], {env:{...env, PATH:bin}, encoding:'utf8'});
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Node 22\+/);
    assert.doesNotMatch(r.stderr, /WebSocket URL/);
  });
  check('help documents external CDP entry', () => assert.match(run('--help').stdout, /--cdp-endpoint/));
  console.log(`PASS ${passed} CLI integration checks`);
} finally {
  rmSync(root, {recursive:true, force:true});
}
