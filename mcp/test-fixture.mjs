// Offline protocol fixture: real MCP transport + P1 runner, injected host/engine.
import { serveStdio } from './server.mjs';
let connects = 0;
const config = { cdpEndpoint: 'http://127.0.0.1:1', steps: 2 };
await serveStdio(config, { maxRecords: 12, runnerDeps: {
  engine: {
    loadApiKey: () => process.argv.includes('--missing-key') ? null : 'offline-test-only',
    runJevAutonomousLoop: async (page, goal, options) => {
      if (goal === 'wait') await page.cdp('test.wait');
      if (goal === 'throw') throw new Error('execution failed');
      if (goal === 'model_done') return { success: true, reason: 'jev_done', history: [] };
      if (goal === 'miss') return { success: true, reason: 'check_passed', history: [] };
      if (goal === 'partial') return { success: false, reason: 'action_outcome_unknown', history: [{ action: 'batch', batchSize: 2, executedSubActions: [{ action: 'click', target: 'button' }], changed: false, error: 'lost receipt' }] };
      if (await options.check(page)) return { success: true, reason: 'check_passed', history: [], steps: 0 };
      return { success: false, reason: 'blocked', history: [], steps: 0 };
    },
  },
  connectCdpHost: async ({ signal }) => {
    connects++;
    let url = 'about:blank';
    process.stderr.write('fixture:connect\n');
    return {
      metadata: { targetId: 'owned-' + connects, ownedPage: true, createdTarget: true },
      page: {
        goto: async value => { url = value; }, url: async () => url,
        title: async () => 'Offline fixture',
        cdp: async () => {
          process.stderr.write('fixture:waiting\n');
          await new Promise((resolve, reject) => {
            const abort = () => { const e = new Error('cancelled'); e.code = 'EGO_HOST_ABORTED'; reject(e); };
            if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
          });
        },
      },
      close: async ({ keepPage }) => {
        process.stderr.write('fixture:released:' + keepPage + '\n');
        return { closed: true, targetClosed: !keepPage, keptPage: keepPage, browserClosed: false };
      },
    };
  },
} });
