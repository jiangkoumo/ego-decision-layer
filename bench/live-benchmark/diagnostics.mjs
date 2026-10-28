// Passive, bounded diagnostics. Never retain state, criteria descriptions, call
// arguments/results, URLs, input values, headers, receipts or exception messages.
// No browser/model calls belong in this module.
export const DIAGNOSTIC_LIMITS = Object.freeze({ asks: 32, browserCalls: 400, candidates: 80, stateScanChars: 65536 });
const HEADS = ['operation', 'click_target', 'type_text_target', 'select_target', 'input_text'];
const OPERATIONS = new Set(['click', 'type_text', 'type_text_submit', 'select', 'scroll_up', 'scroll_down', 'wait', 'done', 'blocked']);
const safeChoice = (head, value) => typeof value !== 'string' ? null
  : head === 'operation' ? (OPERATIONS.has(value) ? value : '<redacted>')
    : value === 'none' || /^(?:ref=\d{1,8}(?:#\d{1,8})?|t\d{1,8})$/.test(value) ? value : '<redacted>';

// Best effort at each boundary: diagnostic failure must not replace a real result
// or exception. These wrappers also contain throwing accessors in diagnostic input.
export function diagnosticAttempt(fn, fallback = null) {
  try { return fn(); } catch { return fallback; }
}

export function createDiagnostics() {
  const origin = Date.now();
  const asks = [];
  const browserCalls = [];
  const dropped = { asks: 0, browserCalls: 0 };
  let errors = 0;
  const safely = (fn) => {
    try { return fn(); } catch { errors += 1; return null; }
  };
  const begin = (list, kind, limit, fields) => {
    if (list.length >= limit) { dropped[kind] += 1; return null; }
    const row = { ...fields, startMs: Date.now() - origin, durationMs: null, status: 'inflight' };
    list.push(row);
    return row;
  };
  return {
    beginAsk(state, questions) {
      return safely(() => {
        // Do not even inspect additional asks once capacity is reached.
        if (asks.length >= DIAGNOSTIC_LIMITS.asks) { dropped.asks += 1; return null; }
        const heads = [];
        for (const head of HEADS) {
          const criteria = questions?.[head]?.criteria;
          if (!criteria || typeof criteria !== 'object') continue;
          const candidates = [];
          let truncated = false;
          for (const key in criteria) {
            if (!Object.prototype.hasOwnProperty.call(criteria, key)) continue;
            if (candidates.length >= DIAGNOSTIC_LIMITS.candidates) { truncated = true; break; }
            candidates.push(safeChoice(head, key));
          }
          heads.push({ head, candidates, truncated, selected: null, selectedInCandidates: null });
        }
        return begin(asks, 'asks', DIAGNOSTIC_LIMITS.asks, {
          input: {
            stateChars: typeof state === 'string' ? state.length : null,
            // Count only a bounded prefix, explicitly labelled as such.
            scannedChars: typeof state === 'string' ? Math.min(state.length, DIAGNOSTIC_LIMITS.stateScanChars) : 0,
            scannedLines: typeof state === 'string' ? state.slice(0, DIAGNOSTIC_LIMITS.stateScanChars).split('\n').length : null,
            truncated: typeof state === 'string' ? state.length > DIAGNOSTIC_LIMITS.stateScanChars : null,
          },
          heads,
        });
      });
    },
    endAsk(row, answers, status) {
      safely(() => {
        if (!row) return;
        row.durationMs = Math.max(0, Date.now() - origin - row.startMs);
        row.status = status;
        for (const entry of row.heads) {
          entry.selected = safeChoice(entry.head, answers?.[entry.head]?.choice);
          entry.selectedInCandidates = entry.selected === null ? null
            : entry.candidates.includes(entry.selected) && entry.selected !== '<redacted>' ? true
              : entry.truncated ? null : false;
        }
      });
    },
    beginBrowser(method, scope) {
      return safely(() => begin(browserCalls, 'browserCalls', DIAGNOSTIC_LIMITS.browserCalls, {
        // Method names only, never arguments. Unusual names are redacted.
        method: typeof method === 'string' && method.length <= 96 && /^(?:page|keyboard|cdp)\.[A-Za-z.]+$/.test(method) ? method : '<redacted>',
        scope,
      }));
    },
    endBrowser(row, status) {
      safely(() => {
        if (!row) return;
        row.durationMs = Math.max(0, Date.now() - origin - row.startMs);
        row.status = status;
      });
    },
    snapshot() {
      return safely(() => {
        const elapsedMs = Date.now() - origin;
        const copy = (rows) => rows.map((row) => ({ ...row, elapsedMs: row.durationMs ?? Math.max(0, elapsedMs - row.startMs) }));
        // Deep copy so a late in-flight completion cannot rewrite a saved report.
        return JSON.parse(JSON.stringify({
          version: 1, limits: DIAGNOSTIC_LIMITS, dropped: { ...dropped }, errors,
          asks: copy(asks), browserCalls: copy(browserCalls),
          timing: {
            unit: 'ms', settleMs: null,
            note: 'Public page/CDP calls and logical model asks are inclusive elapsed intervals; they may overlap each other and engine phases and must not be added. Logical asks include HTTP/fallback and response handling, not server inference alone. Unmeasured waits/settle are unknown.',
          },
        }));
      });
    },
  };
}

/** Invoke exactly once with unchanged arguments/result/error, measuring only the
 * existing public call. Recorder failure is isolated before and after invocation. */
export async function measureBrowserCall(diagnostics, method, scope, invoke) {
  const token = diagnosticAttempt(() => diagnostics?.beginBrowser(method, scope));
  try {
    const result = await invoke();
    diagnosticAttempt(() => diagnostics?.endBrowser(token, 'fulfilled'));
    return result;
  } catch (error) {
    diagnosticAttempt(() => diagnostics?.endBrowser(token, 'rejected'));
    throw error;
  }
}
