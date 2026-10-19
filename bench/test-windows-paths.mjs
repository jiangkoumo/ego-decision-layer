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
check("TMPD 在 Windows 上转成混合路径", /cygpath -m "\$TMPD"/.test(src));

// ── 行为检查：真跑 _lib_to_url ─────────────────────────────────────────
const fnMatch = src.match(/_lib_to_url\(\)\s*\{[\s\S]*?\n\}/);
check("找到 _lib_to_url 函数", Boolean(fnMatch));

if (fnMatch) {
  const dir = mkdtempSync(join(tmpdir(), "ego-decision-layer-winpath-"));
  // 把 uname 换成可控桩：用 $FAKE_OS 固定分支，真实调用链不变
  const stubbed = fnMatch[0].replace(/\$\(uname -s 2>\/dev\/null\)/g, '"${FAKE_OS:-$(uname -s 2>/dev/null)}"');
  const scriptPath = join(dir, "probe.sh");
  // 写文件而不是 bash -c 传参：避免二次转义把反斜杠/斜杠吃掉。
  // 入参走环境变量，不用位置参数（避免 $0/$1 错位）。
  writeFileSync(scriptPath, `${stubbed}\n_lib_to_url "$PROBE_PATH"\n`);

  const run = (input, fakeOs) => {
    const env = { ...process.env, PROBE_PATH: input };
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

  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
