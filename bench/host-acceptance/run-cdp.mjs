#!/usr/bin/env node
// 双宿主验收的第二个入口：普通 Node + 外部 Chrome（CDP endpoint），复用同一套任务/输入/预算。
//
// 为什么是普通 Node：ego 内嵌运行时访问不了 loopback（CDP endpoint 是 127.0.0.1），
// 所以这条腿必须在 ego 之外跑；任务集与断言完全共用 suite.mjs。
//
// 适配器契约（由 scripts/hosts/cdp-host.mjs 提供，本文件不复制其实现）：
//   const { page, metadata, close } = await connectCdpHost({ endpoint, signal, timeoutMs });
//   await close({ keepPage })  // 只清理自己的 target/连接，绝不调用 Browser.close
//
// 用法：
//   node bench/host-acceptance/run-cdp.mjs --endpoint http://127.0.0.1:9222
//   node bench/host-acceptance/run-cdp.mjs --endpoint ws://127.0.0.1:9222/devtools/browser/<id>
//
// 选项：
//   --endpoint <http|ws>     必填，CDP endpoint
//   --adapter <path>         适配器路径（默认 <repo>/scripts/hosts/cdp-host.mjs；可指向别的 worktree）
//   --engine <path>          引擎路径（默认当前工作树 scripts/decider-loop.mjs；可指向别的 worktree）
//   --task-ids a,b           只跑部分任务
//   --timeout-ms <n>         单任务上限（默认 60000）
//   --connect-timeout-ms <n> 连接上限（默认 30000）
//   --json <path>            另存完整报告（相对当前目录，由调用方指定）
//   --keep-page              保留本次创建的 target 供排查（默认关闭并回收）
//
// 退出码：0 12 项任务全过；1 有任务失败/不完整；2 用法错误、适配器缺失（SKIP）或连接失败。
// 「适配器缺失」按 SKIP 处理并显式非零退出，不当成通过。

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

function parseArgs(argv) {
  const out = { taskIds: undefined, keepPage: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 缺少取值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--endpoint": out.endpoint = next(); break;
      case "--adapter": out.adapter = next(); break;
      case "--engine": out.engine = next(); break;
      case "--task-ids": out.taskIds = next(); break;
      case "--timeout-ms": out.taskTimeoutMs = Number(next()); break;
      case "--connect-timeout-ms": out.connectTimeoutMs = Number(next()); break;
      case "--json": out.json = next(); break;
      case "--keep-page": out.keepPage = true; break;
      case "--help":
      case "-h": out.help = true; break;
      default: throw new Error(`未知参数：${arg}`);
    }
  }
  return out;
}

const USAGE = `用法: node bench/host-acceptance/run-cdp.mjs --endpoint <http|ws> [--adapter <path>] [--engine <path>]
         [--task-ids a,b] [--timeout-ms n] [--connect-timeout-ms n] [--json <path>] [--keep-page]
退出码: 0 全过 / 1 有失败或不完整 / 2 用法错误、适配器缺失(SKIP)或连接失败`;

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  console.log(`FAIL: ${err.message}`);
  console.log(USAGE);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
if (!args.endpoint) {
  console.log("FAIL: 缺少 --endpoint");
  console.log(USAGE);
  process.exit(2);
}

const adapterPath = resolve(args.adapter ?? join(REPO, "scripts", "hosts", "cdp-host.mjs"));
if (!existsSync(adapterPath)) {
  console.log(`SKIP: CDP 宿主适配器不存在：${adapterPath}`);
  console.log("      这条腿需要 scripts/hosts/cdp-host.mjs（由宿主适配任务提供）；缺依赖不算通过。");
  process.exit(2);
}

const suiteUrl = pathToFileURL(join(HERE, "suite.mjs")).href;
const suite = await import(suiteUrl);
const adapterModule = await import(pathToFileURL(adapterPath).href);
const connectCdpHost = adapterModule.connectCdpHost;
if (typeof connectCdpHost !== "function") {
  console.log(`SKIP: ${adapterPath} 没有导出 connectCdpHost（契约见 docs/HOST-ACCEPTANCE.md）`);
  process.exit(2);
}

const controller = new AbortController();
const onSignal = () => controller.abort();
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

let host = null;
let exitCode = 2;
try {
  console.log(`adapter=${adapterPath}`);
  console.log(`endpoint=${args.endpoint}`);
  host = await connectCdpHost({
    endpoint: args.endpoint,
    signal: controller.signal,
    timeoutMs: args.connectTimeoutMs ?? 30000,
  });
  if (host?.metadata) console.log(`metadata=${JSON.stringify(host.metadata)}`);

  const report = await suite.runHostAcceptance(host.page, {
    host: "cdp-external",
    engine: args.engine,
    taskIds: args.taskIds,
    taskTimeoutMs: args.taskTimeoutMs,
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
      ` engineGoalSuccess=${s.goalTasks.engineGoalSuccess} falseSuccess=${s.falseSuccesses.length}` +
      ` notRun=${s.notRun.length} halted=${s.halted}` +
      ` decisions=${s.decisionRequests} dispatches=${s.dispatches} latencyMs=${s.latencyMs}`
  );
  console.log(`engine=${report.enginePath}`);
  console.log(`note: ${s.disclaimer}`);
  console.log("RESULT: " + JSON.stringify(report));
  exitCode = s.taskFailed === 0 && s.complete === true ? 0 : 1;

  if (args.json) {
    await writeFile(resolve(process.cwd(), args.json), JSON.stringify(report, null, 2));
    console.log(`REPORT: ${resolve(process.cwd(), args.json)}`);
  }
} catch (err) {
  console.log(`FAIL: ${err?.stack || err}`);
  exitCode = 2;
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  if (host && typeof host.close === "function") {
    try {
      const closed = await host.close({ keepPage: args.keepPage });
      console.log(`close=${JSON.stringify(closed)}`);
    } catch (err) {
      console.log(`WARN: close 失败：${err?.message || err}`);
      exitCode = exitCode === 0 ? 2 : exitCode;
    }
  }
}
process.exitCode = exitCode;
