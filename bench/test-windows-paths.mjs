// 验收（单元层）：CLI 把引擎路径转成 import() 可用的 URL。
//
// 为什么需要：Node 的 ESM 加载器只接受 file:// / data: / node: URL。Windows（Git Bash /
// MSYS / Cygwin）下 $LIB 是 `/c/...` 形式，直接 `await import("/c/...")` 会抛
// ERR_UNSUPPORTED_ESM_URL_SCHEME（`c:` 被当成协议名）。CLI 里几处前置检查都吞掉 stderr，
// 于是症状表现为「未找到 Jev 凭证（exit 3）」——而凭证其实完好，误诊成本极高。
// 同一类问题还出现在 mktemp -d 的路径上：父进程用 /c/tmp/x 写 config.json，
// ego 的内嵌 node 把它解析成 C:\tmp\x，子进程读不到。
//
// 用法: node bench/test-windows-paths.mjs（无需浏览器、无需网络、不需要凭证）
//
// 做法：不重实现一遍 shell 逻辑，而是把 CLI 里的 _lib_to_url 抽出来写进临时脚本执行，
// 这样测试与实现不会各自漂移。所有 Windows 用例都显式固定 uname 分支，
// 保证在 Linux / macOS 上跑也能覆盖 Windows 路径（否则这些分支永远测不到）。
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ego-decision-layer");
const src = readFileSync(CLI, "utf8");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// ── 静态检查：所有 import() 点都必须用 LIB_URL，而不是裸 $LIB ──────────────
check("CLI 定义了 LIB_URL", /LIB_URL="\$\(_lib_to_url/.test(src));
check("EGO_JEV_LIB_CHECK 用 LIB_URL", /EGO_JEV_LIB_CHECK="\$LIB_URL"/.test(src));
check("EGO_EXTRACT_LIB 用 LIB_URL", /EGO_EXTRACT_LIB="\$LIB_URL"/.test(src));
check("JEV_ENGINE_LIB 用 LIB_URL", /JEV_ENGINE_LIB="\$LIB_URL"/.test(src));
check("heredoc 里 import 用 LIB_URL", /await import\("\$LIB_URL"\)/.test(src));
check("没有 import(\"\$LIB\") 残留", !/await import\("\$LIB"\)/.test(src));
check("TMPD 使用子进程路径转换", /TMPD="\$\(_runtime_path "\$TMPD"\)"/.test(src));
check("缓存默认路径与覆盖路径都先转换", /CACHE_FILE="\$\(_runtime_path "\$\{EGO_JEV_CACHE_FILE:-\$HOME\//.test(src));
check("配置序列化使用转换后的缓存路径", /JEV_CACHE_FILE="\$CACHE_FILE"/.test(src));

// ── 行为检查：真跑 _lib_to_url ─────────────────────────────────────────
const fnMatch = src.match(/_lib_to_url\(\)\s*\{[\s\S]*?\n\}/);
const runtimeMatch = src.match(/_runtime_path\(\)\s*\{[\s\S]*?\n\}/);
check("找到路径转换函数", Boolean(fnMatch && runtimeMatch));

if (fnMatch && runtimeMatch) {
  const dir = mkdtempSync(join(tmpdir(), "ego-decision-layer-winpath-"));
  const scriptPath = join(dir, "probe.sh");
  // 固定 OS 与挂载映射，避免 macOS/Linux 本机是否装 cygpath 影响覆盖率。
  const stubs = `
set -e
uname() { printf '%s' "$FAKE_OS"; }
cygpath() {
  if [ "$2" = "/home/tester/cache.json" ]; then
    printf '%s' 'C:/cygwin64/home/tester/cache.json'
  elif [ "$2" = "/home/tester/.config/ego-decision-layer/action-cache.json" ]; then
    printf '%s' 'C:/cygwin64/home/tester/.config/ego-decision-layer/action-cache.json'
  else
    printf '%s' "$2"
  fi
}
`;
  writeFileSync(scriptPath, `${stubs}\n${runtimeMatch[0]}\n${fnMatch[0]}\nif [ "$PROBE_KIND" = runtime ]; then _runtime_path "$PROBE_PATH"; else _lib_to_url "$PROBE_PATH"; fi\n`);

  const run = (input, fakeOs, kind = "url") => {
    const env = { ...process.env, PROBE_PATH: input, PROBE_KIND: kind };
    if (fakeOs) env.FAKE_OS = fakeOs;
    try {
      return execFileSync("bash", [scriptPath], { encoding: "utf8", env }).trim();
    } catch (e) {
      return `ERR:${String(e.message).slice(0, 80)}`;
    }
  };

  const posix = run("/usr/local/lib/decider-loop.mjs", "Linux");
  check("POSIX 原样返回", posix === "/usr/local/lib/decider-loop.mjs", posix);

  const win1 = run("/c/Users/someuser/x/decider-loop.mjs", "MINGW64_NT-10.0");
  check("/c/... → file:///C:/...",
    win1 === "file:///C:/Users/someuser/x/decider-loop.mjs", win1);

  // 原生 MSYS 报 MSYS_NT-*；早先误写成 MSBUILD* 会让整条 Windows 分支失效
  const msys = run("/c/Users/someuser/x/decider-loop.mjs", "MSYS_NT-10.0-19045");
  check("MSYS_NT 前缀被识别",
    msys === "file:///C:/Users/someuser/x/decider-loop.mjs", msys);

  // 默认 Cygwin 用 /cygdrive/c/...，不是 /c/...
  const cyg = run("/cygdrive/c/Users/someuser/x/decider-loop.mjs", "CYGWIN_NT-10.0");
  check("/cygdrive/c/... → file:///C:/...",
    cyg === "file:///C:/Users/someuser/x/decider-loop.mjs", cyg);

  const win2 = run("D:/repo/scripts/decider-loop.mjs", "MINGW64_NT-10.0");
  check("D:/... → file:///D:/...",
    win2 === "file:///D:/repo/scripts/decider-loop.mjs", win2);

  // 已经是 file:// URL：必须原样保留，不能叠前缀
  const already = run("file:///C:/repo/decider-loop.mjs", "MINGW64_NT-10.0");
  check("file:// 幂等", already === "file:///C:/repo/decider-loop.mjs", already);

  // 反斜杠：统一成正斜杠，否则 URL 里会留非法字符
  const backslashPath = String.raw`C:\repo\scripts\decider-loop.mjs`;
  const back = run(backslashPath, "MINGW64_NT-10.0");
  check("反斜杠归一化为正斜杠",
    back === "file:///C:/repo/scripts/decider-loop.mjs", back);

  // URL 保留字符：拼字符串会把 # 之后当成 fragment，路径整段丢失
  const hashPath = run("/c/work#1/lib/decider-loop.mjs", "MINGW64_NT-10.0");
  check("# 被百分号编码而非当成 fragment",
    hashPath === "file:///C:/work%231/lib/decider-loop.mjs", hashPath);
  check("# 不在 URL 里残留裸 #", !/[^%]#/.test(hashPath.replace("file:///", "")), hashPath);

  const spacePath = run("/c/my repo/lib/decider-loop.mjs", "MINGW64_NT-10.0");
  check("空格被编码", spacePath === "file:///C:/my%20repo/lib/decider-loop.mjs", spacePath);

  // 中文用户名在 Windows 上很常见，必须按 UTF-8 百分号编码
  const cjkPath = run("/c/Users/张三/x/decider-loop.mjs", "MINGW64_NT-10.0");
  check("中文路径被正确编码",
    cjkPath === "file:///C:/Users/%E5%BC%A0%E4%B8%89/x/decider-loop.mjs", cjkPath);

  for (const os of ["MINGW64_NT-10.0", "MSYS_NT-10.0", "CYGWIN_NT-10.0"]) {
    const unc = run("//server/share/my repo#1/张三/lib.mjs", os);
    check(`${os}: UNC authority 与路径编码`,
      unc === "file://server/share/my%20repo%231/%E5%BC%A0%E4%B8%89/lib.mjs", unc);
    check(`${os}: UNC URL 可解析且服务器名保留`, new URL(unc).hostname === "server");
  }
  const uncBack = run(String.raw`\\server\share\lib.mjs`, "MINGW64_NT-10.0");
  check("反斜杠 UNC 路径保留 authority", uncBack === "file://server/share/lib.mjs", uncBack);
  const percent = run("/c/a%20b/q?.mjs", "MSYS_NT-10.0");
  check("百分号与问号不会被解释为 URL 转义或查询", percent === "file:///C:/a%2520b/q%3F.mjs", percent);
  for (const [input, expected] of [
    ["/c/Users/tester/.config/ego-decision-layer/action-cache.json", "C:/Users/tester/.config/ego-decision-layer/action-cache.json"],
    ["/cygdrive/d/cache/action-cache.json", "D:/cache/action-cache.json"],
    ["/home/tester/.config/ego-decision-layer/action-cache.json", "C:/cygwin64/home/tester/.config/ego-decision-layer/action-cache.json"],
    ["/home/tester/cache.json", "C:/cygwin64/home/tester/cache.json"],
    ["//server/share/cache.json", "//server/share/cache.json"],
    [String.raw`C:\cache\action-cache.json`, "C:/cache/action-cache.json"],
  ]) {
    const actual = run(input, "CYGWIN_NT-10.0", "runtime");
    check(`子进程缓存路径: ${input}`, actual === expected, actual);
  }
  check("POSIX 子进程路径保持原样", run("/home/tester/cache.json", "Linux", "runtime") === "/home/tester/cache.json");

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
