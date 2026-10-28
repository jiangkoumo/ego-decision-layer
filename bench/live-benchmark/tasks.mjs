// P2 live benchmark batch 1: two real sites, one shared task contract for both hosts.
//
// The task file is deliberately data-only: the runner, both host legs and the offline
// policy test all read the same start URL, goal, candidate text, budgets and verifier
// name. Verifiers live in verifiers.mjs and are independent of the engine result.

export const VERSION = 'p2-live-v1';

export const TASK_DEFINITIONS = [
  {
    id: 'hn-navigation',
    site: 'news.ycombinator.com',
    startUrl: 'https://news.ycombinator.com/',
    goal: '先打开 new 页面，再打开 comments 页面',
    text: [],
    // One decision request per step; the wall-clock budget is enforced by the harness
    // around the engine loop (the engine itself has no internal clock cut-off).
    budget: { steps: 5, timeMs: 30000, decisionRequests: 5 },
    expected: { origin: 'https://news.ycombinator.com', pathname: '/newcomments' },
    verifier: 'hackerNewsNewComments',
    verifierDescription: 'exact origin + pathname /newcomments, #hnmain and a comment tree with rows/items',
    conditions: { login: 'unknown', captcha: 'unknown', region: 'unknown', siteChange: 'unknown' },
  },
  {
    id: 'wiki-search',
    site: 'en.wikipedia.org',
    startUrl: 'https://en.wikipedia.org/wiki/Main_Page',
    goal: '在顶部搜索框输入 Jev 并提交',
    text: ['Jev'],
    budget: { steps: 5, timeMs: 30000, decisionRequests: 5 },
    expected: { origin: 'https://en.wikipedia.org', pathname: '/wiki/Jev' },
    verifier: 'wikipediaJevArticle',
    verifierDescription: 'exact origin + pathname /wiki/Jev, #firstHeading Jev and article content paragraphs',
    conditions: { login: 'unknown', captcha: 'unknown', region: 'unknown', siteChange: 'unknown' },
  },
];

export const LIVE_TASKS = TASK_DEFINITIONS;

// v1 above is historical. Selecting v2 is explicit; do not relabel saved v1 runs.
export const VERSION_V2 = 'p2-live-v2';

export const TASK_DEFINITIONS_V2 = [
  {
    ...TASK_DEFINITIONS[0],
    taskSetVersion: VERSION_V2,
    expected: { ...TASK_DEFINITIONS[0].expected, search: '', domKind: 'comments' },
    verifier: 'hackerNewsPage',
    verifierDescription: 'exact origin/path/query, active HN navigation and nonempty comment bodies',
  },
  {
    ...TASK_DEFINITIONS[1],
    taskSetVersion: VERSION_V2,
    expected: { ...TASK_DEFINITIONS[1].expected, search: '', heading: 'Jev' },
    verifier: 'wikipediaArticle',
    verifierDescription: 'exact origin/path/query, exact article heading and nonempty article paragraphs',
  },
  ...[
    ['hn-newest', 'new', '/newest'],
    ['hn-ask', 'ask', '/ask'],
    ['hn-show', 'show', '/show'],
    ['hn-jobs', 'jobs', '/jobs'],
  ].map(([id, link, pathname]) => ({
    id,
    taskSetVersion: VERSION_V2,
    site: 'news.ycombinator.com',
    startUrl: 'https://news.ycombinator.com/',
    goal: `打开 Hacker News 顶部的 ${link} 页面`,
    text: [],
    budget: { steps: 5, timeMs: 30000, decisionRequests: 5 },
    expected: { origin: 'https://news.ycombinator.com', pathname, search: '', domKind: 'stories' },
    verifier: 'hackerNewsPage',
    verifierDescription: 'exact origin/path/query, active HN navigation and story rows with title links',
    conditions: { login: 'unknown', captcha: 'unknown', region: 'unknown', siteChange: 'unknown' },
  })),
  ...[
    ['wiki-ada-lovelace', 'Ada Lovelace', '/wiki/Ada_Lovelace'],
    ['wiki-alan-turing', 'Alan Turing', '/wiki/Alan_Turing'],
  ].map(([id, heading, pathname]) => ({
    id,
    taskSetVersion: VERSION_V2,
    site: 'en.wikipedia.org',
    startUrl: 'https://en.wikipedia.org/wiki/Main_Page',
    goal: `在顶部搜索框输入 ${heading} 并提交`,
    text: [heading],
    budget: { steps: 5, timeMs: 30000, decisionRequests: 5 },
    expected: { origin: 'https://en.wikipedia.org', pathname, search: '', heading },
    verifier: 'wikipediaArticle',
    verifierDescription: 'exact origin/path/query, exact article heading and nonempty article paragraphs',
    conditions: { login: 'unknown', captcha: 'unknown', region: 'unknown', siteChange: 'unknown' },
  })),
];

export const LIVE_TASKS_V2 = TASK_DEFINITIONS_V2;
export const TASK_SETS = {
  v1: { version: VERSION, tasks: TASK_DEFINITIONS },
  v2: { version: VERSION_V2, tasks: TASK_DEFINITIONS_V2 },
};

export function getTask(id, version) {
  if (version === undefined) {
    return TASK_DEFINITIONS.find((task) => task.id === id) ??
      TASK_DEFINITIONS_V2.find((task) => task.id === id) ?? null;
  }
  if (!Object.hasOwn(TASK_SETS, version)) throw new Error(`unknown task set: ${version}`);
  const taskSet = TASK_SETS[version];
  return taskSet.tasks.find((task) => task.id === id) ?? null;
}

export function selectTasks(spec = 'all') {
  return resolveTaskSet(spec).tasks;
}

export function resolveTaskSet(spec = 'all') {
  if (spec === undefined || spec === null || spec === 'all' || spec === '') {
    return { version: VERSION, tasks: [...TASK_DEFINITIONS] };
  }
  if (Object.hasOwn(TASK_SETS, spec)) {
    const taskSet = TASK_SETS[spec];
    return { version: taskSet.version, tasks: [...taskSet.tasks] };
  }
  const [explicitVersion, selector] = String(spec).includes(':') ? String(spec).split(':') : [null, String(spec)];
  if (explicitVersion && !Object.hasOwn(TASK_SETS, explicitVersion)) throw new Error(`unknown task set: ${explicitVersion}`);
  if (String(spec).split(':').length > 2) throw new Error(`invalid tasks selector: ${spec}`);
  const ids = selector.split(',').map((value) => value.trim()).filter(Boolean);
  if (!ids.length) throw new Error('tasks selector is empty');
  const version = explicitVersion ?? (ids.some((id) =>
    !TASK_DEFINITIONS.some((task) => task.id === id) && TASK_DEFINITIONS_V2.some((task) => task.id === id)) ? 'v2' : 'v1');
  const selected = ids.map((id) => {
    const task = getTask(id, version);
    if (!task) throw new Error(`unknown task: ${id}`);
    return task;
  });
  return { version: TASK_SETS[version].version, tasks: selected };
}

export const SITE_NOTES = {
  'hn-navigation':
    'HN reaches /newcomments through one or two link clicks from the front page. ' +
    'The DOM verifier requires the comment table, so a URL-only false success is rejected.',
  'wiki-search':
    'Wikipedia has been variable under the historical 5-step budget. Failures are measurement ' +
    'results and must stay in the raw file; the budget is not relaxed to make every trial pass.',
};

export const TASK_SET_NOTES_V2 = [
  'Eight public tasks; fixed candidate text and historical 5-step/30-second/5-request budgets. No login is required by the task, but site conditions remain observed rather than assumed.',
  'Wikipedia headings must match the English article exactly. Automatic translation may change the heading/body and produce a verifier failure; record it, do not relax the expected heading or silently disable translation.',
  'HN verification uses structural content and the selected navigation href, not translated navigation labels.',
  'Select with selectTasks("v2") or selectTasks("v2:hn-newest,wiki-ada-lovelace"); lookup with getTask(id, "v2"). The host runner must preserve this version and pass task to verifier(page, task).',
];
