// Offline behavioral coverage. No browser/model/network calls; real runs remain a
// separate integration check after suite passes verifier(page, task).
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import {
  VERSION, VERSION_V2, TASK_DEFINITIONS, TASK_DEFINITIONS_V2, LIVE_TASKS,
  LIVE_TASKS_V2, TASK_SETS, getTask, selectTasks, resolveTaskSet, TASK_SET_NOTES_V2,
} from './live-benchmark/tasks.mjs';
import {
  getVerifier, verifyHackerNews, verifyWikipediaJevArticle,
  verifyHackerNewsPage, verifyWikipediaArticle,
} from './live-benchmark/verifiers.mjs';

assert.equal(VERSION, 'p2-live-v1');
assert.equal(VERSION_V2, 'p2-live-v2');
assert.equal(LIVE_TASKS, TASK_DEFINITIONS);
assert.equal(LIVE_TASKS_V2, TASK_DEFINITIONS_V2);
assert.equal(TASK_SETS.v1.tasks, TASK_DEFINITIONS);
assert.equal(TASK_SETS.v2.tasks, TASK_DEFINITIONS_V2);
assert.deepEqual(TASK_DEFINITIONS.map((task) => task.id), ['hn-navigation', 'wiki-search']);
const ids = ['hn-navigation', 'wiki-search', 'hn-newest', 'hn-ask', 'hn-show', 'hn-jobs', 'wiki-ada-lovelace', 'wiki-alan-turing'];
assert.deepEqual(TASK_DEFINITIONS_V2.map((task) => task.id), ids);
assert.equal(new Set(ids).size, 8);
const expectedPaths = ['/newcomments', '/wiki/Jev', '/newest', '/ask', '/show', '/jobs', '/wiki/Ada_Lovelace', '/wiki/Alan_Turing'];
for (const [i, task] of TASK_DEFINITIONS_V2.entries()) {
  assert.equal(task.taskSetVersion, VERSION_V2);
  assert.equal(task.expected.pathname, expectedPaths[i]);
  assert.equal(task.expected.search, '');
  assert.deepEqual(task.budget, { steps: 5, timeMs: 30000, decisionRequests: 5 });
  assert.equal(task.expected.origin, `https://${task.site}`);
  assert.equal(new URL(task.startUrl).origin, task.expected.origin);
  assert.ok(task.goal && task.verifierDescription);
  assert.deepEqual(task.conditions, { login: 'unknown', captcha: 'unknown', region: 'unknown', siteChange: 'unknown' });
  if (task.site === 'en.wikipedia.org') {
    assert.deepEqual(task.text, [task.expected.heading]);
    assert.ok(task.goal.includes(task.expected.heading));
    assert.equal(task.startUrl, 'https://en.wikipedia.org/wiki/Main_Page');
    assert.equal(getVerifier(task.verifier), verifyWikipediaArticle);
  } else {
    assert.deepEqual(task.text, []);
    assert.equal(task.startUrl, 'https://news.ycombinator.com/');
    assert.equal(getVerifier(task.verifier), verifyHackerNewsPage);
  }
  assert.equal(getTask(task.id, 'v2'), task);
}
for (const task of TASK_DEFINITIONS) {
  const v2 = getTask(task.id, 'v2');
  for (const field of ['id', 'site', 'startUrl', 'goal', 'text', 'budget', 'conditions']) {
    assert.deepEqual(v2[field], task[field], `historical ${task.id}.${field}`);
  }
  assert.equal(getTask(task.id), task);
}
for (const selector of [undefined, null, '', 'all', 'v1', 'hn-navigation,wiki-search']) {
  assert.deepEqual(resolveTaskSet(selector), { version: VERSION, tasks: TASK_DEFINITIONS });
  assert.deepEqual(selectTasks(selector), TASK_DEFINITIONS);
}
for (const selector of ['v2', 'hn-newest,wiki-ada-lovelace', 'v2:wiki-search', 'v1:wiki-search']) {
  const resolved = resolveTaskSet(selector);
  assert.deepEqual(resolved.tasks, selectTasks(selector));
  assert.equal(resolved.version, selector.startsWith('v1:') ? VERSION : VERSION_V2);
}
assert.deepEqual(selectTasks('v2'), TASK_DEFINITIONS_V2);
assert.equal(selectTasks('wiki-search,hn-newest')[0], getTask('wiki-search', 'v2'));
assert.equal(resolveTaskSet('wiki-search').version, VERSION);
assert.equal(getTask('hn-newest'), getTask('hn-newest', 'v2'));
assert.equal(getTask('missing'), null);
assert.equal(getTask('hn-newest', 'v1'), null);
for (const selector of ['missing', 'v2:missing', 'hn-newest,missing', 'v1:hn-newest', ',', 'v2:', 'v3:wiki-search', 'v2:wiki-search:extra']) {
  assert.throws(() => selectTasks(selector), Error, selector);
  assert.throws(() => resolveTaskSet(selector), Error, selector);
}
assert.throws(() => getTask('wiki-search', 'constructor'), /unknown task set/);
assert.throws(() => getVerifier('missing'), /unknown verifier/);
assert.match(TASK_SET_NOTES_V2.join(' '), /translation/);

// Execute the production DOM probes against a small deterministic document surface,
// rather than returning a precomputed probe result. This also covers selector drift
// within the probes, their paragraph filtering and missing/evaluate-error paths.
function pageFixture(task, overrides = {}) {
  const expected = task.expected;
  const url = overrides.url ?? `${expected.origin}${expected.pathname}`;
  const location = new URL(overrides.domUrl ?? url);
  const empty = overrides.empty === true;
  const heading = overrides.heading ?? expected.heading ?? '';
  const paragraphText = overrides.body ?? `${heading || 'A Hacker News item'} has article text.`;
  const nodes = (count, make = () => ({})) => Array.from({ length: count }, make);
  const document = {
    title: 'fixture',
    body: { innerText: empty ? '' : paragraphText },
    querySelector(selector) {
      if (empty) return null;
      if (selector === '#hnmain') return expected.domKind ? {} : null;
      if (selector === '.comment-tree') return expected.domKind === 'comments' ? {} : null;
      if (selector === '#firstHeading') return { textContent: heading };
      if (selector === '#mw-content-text') return {
        querySelectorAll: () => paragraphText ? [{ textContent: paragraphText }] : [],
      };
      return null;
    },
    querySelectorAll(selector) {
      if (empty) return [];
      if (selector === 'a[href]') return nodes(12, () => ({ getAttribute: () => 'item?id=1' }));
      if (selector === '.comment-tree tr.athing, tr.comtr, .comment') return nodes(expected.domKind === 'comments' ? 12 : 0);
      if (selector === '.comment') return expected.domKind === 'comments' ? [{ textContent: paragraphText }] : [];
      if (selector === 'tr.athing') return nodes(expected.domKind === 'stories' ? 12 : 0);
      if (selector === '.titleline > a[href]') return nodes(expected.domKind === 'stories' ? 12 : 0, () => ({ textContent: paragraphText }));
      if (selector === '.pagetop .topsel a[href]') return [{ getAttribute: () => overrides.selectedPath ?? expected.pathname }];
      return [];
    },
  };
  return {
    async url() { return url; },
    async title() { return document.title; },
    async waitForLoadState() {},
    async evaluate(fn) {
      if (overrides.evaluateError) throw new Error('probe failed');
      return runInNewContext(`(${fn.toString()})()`, { document, location, URL });
    },
    get engine() { throw new Error('verifier must not inspect engine'); },
    get success() { throw new Error('verifier must not inspect engine success'); },
  };
}

for (const task of TASK_DEFINITIONS_V2) {
  const verifier = getVerifier(task.verifier);
  const guardedTask = { ...task, get engine() { throw new Error('engine result is not evidence'); } };
  assert.equal((await verifier(pageFixture(task), guardedTask)).ok, true, task.id);
  for (const overrides of [
    { empty: true }, { evaluateError: true },
    { url: `${task.expected.origin}${task.expected.pathname}?search=wrong` },
    { domUrl: `${task.expected.origin}${task.expected.pathname}?search=wrong` },
    { url: `https://example.com${task.expected.pathname}` },
    { url: `${task.expected.origin}${task.expected.pathname}/extra` },
    ...(task.expected.heading ? [{ heading: 'Wrong article' }, { heading: task.expected.heading.toLowerCase() }, { body: '' }, { heading: '自动翻译的标题' }] : [{ selectedPath: '/wrong' }, { body: '' }]),
  ]) {
    assert.equal((await verifier(pageFixture(task, overrides), guardedTask)).ok, false, `${task.id}: ${JSON.stringify(overrides)}`);
  }
  assert.equal((await verifier(pageFixture(task), { success: true })).ok, false, 'engine success alone is not evidence');
  assert.equal((await verifier(pageFixture(task))).ok, false, 'missing task is rejected');
}

// Historical wrappers intentionally retain their old behavior (including query
// tolerance and case-insensitive Jev); stricter v2 rules never rewrite old evidence.
assert.equal(getVerifier('hackerNewsNewComments'), verifyHackerNews);
assert.equal(getVerifier('wikipediaJevArticle'), verifyWikipediaJevArticle);
const oldHn = getTask('hn-navigation', 'v2');
const oldWiki = getTask('wiki-search', 'v2');
assert.equal((await verifyHackerNews(pageFixture(oldHn, { url: `${oldHn.expected.origin}/newcomments?next=1` }))).ok, true);
assert.equal((await verifyWikipediaJevArticle(pageFixture(oldWiki, { heading: 'jev', url: `${oldWiki.expected.origin}/wiki/Jev?oldid=1` }))).ok, true);
assert.equal((await verifyHackerNews(pageFixture(oldHn, { empty: true }))).ok, false);
assert.equal((await verifyWikipediaJevArticle(pageFixture(oldWiki, { body: '' }))).ok, false);

console.log('PASS: v1 compatibility; v2 eight-task definitions/version selection; independent exact URL/query + HN semantic DOM + Wiki heading/body verifiers (offline only)');
