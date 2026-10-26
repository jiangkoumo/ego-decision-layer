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

export function getTask(id) {
  return TASK_DEFINITIONS.find((task) => task.id === id) ?? null;
}

export function selectTasks(spec = 'all') {
  if (spec === undefined || spec === null || spec === 'all' || spec === '') return [...TASK_DEFINITIONS];
  const ids = String(spec).split(',').map((value) => value.trim()).filter(Boolean);
  if (!ids.length) throw new Error('tasks selector is empty');
  const selected = ids.map((id) => {
    const task = getTask(id);
    if (!task) throw new Error(`unknown task: ${id}`);
    return task;
  });
  return selected;
}

export const SITE_NOTES = {
  'hn-navigation':
    'HN reaches /newcomments through one or two link clicks from the front page. ' +
    'The DOM verifier requires the comment table, so a URL-only false success is rejected.',
  'wiki-search':
    'Wikipedia has been variable under the historical 5-step budget. Failures are measurement ' +
    'results and must stay in the raw file; the budget is not relaxed to make every trial pass.',
};
