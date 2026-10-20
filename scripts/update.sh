#!/usr/bin/env bash
# Update the installation owning this script; loaded as a function before replacing files.
# Bash 3.2 compatible. Does not modify browser application bundles or credentials.
set -uo pipefail

update_main() {
  local source="${BASH_SOURCE[0]}" dir repo bindir run_test=0 rc top branch before after
  while [ -L "$source" ]; do
    dir="$(cd -P "$(dirname "$source")" && pwd)" || return 1
    source="$(readlink "$source")"
    case "$source" in /*) ;; *) source="$dir/$source" ;; esac
  done
  repo="$(cd -P "$(dirname "$source")/.." && pwd)" || return 1
  bindir="${BINDIR:-$HOME/.local/bin}"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --test) run_test=1 ;;
      -h|--help)
        printf '%s\n' '用法: ego-decision-layer update [--test]' \
          '更新当前安装，刷新命令入口及已启用的路由；--test 更新后运行浏览器冒烟。' \
          'Git 克隆使用 fast-forward；skills 拷贝按原全局/项目作用域定向更新。' \
          '本地改动、拉取失败或缺少安装记录会非零退出，不会重置或覆盖本地 Git 改动。'
        return 0 ;;
      *) printf '错误: 未知更新选项 %s\n' "$1" >&2; return 2 ;;
    esac
    shift
  done
  command -v node >/dev/null 2>&1 || { printf '错误: 更新需要 Node.js\n' >&2; return 2; }
  printf '==> ego-decision-layer 更新\n安装: %s\n' "$repo"
  before="$(bash "$repo/scripts/ego-decision-layer" --version)" || return 1
  printf '当前: %s\n' "$before"

  # rev-parse alone also succeeds inside an unrelated parent repository.
  top="$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null)" || top=""
  if [ -n "$top" ]; then top="$(cd -P "$top" && pwd)" || return 1; fi
  if [ "$top" = "$repo" ]; then
    if [ -n "$(git -C "$repo" status --porcelain --untracked-files=no)" ]; then
      printf '错误: 已跟踪文件有未提交改动，更新已停止。请先处理: git -C "%s" status\n' "$repo" >&2
      return 1
    fi
    branch="$(git -C "$repo" symbolic-ref --quiet --short HEAD)" || {
      printf '错误: 当前固定在标签或提交上；请先切换到要跟踪的分支。\n' >&2; return 1;
    }
    if ! git -C "$repo" rev-parse --verify '@{upstream}' >/dev/null 2>&1; then
      printf '错误: 分支 %s 没有上游，无法确定更新来源。\n' "$branch" >&2; return 1
    fi
    printf '==> 拉取 %s 的上游（仅 fast-forward）\n' "$branch"
    git -C "$repo" pull --ff-only || { rc=$?; printf '错误: 拉取失败，未完成更新（退出码 %s）。\n' "$rc" >&2; return "$rc"; }
  else
    # Skills copies do not carry a Git checkout. Use only a matching lock entry,
    # and preserve the manager's scope rather than reinstalling into a guessed directory.
    local scope_root lock_file scope global_root
    scope_root="$(cd -P "$repo/../../.." && pwd)" || return 1
    global_root="$(cd -P "$HOME" && pwd)" || return 1
    lock_file=""; scope=""
    if [ "$scope_root" = "$global_root" ] && [ -f "$HOME/.agents/.skill-lock.json" ]; then
      lock_file="$HOME/.agents/.skill-lock.json"; scope="--global"
    elif [ -f "$scope_root/skills-lock.json" ]; then
      lock_file="$scope_root/skills-lock.json"; scope="--project"
    fi
    # Native Windows Node needs a drive path, not the shell mount alias.
    local native_lock="$lock_file"
    case "$(uname -s)" in
      MINGW*|MSYS*|CYGWIN*)
        if [ -n "$native_lock" ] && command -v cygpath >/dev/null 2>&1; then
          native_lock="$(cygpath -m "$native_lock")" || return 1
        fi ;;
    esac
    if [ -z "$lock_file" ] || ! EGO_UPDATE_LOCK="$native_lock" node -e '
      try {
        const fs = require("node:fs");
        const lock = JSON.parse(fs.readFileSync(process.env.EGO_UPDATE_LOCK, "utf8"));
        process.exit(lock.skills && Object.hasOwn(lock.skills, "ego-decision-layer") ? 0 : 1);
      } catch { process.exit(1); }
    '; then
      printf '错误: 当前安装不是独立 Git 克隆，也没有匹配的 skills 安装记录。\n请通过原安装渠道更新；ZIP 用户可下载最新源码，插件用户请更新 marketplace 与插件。\n' >&2
      return 1
    fi
    command -v npx >/dev/null 2>&1 || { printf '错误: skills 安装更新需要 npx\n' >&2; return 2; }
    printf '==> 定向更新 skills 安装（%s）\n' "$scope"
    local manager_output
    manager_output="$(cd "$scope_root" && npx --yes skills update ego-decision-layer "$scope" --yes 2>&1)"
    rc=$?
    printf '%s\n' "$manager_output"
    if [ "$rc" -ne 0 ]; then
      printf '错误: skills 更新失败（退出码 %s）。\n' "$rc" >&2; return "$rc"
    fi
    # skills may report a failed source check/skipped lock entry with exit 0.
    case "$manager_output" in
      *"Failed to check"*|*"Failed to update"*|*"cannot be checked automatically"*|*"No installed skills found matching"*|*"No project skills to update"*|*"No global skills to check"*)
        printf '错误: skills 未完成当前技能的更新检查，请按上面的原因处理。\n' >&2; return 1 ;;
    esac
  fi

  if [ ! -f "$repo/scripts/ego-decision-layer" ]; then
    printf '错误: 更新后原安装入口缺失，未刷新链接；请检查原安装渠道。\n' >&2; return 1
  fi
  after="$(bash "$repo/scripts/ego-decision-layer" --version)" || return 1
  printf '更新后: %s\n' "$after"
  mkdir -p "$bindir" || return 1
  ln -sfn "$repo/scripts/ego-decision-layer" "$bindir/ego-decision-layer" || return 1
  if [ -f "$repo/scripts/ego-jev" ]; then  # 历史兼容入口
    ln -sfn "$repo/scripts/ego-jev" "$bindir/ego-jev" || return 1  # 历史兼容入口
  fi
  printf '命令入口: %s/ego-decision-layer\n' "$bindir"
  case ":$PATH:" in
    *":$bindir:"*) ;;
    *) printf '提示: %s 不在 PATH 中；可通过 BINDIR 指定原命令目录，或将该目录加入 PATH。\n' "$bindir" >&2 ;;
  esac
  if [ -f "$repo/scripts/wire-agent-skills.sh" ]; then
    bash "$repo/scripts/wire-agent-skills.sh" --if-enabled || return $?
  fi
  if [ "$run_test" = 1 ]; then
    printf '==> 浏览器冒烟测试\n'
    bash "$repo/scripts/ego-decision-layer" --url 'https://en.wikipedia.org/wiki/Main_Page' \
      --text Jev --until /wiki/Jev --steps 5 'type Jev into the search box and submit' || return $?
  fi
  printf '更新检查与入口刷新完成。新开的 Agent 会话会读取更新后的技能说明。\n'
}

update_main "$@"; exit $?
