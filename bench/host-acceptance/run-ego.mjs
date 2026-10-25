// Dual-host acceptance on ego lite: run the shared task suite inside a real ego browser.
//
// Why this entry point exists: the suite must run against a real host (real page object,
// real CDP dispatch, real DOM), not a stub. This script is the ego-lite entry point;
// run-cdp.mjs is the external-Chrome entry point and shares the exact same task set.
//
// Run (from the repo root):
//   sed "s|__REPO__|$PWD|g" bench/host-acceptance/run-ego.mjs | ego-browser nodejs
//
// Optional overrides (extra sed expressions, all placeholders are optional):
//   -e "s|__ENGINE__|/abs/path/to/other/worktree/scripts/decider-loop.mjs|"   # cross-worktree recheck
//   -e "s|__TASK_IDS__|click-button,select-native|"                          # subset
//   -e "s|__OUT__|/abs/path/report.json|"                                    # also write the JSON report
//   -e "s|__TIMEOUT_MS__|20000|"                                             # per-task timeout (default 60s)
//
// Exit code: 0 all tasks verified, 1 some task failed, 2 setup/import error.
// Keep this file ASCII-only: it is fed to `ego-browser nodejs` through stdin and must not
// depend on how the host decodes non-ASCII bytes (fixtures live in tasks.mjs, a real file).
const REPO = "__REPO__";
const ENGINE = "__ENGINE__";
const TASK_IDS = "__TASK_IDS__";
const OUT = "__OUT__";
const TIMEOUT = "__TIMEOUT_MS__";

const isSet = (value) => Boolean(value) && !String(value).startsWith("__");
const ROOT = REPO.startsWith("/") ? REPO : (process.env.HOME || "") + "/.agents/skills/ego-decision-layer";

const suiteUrl = ROOT + "/bench/host-acceptance/suite.mjs";
let suite;
try {
  suite = await import(suiteUrl);
} catch (err) {
  console.log(`FAIL: cannot import the acceptance suite from ${suiteUrl}: ${err?.message || err}`);
  console.log('Hint: run it from the repo root with sed "s|__REPO__|$PWD|g" bench/host-acceptance/run-ego.mjs | ego-browser nodejs');
  process.exitCode = 2;
  throw err;
}

const space = await taskSpace(`ego-host-acceptance-${Date.now()}`);
const page = space.page("p1");
let exitCode = 0;
try {
  const report = await suite.runHostAcceptance(page, {
    host: "ego-lite",
    engine: isSet(ENGINE) ? ENGINE.trim() : undefined,
    taskIds: isSet(TASK_IDS) ? TASK_IDS.trim() : undefined,
    taskTimeoutMs: isSet(TIMEOUT) ? Number(TIMEOUT) : undefined,
    onTask: (record) => {
      const m = record.metrics;
      console.log(
        `[${record.id}] ${m.taskPassed ? "ok  " : "FAIL"} ${String(m.latencyMs).padStart(5)}ms` +
          ` expect=${record.expect} engineGoal=${m.engineGoalSuccess}` +
          ` decisions=${m.decisionRequests} dispatches=${m.dispatches} stop=${m.stopReason ?? "null"}` +
          (m.falseSuccess ? " FALSE_SUCCESS" : "") +
          (record.verification.ok ? "" : ` :: ${record.verification.detail}`)
      );
    },
  });
  const s = report.summary;
  console.log("");
  console.log(
    `host=${report.host} tasks=${s.total} failed=${s.taskFailed} passed=${s.taskPassed}` +
      ` goalTasks=${s.goalTasks.total}/${s.goalTasks.taskPassed} guardTasks=${s.guardTasks.total}/${s.guardTasks.taskPassed}` +
      ` engineGoalSuccess=${s.goalTasks.engineGoalSuccess}` +
      ` falseSuccess=${s.falseSuccesses.length} notRun=${s.notRun.length} halted=${s.halted}` +
      ` decisions=${s.decisionRequests} dispatches=${s.dispatches} latencyMs=${s.latencyMs}`
  );
  console.log(`engine=${report.enginePath}`);
  console.log(`note: ${s.disclaimer}`);
  console.log("RESULT: " + JSON.stringify(report));
  // ego-browser CLI 自己也可能以 0 退出，所以判定同时要求「12 项任务全跑过」且「failed=0」。
  const complete = s.complete === true && s.total === suite.TASK_IDS.length;
  exitCode = s.taskFailed === 0 && complete ? 0 : 1;
  if (!complete) {
    console.log(
      `INCOMPLETE: expected ${suite.TASK_IDS.length} tasks, ran ${s.total}, notRun=${s.notRun.join(",") || "none"}, halted=${s.halted}`
    );
  }

  if (isSet(OUT)) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(OUT.trim(), JSON.stringify(report, null, 2));
    console.log("REPORT: " + OUT.trim());
  }
} catch (err) {
  console.log(`FAIL: acceptance run threw: ${err?.stack || err}`);
  exitCode = 2;
} finally {
  try {
    await space.finish({ keep: [] });
  } catch (err) {
    console.log(`WARN: taskSpace.finish failed: ${err?.message || err}`);
  }
}
process.exitCode = exitCode;
