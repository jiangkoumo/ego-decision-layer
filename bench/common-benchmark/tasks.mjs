// P2 batch 1: references to the P1 fixtures, decisions and independent verifiers.
import { TASKS } from '../host-acceptance/tasks.mjs';

export const VERSION = 'p2-controlled-v1';
const ids = ['click-button', 'click-link-nav', 'type-text', 'search-submit',
  'select-native', 'checkbox-toggle', 'covered-target', 'stale-ref',
  'danger-action', 'control-stop'];
export const TASKS_V1 = ids.map(id => {
  const task = TASKS.find(t => t.id === id);
  if (!task) throw new Error(`Missing acceptance task: ${id}`);
  return {
    id, goal: task.goal, expect: task.expect,
    // Guard tasks must be stopped by a rejection or control stop, never by dispatch.
    expectedRejection: task.expect === 'guard',
    start: { url: 'about:blank', fixture: `bench/host-acceptance/tasks.mjs#${id}` },
    input: { text: task.text ?? [], decision: task.decision, validate: task.validate !== false },
    verifier: `bench/host-acceptance/tasks.mjs#${id}.verify`,
    budget: { steps: task.maxSteps, timeMs: 10000, decisionRequests: task.maxSteps },
    conditions: { login: 'not-applicable', captcha: 'not-applicable', region: 'not-applicable', siteChange: 'not-applicable' },
  };
});

// Candidates only: no runner executes these URLs.
export const SITE_CANDIDATES = [
  { id: 'hn-navigation', url: 'https://news.ycombinator.com', goal: 'open new then comments', verifierCandidate: 'URL pathname === /newcomments' },
  { id: 'wiki-search', url: 'https://en.wikipedia.org/wiki/Main_Page', goal: 'search Jev', verifierCandidate: 'URL pathname === /wiki/Jev plus article DOM' },
  { id: 'ddg-select', url: 'https://duckduckgo.com/settings', goal: 'change language', verifierCandidate: 'native select value plus persisted setting (to define)' },
].map(t => ({ ...t, status: 'candidate-unverified', conditions: { login: 'unknown', captcha: 'unknown', region: 'unknown', siteChange: 'unknown' } }));
