# Live Jev dual-host benchmark (P2 batch 1)

This directory measures the **real** engine against **real sites** on two hosts with the
same task manifest, budgets, engine and independent final-state verifiers:

- **cdp**: ordinary Node 22+ + a temporary headless Chrome, connected through
  `scripts/hosts/cdp-host.mjs` (one owned tab per host leg).
- **ego**: a fresh `ego-browser` TaskSpace, running the same `suite.mjs` inside the ego
  Node runtime (staged outside this workspace to avoid the known ego loader stall).

No decision is injected. `options.ask` is a thin wrapper around the real
`scripts/decider-loop.mjs#askJev`; it counts logical asks, enforces the request budget and
temporarily counts HTTP attempts. The engine still observes the DOM and dispatches through
the real host.

> **Small sample / no extrapolation**: this first batch is 2 tasks × 2 hosts × 3 rounds =
> **12 trials**. It is a reproducible measurement entry point, not a population success
> rate. Wiki has historically been variable under a 5-step budget; failures are retained.

## Tasks and budgets

| id | start | goal | text | steps | wall clock | logical asks | verifier |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| `hn-navigation` | `https://news.ycombinator.com/` | 先打开 new 页面，再打开 comments 页面 | — | 5 | 30 s | 5 | exact origin + `/newcomments`, `#hnmain`, comment rows/items |
| `wiki-search` | `https://en.wikipedia.org/wiki/Main_Page` | 在顶部搜索框输入 Jev 并提交 | `Jev` | 5 | 30 s | 5 | exact origin + `/wiki/Jev`, `#firstHeading` = Jev, article content paragraph |

The task manifest is `tasks.mjs`; verifiers are `verifiers.mjs`. `decisionRequests` in the
task budget is the **logical `ask` call count** (one per engine decision). A backend
fallback can turn one logical ask into more than one HTTP attempt; `httpRequests` is
counted inside each `askJev` wait window and reported separately. If a host runtime exposes
no global `fetch`, that field is `null` with a reason, never guessed.

**Timing contract:** the task `timeMs` clock starts before the initial navigation. Initial
navigation has its own `goto` (15 s) and `waitForLoadState` (10 s) bounds, so it is not cut
by the engine timer; however, elapsed navigation time is subtracted from the remaining
engine budget (`remaining = timeMs - elapsed`). If no time remains, the engine is not
started and the trial is a wall-clock failure. The verifier has a separate 10 s bound, so
total trial latency can exceed `timeMs`, while the engine loop itself cannot exceed the
remaining budget. `latencyMs` is total trial latency (navigation + engine + verifier) and
`engineLatencyMs` is the engine-loop portion.

Each trial is a task PASS only when **all** of these hold:

1. the independent verifier passes (exact URL + DOM), and
2. the engine reports success, and
3. there was no navigation/timeout/unsettled engine, no logical-ask budget stop, no step
   budget overflow, and no thrown engine/model error.

`verifierOk` and `engine.success` are still recorded independently. This prevents a late
DOM match after a timeout or a URL-only engine stop from being counted as a task success.

## Run

```bash
# Offline policy tests (no browser, network or credentials)
node bench/test-live-benchmark.mjs

# Fixed first batch: cdp then ego, 3 rounds per task per host
node bench/live-benchmark/run.mjs --live --hosts both --tasks all --rounds 3

# One host / task / round (still explicit --live)
node bench/live-benchmark/run.mjs --live --hosts cdp --tasks hn-navigation --rounds 1

# Existing external Chrome: runner creates only its own target and never closes the browser
node bench/live-benchmark/run.mjs --live --hosts cdp --endpoint http://127.0.0.1:9222 --rounds 3
```

`--live` is mandatory: without it the runner exits 2 before touching the network. The raw
JSON goes to `bench/live-benchmark/raw/live-<timestamp>.json` unless `--out` is supplied.
Exit codes: `0` all requested trials passed and cleanup confirmed; `1` any trial failed or
a host/setup/cleanup failed; `2` usage error, missing browser/credentials, or incomplete.

### Isolation and cleanup

- **ego**: one fresh named TaskSpace (`ego-p2-live-…`) on page `p1`; `space.finish({keep:[]})`
  in `finally`; the child writes `taskSpaceFinished`, `pagesBeforeFinish` and `stageRemoved`.
- **cdp**: temporary `--user-data-dir`, own target; cleanup closes the target, stops the
  Chrome PID, verifies the PID is gone, and removes the profile. `--endpoint` never stops or
  closes the external browser; only the owned target is closed.
- User tabs, user profiles, caches and existing pages are not reused. `cache: false` and
  `textModel: null` are forced for every trial.
- A wall-clock timeout first closes a **harness gate** and the logical-ask gate. Every later
  page/CDP call is rejected before dispatch, and no new model ask can start. If the engine
  promise still has not settled after a bounded grace period, the trial is marked
  `unsettled` and the remaining plan entries are recorded as **`NOT_RUN`**; the next trial
  is not started. Host cleanup still runs.

## First measured batch (2026-10-26)

Raw evidence: [`raw/live-2026-10-26T08-52-43-090Z.json`](raw/live-2026-10-26T08-52-43-090Z.json).
The file is sanitized; `runner.files` records the SHA-256 of each script at run time, and
`repoHead` records the base commit `65b759f`.

Environment (from the raw file): macOS arm64, Node `v22.22.2`, ego-browser `0.6.0.20`,
external Chrome `156.0.8078.48`, Jev server model `jev-1.14.0` (request alias
`jev-latest`), credentials read only through the existing file chain.

Execution order was cdp HN r1–r3, cdp Wiki r1–r3, then ego HN r1–r3, ego Wiki r1–r3.

| host / task | PASS | verifierOk | median engine latency | median total | logical asks | HTTP attempts |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cdp / hn-navigation | 3/3 | 3/3 | 2061 ms | 2333 ms | 6 | 6 |
| cdp / wiki-search | 1/3 | 1/3 | 1807 ms | 3582 ms | 15 | 15 |
| ego / hn-navigation | 3/3 | 3/3 | 1410 ms | 1862 ms | 6 | 6 |
| ego / wiki-search | 3/3 | 3/3 | 1048 ms | 2092 ms | 3 | 3 |

Overall: **10/12 task PASS**, 0 false successes, 0 not-run trials, 0 cleanup failures.
Engine success was 10/12. The two failures are retained CDP Wiki trials
`cdp/wiki-search/r1` and `cdp/wiki-search/r3`: both ended at
`https://en.wikipedia.org/wiki/Main_Page` with engine `max_steps_reached`; the verifier
rejected them because the page was not `/wiki/Jev`. They were not retried or re-budgeted.
`falseSuccessRate` is 0 because no trial had engine success with a failed verifier.

Failure consumption for the two failed trials: **6102 ms total trial latency** (including
initial navigation and verifier; the engine-loop portion is **3409 ms**), 10 logical asks /
10 HTTP attempts, 25218 input tokens and 2620 output tokens. `costUsd` is `null` (no pricing
asserted) and human takeover is `null` (not instrumented).

Cleanup evidence in the raw file: CDP `targetClosed: true`, `processStopped: true`,
`profileRemoved: true`; ego `taskSpaceFinished: true`, `pagesBeforeFinish: ["p1"]`,
`stageRemoved: true`, child exit code 0. No cleanup failures were reported.

### Diagnostic smokes kept for calibration

The fixed batch above is the measurement. The `raw/diagnostics/` files are earlier
diagnostic runs and are **not** part of the 12 trials:

- `cdp-hn-overstrict-comment-tree.json`: the first HN smoke exposed an over-strict verifier
  requiring `.comment-tree`; the real `/newcomments` page had `#hnmain` plus 30 comment
  rows/120 item links. The verifier was corrected to require `#hnmain` + comment rows/items.
- `cdp-wiki-long-paragraph.json`: the first Wiki smoke reached `/wiki/Jev` but the page is a
  disambiguation page with one short paragraph; the initial 100-character requirement was
  replaced with exact heading + content paragraph > 0.
- `ego-hn-smoke.json`: successful ego HN smoke after the version/cleanup checks.
- `cdp-launch-failure.json`: intentionally launched a non-browser executable as Chrome;
  this is a real launch FAIL, and the profile/PID cleanup was confirmed. It is not a SKIP.

## Limitations / not verified

- Only macOS arm64 was measured. Windows and Linux host paths are **not verified**.
- Only local ego lite and a temporary headless Chrome were measured; externally configured
  Chrome, remote CDP, and other Chromium builds are not claimed.
- Live site content, network latency, login walls, captcha, region blocks and site changes
  can alter results. Task condition fields stay `unknown`; the verifier records observed
  password/captcha/region markers, and the absence of a marker is not proof of absence.
- The wall-clock budget bounds the engine loop and is reduced by elapsed navigation; it
  does not hard-cap initial navigation or the verifier. The logical ask budget is not an
  HTTP budget.
- Token-usage boundary: normal trials take `usage` from the engine result, falling back to
  ask receipts; both start at zero. `failedTrial` (harness-level failure before a trial
  starts) and `NOT_RUN` records contain zero placeholders, and a navigation failure or
  timeout before any ask yields zero receipts. Those zeros mean **no usage observed**, not
  a measured zero-cost run; read `usageSource` and the failure reason together. No trial in
  the measured 12 hit this boundary (all had at least one logical ask). `costUsd` remains
  `null` regardless.
- No publishing, posting, account changes, payments or deletions are performed.
- Cost in USD and human takeover are `null`; no unit price is invented.
- This batch does not establish a general model or site success rate. Report the raw file,
  script revision and command together with any number.
