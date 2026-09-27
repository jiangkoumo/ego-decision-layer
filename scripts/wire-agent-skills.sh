#!/usr/bin/env bash
# ego-decision-layer — 把 Agent 技能目录里的 ego-browser 入口接管成「路由层」，让多步浏览器任务默认走 ego-decision-layer。
#
# 背景：ego lite 会把官方技能写进每个 Agent 的技能目录（~/.agents/skills、~/.claude/skills……），
# 那个位置由 App 管理、升级时会重建；官方正文不知道 ego-decision-layer 存在，于是 Agent 默认照着它写逐步脚本。
# 本脚本把入口换成路由层：技能正文仍是 App 的当前版本（软链跟随，升级自动更新），
# 只是最前面多一条路由规则——多步线性任务先走 `ego-decision-layer`。
#
# 只写 Agent 技能目录，不碰 /Applications 里的应用包；`--restore` 可还原成官方软链。
#
# 用法:
#   scripts/wire-agent-skills.sh [--dry-run] [--check] [--restore] [--if-enabled] [--ensure]
#                                [--status-json] [--always-on FILE] [--always-on --remove FILE]
#                                [--dir DIR]... [--vendor DIR]
#
#   （默认动作）接管 / 刷新：把已存在的 ego-browser 入口换成路由层，幂等
#   --check       只读检查：每个目录给出结论（已接管 / 无需接管 / 漂移），并汇总三个数字
#   --restore     还原：接管层变回原软链，同时移除所有已记录的 always-on 块
#   --if-enabled  仅当之前接管过（有启用标记）才动手；给 update.sh 用
#   --ensure      给 CLI 首跑用：接管过就静默刷新；没接管过但检测到官方入口才首跑接管一次；
#                 两者都不是就什么都不做（见下方 EGO_JEV_NO_WIRE）
#   --status-json 只读：把同一份路由状态输出成 JSON（给 `ego-decision-layer --route-status` 用）
#   --always-on FILE  向 FILE 插入一段带标记的路由说明块（幂等、可精确移除）
#   --always-on --remove FILE
#                 只从 FILE 移除我们自己的标记块（文件其余内容逐字节不变；**不动接管层**）；
#                 别名：--always-on-remove FILE。幂等：没有块时 exit 0；文件不存在 → exit 2
#   --dry-run     只打印会做什么，不落盘
#
# 退出码: 0 正常 / 1 需要处理（--check 发现漂移；或接管动作没达成） / 2 用法或环境错误
#
# 环境变量:
#   EGO_JEV_SKILLS_DIRS  以 : 分隔的技能目录列表，覆盖默认探测
#   EGO_JEV_VENDOR       官方技能目录，覆盖自动探测
#   EGO_JEV_CONFIG_DIR   启用标记 / always-on 记录目录，默认 ~/.config/ego-decision-layer（环境变量名为历史名，保留）
#   EGO_JEV_SKILL_PATH   ego-decision-layer 自己的 SKILL.md（写进路由层）
#   EGO_JEV_CLI          ego-decision-layer CLI 路径（写进路由层的「自知」行）；默认 <仓库>/scripts/ego-decision-layer
#   EGO_JEV_NO_WIRE      设为非空：--ensure 什么都不做（CLI 首跑接管与自愈一并关闭）
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_DIR/overlay/ego-browser/SKILL.md.in"
WIRE_SCRIPT="$REPO_DIR/scripts/wire-agent-skills.sh"
# 配置目录 0.4.0 起改名：新目录优先；新目录不存在而旧目录存在时沿用它并提示一次（不静默丢配置）。
USING_LEGACY_CONFIG=0
if [[ -n "${EGO_JEV_CONFIG_DIR:-}" ]]; then
  CONFIG_DIR="$EGO_JEV_CONFIG_DIR"
elif [[ -d "$HOME/.config/ego-decision-layer" ]]; then
  CONFIG_DIR="$HOME/.config/ego-decision-layer"
elif [[ -d "$HOME/.config/ego-jev" ]]; then   # 兼容旧配置目录
  CONFIG_DIR="$HOME/.config/ego-jev"            # 兼容旧配置目录
  USING_LEGACY_CONFIG=1
else
  CONFIG_DIR="$HOME/.config/ego-decision-layer"
fi
[[ $USING_LEGACY_CONFIG -eq 1 ]] && printf '[ego-decision-layer] 检测到旧配置目录 ~/.config/ego-jev，本次沿用它；bash scripts/rename-self.sh 可迁移\n' >&2
FLAG_FILE="$CONFIG_DIR/wire-enabled.json"
ALWAYS_ON_LIST="$CONFIG_DIR/always-on.list"
OPTOUT_FILE="$CONFIG_DIR/opted-out"
MARKER_NAME=".ego-jev-overlay.json"          # 内部标记名保留（兼容 pre-0.4.0 的 --restore）
MARKER_MAGIC='"overlay": "ego-jev"'          # 内部标记内容保留（兼容）
ROUTE_BEGIN='<!-- ego-decision-layer:route begin -->'
ROUTE_END='<!-- ego-decision-layer:route end -->'
# 历史 always-on 块标记（pre-0.4.0）：--restore / 重插时先删掉旧块（兼容）
ROUTE_BEGIN_LEGACY='<!-- ego-jev:route begin -->'
ROUTE_END_LEGACY='<!-- ego-jev:route end -->'

# 路由说明（进 frontmatter 的 description，是 Agent 选择技能的依据）。
# 必须排在厂商描述之前：描述会被按预算压缩、优先丢最少用的尾部，放在末尾等于最先被砍。
# 开头即「触发条件 + 动作」，长度刻意不超过厂商描述之后的那版旧拼法（越短越抗截断）。
ROUTING_NOTE='多步线性浏览器任务（连续点击、翻页、搜索表单提交、多字段填写、导航跳转）先用 `ego-decision-layer` CLI 在单进程内闭环（一条命令，别写逐步脚本）；单步动作、精确 DOM/选择器、批量抓取走本技能的 ego-browser API。本入口已由 ego-decision-layer 接管。'

MODE="wire"          # wire | check | restore | ensure | status | always-on
DRY_RUN=0
IF_ENABLED=0
ENSURE=0
DIRS_FIXED=0
ALWAYS_ON_FILE=""
VENDOR_ARG="${EGO_JEV_VENDOR:-}"
declare -a DIRS=()

info() { printf '  %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
fail() { printf 'error: %s\n' "$*" >&2; exit 2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --restore) MODE="restore"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --if-enabled) IF_ENABLED=1; shift ;;
    --ensure) MODE="ensure"; ENSURE=1; shift ;;
    --status-json) MODE="status"; shift ;;
    --always-on)
      if [[ "${2:-}" == "--remove" ]]; then
        [[ $# -ge 3 && -n "${3:-}" ]] || fail "--always-on --remove 需要一个非空文件路径"
        MODE="always-on-remove"; ALWAYS_ON_FILE="$3"; shift 3
      else
        [[ $# -ge 2 && -n "${2:-}" ]] || fail "--always-on 需要一个非空文件路径"
        MODE="always-on"; ALWAYS_ON_FILE="$2"; shift 2
      fi ;;
    --always-on-remove) [[ $# -ge 2 && -n "${2:-}" ]] || fail "--always-on-remove 需要一个非空文件路径"; MODE="always-on-remove"; ALWAYS_ON_FILE="$2"; shift 2 ;;
    --dir) [[ $# -ge 2 && -n "$2" ]] || fail "--dir 需要一个非空目录"; DIRS+=("$2"); DIRS_FIXED=1; shift 2 ;;
    --vendor) [[ $# -ge 2 && -n "$2" ]] || fail "--vendor 需要一个非空目录"; VENDOR_ARG="$2"; shift 2 ;;
    -h|--help) awk 'NR==1{next} /^set -uo pipefail/{exit} {print}' "$0"; exit 0 ;;
    *) fail "未知参数: $1" ;;
  esac
done

# ── 工具 ─────────────────────────────────────────────────────────────────────

# 解析软链（含相对目标）；目录存在时返回物理路径
resolve_path() {
  local p="$1" d depth=0
  while [[ -L "$p" && $depth -lt 40 ]]; do
    d="$(cd "$(dirname "$p")" && pwd -P)" || break
    p="$(readlink "$p")"
    [[ "$p" = /* ]] || p="$d/$p"
    depth=$((depth + 1))
  done
  if [[ -d "$p" ]]; then (cd "$p" && pwd -P); else printf '%s' "$p"; fi
}

# ego lite 的技能目录形状：稳定软链，或 App 版本目录里的 Resources/ego-skills/ego-browser。
# 用它做判据（而不是宽松的 *ego-skills* 通配），避免误伤名字里带 ego-skills 的无关软链；
# 也允许目标暂时不存在（升级窗口里的悬空软链）——那种情况正是要重接管的。
looks_like_ego_vendor_path() {
  local p="$1"
  [[ -n "$p" ]] || return 1
  case "$p" in
    "$HOME/.local/share/ego/ego-skills"|"$HOME/.local/share/ego/ego-skills/"*) return 0 ;;
    "$HOME/.local/share/ego/active_version_dir/Resources/ego-skills/ego-browser"|"$HOME/.local/share/ego/active_version_dir/Resources/ego-skills/ego-browser/"*) return 0 ;;
    */Versions/*/Resources/ego-skills/ego-browser|*/Versions/*/Resources/ego-skills/ego-browser/*) return 0 ;;
  esac
  return 1
}

vendor_frontmatter_field() { # vendor_frontmatter_field <key>：frontmatter 字段允许缩进（App 的 metadata: 下就是缩进的）
  awk -v key="$1" 'NR==1 && $0=="---" {inf=1; next}
       inf && /^---[[:space:]]*$/ {exit}
       inf { line=$0; sub(/^[[:space:]]*/,"",line);
             if (index(line, key ":")==1) { sub("^" key ":[[:space:]]*","",line); gsub(/"/,"",line); print line; exit } }' \
    "$VENDOR/SKILL.md" 2>/dev/null
}

decision_layer_skill_path() {
  if [[ -n "${EGO_JEV_SKILL_PATH:-}" ]]; then printf '%s' "$EGO_JEV_SKILL_PATH"; return; fi
  local cand legacy_skill="$HOME/.agents/skills/ego-jev/SKILL.md"   # 兼容 pre-0.4.0 的旧安装位置
  for cand in "$HOME/.agents/skills/ego-decision-layer/SKILL.md" "$legacy_skill" "$REPO_DIR/SKILL.md"; do
    [[ -f "$cand" ]] && { printf '%s' "$cand"; return; }
  done
  printf '%s' "未安装（直接用 ego-decision-layer CLI 即可）"
}

decision_layer_cli_path() {  # 写进路由层「自知」行的 CLI 路径（确定性；找不到就退回 PATH 里的命令名）
  if [[ -n "${EGO_JEV_CLI:-}" ]]; then printf '%s' "$EGO_JEV_CLI"; return; fi
  local cand
  for cand in "$REPO_DIR/scripts/ego-decision-layer" "$HOME/.agents/skills/ego-decision-layer/scripts/ego-decision-layer"; do
    [[ -f "$cand" ]] && { printf '%s' "$cand"; return; }
  done
  printf '%s' "ego-decision-layer"
}

# 生成路由层 SKILL.md 到 stdout（必须确定性：不含时间戳/随机数，否则 --check 会一直误报漂移）
render_overlay() {
  local desc ver date jev cli line desc_yaml
  desc="$(vendor_frontmatter_field description)"
  ver="$(vendor_frontmatter_field version)"
  date="$(vendor_frontmatter_field date)"
  jev="$(decision_layer_skill_path)"
  cli="$(decision_layer_cli_path)"
  [[ -n "$desc" ]] || desc="When you need a browser, read this Skill by default（原描述读取失败，请重跑本脚本）"
  # frontmatter 是 YAML：description 用单引号标量，内部单引号翻倍，换行压成空格。
  # 不这样做的话，厂商描述里一旦出现 ": " 就会让整条技能解析失败（Agent 直接看不到这个技能）。
  # 路由句在前、厂商描述在后（厂商文本一字不改，只挪位置）。
  desc_yaml="'$(printf '%s %s' "$ROUTING_NOTE" "$desc" | tr '\n' ' ' | sed "s/'/''/g")'"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line//'{{DESCRIPTION_YAML}}'/$desc_yaml}"
    line="${line//'{{VENDOR_VERSION}}'/$ver}"
    line="${line//'{{VENDOR_DATE}}'/$date}"
    line="${line//'{{EGO_SKILLS_DIR}}'/$VENDOR}"
    line="${line//'{{EGO_JEV_SKILL}}'/$jev}"
    line="${line//'{{WIRE_SCRIPT}}'/$WIRE_SCRIPT}"
    line="${line//'{{EGO_JEV_CLI}}'/$cli}"
    printf '%s\n' "$line"
  done < "$TEMPLATE"
}

is_our_overlay() { [[ -d "$1" && -f "$1/$MARKER_NAME" ]] && grep -q "$MARKER_MAGIC" "$1/$MARKER_NAME" 2>/dev/null; }

write_marker() {
  local dir="$1" original="$2"
  {
    printf '{\n'
    printf '  "overlay": "ego-jev",\n'   # 内部标记内容保留（兼容）
    printf '  "wiredAt": "%s",\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '  "original": "%s",\n' "$original"
    printf '  "vendor": "%s",\n' "${VENDOR:-}"
    printf '  "vendorVersion": "%s",\n' "$(vendor_frontmatter_field version)"
    printf '  "wireScript": "%s",\n' "$WIRE_SCRIPT"
    printf '  "restore": "bash %s --restore"\n' "$WIRE_SCRIPT"
    printf '}\n'
  } > "$dir/$MARKER_NAME"
}

marker_field() { # marker_field <file> <key>：按行锚定，避免贪心匹配吃掉后面的字段
  sed -n "s/^[[:space:]]*\"$2\"[[:space:]]*:[[:space:]]*\"\\(.*\\)\"[[:space:]]*,\{0,1\}[[:space:]]*$/\\1/p" "$1" | head -1
}

# 生成路由层（覆盖已有同名条目由调用方负责）：SKILL.md + 官方各子目录的软链（按现有目录走，不写死名单）
install_overlay() {
  local target="$1" original="$2" sub name
  if [[ -z "$VENDOR" || ! -f "$VENDOR/SKILL.md" ]]; then
    warn "拒绝写路由层：官方技能目录不可用（${VENDOR:-空}）"
    return 1
  fi
  mkdir -p "$target" || return 1
  render_overlay > "$target/SKILL.md" || return 1
  for sub in "$VENDOR"/*/; do
    [[ -e "$sub" ]] || continue
    name="$(basename "$sub")"
    ln -sfn "$VENDOR/$name" "$target/$name" || return 1
  done
  write_marker "$target" "$original"
}

# ── always-on 路由块（只在显式 --always-on 时写；幂等；可精确移除）──────────────
# 块内容必须确定性（只含仓库路径，不含时间戳/随机数），否则 --check/--status 会误报。

route_block() {
  local jev line
  jev="$(decision_layer_skill_path)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line//'{{EGO_JEV_SKILL}}'/$jev}"
    line="${line//'{{WIRE_SCRIPT}}'/$WIRE_SCRIPT}"
    printf '%s\n' "$line"
  done <<'BLOCK'
<!-- ego-decision-layer:route begin -->
## 浏览器任务：多步线性先走 ego-decision-layer

多步线性浏览器任务（连续点击、翻页、搜索表单提交、多字段填写、导航跳转）先用 `ego-decision-layer` CLI
在单进程内闭环（一条命令，别写逐步脚本）：

```bash
ego-decision-layer --url "https://…" --until "/expected/path" --steps 8 "把目标写清楚"
```

单步动作、精确 DOM/选择器、批量抓取仍走 `ego-browser` 原生 API。

Multi-step linear browser work (click chains, pagination, form submits, navigation) should go
through the `ego-decision-layer` CLI first; single actions, precise DOM/selector work and bulk scraping stay
on the `ego-browser` API.

技能目录：`{{EGO_JEV_SKILL}}` · 路由层与 always-on 块的还原：`bash {{WIRE_SCRIPT}} --restore`
<!-- ego-decision-layer:route end -->
BLOCK
  return 0
}

always_on_files() { [[ -f "$ALWAYS_ON_LIST" ]] && grep -v '^$' "$ALWAYS_ON_LIST"; return 0; }

always_on_add() {  # <file>
  local f="$1" tmp
  mkdir -p "$CONFIG_DIR" || return 1
  tmp="$(mktemp "${TMPDIR:-/tmp}/ego-decision-layer-ao.XXXXXX")" || return 1
  { always_on_files; printf '%s\n' "$f"; } | sort -u > "$tmp" && mv "$tmp" "$ALWAYS_ON_LIST"
}

always_on_remaining() {  # stdout = 列表里仍有标记块的文件（逗号分隔；没有则「（无）」）
  local out="" f
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    file_has_block "$f" || continue
    out="${out:+$out, }$f"
  done < <(always_on_files)
  printf '%s' "${out:-（无）}"
}

always_on_remove_file() {  # <file>：从 always-on.list 里去掉这个文件（其余条目原样保留）
  local f="$1" tmp
  [[ -f "$ALWAYS_ON_LIST" ]] || return 0
  tmp="$(mktemp "${TMPDIR:-/tmp}/ego-decision-layer-aolist.XXXXXX")" || return 1
  always_on_files | grep -v -F -x "$f" > "$tmp" || true
  if [[ -s "$tmp" ]]; then mv "$tmp" "$ALWAYS_ON_LIST"; else rm -f "$tmp" "$ALWAYS_ON_LIST"; fi
  return 0
}

block_bounds() {  # <file>：打印「起 止」行号（新标记优先，其次历史标记）；没有则 return 1
  local file="$1" b e
  for which in new legacy; do
    if [[ "$which" == "new" ]]; then
      b="$(grep -nF "$ROUTE_BEGIN" "$file" 2>/dev/null | head -1 | cut -d: -f1)"
      e="$(grep -nF "$ROUTE_END" "$file" 2>/dev/null | head -1 | cut -d: -f1)"
    else
      b="$(grep -nF "$ROUTE_BEGIN_LEGACY" "$file" 2>/dev/null | head -1 | cut -d: -f1)"
      e="$(grep -nF "$ROUTE_END_LEGACY" "$file" 2>/dev/null | head -1 | cut -d: -f1)"
    fi
    [[ -n "$b" && -n "$e" && "$e" -ge "$b" ]] && { printf '%s %s\n' "$b" "$e"; return 0; }
  done
  return 1
}

file_has_block() { [[ -f "$1" ]] && block_bounds "$1" >/dev/null; }

# 生成「原文件（去掉旧块，新旧标记都认）+ 新块」到 stdout；块外内容按行原样保留
file_with_block() {  # <file> <blockfile>
  local file="$1" bf="$2" bounds b e
  if [[ -f "$file" ]]; then
    bounds="$(block_bounds "$file")" || true
    if [[ -n "$bounds" ]]; then
      b="${bounds%% *}"; e="${bounds##* }"
      head -n "$((b - 1))" "$file"
      cat "$bf"
      tail -n "+$((e + 1))" "$file"
      return 0
    fi
    cat "$file"
    [[ -s "$file" ]] && printf '\n'
  fi
  cat "$bf"
  return 0
}

file_without_block() {  # <file>：stdout = 去掉块（新旧标记都认）+ 其自带分隔空行后的内容
  local file="$1" bounds b e tmp
  [[ -f "$file" ]] || return 0
  bounds="$(block_bounds "$file")" || true
  if [[ -n "$bounds" ]]; then
    b="${bounds%% *}"; e="${bounds##* }"
    # apply_always_on 在非空文件末尾插块前会补一个空行（分隔空行）：这里去掉恰好一个尾部空行，
    # 让「没有 .bak」的兜底路径也尽量贴近原文件（有 .bak 时走精确还原，不会到这里）。
    tmp="$(mktemp "${TMPDIR:-/tmp}/ego-decision-layer-out.XXXXXX")" || return 1
    if [[ "$b" -gt 1 ]]; then head -n "$((b - 1))" "$file" > "$tmp"; else : > "$tmp"; fi   # BSD head 不接受 -n 0
    if [[ -s "$tmp" && -z "$(tail -n 1 "$tmp")" ]]; then sed '$d' "$tmp"; else cat "$tmp"; fi
    rm -f "$tmp"
    tail -n "+$((e + 1))" "$file"
  else
    cat "$file"
  fi
  return 0
}

apply_always_on() {  # <file>
  local file="$1" bf tmp
  bf="$(mktemp "${TMPDIR:-/tmp}/ego-decision-layer-blk.XXXXXX")" || return 1
  route_block > "$bf" || { rm -f "$bf"; return 1; }
  if [[ -e "$file" ]]; then
    [[ -e "$file.bak" ]] || cp "$file" "$file.bak" || { rm -f "$bf"; return 1; }
  else
    mkdir -p "$(dirname "$file")" || { rm -f "$bf"; return 1; }
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/ego-decision-layer-out.XXXXXX")" || { rm -f "$bf"; return 1; }
  file_with_block "$file" "$bf" > "$tmp" && mv "$tmp" "$file" || { rm -f "$bf" "$tmp"; return 1; }
  rm -f "$bf"
  always_on_add "$file"
}

remove_always_on() {  # <file>：.bak 与「去掉块后的当前内容」一致才按备份还原；否则只去块（不覆盖非块内容）
  local file="$1" tmp stripped
  if [[ -f "$file" && -f "$file.bak" ]]; then
    stripped="$(mktemp "${TMPDIR:-/tmp}/ego-decision-layer-strip.XXXXXX")" || return 1
    file_without_block "$file" > "$stripped"
    if cmp -s "$stripped" "$file.bak"; then
      # .bak 确实是「插块前的原样」——按备份精确还原
      rm -f "$stripped"
      cp "$file.bak" "$file" && rm -f "$file.bak"
      return 0
    fi
    # .bak 是旧的（插块之后文件又被改过，例如命名迁移）：绝不拿它覆盖非块内容，
    # 改走「只去标记区」路径；.bak 保留不动（不谎称已还原）。
    rm -f "$stripped"
  fi
  [[ -f "$file" ]] || return 0
  tmp="$(mktemp "${TMPDIR:-/tmp}/ego-decision-layer-out.XXXXXX")" || return 1
  file_without_block "$file" > "$tmp" && mv "$tmp" "$file"
  [[ -s "$file" ]] || rm -f "$file"   # 只去块后变空、且无可用备份 → 这是本脚本建的文件
  return 0
}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# ── 用户明确选择不接管（opt-out）──────────────────────────────────────────────
# 由 --restore 写入、只能被显式 wire 解除；自动路径（--ensure / --if-enabled）不得解除。
# 内容确定性（无时间戳/随机数）。
write_optout() {
  mkdir -p "$CONFIG_DIR" || return 1
  {
    printf '%s\n' 'ego-decision-layer: 已按用户选择不接管官方 ego-browser 入口（由 --restore 写入）'
    printf '重新启用: bash %s\n' "$WIRE_SCRIPT"
  } > "$OPTOUT_FILE"
}
clear_optout() { rm -f "$OPTOUT_FILE"; }
opted_out() { [[ -f "$OPTOUT_FILE" ]]; }

generated_hash() {  # 路由层生成物的内容哈希（确定性）
  local h=""
  if command -v shasum >/dev/null 2>&1; then
    h="$(render_overlay | shasum -a 256 | awk '{print $1}')"
  elif command -v sha256sum >/dev/null 2>&1; then
    h="$(render_overlay | sha256sum | awk '{print $1}')"
  fi
  printf 'sha256:%s' "$h"
}

# ── 解析官方技能目录（可以解析不到：--restore 不需要它）────────────────────────

resolve_vendor() {
  local cand
  for cand in "$VENDOR_ARG" \
              "$HOME/.local/share/ego/ego-skills" \
              "$HOME/.local/share/ego/active_version_dir/Resources/ego-skills/ego-browser"; do
    [[ -z "$cand" ]] && continue
    [[ "$cand" = /* ]] || cand="$PWD/$cand"
    # 刻意不解析软链：保留稳定的 ~/.local/share/ego/ego-skills，App 升级会自己改指向；
    # 解析到 Versions/<版本号>/… 的话，升级后生成物就会指向被删掉的旧版本目录。
    [[ -f "$cand/SKILL.md" ]] && { printf '%s' "$cand"; return 0; }
  done
  if command -v ego-browser >/dev/null 2>&1; then
    local helper version_dir
    helper="$(resolve_path "$(command -v ego-browser)")"
    version_dir="$(cd "$(dirname "$helper")/.." && pwd -P)"
    cand="$version_dir/Resources/ego-skills/ego-browser"
    [[ -f "$cand/SKILL.md" ]] && { printf '%s' "$cand"; return 0; }
  fi
  return 1
}

stable_vendor_path() {  # 稳定入口（App 升级会改指向）；用于把失效的旧版本路径修回来
  local cand="$HOME/.local/share/ego/ego-skills"
  [[ -f "$cand/SKILL.md" ]] && printf '%s' "$cand"
}

# ── 目标技能目录 ─────────────────────────────────────────────────────────────

default_dirs() {
  printf '%s\n' "$HOME/.agents/skills" "$HOME/.claude/skills" "$HOME/.codex/skills" \
                "$HOME/.cursor/skills" "$HOME/.kiro/skills"
}

dedup_lines() { awk '!seen[$0]++'; }   # bash 3.2 兼容：不用 nameref/关联数组

flag_dirs() { # 启用标记里记下的目录（可能没有）
  [[ -f "$FLAG_FILE" ]] || return 0
  sed -n 's/.*"dirs"[[:space:]]*:[[:space:]]*\[\(.*\)\].*/\1/p' "$FLAG_FILE" | head -1 |
    tr ',' '\n' | sed 's/^[[:space:]]*"//; s/"[[:space:]]*$//; s/^[[:space:]]*//; s/[[:space:]]*$//' |
    grep -v '^$'
}

if [[ $DIRS_FIXED -eq 0 && -n "${EGO_JEV_SKILLS_DIRS:-}" ]]; then
  IFS=':' read -r -a DIRS <<< "$EGO_JEV_SKILLS_DIRS"   # 命令行 --dir 优先于环境变量
  DIRS_FIXED=1
fi

if [[ $IF_ENABLED -eq 1 && ! -f "$FLAG_FILE" ]]; then
  exit 0   # 从没接管过 → 静默跳过（update.sh 用）
fi

if [[ $DIRS_FIXED -eq 0 ]]; then
  DIRS=()
  # 接管过的自定义目录（--dir）也要继续维护，不能只认默认探测
  while IFS= read -r d; do DIRS+=("$d"); done < <( { flag_dirs; default_dirs; } | dedup_lines )
fi

if [[ -f "$TEMPLATE" ]]; then :; else fail "缺少模板: ${TEMPLATE}（本脚本要在 ego-decision-layer 仓库内运行）"; fi

declare -a RECORDED_DIRS=()
if [[ -f "$FLAG_FILE" ]]; then
  while IFS= read -r d; do [[ -n "$d" ]] && RECORDED_DIRS+=("$d"); done < <(flag_dirs)
fi
is_recorded() {   # 这个目录是「我们接管过、并由启用标记记录在案」的（仅默认探测到、没接管过的不算）
  local v
  for v in "${RECORDED_DIRS[@]:-}"; do [[ "$v" == "$1" ]] && return 0; done
  return 1
}

if [[ -n "$VENDOR_ARG" ]]; then
  # 显式指定（--vendor 或 EGO_JEV_VENDOR）就是权威：合法则用它，非法则直接报环境错误，不回退自动探测
  if [[ -f "$VENDOR_ARG/SKILL.md" ]]; then
    VENDOR="$VENDOR_ARG"
  else
    VENDOR=""
    if [[ "$MODE" == "wire" ]]; then
      fail "--vendor 指定的目录里没有 SKILL.md: ${VENDOR_ARG}（不会回退自动探测；去掉 --vendor 或改对环境变量）"
    fi
    warn "--vendor 指定的目录里没有 SKILL.md: ${VENDOR_ARG}（不回退自动探测）"
  fi
else
  VENDOR="$(resolve_vendor || true)"
fi
VENDOR_REAL=""
[[ -n "$VENDOR" ]] && VENDOR_REAL="$(resolve_path "$VENDOR")"

# 这个目录里有没有「官方 ego-browser 入口」可接管（我们的路由层，或一条指向 ego lite 的软链）
has_wireable_entry() {
  local dir="$1" target="$dir/ego-browser" raw
  is_our_overlay "$target" && return 0
  if [[ -L "$target" ]]; then
    raw="$(readlink "$target")"
    if looks_like_ego_vendor_path "$raw" || { [[ -n "$VENDOR" ]] && [[ "$(resolve_path "$target")" == "$VENDOR_REAL" ]]; }; then
      return 0
    fi
  fi
  return 1
}

# ── --ensure：给 CLI 首跑用 ──────────────────────────────────────────────
# 已启用 → 静默刷新（等价 --if-enabled）；未启用但检测到官方入口 → 首跑接管一次；
# 两者都不是 → 什么都不做（不建目录、不打噪音）。EGO_JEV_NO_WIRE 可整体关掉。
FIRST_RUN=0
if [[ "$MODE" == "ensure" ]]; then
  if [[ -n "${EGO_JEV_NO_WIRE:-}" ]]; then exit 0; fi
  if opted_out; then exit 0; fi   # 用户明确选择不接管（--restore）→ 什么都不做，连入口都不探测
  if [[ -f "$FLAG_FILE" ]]; then
    MODE="wire"
  else
    any_entry=0
    for dir in "${DIRS[@]}"; do has_wireable_entry "$dir" && any_entry=1; done
    if [[ $any_entry -eq 0 ]]; then exit 0; fi
    MODE="wire"; FIRST_RUN=1
  fi
fi

if [[ "$MODE" == "wire" && -z "$VENDOR" ]]; then
  any_overlay=0
  for dir in "${DIRS[@]}"; do is_our_overlay "$dir/ego-browser" && any_overlay=1; done
  if [[ $any_overlay -eq 0 ]]; then
    fail "找不到 ego lite 的官方技能目录（SKILL.md）。安装 ego lite 后重试，或用 --vendor 指定。"
  fi
  warn "找不到 ego lite 的官方技能目录：本次只能报告状态，不能刷新（装好 ego lite 后重跑）"
fi

# ── --always-on：只写指定的那个文件（默认不写任何用户文件）──────────────────────
if [[ "$MODE" == "always-on" ]]; then
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "==> ego-decision-layer always-on（dry-run）"
    info "会向 ${ALWAYS_ON_FILE} 插入/替换路由块（块外内容不动；首次会备份到 ${ALWAYS_ON_FILE}.bak）"
    exit 0
  fi
  if apply_always_on "$ALWAYS_ON_FILE"; then
    echo "==> ego-decision-layer always-on"
    info "已写入路由块: ${ALWAYS_ON_FILE}（幂等）"
    info "只移除这一块: bash ${WIRE_SCRIPT} --always-on --remove ${ALWAYS_ON_FILE}"
    info "连同路由层一起还原: bash ${WIRE_SCRIPT} --restore"
    exit 0
  fi
  warn "写入失败: ${ALWAYS_ON_FILE}"
  exit 1
fi

# ── --always-on --remove / --always-on-remove：只移目标文件的块，绝不碰接管层 ──
if [[ "$MODE" == "always-on-remove" ]]; then
  echo "==> ego-decision-layer always-on --remove"
  if [[ ! -e "$ALWAYS_ON_FILE" ]]; then fail "文件不存在: ${ALWAYS_ON_FILE}"; fi
  if ! file_has_block "$ALWAYS_ON_FILE"; then
    info "无块可移: ${ALWAYS_ON_FILE}（没有我们的标记块，未改动任何文件）"
    info "当前 always-on: $(always_on_remaining)"
    exit 0
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    info "会从 ${ALWAYS_ON_FILE} 移除路由块（有 .bak 按备份精确还原，否则只删标记区及其分隔空行）"
    info "接管层不会被动；当前 always-on: $(always_on_remaining)"
    exit 0
  fi
  if ! remove_always_on "$ALWAYS_ON_FILE"; then warn "移除失败: ${ALWAYS_ON_FILE}"; exit 1; fi
  always_on_remove_file "$ALWAYS_ON_FILE"
  info "已移除路由块: ${ALWAYS_ON_FILE}（文件其余内容按原样保留；接管层未动）"
  info "当前 always-on: $(always_on_remaining)"
  exit 0
fi

# ── 三个动作 ─────────────────────────────────────────────────────────────────

had_drift=0
n_overlay=0
n_skipped=0
n_failed=0
n_drift=0
n_noneed=0
OPTED_OUT=0
if opted_out; then OPTED_OUT=1; fi
did_something=0
declare -a WIRED_DIRS=()

wire_one() {
  local dir="$1" target="$dir/ego-browser" original raw
  if is_our_overlay "$target"; then
    if [[ -z "$VENDOR" ]]; then
      warn "跳过 ${target}（ego lite 技能目录找不到，无法校验/刷新；装好 ego lite 后重跑）"
      n_skipped=$((n_skipped + 1)); return
    fi
    if [[ "$(render_overlay)" == "$(cat "$target/SKILL.md")" ]]; then
      info "已接管且最新: ${target}"
    elif [[ $DRY_RUN -eq 1 ]]; then
      info "[dry-run] 刷新: ${target}（生成物过期，例如 ego lite 升级过）"
    else
      install_overlay "$target" "$(marker_field "$target/$MARKER_NAME" original)" || { n_failed=$((n_failed + 1)); return; }
      info "已刷新: ${target}（生成物过期，例如 ego lite 升级过）"
    fi
    n_overlay=$((n_overlay + 1)); did_something=1; WIRED_DIRS+=("$dir"); return
  fi
  if [[ -L "$target" ]]; then
    raw="$(readlink "$target")"
    if [[ -z "$VENDOR" ]]; then
      # 官方目录解析不到：绝不能写盘——install_overlay 的 "$VENDOR"/*/ 会变成 /*/，
      # 把文件系统根下的目录全软链进技能目录。只报告。
      warn "跳过（找不到 ego lite 技能目录，不接管）: ${target} → ${raw}"
      n_skipped=$((n_skipped + 1)); return
    fi
    if looks_like_ego_vendor_path "$raw" || [[ "$(resolve_path "$target")" == "$VENDOR_REAL" ]]; then
      if [[ $DRY_RUN -eq 1 ]]; then info "[dry-run] 接管: ${target}（原软链 → ${raw}）"; return; fi
      rm -f "$target"                      # 只删这条软链，不碰它指向的目录
      install_overlay "$target" "$raw" || { n_failed=$((n_failed + 1)); return; }
      info "已接管: ${target}（原软链 → ${raw}）"
      n_overlay=$((n_overlay + 1)); did_something=1; WIRED_DIRS+=("$dir"); return
    fi
    warn "跳过（软链指向别处，不是 ego lite 技能）: ${target} → ${raw}"
    n_skipped=$((n_skipped + 1)); return
  fi
  if [[ -d "$target" ]]; then
    warn "跳过（普通目录，不是我们的路由层，不覆盖——若这是官方技能的一份拷贝，请手工处理）: ${target}"
    n_skipped=$((n_skipped + 1)); return
  fi
  if [[ -d "$dir" ]]; then
    if [[ -n "$VENDOR" ]] && is_recorded "$dir"; then
      # 官方正文在、这个目录也确实是「我们接管过」的，只是入口没了（升级窗口 / 被删）→ 按启用意图重建
      # 启用过、官方正文也在，只是入口没了（升级窗口 / 被删）→ 按启用意图重建
      original="$(stable_vendor_path)"
      [[ -n "$original" ]] || original="$VENDOR"
      if [[ $DRY_RUN -eq 1 ]]; then
        info "[dry-run] 重建入口: ${target}（入口不存在，原目标按稳定入口 ${original}）"
      elif install_overlay "$target" "$original"; then
        info "已重建入口: ${target}（之前接管过，但入口消失了）"
        n_overlay=$((n_overlay + 1)); did_something=1; WIRED_DIRS+=("$dir")
      else
        n_failed=$((n_failed + 1))
      fi
      return
    fi
    info "跳过（目录里没有 ego-browser 入口）: ${dir}"
  else
    info "跳过（目录不存在）: ${dir}"
  fi
  n_skipped=$((n_skipped + 1))
}

# 只读探测：输出 "<state>\t<target>"（不打印、不写盘）；--check 与 --status-json 共用
probe_dir() {
  local dir="$1" target="$dir/ego-browser" sub missing=0 raw
  if is_our_overlay "$target"; then
    if [[ -z "$VENDOR" ]]; then printf 'wired-novendor\t\n'; return; fi
    for sub in "$VENDOR"/*/; do
      [[ -e "$sub" ]] || continue
      [[ -e "$target/$(basename "$sub")" ]] || missing=1   # 软链断了：通常指向被删掉的旧版本目录
    done
    if [[ $missing -eq 1 ]]; then printf 'wired-broken\t\n'; return; fi
    if [[ "$(render_overlay)" == "$(cat "$target/SKILL.md")" ]]; then printf 'wired-ok\t\n'; else printf 'wired-stale\t\n'; fi
    return
  fi
  if [[ -L "$target" ]]; then
    raw="$(readlink "$target")"
    if looks_like_ego_vendor_path "$raw" || [[ -n "$VENDOR" && "$(resolve_path "$target")" == "$VENDOR_REAL" ]]; then
      if [[ -e "$target" ]]; then printf 'official\t%s\n' "$raw"; else printf 'official-broken\t%s\n' "$raw"; fi
    else
      printf 'foreign\t%s\n' "$raw"
    fi
    return
  fi
  if [[ -e "$target" ]]; then printf 'plain\t\n'; return; fi
  if [[ -d "$dir" ]] && is_recorded "$dir"; then printf 'missing-recorded\t\n'; return; fi
  if [[ -d "$dir" ]]; then printf 'none\t\n'; else printf 'no-dir\t\n'; fi
}

# 人类可读渲染 + 计数（只打印，不写盘）
render_check_line() {  # <state> <dir> <target>
  local state="$1" dir="$2" t="$3" target="$dir/ego-browser"
  case "$state" in
    wired-ok) info "OK    ${target}（路由层，生成物最新）"; n_overlay=$((n_overlay + 1)) ;;
    wired-stale) warn "漂移  ${target}（生成物过期：ego lite 升级过，重跑本脚本刷新）"; n_drift=$((n_drift + 1)); had_drift=1 ;;
    wired-broken) warn "漂移  ${target}（官方子目录软链已失效：ego lite 升级删掉了旧版本目录，重跑本脚本）"; n_drift=$((n_drift + 1)); had_drift=1 ;;
    wired-novendor) warn "漂移  ${target}（ego lite 技能目录找不到：无法校验/刷新，装好后重跑本脚本）"; n_drift=$((n_drift + 1)); had_drift=1 ;;
    official)
      if [[ $OPTED_OUT -eq 1 ]]; then info "无需接管  ${target}（已按用户选择不接管）"; n_noneed=$((n_noneed + 1))
      else warn "未接管  ${target}（还是官方软链：重跑本脚本接管）"; n_drift=$((n_drift + 1)); had_drift=1; fi ;;
    official-broken)
      if [[ $OPTED_OUT -eq 1 ]]; then info "无需接管  ${target}（已按用户选择不接管；软链断向 ${t}）"; n_noneed=$((n_noneed + 1))
      else warn "漂移  ${target}（软链断向 ${t}：升级窗口，重跑本脚本接管）"; n_drift=$((n_drift + 1)); had_drift=1; fi ;;
    foreign) warn "未知  ${target}（软链指向别处，不是 ego lite 技能）: → ${t}"; n_drift=$((n_drift + 1)); had_drift=1 ;;
    plain) warn "未知  ${target}（既不是我们的路由层，也不是官方软链）"; n_drift=$((n_drift + 1)); had_drift=1 ;;
    missing-recorded) warn "漂移  ${dir}（接管过，但 ego-browser 入口不见了：重跑本脚本）"; n_drift=$((n_drift + 1)); had_drift=1 ;;
    none) info "无需接管  ${dir}（没有官方 ego-browser 入口；该 Agent 通过自身的 ego-decision-layer 技能被发现）"; n_noneed=$((n_noneed + 1)) ;;
    no-dir) info "无需接管  ${dir}（目录不存在）"; n_noneed=$((n_noneed + 1)) ;;
  esac
  return 0
}

restore_one() {
  local dir="$1" target="$dir/ego-browser" original stable
  if ! is_our_overlay "$target"; then
    info "无需还原: ${target}"
    return
  fi
  original="$(marker_field "$target/$MARKER_NAME" original)"
  if [[ -z "$original" ]]; then
    warn "跳过 ${target}：标记文件里没记下原始软链目标，请手工恢复"
    n_failed=$((n_failed + 1)); return
  fi
  if [[ ! -e "$original" ]]; then
    # 记的是版本号物理路径、而那个版本已被删：改回稳定入口，别还原成一条断链。
    # 相对软链要相对入口所在目录判断，不能拿进程 CWD 当基准。
    local orig_abs="$original"
    case "$original" in
      /*) ;;
      *) orig_abs="$(cd "$(dirname "$target")" && pwd -P)/$original" ;;
    esac
    if [[ -e "$orig_abs" ]]; then
      :   # 原目标其实还在（只是相对路径）——按原样还原
    else
      stable="$(stable_vendor_path)"
      if [[ -n "$stable" ]]; then
        info "原目标已失效（${original}）→ 还原到稳定入口 ${stable}"
        original="$stable"
      fi
    fi
  fi
  if [[ $DRY_RUN -eq 1 ]]; then info "[dry-run] 还原: 删目录 ${target} → 重建软链 ${original}"; return; fi
  rm -rf "$target"          # 显式路径：只在确认是本公司生成的路由层后执行
  ln -sfn "$original" "$target"
  info "已还原: ${target} → ${original}"
  did_something=1
}

# 只读状态（机器可读）：`ego-decision-layer --route-status` 用它；不写盘、不起浏览器、不要凭证
emit_status_json() {
  local dir rec st tg first=1 n=0 m=0 k=0 ao_first=1 f wired drift entry hasEntry
  printf '{\n'
  if [[ -f "$FLAG_FILE" ]]; then printf '  "enabled": true,\n'; else printf '  "enabled": false,\n'; fi
  if opted_out; then printf '  "optedOut": true,\n'; else printf '  "optedOut": false,\n'; fi
  if [[ -n "$VENDOR" ]]; then printf '  "vendor": "%s",\n' "$(json_escape "$VENDOR")"; else printf '  "vendor": null,\n'; fi
  printf '  "generatedHash": "%s",\n' "$(generated_hash)"
  printf '  "dirs": ['
  for dir in "${DIRS[@]}"; do
    rec="$(probe_dir "$dir")"
    st="${rec%%$'\t'*}"
    tg="${rec#*$'\t'}"
    wired=false; drift=false; entry="none"; hasEntry=false
    case "$st" in
      wired-ok) wired=true; entry="wired"; hasEntry=true; n=$((n + 1)) ;;
      wired-stale|wired-broken|wired-novendor) wired=true; drift=true; entry="wired"; hasEntry=true; k=$((k + 1)) ;;
      official|official-broken)
        hasEntry=true; entry="official"
        if opted_out; then drift=false; m=$((m + 1)); else drift=true; k=$((k + 1)); fi ;;
      foreign) drift=true; entry="foreign"; k=$((k + 1)) ;;
      plain) drift=true; entry="plain"; k=$((k + 1)) ;;
      missing-recorded) drift=true; entry="missing"; k=$((k + 1)) ;;
      *) entry="none"; m=$((m + 1)) ;;
    esac
    [[ $first -eq 0 ]] && printf ','
    printf '\n    { "dir": "%s", "entry": "%s", "hasEntry": %s, "wired": %s, "drift": %s, "target": "%s" }' \
      "$(json_escape "$dir")" "$entry" "$hasEntry" "$wired" "$drift" "$(json_escape "$tg")"
    first=0
  done
  printf '\n  ],\n'
  printf '  "summary": { "n": %s, "m": %s, "k": %s },\n' "$n" "$m" "$k"
  printf '  "alwaysOn": ['
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    file_has_block "$f" || continue
    [[ $ao_first -eq 0 ]] && printf ', '
    printf '"%s"' "$(json_escape "$f")"
    ao_first=0
  done < <(always_on_files)
  printf ']\n'
  printf '}\n'
}

if [[ "$MODE" == "status" ]]; then emit_status_json; exit 0; fi

echo "==> ego-decision-layer 路由接管（${MODE}）"
info "官方技能: ${VENDOR:-（未找到）}"

# 显式 wire（用户直接跑 wire-agent-skills.sh，或 install.sh 的接管步骤）解除 opt-out；
# 自动路径（--ensure / --if-enabled）不得解除——用户的显式选择不能被自动流程反转。
if [[ "$MODE" == "wire" && $ENSURE -eq 0 && $IF_ENABLED -eq 0 && $DRY_RUN -eq 0 ]] && opted_out; then
  clear_optout
  info "已解除「不接管」选择（显式 wire），重新接管官方 ego-browser 入口"
fi

rec=""
for dir in "${DIRS[@]}"; do
  case "$MODE" in
    wire) wire_one "$dir" ;;
    check) rec="$(probe_dir "$dir")"; render_check_line "${rec%%$'\t'*}" "$dir" "${rec#*$'\t'}" ;;
    restore) restore_one "$dir" ;;
  esac
done

case "$MODE" in
  check)
    echo
    ao_count=0
    while IFS= read -r f; do
      [[ -n "$f" ]] || continue
      file_has_block "$f" && ao_count=$((ao_count + 1))
    done < <(always_on_files)
    echo "==> 路由: 已接管 ${n_overlay} / 无需接管 ${n_noneed} / 漂移 ${n_drift}"
    if [[ $OPTED_OUT -eq 1 ]]; then
      info "已按用户选择不接管（由 --restore 写入；重新启用：bash ${WIRE_SCRIPT}）"
    fi
    info "always-on 块: ${ao_count} 个文件在位"
    if [[ $had_drift -eq 0 ]]; then
      # 用户显式选择过不接管时，不能说“所有入口都已接管”——那与上面那行自相矛盾。
      if [[ $OPTED_OUT -eq 1 ]]; then
        echo "==> 检查通过：按你的选择未接管任何入口（重新启用命令见上）"
      else
        echo "==> 检查通过：所有 ego-browser 入口都已接管且最新"
      fi
      exit 0
    fi
    echo "==> 发现需要处理的情况（见上）：能修的用 \`bash $WIRE_SCRIPT\` 重跑；官方技能是拷贝目录时脚本不会覆盖，需人工处理" >&2
    exit 1
    ;;
  restore)
    if [[ $DRY_RUN -eq 0 ]]; then
      ao_left=0
      while IFS= read -r f; do
        [[ -n "$f" ]] || continue
        remove_always_on "$f"
        ao_left=$((ao_left + 1))
      done < <(always_on_files)
      [[ $ao_left -gt 0 ]] && info "已移除 ${ao_left} 个 always-on 块（还原成原文件）"
      rm -f "$ALWAYS_ON_LIST"
      if [[ -f "$FLAG_FILE" ]]; then
        left=0
        for dir in "${DIRS[@]}"; do is_our_overlay "$dir/ego-browser" && left=1; done
        if [[ $left -eq 0 ]]; then
          rm -f "$FLAG_FILE"
          info "已清掉启用标记: ${FLAG_FILE}"
        fi
      fi
      # 记录「用户已明确选择不接管」：自动路径（--ensure）见到它就什么都不做，
      # 只有显式 wire 才能解除。
      write_optout && info "已记录「不接管」选择: ${OPTOUT_FILE}（重新启用：bash ${WIRE_SCRIPT}）"
    fi
    exit $(( n_failed > 0 ? 1 : 0 ))
    ;;
esac

if [[ $DRY_RUN -eq 0 && $did_something -eq 1 ]]; then
  mkdir -p "$CONFIG_DIR"
  merged=()
  while IFS= read -r d; do merged+=("$d"); done < <( { flag_dirs; printf '%s\n' "${WIRED_DIRS[@]:-}"; } | grep -v '^$' | dedup_lines )
  {
    printf '{\n'
    printf '  "enabled": true,\n'
    printf '  "wiredAt": "%s",\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf '  "vendor": "%s",\n' "${VENDOR_REAL:-}"
    printf '  "dirs": ['
    first=1
    for d in "${merged[@]}"; do [[ $first -eq 0 ]] && printf ', '; printf '"%s"' "$d"; first=0; done
    printf '],\n'
    printf '  "restore": "bash %s --restore"\n' "$WIRE_SCRIPT"
    printf '}\n'
  } > "$FLAG_FILE"
fi

echo
if [[ $FIRST_RUN -eq 1 && $n_overlay -gt 0 ]]; then
  echo "已首跑接管 ${n_overlay} 个入口：多步线性浏览器任务默认走 ego-decision-layer；还原: bash ${WIRE_SCRIPT} --restore"
fi
if [[ $n_overlay -gt 0 ]]; then
  echo "已接管 ${n_overlay} 个入口：多步线性任务先走 ego-decision-layer，其余仍按官方 ego-browser API。"
  echo "技能正文照旧从 App 当前版本读取（软链跟随升级）；新开的 Agent 会话才会看到这层路由。"
fi
if [[ $n_skipped -gt 0 ]]; then
  warn "有 ${n_skipped} 个目录没接管（见上）——那些 Agent 仍会走官方正文；--dry-run 可先预览。"
fi
if [[ $DRY_RUN -eq 0 && $did_something -eq 1 ]]; then
  info "启用标记: ${FLAG_FILE}（ego 升级后 update.sh 会据此自动重接管）"
  info "还原官方软链: bash ${WIRE_SCRIPT} --restore"
fi
if [[ $n_failed -gt 0 ]]; then
  warn "有 ${n_failed} 个入口操作失败（见上）"
  exit 1
fi
if [[ $DRY_RUN -eq 0 && $n_overlay -eq 0 ]]; then
  exit 1   # 一个都没接管：让 install.sh --wire / update.sh 能发现
fi
exit 0
