// scripts/wire-agent-skills.sh 的单元测试：无浏览器、无凭证、无网络，CI 可跑。
// 用一个临时 HOME 造出「官方技能软链」，验证接管 / 幂等 / 漂移检测 / 还原。
// 用法: node bench/test-wire-skill.mjs
const { spawnSync } = await import("node:child_process");
const fs = await import("node:fs");
const os = await import("node:os");
const { dirname, join, relative } = await import("node:path");
const { fileURLToPath } = await import("node:url");

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIRE = join(REPO, "scripts", "wire-agent-skills.sh");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const root = fs.mkdtempSync(join(os.tmpdir(), "ego-decision-layer-wire-"));
const HOME = join(root, "home");
const VENDOR = join(root, "vendor");
const SKILLS = join(HOME, ".agents", "skills");
const CFG = join(root, "cfg");
const ENTRY = join(SKILLS, "ego-browser");
const VENDOR_LINK = join(HOME, ".local", "share", "ego", "ego-skills");

const vendorSkill = (desc, version) => `---
name: ego-browser
description: ${desc}
metadata:
  version: "${version}"
  date: "2026-09-09"
---

# ego-browser

官方正文：这句必须留在软链目标里。
`;
const DESC_1 = "When you need a browser, read this Skill by default. VERSION-ONE-TEXT.";
const DESC_2 = "When you need a browser, read this Skill by default. VERSION-TWO-TEXT.";

const setup = () => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const d of [VENDOR, SKILLS, CFG, join(VENDOR, "references"), join(VENDOR, "scripts"), join(VENDOR, "learnings"), dirname(VENDOR_LINK), join(SKILLS, "ego-decision-layer")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(join(VENDOR, "SKILL.md"), vendorSkill(DESC_1, "2.0.0"));
  fs.writeFileSync(join(VENDOR, "references", "api.md"), "# api\n");
  fs.writeFileSync(join(SKILLS, "ego-decision-layer", "SKILL.md"), "---\nname: ego-decision-layer\n---\n");
  fs.symlinkSync(VENDOR, VENDOR_LINK, "dir");
  fs.symlinkSync(VENDOR_LINK, ENTRY, "dir");
};

// PATH 固定成 /usr/bin:/bin：避免测试里“vendor 消失”场景又被真机上的 ego-browser 回退探测捞回来
const baseEnv = () => ({ ...process.env, HOME, EGO_JEV_CONFIG_DIR: CFG, PATH: "/usr/bin:/bin" });
const wireEnv = (extra, ...args) => {
  const r = spawnSync("bash", [WIRE, ...args], { env: { ...baseEnv(), ...extra }, encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const wire = (...args) => wireEnv({}, ...args);
const overlayText = () => fs.readFileSync(join(ENTRY, "SKILL.md"), "utf8");
const isOverlay = () => fs.existsSync(join(ENTRY, ".ego-jev-overlay.json"));
const isOurOverlayAt = (p) => fs.existsSync(join(p, ".ego-jev-overlay.json"));
const isSymlink = () => fs.lstatSync(ENTRY).isSymbolicLink();

// ── [1] 接管 ────────────────────────────────────────────────────────────────
console.log("\n[1] 接管官方入口");
setup();
check("接管前 --check 报未接管（exit 1）", wire("--check").code === 1);
{
  const r = wire();
  check("wire 退出码 0", r.code === 0, r.out);
  check("入口变成实目录（不再是软链）", !isSymlink() && fs.statSync(ENTRY).isDirectory());
  check("生成了标记文件", isOverlay());
  check("生成物带路由规则", overlayText().includes("先路由，再决定写不写脚本"));
  check("生成物带 ego-decision-layer CLI 用法", overlayText().includes("ego-decision-layer --url"));
  check("保留了官方描述（触发词不变）", overlayText().includes(DESC_1));
  { // 回归保护（位置断言，不是 contains）：路由句必须排在厂商描述之前——描述被压缩时先丢尾部，
    // 旧拼法把路由句放末尾，等于最先被砍掉。这里断言路由句的开头与结尾都在厂商文本之前。
    const descLine = overlayText().split("\n").find((l) => l.startsWith("description: ")) || "";
    const pOpen = descLine.indexOf("多步线性");
    const pTail = descLine.indexOf("本入口已由 ego-decision-layer 接管");
    const pVendor = descLine.indexOf(DESC_1);
    check("路由句整段在厂商描述之前（位置断言）", pOpen >= 0 && pTail >= 0 && pVendor >= 0 && pOpen < pTail && pTail < pVendor, `open=${pOpen} tail=${pTail} vendor=${pVendor}`);
  }
  check("指向稳定的官方软链（不是版本号目录）", overlayText().includes(join(VENDOR_LINK, "SKILL.md")) && !overlayText().includes(join(VENDOR, "SKILL.md")));
  check("references 软链指向稳定路径", fs.readlinkSync(join(ENTRY, "references")) === join(VENDOR_LINK, "references"));
  check("生成物里没有时间戳（否则每次 --check 都会误报漂移）", !/\d{4}-\d{2}-\d{2}T/.test(overlayText()));
  check("官方正文经稳定软链可读", fs.readFileSync(join(VENDOR_LINK, "SKILL.md"), "utf8").includes("官方正文"));
  check("references 是软链且可读", fs.lstatSync(join(ENTRY, "references")).isSymbolicLink() && fs.readFileSync(join(ENTRY, "references", "api.md"), "utf8").includes("# api"));
  check("标记里存了原始软链目标", fs.readFileSync(join(ENTRY, ".ego-jev-overlay.json"), "utf8").includes(VENDOR_LINK));
  check("写了启用标记", fs.existsSync(join(CFG, "wire-enabled.json")));
  check("接管后 --check 通过（exit 0）", wire("--check").code === 0);
  { // 跨秒再查一次：生成物必须是确定性的（时间戳/随机数不得进 SKILL.md）
    const t0 = Date.now();
    while (Date.now() - t0 < 1100) { /* 跨过一秒边界 */ }
    check("换一秒后 --check 仍通过（生成物确定性）", wire("--check").code === 0);
  }
}

// ── [2] 幂等 ────────────────────────────────────────────────────────────────
console.log("\n[2] 幂等");
{
  const before = overlayText();
  const r = wire();
  check("重复 wire 退出码 0", r.code === 0, r.out);
  check("生成物不变", overlayText() === before);
  check("仍是我们的路由层", isOverlay());
}

// ── [3] dry-run 不落盘 ──────────────────────────────────────────────────────
console.log("\n[3] dry-run");
setup();
{
  const r = wire("--dry-run");
  check("dry-run 退出码 0", r.code === 0, r.out);
  check("dry-run 没动入口（还是软链）", isSymlink());
  check("dry-run 没写启用标记", !fs.existsSync(join(CFG, "wire-enabled.json")));
}

// ── [4] ego lite 升级 → 生成物过期，用 --check 抓到并刷新 ────────────────────
console.log("\n[4] 生成物过期（官方升级）");
setup();
wire();
fs.writeFileSync(join(VENDOR, "SKILL.md"), vendorSkill(DESC_2, "2.1.0"));
check("升级后 --check 报漂移（exit 1）", wire("--check").code === 1);
{
  const r = wire("--if-enabled");
  check("--if-enabled 重扫后刷新（exit 0）", r.code === 0, r.out);
  check("生成物已跟上新描述", overlayText().includes(DESC_2));
  check("--check 重新通过", wire("--check").code === 0);
}

// ── [4b] ego lite 换版本号：旧版本目录被删，生成物不能因此失效 ────────────────
console.log("\n[4b] ego lite 换版本号（旧目录消失）");
setup();
wire();
{
  const vendorNew = join(root, "vendor-new-version");
  fs.mkdirSync(join(vendorNew, "references"), { recursive: true });
  fs.writeFileSync(join(vendorNew, "SKILL.md"), vendorSkill(DESC_1, "2.0.0"));
  fs.writeFileSync(join(vendorNew, "references", "api.md"), "# api\n");
  fs.rmSync(VENDOR_LINK, { force: true });
  fs.symlinkSync(vendorNew, VENDOR_LINK, "dir");          // App 升级：稳定软链改指向新版本
  fs.rmSync(VENDOR, { recursive: true, force: true });    // 旧版本目录被删
  const r = wire("--check");
  check("稳定软链改指向后 --check 仍通过（没指向被删的版本目录）", r.code === 0, r.out);
  check("官方正文仍可读（经稳定软链）", fs.readFileSync(join(VENDOR_LINK, "SKILL.md"), "utf8").includes("官方正文"));
  check("references 仍可读", fs.readFileSync(join(ENTRY, "references", "api.md"), "utf8").includes("# api"));
}

// ── [5] ego lite 升级把入口还原成官方软链 → update.sh 用 --if-enabled 重接管 ─
console.log("\n[5] 入口被 App 还原");
setup();
wire();
fs.rmSync(ENTRY, { recursive: true, force: true });
fs.symlinkSync(VENDOR_LINK, ENTRY, "dir");
check("被还原后 --check 报漂移（exit 1）", wire("--check").code === 1);
{
  const r = wire("--if-enabled");
  check("--if-enabled 重新接管（exit 0）", r.code === 0, r.out);
  check("入口又变回路由层", isOverlay());
}

// ── [6] 没启用过时 --if-enabled 什么都不做 ──────────────────────────────────
console.log("\n[6] --if-enabled 且从未启用");
setup();
{
  const r = wire("--if-enabled");
  check("退出码 0（静默跳过）", r.code === 0, r.out);
  check("入口保持官方软链", isSymlink() && !isOverlay());
  check("没写启用标记", !fs.existsSync(join(CFG, "wire-enabled.json")));
}

// ── [7] 不碰别人的软链 ──────────────────────────────────────────────────────
console.log("\n[7] 不越界");
setup();
const OTHER = join(root, "other-skill");
fs.mkdirSync(OTHER, { recursive: true });
fs.writeFileSync(join(OTHER, "SKILL.md"), "---\nname: other\n---\n");
fs.rmSync(ENTRY, { force: true });
fs.symlinkSync(OTHER, ENTRY, "dir");
{
  const r = wire();
  check("指向别处的软链不被接管（exit 1：一个都没接管到）", r.code === 1, r.out);
  check("软链没被动", isSymlink() && fs.readlinkSync(ENTRY) === OTHER);
  check("没写启用标记", !fs.existsSync(join(CFG, "wire-enabled.json")));
  check("输出里有跳过原因", r.out.includes("跳过"));
}

// ── [8] 还原 ────────────────────────────────────────────────────────────────
console.log("\n[8] 还原官方软链");
setup();
wire();
{
  const r = wire("--restore");
  check("--restore 退出码 0", r.code === 0, r.out);
  check("入口恢复成软链", isSymlink());
  check("指向原目标", fs.readlinkSync(ENTRY) === VENDOR_LINK);
  check("路由层已删干净（标记文件消失）", !isOverlay());
  check("清掉了启用标记", !fs.existsSync(join(CFG, "wire-enabled.json")));
  check("官方正文仍可读", fs.readFileSync(join(ENTRY, "SKILL.md"), "utf8").includes("官方正文"));
  check("再 --restore 是 no-op（exit 0）", wire("--restore").code === 0);
}

// ── [9] ego lite 不在了也要能撤（逃生口不自锁）────────────────────────────
console.log("\n[9] vendor 消失（卸载 / 升级窗口）");
setup();
wire();
fs.rmSync(VENDOR_LINK, { force: true });
fs.rmSync(VENDOR, { recursive: true, force: true });
{
  const c = wire("--check");
  check("--check 报漂移而不是用法错误（exit 1）", c.code === 1, c.out);
  check("--check 不再打印 error:", !c.out.includes("error:"), c.out);
  const w = wire("--if-enabled");
  check("--if-enabled 不崩（exit 1）", w.code === 1, w.out);
  check("路由层还在（没被清掉）", isOverlay());
  const r = wire("--restore");
  check("--restore 仍能还原（exit 0）", r.code === 0, r.out);
  check("还原成软链", isSymlink());
}

// ── [10] 入口被删 / 悬空软链 → --check 必须报（不能报「检查通过」）──────────
console.log("\n[10] 入口消失与悬空软链");
setup();
wire();
fs.rmSync(ENTRY, { recursive: true, force: true });
{
  const c = wire("--check");
  check("入口被删后 --check exit 1", c.code === 1, c.out);
  check("不再声称「检查通过」", !c.out.includes("检查通过"));
  const w = wire("--if-enabled");
  check("--if-enabled 把入口接回来（exit 0）", w.code === 0, w.out);
  check("入口又是路由层且内容可用", isOverlay() && overlayText().includes("先路由"));
  check("标记里的原目标指向稳定入口", fs.readFileSync(join(ENTRY, ".ego-jev-overlay.json"), "utf8").includes(VENDOR_LINK));
}
setup();
wire();
fs.rmSync(ENTRY, { recursive: true, force: true });
fs.symlinkSync(join(root, "Versions", "9.9.9", "Resources", "ego-skills", "ego-browser"), ENTRY, "dir");
{
  const c = wire("--check");
  check("悬空 ego 形状软链 → --check exit 1", c.code === 1, c.out);
  const w = wire("--if-enabled");
  check("悬空软链也能被重接管（exit 0）", w.code === 0, w.out);
  check("入口变成可用的路由层", isOverlay() && overlayText().includes("先路由"));
}

// ── [11] 官方技能是拷贝目录 → 不覆盖，且绝不谎报成功 ────────────────────
console.log("\n[11] 官方技能是拷贝目录");
setup();
fs.rmSync(ENTRY, { force: true });
fs.mkdirSync(ENTRY, { recursive: true });
fs.writeFileSync(join(ENTRY, "SKILL.md"), vendorSkill(DESC_1, "2.0.0"));
{
  const w = wire();
  check("不覆盖普通目录（exit 1：没接管到）", w.code === 1, w.out);
  check("提示需人工处理", w.out.includes("普通目录"));
  check("不谎报「已接管 1 个入口」", !w.out.includes("已接管 1 个入口"));
  check("原内容没被动", fs.readFileSync(join(ENTRY, "SKILL.md"), "utf8").includes("官方正文"));
  check("--check exit 1", wire("--check").code === 1);
}

// ── [12] 名字里带 ego-skills 的无关软链不许误伤 ───────────────────────────
console.log("\n[12] 相似名字的软链");
setup();
const FOREIGN = join(root, "my-ego-skills", "other");
fs.mkdirSync(FOREIGN, { recursive: true });
fs.writeFileSync(join(FOREIGN, "SKILL.md"), "---\nname: other\n---\n");
fs.rmSync(ENTRY, { force: true });
fs.symlinkSync(FOREIGN, ENTRY, "dir");
{
  const w = wire();
  check("不接管（exit 1）", w.code === 1, w.out);
  check("软链原样", fs.readlinkSync(ENTRY) === FOREIGN);
  check("理由是「指向别处」", w.out.includes("指向别处"));
}

// ── [13] --dir 接管的目录，--if-enabled 也要继续维护 ──────────────────────
console.log("\n[13] --dir 自定义目录");
setup();
const CUSTOM = join(root, "custom-skills");
fs.mkdirSync(CUSTOM, { recursive: true });
fs.symlinkSync(VENDOR_LINK, join(CUSTOM, "ego-browser"), "dir");
{
  const w = wire("--dir", CUSTOM);
  check("--dir 接管成功", w.code === 0 && isOurOverlayAt(join(CUSTOM, "ego-browser")), w.out);
  check("启用标记记下了自定义目录", fs.readFileSync(join(CFG, "wire-enabled.json"), "utf8").includes(CUSTOM));
  fs.writeFileSync(join(VENDOR, "SKILL.md"), vendorSkill(DESC_2, "2.0.0"));
  const r = wire("--if-enabled");
  check("--if-enabled（不带 --dir）会刷到自定义目录（exit 0）", r.code === 0, r.out);
  check("自定义目录的生成物已更新", fs.readFileSync(join(CUSTOM, "ego-browser", "SKILL.md"), "utf8").includes(DESC_2));
}

// ── [14] 接管失败时 install.sh / update.sh 必须非零退出 ──────────────────
console.log("\n[14] 包装脚本的退出码");
setup();
const EMPTY_SKILLS = join(root, "empty-skills");
fs.mkdirSync(EMPTY_SKILLS, { recursive: true });
const fakeBin = join(root, "fakebin");
const makeFakeEgoBrowser = () => {
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(join(fakeBin, "ego-browser"), `#!/bin/sh
echo "$*" >> "\${FAKE_LOG:-/dev/null}"
case "$1" in
  --version|-v) echo "ego-browser 0.0.0-test"; exit 0 ;;
esac
exit 3
`, { mode: 0o755 });
};
makeFakeEgoBrowser();
{
  const r = spawnSync("bash", [join(REPO, "install.sh"), "--wire", "--bindir", join(root, "bin-install"), "--skills-dir", join(root, "skills-install")], {
    env: { ...baseEnv(), PATH: `${dirname(process.execPath)}:${fakeBin}:/usr/bin:/bin`, EGO_JEV_SKILLS_DIRS: EMPTY_SKILLS },
    encoding: "utf8",
  });
  check("install.sh --wire 没接管到时非零退出", r.status !== 0, `status=${r.status}`);
}
{
  // update.sh：拷一份最小仓库（无 .git → 跳过 pull），指向一个没有任何入口的技能目录
  const mini = join(root, "mini");
  fs.mkdirSync(join(mini, "scripts"), { recursive: true });
  fs.mkdirSync(join(mini, "overlay", "ego-browser"), { recursive: true });
  for (const f of ["SKILL.md", "install.sh", "update.sh"]) fs.copyFileSync(join(REPO, f), join(mini, f));
  for (const f of ["ego-decision-layer", "decider-loop.mjs", "wire-agent-skills.sh", "update.sh"]) fs.copyFileSync(join(REPO, "scripts", f), join(mini, "scripts", f));
  fs.copyFileSync(join(REPO, "overlay", "ego-browser", "SKILL.md.in"), join(mini, "overlay", "ego-browser", "SKILL.md.in"));
  fs.writeFileSync(join(CFG, "wire-enabled.json"), `{\n  "enabled": true,\n  "dirs": ["${join(root, "missing-skills")}"]\n}\n`);
  const r = spawnSync("bash", [join(mini, "update.sh")], {
    env: { ...baseEnv(), BINDIR: join(root, "bin-update"), EGO_JEV_SKILLS_DIRS: join(root, "missing-skills") },
    encoding: "utf8",
  });
  check("update.sh 重接管失败时非零退出", r.status !== 0, `status=${r.status}`);
}

// ── [15] 厂商描述里出现 ": " 也不能把技能搞成非法 YAML ──────────────────────
console.log("\n[15] 描述含冒号的 YAML 安全");
setup();
const DESC_COLON = "Use ego-browser: the browser tool. Nested: mappings are not allowed.";
fs.writeFileSync(join(VENDOR, "SKILL.md"), vendorSkill(DESC_COLON, "2.0.0"));
wire();
{
  const text = overlayText();
  const line = text.split("\n").find((l) => l.startsWith("description: "));
  check("description 是单引号标量", line.startsWith("description: '") && line.endsWith("'"), line.slice(0, 70));
  const value = line.slice("description: ".length).slice(1, -1).replace(/''/g, "'");
  check("描述内容完整保留（含厂商文本与接管说明）", value.includes(DESC_COLON) && value.includes("已由 ego-decision-layer 接管"));
  check("路由句排在厂商描述之前（位置断言）", value.indexOf("本入口已由 ego-decision-layer 接管") < value.indexOf(DESC_COLON) && value.indexOf(DESC_COLON) > 0, `route=${value.indexOf("本入口已由 ego-decision-layer 接管")} vendor=${value.indexOf(DESC_COLON)}`);
  check("description 只占一行", text.split("\n").filter((l) => l.startsWith("description: ")).length === 1);
  let yamlOk = null;
  try {
    const YAML = await import("yaml");
    yamlOk = YAML.parse(text.split("---\n")[1])?.description?.includes(DESC_COLON) === true;
  } catch { /* 环境里没有 yaml 包 → 跳过这一步 */ }
  if (yamlOk !== null) check("真 YAML 解析通过", yamlOk);
  check("--check 仍通过", wire("--check").code === 0);
}

// ── [16] 厂商新增子目录也要软链上，断了要能发现 ──────────────────────────
console.log("\n[16] 厂商新增子目录");
setup();
fs.mkdirSync(join(VENDOR, "templates"), { recursive: true });
fs.writeFileSync(join(VENDOR, "templates", "t.md"), "t\n");
wire();
{
  check("新子目录被软链", fs.lstatSync(join(ENTRY, "templates")).isSymbolicLink());
  check("软链可读", fs.readFileSync(join(ENTRY, "templates", "t.md"), "utf8") === "t\n");
  check("--check 通过", wire("--check").code === 0);
  fs.rmSync(join(ENTRY, "templates"), { force: true });
  check("软链被删后 --check 报漂移（exit 1）", wire("--check").code === 1);
}

// ── [17] 用法 / --help / 单行 marker ──────────────────────────────────────
console.log("\n[17] 用法与逃生口细节");
setup();
{
  check("--dir 空值 → 用法错误 exit 2", wire("--dir", "").code === 2);
  const h = wire("--help");
  check("--help 只打印注释（不泄漏实现行）", !h.out.includes("set -uo pipefail") && !h.out.includes("REPO_DIR="), h.out.slice(0, 120));
  check("--help 里有退出码说明", h.out.includes("退出码"));
}
setup();
wire();
{
  const m = join(ENTRY, ".ego-jev-overlay.json");
  fs.writeFileSync(m, fs.readFileSync(m, "utf8").split("\n").filter(Boolean).join(" "));
  const r = wire("--restore");
  check("单行 marker → 不删目录、非零退出", r.code === 1 && isOverlay(), r.out);
  check("提示需手工恢复", r.out.includes("手工恢复"));
}

// ── [18] frontmatter 字段取自厂商（缩进字段也要读到）──────────────────
console.log("\n[18] frontmatter 字段");
setup();
wire();
{
  const text = overlayText();
  check("version 带上厂商版本号", /version: "2\.0\.0\+ego-decision-layer"/.test(text), text.split("\n").find((l) => l.includes("version:")));
  check("date 带上厂商日期", /date: "2026-09-09"/.test(text), text.split("\n").find((l) => l.includes("date:")));
}

// ── [19] 探测到但从没接管过的目录：不算漂移，也不许被 --if-enabled 新建入口 ──
console.log("\n[19] 没有入口的目录");
setup();
const CODEX = join(HOME, ".codex", "skills");
fs.mkdirSync(CODEX, { recursive: true });
wire();
{
  const c = wire("--check");
  check("空目录不算漂移（exit 0）", c.code === 0, c.out);
  check("没有给空目录新建入口", !fs.existsSync(join(CODEX, "ego-browser")));
  const r = wire("--if-enabled");
  check("--if-enabled 也不给空目录新建入口", !fs.existsSync(join(CODEX, "ego-browser")), r.out);
}

// ── [20] 官方目录没解析到时：绝不写盘（否则 "$VENDOR"/*/ 会变成 /*/）────────
// 注意：必须保留了另一个 overlay，才会走到 -L 报告分支（否则顶层守卫就 exit 2，这条测试会假绿）
console.log("\n[20] vendor 空时不许写盘");
setup();
const CLAUDE = join(HOME, ".claude", "skills");
fs.mkdirSync(CLAUDE, { recursive: true });
fs.symlinkSync(VENDOR_LINK, join(CLAUDE, "ego-browser"), "dir");
const BOTH = `${SKILLS}:${CLAUDE}`;
wireEnv({ EGO_JEV_SKILLS_DIRS: BOTH });
fs.rmSync(join(CLAUDE, "ego-browser"), { recursive: true, force: true });
fs.symlinkSync(VENDOR_LINK, join(CLAUDE, "ego-browser"), "dir");   // 升级窗口：入口又变回官方软链
fs.rmSync(VENDOR_LINK, { force: true });
fs.rmSync(VENDOR, { recursive: true, force: true });               // vendor 整个消失
{
  const r = wireEnv({ EGO_JEV_SKILLS_DIRS: BOTH });
  check("不接管、非零退出（exit 1）", r.code === 1, r.out);
  check("确实走到了 -L 报告分支", r.out.includes("找不到 ego lite 技能目录，不接管"), r.out);
  check("入口仍是官方软链（没被变成目录）", fs.lstatSync(join(CLAUDE, "ego-browser")).isSymbolicLink());
  check("没写出指向系统根目录的软链", !fs.existsSync(join(CLAUDE, "ego-browser", "etc")) && !fs.existsSync(join(CLAUDE, "ego-browser", "SKILL.md")));
  check(".agents 的既有路由层没被动", isOurOverlayAt(ENTRY));
}

// ── [21] 显式坏 --vendor / EGO_JEV_VENDOR：wire 拒绝，--check/--restore 不被锁死 ──
console.log("\n[21] 显式坏 --vendor");
setup();
wire();
const BAD_VENDOR = join(root, "no-such-vendor");
{
  check("wire --vendor 坏路径（overlay 还在时）= exit 2", wire("--vendor", BAD_VENDOR).code === 2);
  check("--check --vendor 坏路径 = exit 1（不再 2）", wire("--check", "--vendor", BAD_VENDOR).code === 1);
  check("EGO_JEV_VENDOR 坏路径：--check = 1", wireEnv({ EGO_JEV_VENDOR: BAD_VENDOR }, "--check").code === 1);
  check("--restore --vendor 坏路径仍能还原（exit 0）", wire("--restore", "--vendor", BAD_VENDOR).code === 0);
  check("还原成了软链", isSymlink());
  check("wire --vendor 坏路径（无 overlay）= exit 2", wire("--vendor", BAD_VENDOR).code === 2);
  check("EGO_JEV_VENDOR 坏路径：--restore = 0", wireEnv({ EGO_JEV_VENDOR: BAD_VENDOR }, "--restore").code === 0);
}

// ── [22] 入口被删后，普通 wire 也要能重建（--check 叫用户跑的就是它）──────────
console.log("\n[22] wire 重建被删的入口");
setup();
wire();
fs.rmSync(ENTRY, { recursive: true, force: true });
{
  const w = wire();
  check("普通 wire 重建成功（exit 0）", w.code === 0 && isOverlay(), w.out);
  check("重建的是可用路由层", overlayText().includes("先路由"));
}

// ── [23] 巧合的 Resources/ego-skills 布局不再被接管 ───────────────────────
console.log("\n[23] 巧合路径");
setup();
const COINCIDENT = join(root, "fake", "Resources", "ego-skills", "ego-browser");
fs.mkdirSync(COINCIDENT, { recursive: true });
fs.writeFileSync(join(COINCIDENT, "SKILL.md"), "---\nname: other\n---\n");
fs.rmSync(ENTRY, { force: true });
fs.symlinkSync(COINCIDENT, ENTRY, "dir");
{
  const w = wire();
  check("不接管（exit 1）", w.code === 1 && fs.readlinkSync(ENTRY) === COINCIDENT, w.out);
}

// ── [24] 原目标指向已删版本目录 → --restore 改回稳定入口 ────────────────
console.log("\n[24] 原目标已失效的还原");
setup();
wire();
{
  const m = join(ENTRY, ".ego-jev-overlay.json");
  const dead = join(root, "Versions", "1.2.3", "Resources", "ego-skills", "ego-browser");
  fs.writeFileSync(m, fs.readFileSync(m, "utf8").replace(VENDOR_LINK, dead));
  const r = wire("--restore");
  check("还原时不指向已删目录（exit 0）", r.code === 0, r.out);
  check("改回稳定入口", isSymlink() && fs.readlinkSync(ENTRY) === VENDOR_LINK, fs.readlinkSync(ENTRY));
  check("稳定入口可读", fs.readFileSync(join(ENTRY, "SKILL.md"), "utf8").includes("官方正文"));
}

// ── [25] --dir 优先于 EGO_JEV_SKILLS_DIRS ────────────────────────────────
console.log("\n[25] --dir 优先于环境变量");
setup();
const CUSTOM2 = join(root, "custom2");
fs.mkdirSync(CUSTOM2, { recursive: true });
fs.symlinkSync(VENDOR_LINK, join(CUSTOM2, "ego-browser"), "dir");
{
  const r = wireEnv({ EGO_JEV_SKILLS_DIRS: SKILLS }, "--dir", CUSTOM2);
  check("--dir 生效、环境变量被忽略", r.code === 0 && isOurOverlayAt(join(CUSTOM2, "ego-browser")), r.out);
  check("环境变量里的目录没被动", isSymlink());
}

// ── [26] install.sh --wire 成功路径 ──────────────────────────────────────
console.log("\n[26] install.sh --wire 成功路径");
setup();
makeFakeEgoBrowser();
{
  const r = spawnSync("bash", [join(REPO, "install.sh"), "--wire", "--bindir", join(root, "bin26"), "--skills-dir", join(root, "skills26")], {
    env: { ...baseEnv(), PATH: `${dirname(process.execPath)}:${fakeBin}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  check("install.sh --wire 成功退出 0", r.status === 0, `status=${r.status} ${(r.stdout||"").slice(-200)}`);
  check("入口确实被接管了", isOverlay());
}

// ── [27] 相对软链：检查口径与还原都要对 ──────────────────────────────
console.log("\n[27] 相对软链");
setup();
const REL_TARGET = relative(SKILLS, VENDOR_LINK);
fs.rmSync(ENTRY, { force: true });
fs.symlinkSync(REL_TARGET, ENTRY, "dir");
{
  const c = wire("--check");
  check("--check exit 1", c.code === 1, c.out);
  check("不把 ego 相对软链说成「不是 ego lite 技能」", !c.out.includes("不是 ego lite 技能"), c.out);
  const w = wire();
  check("wire 能接管相对软链（exit 0）", w.code === 0 && isOverlay(), w.out);
  check("标记按原样记下相对目标", fs.readFileSync(join(ENTRY, ".ego-jev-overlay.json"), "utf8").includes(`"original": "${REL_TARGET}"`));
  const r = wire("--restore");
  check("--restore 后仍是同一条相对软链（exit 0）", r.code === 0 && fs.readlinkSync(ENTRY) === REL_TARGET, `${r.code} ${fs.readlinkSync(ENTRY)}`);
}

// ── [28] frontmatter YAML 安全性：无依赖检查 + 负对照（真 YAML 包在 CI 里没有）──
console.log("\n[28] frontmatter YAML 安全性");
const unquotedColonIssue = (text) => {
  const fm = text.split("---\n")[1] ?? "";
  return fm.split("\n").some((l) => {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(l);
    if (!m) return false;
    const v = m[2];
    if (!v || v.startsWith("'") || v.startsWith('"') || v.startsWith("|") || v.startsWith(">")) return false;
    return v.includes(": ");   // 未加引号的映射值里出现 ": " → YAML 解析失败，整条技能在 Agent 列表里消失
  });
};
setup();
fs.writeFileSync(join(VENDOR, "SKILL.md"), vendorSkill("Use ego-browser: the browser tool. Nested: mappings are not allowed.", "2.0.0"));
wire();
{
  check("生成物里没有未加引号的 ': '", !unquotedColonIssue(overlayText()));
  check("负对照：修复前的写法会被抓出来", unquotedColonIssue("---\ndescription: \u4e00\u53e5\u8bdd: \u5e26\u5192\u53f7\n---\n"));
}

// ── [29] ego-decision-layer 启动时自愈路由层（档 2）────────────────────────────
console.log("\n[29] CLI 启动自愈");
const stubKey = () => {
  fs.mkdirSync(join(HOME, ".config", "typesafe"), { recursive: true });
  fs.writeFileSync(join(HOME, ".config", "typesafe", "api_key"), "stub-key\n");
};
const runCli = (extra = {}) => {
  const env = { ...baseEnv(), TYPESAFE_API_KEY: "", FAKE_LOG: join(root, "fake.log"), PATH: `${dirname(process.execPath)}:${fakeBin}:/usr/bin:/bin`, ...extra };
  const r = spawnSync("bash", [join(REPO, "scripts", "ego-decision-layer"), "--url", "https://example.com", "点一下"], { env, encoding: "utf8" });
  const argv = fs.existsSync(join(root, "fake.log")) ? fs.readFileSync(join(root, "fake.log"), "utf8") : "(none)";
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, argv };
};
const restoreOfficialEntry = () => {
  fs.rmSync(ENTRY, { recursive: true, force: true });
  fs.symlinkSync(VENDOR_LINK, ENTRY, "dir");      // 模拟 ego 升级把入口重建回官方软链
};
{
  setup();
  makeFakeEgoBrowser();
  stubKey();
  wire();
  restoreOfficialEntry();
  const r = runCli();
  check("跑 ego-decision-layer 会把入口自愈回路由层", isOurOverlayAt(ENTRY), r.out);
  check("stderr 有自愈提示", r.out.includes("已自动重接管"), r.out);
  check("退出码仍来自引擎（fake ego-browser 的 3）", r.code === 3, `code=${r.code} argv=${JSON.stringify(r.argv)} out=${r.out.slice(-200)}`);
  check("自愈后 --check 通过", wire("--check").code === 0);

  restoreOfficialEntry();
  const r2 = runCli({ EGO_JEV_NO_HEAL: "1" });
  check("EGO_JEV_NO_HEAL=1 时不动入口", fs.lstatSync(ENTRY).isSymbolicLink() && !isOurOverlayAt(ENTRY), r2.out);
  check("也没有自愈提示", !r2.out.includes("已自动重接管"));
}
{
  setup();                                          // 从没接管过的机器：CLI 首跑会一次性接管
  makeFakeEgoBrowser();
  stubKey();
  const r = runCli();
  check("首跑：检测到官方入口 → 接管一次", isOurOverlayAt(ENTRY), r.out);
  check("首跑：打印一行说明（含还原提示）", r.out.includes("首次运行") && r.out.includes("--restore"), r.out);
  check("首跑：退出码仍来自引擎（fake ego-browser 的 3）", r.code === 3, `code=${r.code}`);
  check("首跑：写了启用标记", fs.existsSync(join(CFG, "wire-enabled.json")));
  const r2 = runCli();
  check("第二次：已启用 → 静默刷新，不再打首跑说明", isOurOverlayAt(ENTRY) && !r2.out.includes("首次运行"), r2.out);
}
{
  setup();                                          // 连官方入口都没有的机器：CLI 什么都不做
  makeFakeEgoBrowser();
  stubKey();
  fs.rmSync(ENTRY, { recursive: true, force: true });
  const r = runCli();
  check("没有官方入口 → 不建目录、不写标记", !fs.existsSync(ENTRY) && !fs.existsSync(join(CFG, "wire-enabled.json")), r.out);
}
{
  setup();                                          // EGO_JEV_NO_WIRE 整体关掉
  makeFakeEgoBrowser();
  stubKey();
  const r = runCli({ EGO_JEV_NO_WIRE: "1" });
  check("EGO_JEV_NO_WIRE=1 → 完全不接管", fs.lstatSync(ENTRY).isSymbolicLink() && !isOurOverlayAt(ENTRY), r.out);
  check("EGO_JEV_NO_WIRE=1 → 没有首跑说明", !r.out.includes("首次运行"), r.out);
}
{
  setup();                                          // 缺凭证的错误路径不写盘
  makeFakeEgoBrowser();
  wire();
  restoreOfficialEntry();
  const r = runCli({ TYPESAFE_API_KEY_FILE: join(root, "nope", "api_key") });
  check("缺凭证时退出 3 且不自愈", r.code === 3 && fs.lstatSync(ENTRY).isSymbolicLink(), `code=${r.code} ${r.out.slice(0, 60)}`);
}

// ── [30] macOS bash 3.2 的 "$VAR 紧跟中文" 陷阱（会让脚本直接崩在 unbound variable）──
console.log("\n[30] bash 3.2 变量展开陷阱");
{
  const bad = [];
  for (const f of ["scripts/ego-decision-layer", "scripts/ego-jev", "scripts/wire-agent-skills.sh", "install.sh", "update.sh"]) {   // 含历史垫片
    const src = fs.readFileSync(join(REPO, f), "utf8");
    src.split("\n").forEach((line, i) => {
      if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(line)) bad.push(`${f}:${i + 1}`);
    });
  }
  check("脚本里没有「$VAR 紧跟非 ASCII 字符」", bad.length === 0, bad.join(", "));
}
{
  setup();
  makeFakeEgoBrowser();
  stubKey();
  const r = runCli({ EGO_BROWSER_BIN: "no-such-ego-binary-xyz", EGO_JEV_NO_HEAL: "1" });
  check("ego-browser 缺失时报错而不是崩", r.code === 2 && !r.out.includes("unbound variable") && r.out.includes("找不到"), `code=${r.code} ${r.out.slice(0, 120)}`);
}

// ── [31] --check：无需接管结论 + 三个数字 + 只读 ────────────────────────────
console.log("\n[31] --check 结论与只读性");
{
  setup();
  fs.mkdirSync(join(HOME, ".codex", "skills", "ego-decision-layer"), { recursive: true });
  fs.writeFileSync(join(HOME, ".codex", "skills", "ego-decision-layer", "SKILL.md"), "---\nname: ego-decision-layer\n---\n");
  wire();
  const c = wire("--check");
  check("--check exit 0", c.code === 0, c.out);
  check("无需接管：写明结论与原因", c.out.includes("无需接管") && c.out.includes("没有官方 ego-browser 入口"), c.out);
  const m = c.out.match(/已接管 (\d+) \/ 无需接管 (\d+) \/ 漂移 (\d+)/);
  check("汇总三个数字", Boolean(m), c.out);
  check("数字：1 接管 / 0 漂移", Boolean(m) && m[1] === "1" && m[3] === "0", c.out);
  check("--check 报告 always-on 块数", /always-on 块: \d+ 个文件在位/.test(c.out), c.out);
  const snapshotTree = (dir) => {
    const out = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        const st = fs.lstatSync(p);
        if (st.isSymbolicLink()) { out.push(`${p}|L|${st.mtimeMs}|${fs.readlinkSync(p)}`); continue; }
        if (st.isDirectory()) { out.push(`${p}|D|${st.mtimeMs}`); walk(p); continue; }
        out.push(`${p}|F|${st.mtimeMs}|${st.size}`);
      }
    };
    walk(dir);
    return out.sort().join("\n");
  };
  const before = snapshotTree(root);
  const c2 = wire("--check");
  check("--check 两次输出一致", c.out === c2.out);
  check("--check 没有写任何文件（含 mtime）", snapshotTree(root) === before);
}

// ── [32] --ensure：CLI 首跑用的三态 ────────────────────────────────────────
console.log("\n[32] --ensure 三态");
{
  setup();
  const r = wire("--ensure");
  check("未启用但有官方入口 → 首跑接管（exit 0）", r.code === 0 && isOurOverlayAt(ENTRY), r.out);
  check("输出含首跑标记", r.out.includes("已首跑接管"), r.out);
  const r2 = wire("--ensure");
  check("已启用 → 静默刷新（不再首跑）", r2.code === 0 && !r2.out.includes("已首跑接管"), r2.out);
}
{
  setup();
  fs.rmSync(ENTRY, { recursive: true, force: true });
  const r = wire("--ensure");
  check("无官方入口 → 什么都不做（exit 0，无输出）", r.code === 0 && r.out.trim() === "", JSON.stringify(r.out));
  check("无官方入口 → 不写启用标记", !fs.existsSync(join(CFG, "wire-enabled.json")));
}
{
  setup();
  const r = wireEnv({ EGO_JEV_NO_WIRE: "1" }, "--ensure");
  check("EGO_JEV_NO_WIRE=1 → 什么都不做", r.code === 0 && fs.lstatSync(ENTRY).isSymbolicLink() && !isOurOverlayAt(ENTRY), r.out);
}

// ── [33] install.sh 默认接管 / --no-wire ─────────────────────────────────────
console.log("\n[33] install.sh 默认接管");
{
  setup();
  makeFakeEgoBrowser();
  const env = { ...baseEnv(), PATH: `${dirname(process.execPath)}:${fakeBin}:/usr/bin:/bin` };
  const r = spawnSync("bash", [join(REPO, "install.sh"), "--bindir", join(root, "bin33a"), "--skills-dir", join(root, "skills33a")], { env, encoding: "utf8" });
  check("默认（不带 --wire）就接管", isOurOverlayAt(ENTRY), `status=${r.status} ${(r.stdout || "").slice(-200)}`);
  check("默认接管也成功退出", r.status === 0, `status=${r.status}`);
}
{
  setup();
  makeFakeEgoBrowser();
  const env = { ...baseEnv(), PATH: `${dirname(process.execPath)}:${fakeBin}:/usr/bin:/bin` };
  const r = spawnSync("bash", [join(REPO, "install.sh"), "--no-wire", "--bindir", join(root, "bin33b"), "--skills-dir", join(root, "skills33b")], { env, encoding: "utf8" });
  check("--no-wire 跳过接管", fs.lstatSync(ENTRY).isSymbolicLink() && !isOurOverlayAt(ENTRY), `status=${r.status} ${(r.stdout || "").slice(-200)}`);
  check("--no-wire 仍成功退出", r.status === 0, `status=${r.status}`);
}

// ── [34] --restore 是粘性的：自动路径不得撤销用户选择 ────────────────────────
console.log("\n[34] opt-out 粘性");
{
  setup();
  wire();
  wire("--restore");
  check("--restore 写了 opt-out 标记", fs.existsSync(join(CFG, "opted-out")));
  const e = wire("--ensure");
  check("--ensure 不再接管（exit 0，入口仍是官方软链）", e.code === 0 && fs.lstatSync(ENTRY).isSymbolicLink() && !isOurOverlayAt(ENTRY), e.out);
  check("--ensure 不写启用标记", !fs.existsSync(join(CFG, "wire-enabled.json")));
  check("--ensure 不打首跑噪音", !e.out.includes("已首跑接管"), e.out);
  const c = wire("--check");
  check("opt-out 状态下 --check exit 0", c.code === 0, c.out);
  check("--check 文案含「不接管」", c.out.includes("不接管"), c.out);
  const s = JSON.parse(wire("--status-json").out);
  check("--status-json optedOut=true", s.optedOut === true, JSON.stringify(s.optedOut));
  check("opt-out 下不报漂移", s.summary.k === 0 && s.dirs.every((d) => !d.drift), JSON.stringify(s.summary));
  const w = wire();
  check("显式 wire 清掉 opt-out", w.code === 0 && !fs.existsSync(join(CFG, "opted-out")), w.out);
  check("显式 wire 恢复接管", isOurOverlayAt(ENTRY));
  check("显式 wire 后 optedOut=false", JSON.parse(wire("--status-json").out).optedOut === false);
  const e2 = wire("--ensure");
  check("恢复后 --ensure 是刷新（不再首跑）", e2.code === 0 && !e2.out.includes("已首跑接管"), e2.out);
}
{
  setup();   // 回归保护：没有 opt-out 的普通未接管仍 exit 1
  const c = wire("--check");
  check("普通未接管（无 opt-out）仍 exit 1", c.code === 1, c.out);
  check("普通未接管不写 opt-out", !fs.existsSync(join(CFG, "opted-out")));
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;