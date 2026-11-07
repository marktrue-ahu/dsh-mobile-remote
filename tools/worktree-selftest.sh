#!/usr/bin/env bash
# tools/worktree.sh 自测（AGENT-RULES「工作树生命周期」）。
#
# 在**临时克隆**里跑完整生命周期，不触碰真实仓库、不推送任何远端：
#   create → init（独立安装）→ verify（合成门禁）→ deliver → integrate → cleanup
# 覆盖输入注入、并发 create/verify、身份/分支归属、脏树、报告失败、重任务限额、基线例外与 PR 清理。
#
# 用法：bash tools/worktree-selftest.sh [-v]
set -uo pipefail

REPO_SRC="$(cd "$(dirname "$0")/.." && pwd)"
VERBOSE="${1:-}"
PASS=0; FAIL=0
TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-wt-selftest.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

say() { printf '%s\n' "$*"; }
run() { # run <描述> <期望退出码0|非0> <命令...>
  local desc="$1" expect="$2"; shift 2
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if { [ "$expect" = "0" ] && [ "$rc" -eq 0 ]; } || { [ "$expect" = "fail" ] && [ "$rc" -ne 0 ]; }; then
    PASS=$((PASS+1)); say "  PASS  $desc"
    [ "$VERBOSE" = "-v" ] && printf '%s\n' "$out" | sed 's/^/        /'
  else
    FAIL=$((FAIL+1)); say "  FAIL  $desc (期望 ${expect}，实际 exit=$rc)"
    printf '%s\n' "$out" | sed 's/^/        /'
  fi
}
section() { say ""; say "── $* ──"; }
run_fail_with() { # run_fail_with <描述> <期望输出片段> <命令...>：既要求失败，又要求失败原因匹配
  local desc="$1" want="$2"; shift 2
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [ "$rc" -ne 0 ] && printf '%s' "$out" | grep -qF -- "$want"; then
    PASS=$((PASS+1)); say "  PASS  $desc"
    [ "$VERBOSE" = "-v" ] && printf '%s\n' "$out" | sed 's/^/        /'
  else
    FAIL=$((FAIL+1)); say "  FAIL  $desc (期望失败且包含「$want」，实际 exit=$rc)"
    printf '%s\n' "$out" | sed 's/^/        /'
  fi
}
slot_is_locked() { # exclusive try fails while any shared/exclusive holder owns the lock
  local f="$1"
  exec 5>"$f"
  if flock -n 5; then flock -u 5; exec 5>&-; return 1; fi
  exec 5>&-
  return 0
}

# ── 夹具：临时克隆 + main 上游镜像与 github/develop PR 目标 ──
CLONE="$TMP/repo"
git clone --no-hardlinks --quiet "$REPO_SRC" "$CLONE" || { say "克隆失败"; exit 1; }
cd "$CLONE"
git fetch --quiet origin 'refs/heads/*:refs/remotes/origin/*' 2>/dev/null || true
MAIN_SHA="$(git rev-parse origin/main 2>/dev/null || git rev-parse origin/develop)"
git branch -f main "$MAIN_SHA" >/dev/null
git update-ref refs/remotes/github/main "$MAIN_SHA"   # 模拟 main 上游镜像；create 不再以它为基线
git checkout --quiet develop

# 假 github 远端：本地裸仓库，让 create 的 `git fetch github` 离线且可控
GITHUB_BARE="$TMP/github.git"
git init --bare --quiet "$GITHUB_BARE"
if git remote | grep -qx github; then git remote set-url github "$GITHUB_BARE"
else git remote add github "$GITHUB_BARE"; fi

# 被测脚本可能是尚未提交的新文件：拷进克隆的 tools/ 并提交到 **develop**（不是 main）
mkdir -p "$CLONE/tools"
cp -p "$REPO_SRC/tools/worktree.sh" "$REPO_SRC/tools/worktree-selftest.sh" "$REPO_SRC/tools/proxy-env.sh" "$CLONE/tools/"
git add tools/worktree.sh tools/worktree-selftest.sh tools/proxy-env.sh >/dev/null 2>&1
git -c user.email=selftest@local -c user.name=selftest commit -qm "test: selftest fixture" >/dev/null 2>&1

# main 始终只是 origin/main 的镜像；生命周期工具只从 develop 版本化与运行。
if git rev-parse --verify --quiet origin/main >/dev/null; then
  git checkout --quiet -B main origin/main
else
  git branch -f main develop >/dev/null
fi
git checkout --quiet develop
git push --quiet "$GITHUB_BARE" main:refs/heads/main
git push --quiet "$GITHUB_BARE" develop:refs/heads/develop
git fetch --quiet github
MAIN_SHA="$(git rev-parse main)"
DEVELOP_SHA="$(git rev-parse develop)"

# 自测用状态目录/工作树目录：全部隔离在 TMP，不碰真实状态
export DSH_WT_MAIN="$CLONE"
export DSH_WT_ROOT="$TMP/worktrees"
export DSH_WT_STATE="$TMP/state"
export DSH_WT_ALLOW_SYNTHETIC=1
export DSH_WT_SYNTHETIC_GATES=1
export DSH_SESSION_ID="selftest-writer"
WT="$CLONE/tools/worktree.sh"

say "worktree.sh 自测（临时克隆：$CLONE）"
say "feature 基线 develop = $(git rev-parse --short develop)"

section "代理环境：NO_PROXY 自动补本机回环（issue #57）"
PROXY_HELPER="$CLONE/tools/proxy-env.sh"
mkdir -p "$TMP/proxy"
printf 'DSH_PROXY_ENABLED=1\nDSH_PROXY_HTTP=http://proxy.local:8080\n' > "$TMP/proxy/http.env"
printf 'DSH_PROXY_ENABLED=1\nDSH_PROXY_SOCKS=socks5://proxy.local:1080\n' > "$TMP/proxy/socks.env"
printf 'DSH_PROXY_ENABLED=0\nDSH_PROXY_HTTP=http://proxy.local:8080\n' > "$TMP/proxy/disabled.env"
run "未配置 .env 时不设置任何代理变量" 0 \
  env -i PATH="$PATH" HOME="$TMP/proxy" bash -c \
  '. "$1"; apply_proxy_env "$2"; test -z "${HTTP_PROXY:-}" && test -z "${NO_PROXY:-}" && test -z "${ALL_PROXY:-}"' \
  _ "$PROXY_HELPER" "$TMP/proxy/missing.env"
run "HTTP 代理时补 NO_PROXY 的 127.0.0.1/localhost/::1" 0 \
  env -i PATH="$PATH" HOME="$TMP/proxy" bash -c \
  '. "$1"; apply_proxy_env "$2"; [ "$HTTP_PROXY" = "http://proxy.local:8080" ] && [ "$NO_PROXY" = "127.0.0.1,localhost,::1" ]' \
  _ "$PROXY_HELPER" "$TMP/proxy/http.env"
run "已有 NO_PROXY 保留并且只追加缺失项" 0 \
  env -i PATH="$PATH" HOME="$TMP/proxy" NO_PROXY="corp.example.com,127.0.0.1" bash -c \
  '. "$1"; apply_proxy_env "$2"; [ "$NO_PROXY" = "corp.example.com,127.0.0.1,localhost,::1" ]' \
  _ "$PROXY_HELPER" "$TMP/proxy/http.env"
run "SOCKS 代理同样补 NO_PROXY 并设置 Gradle socks 参数" 0 \
  env -i PATH="$PATH" HOME="$TMP/proxy" bash -c \
  '. "$1"; apply_proxy_env "$2"; [ "$ALL_PROXY" = "socks5://proxy.local:1080" ] && [ "$NO_PROXY" = "127.0.0.1,localhost,::1" ] && printf "%s" "$GRADLE_OPTS" | grep -q -- "-DsocksProxyHost=proxy.local"' \
  _ "$PROXY_HELPER" "$TMP/proxy/socks.env"
run "DSH_PROXY_ENABLED=0 时完全不设代理" 0 \
  env -i PATH="$PATH" HOME="$TMP/proxy" bash -c \
  '. "$1"; apply_proxy_env "$2"; test -z "${HTTP_PROXY:-}" && test -z "${NO_PROXY:-}" && test -z "${ALL_PROXY:-}"' \
  _ "$PROXY_HELPER" "$TMP/proxy/disabled.env"

section "create 输入边界与并发登记"
INJECTION_MARKER="$TMP/python-injection-ran"
INJECTED_WRITER="\", \"evil\": __import__(\"os\").system(\"touch $INJECTION_MARKER\"), \"z\": \""
run "Python 代码注入 writer 被拒绝" fail bash "$WT" create 899 injection-probe --writer "$INJECTED_WRITER"
[ ! -e "$INJECTION_MARKER" ] && { PASS=$((PASS+1)); say "  PASS  注入载荷未执行"; } || { FAIL=$((FAIL+1)); say "  FAIL  writer 输入执行了代码"; }

# 两个不同短名并发创建同 issue，只能有一个取得登记与建树权。
bash "$WT" create 898 race-a >"$TMP/create-a.log" 2>&1 & CREATE_A=$!
bash "$WT" create 898 race-b >"$TMP/create-b.log" 2>&1 & CREATE_B=$!
wait "$CREATE_A"; RC_A=$?; wait "$CREATE_B"; RC_B=$?
SUCCESSES=0; [ "$RC_A" -eq 0 ] && SUCCESSES=$((SUCCESSES+1)); [ "$RC_B" -eq 0 ] && SUCCESSES=$((SUCCESSES+1))
[ "$SUCCESSES" -eq 1 ] && { PASS=$((PASS+1)); say "  PASS  同 issue 并发 create 仅一个成功"; } || { FAIL=$((FAIL+1)); say "  FAIL  同 issue 并发 create 成功数=$SUCCESSES"; }
[ "$(find "$DSH_WT_ROOT" -maxdepth 1 -type d -name 'issue-898-*' | wc -l)" -eq 1 ] \
  && { PASS=$((PASS+1)); say "  PASS  并发 create 只留下一个工作树"; } || { FAIL=$((FAIL+1)); say "  FAIL  并发 create 留下孤儿工作树"; }
run "issue 路径穿越被拒" fail bash "$WT" create ../../pwn safe
run "非法短名被拒" fail bash "$WT" create 901 Bad_Name
run "缺参数被拒" fail bash "$WT" create 900
run "--kind 缺值立即拒绝" fail bash "$WT" create 901 safe --kind
run "--writer 缺值立即拒绝" fail bash "$WT" create 901 safe --writer
run "create 建树成功" 0 bash "$WT" create 900 selftest-one
run "重复 create 被拒" fail bash "$WT" create 900 selftest-one
WT1="$DSH_WT_ROOT/issue-900-selftest-one"
[ -d "$WT1" ] && { PASS=$((PASS+1)); say "  PASS  工作树目录已创建"; } || { FAIL=$((FAIL+1)); say "  FAIL  工作树目录缺失"; }
[ "$(git -C "$WT1" rev-parse --abbrev-ref HEAD)" = "feature/selftest-one" ] \
  && { PASS=$((PASS+1)); say "  PASS  分支名正确"; } || { FAIL=$((FAIL+1)); say "  FAIL  分支名错误"; }
[ "$(git -C "$WT1" rev-parse HEAD)" = "$DEVELOP_SHA" ] \
  && { PASS=$((PASS+1)); say "  PASS  功能分支从 develop 起步"; } || { FAIL=$((FAIL+1)); say "  FAIL  功能分支未从 develop 起步"; }
python3 - "$DSH_WT_STATE/tasks/900.json" "$DEVELOP_SHA" <<'PY'
import json,sys
task,sha=sys.argv[1:3]
data=json.load(open(task))
assert data.get("baseline")==sha, data
assert data.get("baseline_ref")=="develop", data
PY
[ "$?" -eq 0 ] && { PASS=$((PASS+1)); say "  PASS  任务基线登记为 develop"; } || { FAIL=$((FAIL+1)); say "  FAIL  任务基线未登记 develop"; }
# 无 --base 时不得出现依赖字段：普通任务不能被误标为"依赖分支例外".
run "无 --base 时不登记依赖分支" 0 python3 -c '
import json,sys
d=json.load(open(sys.argv[1])); assert "depends_on" not in d, d' "$DSH_WT_STATE/tasks/900.json"

section "upstream-main target 从 main 镜像建干净分支"
run "create 接受 --target upstream-main" 0 bash "$WT" create 904 upstream-probe --target upstream-main
WT_UPSTREAM="$DSH_WT_ROOT/issue-904-upstream-probe"
if [ -d "$WT_UPSTREAM" ]; then
  [ "$(git -C "$WT_UPSTREAM" rev-parse --abbrev-ref HEAD)" = "upstream/upstream-probe" ] \
    && { PASS=$((PASS+1)); say "  PASS  上游分支使用 upstream/* 前缀"; } \
    || { FAIL=$((FAIL+1)); say "  FAIL  上游分支前缀错误"; }
  [ "$(git -C "$WT_UPSTREAM" rev-parse HEAD)" = "$MAIN_SHA" ] \
    && { PASS=$((PASS+1)); say "  PASS  上游分支从 main 镜像起步"; } \
    || { FAIL=$((FAIL+1)); say "  FAIL  上游分支没有从 main 镜像起步"; }
  python3 - "$DSH_WT_STATE/tasks/904.json" "$MAIN_SHA" <<'PY'
import json,sys
task,sha=sys.argv[1:3]
data=json.load(open(task))
assert data.get("target")=="upstream-main", data
assert data.get("baseline")==sha and data.get("baseline_ref")=="main", data
PY
  [ "$?" -eq 0 ] && { PASS=$((PASS+1)); say "  PASS  上游任务登记 main 基线与目标"; } || { FAIL=$((FAIL+1)); say "  FAIL  上游任务元数据不正确"; }
else
  FAIL=$((FAIL+1)); say "  FAIL  upstream-main 工作树未创建";
fi
run "upstream-main 禁止依赖 develop feature 分支" fail bash "$WT" create 905 unsafe-base --target upstream-main --base feature/selftest-one

section "develop 基线决策文件继承，但 feature PR 不得改动它们"
run "develop 基线确实含决策文档（用例非空跑）" 0 bash -c 'git -C "$1" ls-tree -r --name-only "$2" -- AGENTS.md CONTEXT.md docs/adr docs/agents docs/design | grep -q .' _ "$CLONE" "$DEVELOP_SHA"
for f in AGENTS.md AGENT-RULES.md CONTEXT.md docs/adr docs/agents docs/design; do
  git -C "$WT1" diff --quiet "$DEVELOP_SHA" HEAD -- "$f" \
    && { PASS=$((PASS+1)); say "  PASS  feature diff 未改动 $f"; } \
    || { FAIL=$((FAIL+1)); say "  FAIL  feature diff 改动了 $f"; }
done

section "依赖分支例外（--base）"
# 造一个「未合入 develop 的依赖分支」：从 develop 开分支并加一个提交，模拟 issue #14 的情形。
DEP_BRANCH="feature/dep-probe"
git -C "$CLONE" branch -f "$DEP_BRANCH" develop >/dev/null 2>&1
DEP_WT="$TMP/depbuild"
git -C "$CLONE" worktree add -q "$DEP_WT" "$DEP_BRANCH" >/dev/null 2>&1
echo "dep-marker" > "$DEP_WT/dep-only.txt"
git -C "$DEP_WT" add -A >/dev/null 2>&1
git -C "$DEP_WT" -c user.email=t@t -c user.name=t commit -qm "test: dependency branch content" >/dev/null 2>&1
git -C "$CLONE" worktree remove --force "$DEP_WT" >/dev/null 2>&1
DEP_SHA="$(git -C "$CLONE" rev-parse "$DEP_BRANCH")"
run "--base 指向不存在的分支被拒" fail bash "$WT" create 890 nobase --base feature/does-not-exist
run "--base 拒绝非分支形式的取值" fail bash "$WT" create 890 badbase --base main
run "--base 拒绝任意 rev（防绕过）" fail bash "$WT" create 890 revbase --base "$DEP_SHA"
run "--base 已在 develop 上的分支被拒" fail bash "$WT" create 890 ancestor --base feature/selftest-one
run "--base 建树成功" 0 bash "$WT" create 891 baseprobe --base "$DEP_BRANCH"
WT_BASE="$DSH_WT_ROOT/issue-891-baseprobe"
[ "$(git -C "$WT_BASE" rev-parse HEAD)" = "$DEP_SHA" ] \
  && { PASS=$((PASS+1)); say "  PASS  工作树起点等于依赖分支 SHA"; } \
  || { FAIL=$((FAIL+1)); say "  FAIL  起点不是依赖分支 SHA"; }
[ -f "$WT_BASE/dep-only.txt" ] \
  && { PASS=$((PASS+1)); say "  PASS  依赖分支的文件确实存在于新树（用例非空跑）"; } \
  || { FAIL=$((FAIL+1)); say "  FAIL  依赖分支内容缺失"; }
# 关键语义：baseline 指创建工作树时的 develop，依赖分支另记。
TASK_BASE="$DSH_WT_STATE/tasks/891.json"
python3 - "$TASK_BASE" "$DEVELOP_SHA" "$DEP_BRANCH" "$DEP_SHA" <<'PY' \
  && { PASS=$((PASS+1)); say "  PASS  baseline 指向 develop，并登记依赖分支与其 SHA"; } \
  || { FAIL=$((FAIL+1)); say "  FAIL  baseline/依赖分支登记不正确"; }
import json,sys
p,develop_sha,dep,dep_sha=sys.argv[1:5]
d=json.load(open(p))
assert d.get("baseline")==develop_sha, ("baseline 不是 develop", d.get("baseline"), develop_sha)
assert d.get("baseline_ref")=="develop", d.get("baseline_ref")
assert d.get("depends_on")==dep, d.get("depends_on")
assert d.get("depends_on_sha")==dep_sha, d.get("depends_on_sha")
PY
run "status 显示依赖分支例外" 0 bash -c 'bash "$1" status 891 | grep -q "依赖分支"' _ "$WT"

section "init 归属、子目录检查与独立产物"
cd "$WT1" || { say "  FAIL  无法进入工作树 $WT1"; exit 1; }
run "异身份 init 被拒" fail env DSH_SESSION_ID=other-agent bash "$WT" init
mkdir -p "$TMP/profile-node-modules"
ln -s "$TMP/profile-node-modules" "$WT1/node_modules"
run "从 Flutter 子目录 init 仍拒绝根 node_modules 软链" fail bash -c 'cd "$1/dsh-mobile-app" && bash "$2" init' _ "$WT1" "$WT"
rm "$WT1/node_modules"
mkdir -p "$TMP/shared-dart"
ln -s "$TMP/shared-dart" "$WT1/dsh-mobile-app/.dart_tool"
run "从子目录 init 拒绝 .dart_tool 目录软链" fail bash -c 'cd "$1/dsh-mobile-app" && bash "$2" init' _ "$WT1" "$WT"
rm "$WT1/dsh-mobile-app/.dart_tool"
mkdir -p "$TMP/shared-build" "$WT1/dsh-mobile-app/build/outputs"
ln -s "$TMP/shared-build" "$WT1/dsh-mobile-app/build/outputs/shared"
run "init 拒绝 build 子目录指向外部工作树的嵌套软链" fail bash "$WT" init
rm -rf "$WT1/dsh-mobile-app/build"
run "owner init 完成独立依赖与 wrapper 准备" 0 bash "$WT" init
# 回归 BLOCKING：安装后才出现的跨树软链必须被发现（file: 本地依赖会软链到树外）。
EXTERNAL_DEP="$TMP/external-local-dep"
mkdir -p "$EXTERNAL_DEP"
printf '{"name":"selftest-external","version":"1.0.0","main":"index.js"}\n' > "$EXTERNAL_DEP/package.json"
printf 'module.exports=1\n' > "$EXTERNAL_DEP/index.js"
PKG_BAK="$TMP/package.json.bak"
cp "$WT1/package.json" "$PKG_BAK"
python3 - "$WT1/package.json" "$EXTERNAL_DEP" <<'PY'
import json,sys
p,dep=sys.argv[1:]
with open(p,encoding="utf-8") as f: doc=json.load(f)
doc.setdefault("dependencies",{})["selftest-external"]="file:"+dep
with open(p,"w",encoding="utf-8") as f: json.dump(doc,f,indent=2); f.write("\n")
PY
git -C "$WT1" add package.json >/dev/null 2>&1
git -C "$WT1" -c user.email=t@t -c user.name=t commit -qm "test: local file dependency" >/dev/null 2>&1
run "安装产生树外软链时 init 必须失败" fail bash "$WT" init
LINKED="$(find "$WT1/node_modules" -maxdepth 1 -type l -name 'selftest-external' -print -quit 2>/dev/null)"
if [ -n "$LINKED" ]; then
  PASS=$((PASS+1)); say "  PASS  file: 依赖确实产生了树外软链（用例非空跑）"
else
  FAIL=$((FAIL+1)); say "  FAIL  未观察到树外软链，用例可能无效"
fi
# 还原：删掉外部依赖与软链，重新提交，再确认 init 恢复可用。
rm -f "$WT1/node_modules/selftest-external"
cp "$PKG_BAK" "$WT1/package.json"
git -C "$WT1" add -A >/dev/null 2>&1
git -C "$WT1" -c user.email=t@t -c user.name=t commit -qm "test: drop local file dependency" >/dev/null 2>&1
run "移除外部依赖后 init 恢复可用" 0 bash "$WT" init
[ -d "$WT1/node_modules" ] && [ ! -L "$WT1/node_modules" ] && \
  { PASS=$((PASS+1)); say "  PASS  node_modules 是本树独立目录"; } || { FAIL=$((FAIL+1)); say "  FAIL  node_modules 未独立"; }
[ "$(stat -c %h "$WT1/dsh-mobile-app/.dart_tool/package_config.json" 2>/dev/null || echo 0)" -eq 1 ] && \
  { PASS=$((PASS+1)); say "  PASS  .dart_tool package_config inode 独立"; } || { FAIL=$((FAIL+1)); say "  FAIL  .dart_tool 不独立"; }
[ -f "$WT1/dsh-mobile-app/android/gradle/wrapper/gradle-wrapper.jar" ] && \
  { PASS=$((PASS+1)); say "  PASS  Gradle wrapper jar 已补齐"; } || { FAIL=$((FAIL+1)); say "  FAIL  wrapper jar 缺失"; }

section "写入者归属、收尾跨会话与 verify"
run "同身份 verify 通过（合成门禁）" 0 bash "$WT" verify
# 收尾与执行常常不是同一个会话：收尾型操作（verify/deliver/verify-baseline）允许跨会话，
# 但必须留痕（审计 + 任务登记）。写入型操作（init）仍然排他。
run "异身份 verify 允许（收尾可跨会话）" 0 env DSH_SESSION_ID=other-agent bash "$WT" verify
run "跨会话收尾写入审计记录" 0 grep -q "wrapup" "$DSH_WT_STATE/audit.log"
run "跨会话收尾记入任务登记（谁收尾可见）" 0 python3 -c "import json,sys;d=json.load(open('$DSH_WT_STATE/tasks/900.json'));sys.exit(0 if d.get('last_wrapup_by')=='other-agent' and d.get('last_wrapup_op')=='verify' else 1)"
run "未给授权理由被拒" fail bash "$WT" authorize 900 takeover
run "非集成角色不能登记接管授权" fail bash "$WT" authorize 900 takeover "selftest 用户批准"
run "集成角色登记 takeover 意向" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 900 takeover "selftest 用户批准"
# 接管授权必须绑定当时的 HEAD；且只有显式带 DSH_WT_TAKEOVER=1 才生效（下一条用第三方身份证明不泄漏）。
run "接管授权绑定当前 HEAD" 0 python3 -c "import json,subprocess,sys;d=json.load(open('$DSH_WT_STATE/tasks/900.json'));head=subprocess.check_output(['git','-C','$WT1','rev-parse','HEAD']).decode().strip();sys.exit(0 if d.get('authorizations',{}).get('takeover',{}).get('scope_sha')==head else 1)"
run "无接管时写入型操作 init 仍被拒" fail env DSH_SESSION_ID=third-agent bash "$WT" init

section "verify 证据与当前树插件隔离"
export DSH_MOBILE_PLUGIN="$TMP/evil-profile/lib/index.js"
run "verify 覆盖继承的外部插件路径" 0 bash "$WT" verify
REPORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["last_report"])' "$DSH_WT_STATE/tasks/900.json")"
if [ -f "$REPORT" ] && grep -q 'synthetic-pass' "$REPORT" && grep -Fq "$WT1/lib/index.js" "$REPORT"; then
  PASS=$((PASS+1)); say "  PASS  原子报告记录合成门禁与当前树插件路径"
else FAIL=$((FAIL+1)); say "  FAIL  报告缺失/写错：$REPORT"; fi
# 同 issue/SHA 两个 verify 并发时，task lock 必须串行化并留下完整单份报告。
env DSH_WT_TEST_GATE_SLEEP=0.3 bash "$WT" verify >"$TMP/verify-1.log" 2>&1 & VERIFY_A=$!
env DSH_WT_TEST_GATE_SLEEP=0.3 bash "$WT" verify >"$TMP/verify-2.log" 2>&1 & VERIFY_B=$!
wait "$VERIFY_A"; VERIFY_RC_A=$?; wait "$VERIFY_B"; VERIFY_RC_B=$?
REPORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["last_report"])' "$DSH_WT_STATE/tasks/900.json")"
[ "$VERIFY_RC_A" -eq 0 ] && [ "$VERIFY_RC_B" -eq 0 ] && [ "$(grep -c '^### synthetic-pass$' "$REPORT")" -eq 1 ] && \
  { PASS=$((PASS+1)); say "  PASS  同 SHA 并发 verify 报告完整且无混写"; } || { FAIL=$((FAIL+1)); say "  FAIL  同 SHA 并发 verify 报告损坏"; }

section "证据结构完整性与真实/合成门禁边界"
# 回归 BLOCKING：截断报告（只剩当前 SHA 行）不得再被当作绿灯交付。
run "当前状态可交付" 0 bash "$WT" deliver
TRUNC_SHA="$(git -C "$WT1" rev-parse HEAD)"
TRUNC_REPORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["last_report"])' "$DSH_WT_STATE/tasks/900.json")"
cp "$TRUNC_REPORT" "$TMP/report.bak"
printf -- '- 提交：`%s`\n' "$TRUNC_SHA" > "$TRUNC_REPORT"
run "报告被截断后 deliver 必须被拒" fail bash "$WT" deliver
run "报告被截断后 integrate 必须被拒" fail env DSH_WT_ROLE=integrator bash "$WT" integrate 900 777
# 把必需门禁结果伪造成全 PASS 但仍缺结构/或缺项，同样拒绝。
python3 - "$TRUNC_REPORT" "$TRUNC_SHA" <<'PY'
import json,sys
p,sha=sys.argv[1:3]
res={"flutter-analyze":{"status":"pass","kind":"executed"}}
with open(p,"w",encoding="utf-8") as f:
    f.write(f"# 验证报告\n\n- 提交：`{sha}`\n\n<!--GATES {{\"mode\":\"required\",\"results\":{json.dumps(res)}}}-->\n")
PY
run "缺少必需门禁项的报告被拒" fail bash "$WT" deliver
# 伪造"跳过"冒充通过：status=pass 但 kind=skipped 也不得交付。
python3 - "$TRUNC_REPORT" "$TRUNC_SHA" <<'PY'
import json,sys
p,sha=sys.argv[1:3]
names=["flutter-analyze","flutter-test","timeline-contract","account-usage","kotlin-usage-panel"]
res={n:{"status":"pass","kind":"skipped"} for n in names}
with open(p,"w",encoding="utf-8") as f:
    f.write(f"# 验证报告\n\n- 提交：`{sha}`\n\n<!--GATES {{\"mode\":\"required\",\"results\":{json.dumps(res)}}}-->\n")
PY
run "伪造 skipped 冒充通过的报告被拒" fail bash "$WT" deliver
cp "$TMP/report.bak" "$TRUNC_REPORT"
# 本节的提交是为了验证证据绑定；恢复基线状态，让后续"相对基线无提交"的用例成立。
git -C "$WT1" reset --hard -q "$DEVELOP_SHA"
run "恢复基线后相对基线无提交" fail bash "$WT" deliver

section "verify 脏树、原子报告与 deliver"
run "无提交时 deliver 被拒" fail bash "$WT" deliver
echo "selftest" > selftest-file.txt
git add -A >/dev/null 2>&1
git -c user.email=t@t -c user.name=t commit -qm "test: selftest commit" >/dev/null 2>&1
CURRENT_SHA="$(git -C "$WT1" rev-parse --short=12 HEAD)"
DELIVERY_SHORT="$(git -C "$WT1" rev-parse --short HEAD)"
run "确认已产生提交" 0 bash -c '[ "$(git -C "$1" rev-parse HEAD)" != "$2" ]' _ "$WT1" "$DEVELOP_SHA"
run "有提交但未验证时 deliver 被拒（必须带证据）" fail bash "$WT" deliver
mv "$DSH_WT_STATE/reports" "$DSH_WT_STATE/reports.saved"
printf 'block report directory creation\\n' >"$DSH_WT_STATE/reports"
run "验证报告目录不可写时 verify fail-closed" fail bash "$WT" verify
VERIFIED="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("last_verified_sha",""))' "$DSH_WT_STATE/tasks/900.json")"
[ "$VERIFIED" != "$(git -C "$WT1" rev-parse HEAD)" ] && { PASS=$((PASS+1)); say "  PASS  报告创建失败未把 HEAD 标记为 verified"; } || { FAIL=$((FAIL+1)); say "  FAIL  报告创建失败仍标记 verified"; }
rm -f "$DSH_WT_STATE/reports"
mv "$DSH_WT_STATE/reports.saved" "$DSH_WT_STATE/reports"
run "干净已提交树 verify 通过" 0 bash "$WT" verify
# BLOCKING 回归：同一 HEAD 先绿灯、再被中断的 verify，绝不能沿用旧绿灯交付。
# 用会 sleep 的合成门禁并在中途杀掉 verify，模拟进程被杀/状态写入失败的窗口。
env DSH_WT_TEST_GATE_SLEEP=5 bash "$WT" verify >"$TMP/interrupted.log" 2>&1 & INTERRUPTED=$!
sleep 1
kill -TERM "$INTERRUPTED" 2>/dev/null || true
wait "$INTERRUPTED" 2>/dev/null || true
STATE_AFTER="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("verification_state",""))' "$DSH_WT_STATE/tasks/900.json")"
[ "$STATE_AFTER" = "running" ] && { PASS=$((PASS+1)); say "  PASS  中断的 verify 停在 running（未完成事务）"; } || { FAIL=$((FAIL+1)); say "  FAIL  中断后状态=$STATE_AFTER，应为 running"; }
run "中断的 verify 不能交付（不继承旧绿灯）" fail bash "$WT" deliver
run "重新完整 verify 后恢复可交付" 0 bash "$WT" verify
run "恢复后 deliver 成功" 0 bash "$WT" deliver
# 摘要目标是目录（而非普通文件）时必须 fail-closed；先清掉上一步已生成的同名摘要。
rm -f "$DSH_WT_STATE/reports/900-delivery-$DELIVERY_SHORT.md"
mkdir "$DSH_WT_STATE/reports/900-delivery-$DELIVERY_SHORT.md"
DELIVERED_AT_BEFORE="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("delivered_at",""))' "$DSH_WT_STATE/tasks/900.json")"
run "摘要目标是目录时 deliver fail-closed" fail bash "$WT" deliver
DELIVERED_AT_AFTER="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("delivered_at",""))' "$DSH_WT_STATE/tasks/900.json")"
[ "$DELIVERED_AT_BEFORE" = "$DELIVERED_AT_AFTER" ] \
  && { PASS=$((PASS+1)); say "  PASS  摘要写失败未改动交付状态"; } || { FAIL=$((FAIL+1)); say "  FAIL  摘要写失败仍更新了交付状态"; }
rmdir "$DSH_WT_STATE/reports/900-delivery-$DELIVERY_SHORT.md"
run "已验证且摘要可写 → deliver 成功" 0 bash "$WT" deliver

# 新 HEAD 未验证时，即使用脏源码跑门禁也必须拒绝；恢复 clean 后 deliver 仍不能继承绿灯。
git commit -q --allow-empty -m "test: unverified head"
echo "uncommitted test edit" >> README.md
run "脏树 verify 在运行门禁前拒绝" fail bash "$WT" verify
git checkout -- README.md
run "撤销脏改动后未验证 HEAD 仍不能 deliver" fail bash "$WT" deliver
run "verify 新 HEAD 后 deliver 可通过" 0 bash "$WT" verify
run "新 HEAD 验证后 deliver 成功" 0 bash "$WT" deliver

# DSH_WT_SKIP_GRADLE 即使显式设置也属于失败，不得把 skip 记成全绿。
run "跳过必需 Gradle 门禁不得 verified" fail env DSH_WT_SKIP_GRADLE=1 bash "$WT" verify
[ "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("last_verified_sha",""))' "$DSH_WT_STATE/tasks/900.json")" != "$(git -C "$WT1" rev-parse HEAD)" ] \
  && { PASS=$((PASS+1)); say "  PASS  Kotlin 门禁跳过未记为 verified"; } || { FAIL=$((FAIL+1)); say "  FAIL  Kotlin 门禁跳过被记为 verified"; }
run "缺 gradlew 门禁不得 verified" fail env DSH_WT_TEST_MISSING_GRADLE=1 bash "$WT" verify
run "缺时间线契约脚本不得 verified" fail env DSH_WT_TEST_MISSING_TIMELINE=1 bash "$WT" verify
run "跳过后重新全绿 verify 并交付" 0 bash "$WT" verify
run "跳过测试后重新交付" 0 bash "$WT" deliver

section "登记任务必须与当前分支绑定"
git switch -q -c feature/wrong-branch
git -c user.email=t@t -c user.name=t commit --allow-empty -qm "test: wrong branch commit"
run "登记树切换到另一 feature 分支后 verify 被拒" fail bash "$WT" verify
run "登记树切换到另一 feature 分支后 deliver 被拒" fail bash "$WT" deliver
git switch -q feature/selftest-one
git branch -D feature/wrong-branch >/dev/null 2>&1

# gradle 已从 exclusive 改为 slots:2（见 worktree.sh 并发限额注释），因此：
#  - 外部持有 legacy exclusive 仍必须挡住 flutter 的 shared；
#  - 外部持有 shared 只表示"某 flutter-test 在跑"，不再挡住 gradle 槽位，
#    这正是本次要放开的并发（gradle 与 flutter-test 可叠加）。
section "真实多进程槽位上限与 gradle/flutter 叠加"
LOCK="$DSH_WT_STATE/locks"
mkdir -p "$LOCK"
run "无外部占用时合成门禁无死锁" 0 bash "$WT" verify
exec 9>"$LOCK/gradle-build.lock"; flock -x -n 9
run "外部 exclusive 阻止 flutter shared 门禁" fail env DSH_WT_SLOT_TIMEOUT=2 bash "$WT" verify
exec 9>&-
exec 8>"$LOCK/gradle-build.lock"; flock -s -n 8
run "外部 shared（有 flutter-test 在跑）不阻止 gradle 槽位门禁" 0 env DSH_WT_SLOT_TIMEOUT=2 bash "$WT" verify
exec 8>&-
# gradle 槽位本身仍需限流：占满 2 个槽后，第三个 gradle 门禁必须等待超时。
exec 8>"$LOCK/gradle-build.1.lock"; flock -x -n 8
exec 9>"$LOCK/gradle-build.2.lock"; flock -x -n 9
run "两个 gradle 槽位占满时 gradle 门禁等锁超时" fail env DSH_WT_SLOT_TIMEOUT=2 bash "$WT" verify
exec 8>&- 9>&-
TIMEOUT_MARKER="$TMP/timeout-injection-ran"
run "并发锁 timeout 环境值拒绝表达式注入" fail env DSH_WT_SLOT_TIMEOUT="\$(touch $TIMEOUT_MARKER)" bash "$WT" verify
[ ! -e "$TIMEOUT_MARKER" ] && { PASS=$((PASS+1)); say "  PASS  非数字 timeout 未执行命令替换"; } || { FAIL=$((FAIL+1)); say "  FAIL  timeout 值执行了命令"; }

# Flutter 全量槽位 = 5（2026-11 由 2 提高，理由见 worktree.sh 并发限额注释）。
# 判据：前 5 个 verify 能同时进入 synthetic-flutter；第 6 个必须等到有槽位释放。
# marker 是门禁命令真实开始时才创建的。
cd "$CLONE"
IDX=910
for n in a b c d e f; do
  run "创建并发测试树 $n" 0 bash "$WT" create "$IDX" "slot-$n"
  IDX=$((IDX+1))
done
A5="$DSH_WT_ROOT/issue-910-slot-a"; B5="$DSH_WT_ROOT/issue-911-slot-b"; C5="$DSH_WT_ROOT/issue-912-slot-c"
D5="$DSH_WT_ROOT/issue-913-slot-d"; E5="$DSH_WT_ROOT/issue-914-slot-e"; F5="$DSH_WT_ROOT/issue-915-slot-f"
PIDS=()
LETTERS=(a b c d e)
IDX=910
for n in "${LETTERS[@]}"; do
  (cd "$DSH_WT_ROOT/issue-$IDX-slot-$n" && env DSH_WT_TEST_GATE_SLEEP=2 DSH_WT_TEST_GATE_MARKER="$TMP/$n.started" bash "$WT" verify >"$TMP/$n.log" 2>&1) &
  PIDS+=($!)
  IDX=$((IDX+1))
done
FIVE=0
for _ in $(seq 1 200); do
  held=0
  for i in 1 2 3 4 5; do slot_is_locked "$LOCK/flutter-test.$i.lock" && held=$((held+1)); done
  [ "$held" -ge 5 ] && { FIVE=1; break; }
  sleep 0.05
done
[ "$FIVE" -eq 1 ] && { PASS=$((PASS+1)); say "  PASS  五个 verify 进程同时占用五个 Flutter slots"; } || { FAIL=$((FAIL+1)); say "  FAIL  未观察到五个并发 slot 持有者"; }
(cd "$F5" && env DSH_WT_SLOT_TIMEOUT=10 DSH_WT_TEST_GATE_MARKER="$TMP/f.started" bash "$WT" verify >"$TMP/f.log" 2>&1) & PF=$!
sleep 0.3
[ ! -e "$TMP/f.started" ] && { PASS=$((PASS+1)); say "  PASS  第六个 Flutter 门禁在五槽占满时未启动"; } || { FAIL=$((FAIL+1)); say "  FAIL  第六个 Flutter 门禁越过 slots:5 上限"; }
ALLRC=0
for pid in "${PIDS[@]}"; do wait "$pid" || ALLRC=1; done
wait "$PF" || ALLRC=1
[ "$ALLRC" -eq 0 ] \
  && { PASS=$((PASS+1)); say "  PASS  五个并发 verify 全部通过"; } \
  || { FAIL=$((FAIL+1)); say "  FAIL  并发 verify 有失败"; cat "$TMP"/[a-e].log "$TMP/f.log"; }
run "从未 deliver 的任务禁止 integrate" fail env DSH_WT_ROLE=integrator bash "$WT" integrate 910

section "基线例外必须有同 SHA、同门禁的基线实测报告"
cd "$WT1"
# 回归 BLOCKING：跳过必需门禁不能靠"基线里同名门禁也失败"拿到例外。
# 合成门禁模式下不存在 kotlin-usage-panel 这个必需门禁，因此本节统一用真实的必需门禁名
# 直接构造报告，验证"跳过/缺失不能开例外"的规则本身（与门禁是否真跑无关）。
SKIP_SHA="$(git -C "$WT1" rev-parse HEAD)"
SUF="$TMP/skip-reports"; mkdir -p "$SUF"
SKIP_CURRENT="$SUF/current.md"; SKIP_BASELINE="$SUF/baseline.md"
make_report() { # <路径> <sha> <kotlin-kind>
  python3 - "$1" "$2" "$3" <<'PY'
import json,sys
p,sha,kind=sys.argv[1:4]
names=["flutter-analyze","flutter-test","timeline-contract","account-usage"]
res={n:{"status":"pass","kind":"executed"} for n in names}
res["kotlin-usage-panel"]={"status":"fail","kind":kind}
with open(p,"w",encoding="utf-8") as f:
    f.write(f"# 验证报告\n\n- 提交：`{sha}`\n\n<!--GATES {{\"mode\":\"required\",\"results\":{json.dumps(res)}}}-->\n")
PY
}
make_report "$SKIP_CURRENT" "$SKIP_SHA" skipped
make_report "$SKIP_BASELINE" "$DEVELOP_SHA" executed
python3 - "$DSH_WT_STATE/tasks/900.json" "$SKIP_CURRENT" "$SKIP_BASELINE" "$DEVELOP_SHA" <<'PY'
import json,sys
p,cur,base,bsha=sys.argv[1:5]
with open(p,encoding="utf-8") as f: d=json.load(f)
d["verification_state"]="failed"; d["status"]="verify-failed"
d["last_failed_sha"]=d.get("last_failed_sha") or ""
d["last_report"]=cur; d["last_failed_gates"]="kotlin-usage-panel"
d.pop("last_verified_sha",None)
d["baseline_verification_state"]="complete"; d["baseline_attempt_sha"]=bsha
d["last_baseline_report"]=base; d["last_baseline_sha"]=bsha; d["last_baseline_failed_gates"]="kotlin-usage-panel"
with open(p,"w",encoding="utf-8") as f: json.dump(d,f,ensure_ascii=False,indent=2)
PY
SKIP_SHA="$(git -C "$WT1" rev-parse HEAD)"
python3 - "$DSH_WT_STATE/tasks/900.json" "$SKIP_SHA" <<'PY'
import json,sys
p,sha=sys.argv[1:3]
with open(p,encoding="utf-8") as f: d=json.load(f)
d["last_failed_sha"]=sha; d["verification_attempt_sha"]=sha
with open(p,"w",encoding="utf-8") as f: json.dump(d,f,ensure_ascii=False,indent=2)
PY
run "当前失败为 skipped 时不得开例外" fail env DSH_WT_ROLE=integrator bash "$WT" authorize-exception 900 "$SKIP_SHA" "kotlin-usage-panel" "$SKIP_BASELINE" "跳过不能开例外"
make_report "$SKIP_CURRENT" "$SKIP_SHA" executed
run "双方均为 executed 时可开例外（规则本身可用）" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize-exception 900 "$SKIP_SHA" "kotlin-usage-panel" "$SKIP_BASELINE" "基线同因失败"
run "恢复真实验证状态" 0 bash "$WT" verify
# 造失败提交；先证明“只填写理由”不足以获批。
touch .selftest-fail-gate
git add -A >/dev/null 2>&1
git -c user.email=t@t -c user.name=t commit -qm "test: introduce failing gate" >/dev/null 2>&1
run "引入失败门禁后 verify 失败" fail bash "$WT" verify
FAILED_SHA="$(git -C "$WT1" rev-parse HEAD)"
run "失败后不登记 verified SHA" 0 python3 -c 'import json,sys; assert json.load(open(sys.argv[1])).get("last_verified_sha","") != sys.argv[2]' "$DSH_WT_STATE/tasks/900.json" "$FAILED_SHA"
run "未批准例外时 deliver 被拒" fail bash "$WT" deliver
run "无基线报告的例外被拒" fail env DSH_WT_ROLE=integrator bash "$WT" authorize-exception 900 "$FAILED_SHA" "synthetic-fail" "$TMP/missing-report.md" "只是新造的失败"
run "复跑登记基线并保存证据" 0 env DSH_WT_TEST_BASELINE_FAIL_GATE=synthetic-fail bash "$WT" verify-baseline 900
BASELINE_REPORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["last_baseline_report"])' "$DSH_WT_STATE/tasks/900.json")"
run "基线门禁名不匹配的例外被拒" fail env DSH_WT_ROLE=integrator bash "$WT" authorize-exception 900 "$FAILED_SHA" "wrong-gate" "$BASELINE_REPORT" "用户确认" 
run "例外提交 SHA 不匹配时被拒" fail env DSH_WT_ROLE=integrator bash "$WT" authorize-exception 900 "0000000000000000000000000000000000000000" "synthetic-fail" "$BASELINE_REPORT" "用户确认"
run "缺少集成审批角色时不能登记例外" fail bash "$WT" authorize-exception 900 "$FAILED_SHA" "synthetic-fail" "$BASELINE_REPORT" "用户确认"
run "基线实测匹配后登记例外" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize-exception 900 "$FAILED_SHA" "synthetic-fail" "$BASELINE_REPORT" "用户明确批准该基线例外"
run "有证据且已批准例外后可交付" 0 bash "$WT" deliver
run "交付摘要包含基线证据" 0 bash -c 'grep -q "以已批准基线例外交付" "$1"/900-delivery-*.md' _ "$DSH_WT_STATE/reports"
OLD_BASELINE_REPORT="$BASELINE_REPORT"
run "复跑已转绿基线更新最新证据" 0 bash "$WT" verify-baseline 900
NEW_BASELINE_REPORT="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["last_baseline_report"])' "$DSH_WT_STATE/tasks/900.json")"
[ "$NEW_BASELINE_REPORT" != "$OLD_BASELINE_REPORT" ] && { PASS=$((PASS+1)); say "  PASS  每次 baseline 测量使用不可变报告路径"; } || { FAIL=$((FAIL+1)); say "  FAIL  baseline 报告路径被覆盖"; }
run "新基线报告转绿时旧例外失效" fail bash "$WT" deliver
git rm -q .selftest-fail-gate >/dev/null 2>&1
git -c user.email=t@t -c user.name=t commit -qm "test: restore green gate" >/dev/null 2>&1
run "移除失败后重跑 verify 恢复全绿" 0 bash "$WT" verify
run "恢复后提交无例外也能交付" 0 bash "$WT" deliver

section "脏树守卫"
echo "dirty" >> README.md
run "脏树 deliver 被拒" fail bash "$WT" deliver
run "脏树 integrator 合并被拒" fail env DSH_WT_ROLE=integrator bash "$WT" integrate 900 777
git checkout -- README.md

section "禁带文件泄漏检查"
mkdir -p docs/adr && echo "secret" > docs/adr/9999-leak.md
git add -A >/dev/null 2>&1 && git -c user.email=t@t -c user.name=t commit -qm "docs: leak"
run "提交里含 docs/adr 时 deliver 被拒" fail bash "$WT" deliver
git rm -q docs/adr/9999-leak.md && git -c user.email=t@t -c user.name=t commit -qm "revert: leak"

section "PR 合入 develop 后才 integrate；本地只快进到远端 develop"
cd "$WT1"
run "integrate 必须提供 PR 编号" fail env DSH_WT_ROLE=integrator bash "$WT" integrate 900
run "修复后的分支提交重新 verify" 0 bash "$WT" verify
run "deliver 更新到当前 SHA" 0 bash "$WT" deliver
DELIVERED_SHA="$(git -C "$WT1" rev-parse HEAD)"
cd "$CLONE"
run "非集成角色 integrate 被拒" fail bash "$WT" integrate 900 777
run "集成角色但无授权被拒" fail env DSH_WT_ROLE=integrator bash "$WT" integrate 900 777
run "登记 integrate 授权" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 900 integrate "用户批准同步已合并 PR"
cd "$WT1"
git -c user.email=t@t -c user.name=t commit --allow-empty -qm "test: advance after authorization"
cd "$CLONE"
run "授权后分支 SHA 变化不能 integrate" fail env DSH_WT_ROLE=integrator DSH_WT_TEST_MERGED_PR="777:$DELIVERED_SHA:feature/selftest-one:develop:$DELIVERED_SHA" bash "$WT" integrate 900 777
cd "$WT1"
run "新 SHA verify/deliver" 0 bash "$WT" verify
run "新 SHA deliver" 0 bash "$WT" deliver
DELIVERED_SHA="$(git -C "$WT1" rev-parse HEAD)"
cd "$CLONE"
run "旧 SHA 授权不能用于新 SHA" fail env DSH_WT_ROLE=integrator DSH_WT_TEST_MERGED_PR="777:$DELIVERED_SHA:feature/selftest-one:develop:$DELIVERED_SHA" bash "$WT" integrate 900 777
run "为新 SHA 登记 integrate 授权" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 900 integrate "用户批准最新交付 SHA"
run "PR base 不是 develop 时拒绝 integrate" fail env DSH_WT_ROLE=integrator DSH_WT_TEST_MERGED_PR="777:$DELIVERED_SHA:feature/selftest-one:main:$DELIVERED_SHA" bash "$WT" integrate 900 777

# 模拟 GitHub PR merge commit：远端 develop 前进，本地 develop 保持旧 tip，integrate 必须只做 fast-forward。
PR_BASE_SHA="$(git -C "$CLONE" rev-parse develop)"
git -C "$CLONE" merge --no-ff --no-edit feature/selftest-one >/dev/null
git -C "$CLONE" push --quiet --force "$GITHUB_BARE" develop:refs/heads/develop
PR_MERGE_SHA="$(git -C "$CLONE" rev-parse HEAD)"
git -C "$CLONE" reset --hard --quiet "$PR_BASE_SHA"
git -C "$CLONE" fetch --quiet github develop
PR_FAKE="777:$DELIVERED_SHA:feature/selftest-one:develop:$PR_MERGE_SHA"
run "集成执行者核验已合入 PR、快进 develop 并跑门禁" 0 env DSH_WT_ROLE=integrator DSH_WT_TEST_MERGED_PR="$PR_FAKE" bash "$WT" integrate 900 777
run "develop 已含 PR merge commit 与交付分支" 0 bash -c 'git -C "$1" merge-base --is-ancestor "$2" develop && git -C "$1" merge-base --is-ancestor feature/selftest-one develop' _ "$CLONE" "$PR_MERGE_SHA"
DEVELOP_SHA="$(git -C "$CLONE" rev-parse develop)"

section "cleanup 要求已合并且 head SHA 匹配的 PR"
run "无授权 cleanup 被拒" fail env DSH_WT_ROLE=integrator bash "$WT" cleanup 900 777
run "登记 cleanup 授权" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 900 cleanup "用户批准清理已合并 PR"
run "PR head SHA 不匹配时不删工作树" fail env DSH_WT_ROLE=integrator DSH_WT_TEST_MERGED_PR="777:wrong-sha:feature/selftest-one:develop:$PR_MERGE_SHA" bash "$WT" cleanup 900 777
[ -d "$WT1" ] && { PASS=$((PASS+1)); say "  PASS  PR 证据不匹配时工作树保留"; } || { FAIL=$((FAIL+1)); say "  FAIL  PR 不匹配却删除工作树"; }
# 交付后分支若再前进，旧 delivered_sha/PR 证据不覆盖新提交；必须重新验证并走新 PR。
git -C "$WT1" commit --allow-empty -qm "test: drift after delivery"
DRIFT_SHA="$(git -C "$WT1" rev-parse HEAD)"
run "漂移且上游未包含时拒绝登记 cleanup 授权" fail env DSH_WT_ROLE=integrator bash "$WT" authorize 900 cleanup "试图把授权绑到漂移 SHA"
run "交付后分支前进但上游未包含 → 拒绝清理" fail env DSH_WT_ROLE=integrator DSH_WT_TEST_MERGED_PR="777:$DRIFT_SHA:feature/selftest-one:develop:$DRIFT_SHA" bash "$WT" cleanup 900 777
[ -d "$WT1" ] && { PASS=$((PASS+1)); say "  PASS  上游未包含时工作树保留"; } || { FAIL=$((FAIL+1)); say "  FAIL  上游未包含却删除工作树"; }
git -C "$WT1" reset --hard --quiet "$DELIVERED_SHA"
run "核验合并 PR 后 cleanup 成功" 0 env DSH_WT_ROLE=integrator DSH_WT_TEST_MERGED_PR="$PR_FAKE" bash "$WT" cleanup 900 777
[ -d "$WT1" ] && { FAIL=$((FAIL+1)); say "  FAIL  工作树仍在"; } || { PASS=$((PASS+1)); say "  PASS  工作树已移除"; }
if git -C "$CLONE" show-ref --verify --quiet refs/heads/feature/selftest-one; then
  PASS=$((PASS+1)); say "  PASS  未授权 branch-delete 时保留本地分支"
else
  FAIL=$((FAIL+1)); say "  FAIL  未授权时分支被删除"
fi

section "upstream-main PR merge 更新 main 镜像但不改 develop"
cd "$WT_UPSTREAM"
printf 'upstream contribution\n' > upstream-contribution.txt
git add upstream-contribution.txt >/dev/null 2>&1
git -c user.email=t@t -c user.name=t commit -qm "feat: upstream contribution fixture"
# issue #58：上游 main 前进后 rebase，upstream-main 任务的基线必须能刷新到 github/main（不是 develop）。
cd "$CLONE"
git checkout --quiet -b advance-github-main main
mkdir -p docs/agents
printf 'upstream doc advance\n' >> docs/agents/issue-tracker.md
git add -A >/dev/null 2>&1
git -c user.email=t@t -c user.name=t commit -qm "docs: upstream main advance fixture"
ADV_MAIN="$(git rev-parse HEAD)"
git push --quiet --force "$GITHUB_BARE" advance-github-main:refs/heads/main
git checkout --quiet develop
git branch -D advance-github-main >/dev/null 2>&1
git fetch --quiet github main
cd "$WT_UPSTREAM"
git -c user.email=t@t -c user.name=t rebase --quiet github/main
run_fail_with "upstream 任务未授权 refresh-baseline 被拒（fail-closed）" "授权" bash "$WT" refresh-baseline 904
run "登记 upstream refresh-baseline 授权（绑定 rebase 后 HEAD）" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 904 refresh-baseline "用户批准 rebase 后刷新上游基线"
run_fail_with "upstream 任务拒绝 develop 上的提交作为新基线" "github/main" bash "$WT" refresh-baseline 904 "$(git -C "$CLONE" rev-parse develop)"
run "upstream 刷新基线到前进后的 github/main" 0 bash "$WT" refresh-baseline 904
run "upstream 基线已前进且旧证据清空" 0 python3 - "$DSH_WT_STATE/tasks/904.json" "$ADV_MAIN" <<'PY'
import json,sys
p,new=sys.argv[1:3]
d=json.load(open(p))
assert d.get("baseline")==new, ("baseline",d.get("baseline"),new)
assert d.get("baseline_ref")=="main", d.get("baseline_ref")
assert d.get("baseline_updated_by")=="selftest-writer", d.get("baseline_updated_by")
hist=d.get("baseline_history") or []
assert hist and hist[-1].get("baseline")!=new and hist[-1].get("new_baseline")==new, hist
for key in ("verification_state","last_verified_sha","last_report","delivered_sha","delivered_at"):
    assert key not in d, key
assert d.get("authorizations",{}).get("refresh-baseline",{}).get("used_at"), "授权未标记已使用"
PY
run_fail_with "upstream 刷新后未重新 verify 时 deliver 被拒" "验证报告" bash "$WT" deliver
run "upstream 刷新后重新 verify" 0 bash "$WT" verify
run "upstream 刷新后 deliver 按新基线通过" 0 bash "$WT" deliver
run "upstream 交付摘要记录新基线" 0 bash -c 'grep -q "$2" "$1"/904-delivery-*.md' _ "$DSH_WT_STATE/reports" "$ADV_MAIN"
UPSTREAM_DELIVERED_SHA="$(git rev-parse HEAD)"
cd "$CLONE"
UPSTREAM_DEVELOP_BEFORE="$(git rev-parse develop)"
run "授权 upstream-main integrate" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 904 integrate "用户批准核验 upstream main PR"
UPSTREAM_MAIN_BASE="$ADV_MAIN"
git checkout --quiet -b simulate-upstream-pr "$UPSTREAM_MAIN_BASE"
git merge --no-ff --no-edit upstream/upstream-probe >/dev/null
git push --quiet --force "$GITHUB_BARE" simulate-upstream-pr:refs/heads/main
UPSTREAM_PR_MERGE_SHA="$(git rev-parse HEAD)"
git checkout --quiet develop
git branch -D simulate-upstream-pr >/dev/null 2>&1
git fetch --quiet github main
UPSTREAM_PR_FAKE="904:$UPSTREAM_DELIVERED_SHA:upstream/upstream-probe:main:$UPSTREAM_PR_MERGE_SHA"
run "upstream-main PR merge 后只快进本地 main" 0 env DSH_WT_ROLE=integrator DSH_WT_TEST_MERGED_PR="$UPSTREAM_PR_FAKE" bash "$WT" integrate 904 904
[ "$(git rev-parse main)" = "$UPSTREAM_PR_MERGE_SHA" ] \
  && { PASS=$((PASS+1)); say "  PASS  本地 main mirror 已快进到 PR merge"; } \
  || { FAIL=$((FAIL+1)); say "  FAIL  本地 main mirror 未到 PR merge"; }
[ "$(git rev-parse develop)" = "$UPSTREAM_DEVELOP_BEFORE" ] \
  && { PASS=$((PASS+1)); say "  PASS  upstream-main integrate 未改动 develop"; } \
  || { FAIL=$((FAIL+1)); say "  FAIL  upstream-main integrate 改动了 develop"; }
run "授权 upstream-main cleanup" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 904 cleanup "用户批准清理已合入上游的工作树"
run "核验 upstream-main PR 后 cleanup 成功" 0 env DSH_WT_ROLE=integrator DSH_WT_TEST_MERGED_PR="$UPSTREAM_PR_FAKE" bash "$WT" cleanup 904 904
[ -d "$WT_UPSTREAM" ] && { FAIL=$((FAIL+1)); say "  FAIL  upstream 工作树仍在"; } || { PASS=$((PASS+1)); say "  PASS  upstream 工作树已清理"; }
run "origin/main 镜像未同步时拒绝新 upstream 工作树" fail bash "$WT" create 906 stale-origin --target upstream-main

section "develop 基线文件可继承，但 feature PR 不得修改规则文档"
cd "$CLONE"
git checkout --quiet -B leaky-develop develop
printf 'x\n' > AGENT-RULES.md
# AGENT-RULES.md 在本机被 gitignore，必须 -f 才能真的进入 develop 基线提交（否则用例是空跑）
run "把 AGENT-RULES.md 加入测试 develop 基线" 0 bash -c 'cd "$1" && git add -f AGENT-RULES.md && git -c user.email=t@t -c user.name=t commit -qm "chore: add rules to develop fixture"' _ "$CLONE"
git checkout --quiet develop
git reset --hard --quiet leaky-develop
DEVELOP_SHA="$(git rev-parse develop)"
git push --quiet --force "$GITHUB_BARE" develop:refs/heads/develop
git fetch --quiet github
run "develop 基线已有 Agent-Rules 时仍允许从 develop 建树" 0 bash "$WT" create 902 rules-base
WT_RULES="$DSH_WT_ROOT/issue-902-rules-base"
[ "$(git -C "$WT_RULES" rev-parse HEAD)" = "$DEVELOP_SHA" ] \
  && { PASS=$((PASS+1)); say "  PASS  rules-base 从当前 develop 起步"; } \
  || { FAIL=$((FAIL+1)); say "  FAIL  rules-base 起点不是 develop"; }
[ -f "$WT_RULES/AGENT-RULES.md" ] \
  && { PASS=$((PASS+1)); say "  PASS  develop 已有的 Agent-Rules 被继承"; } \
  || { FAIL=$((FAIL+1)); say "  FAIL  develop 的 Agent-Rules 未被继承"; }
printf 'feature-change\n' >> "$WT_RULES/AGENT-RULES.md"
git -C "$WT_RULES" add -f AGENT-RULES.md >/dev/null 2>&1
git -C "$WT_RULES" -c user.email=t@t -c user.name=t commit -qm "test: modify inherited agent rules"
run "feature PR 修改继承的 Agent-Rules 被拒" fail bash -c 'cd "$1" && bash "$2" deliver' _ "$WT_RULES" "$WT_RULES/tools/worktree.sh"

section "本地 develop 与 github/develop 不一致时拒绝建树"
git checkout --quiet -b github-develop-advanced develop
git -c user.email=t@t -c user.name=t commit --allow-empty -qm "test: advance github develop only"
git push --quiet --force "$GITHUB_BARE" github-develop-advanced:refs/heads/develop
git fetch --quiet github
git checkout --quiet develop
run "本地 develop 落后 github/develop → create 被拒" fail bash "$WT" create 903 stale-base
git push --quiet --force "$GITHUB_BARE" develop:refs/heads/develop
git fetch --quiet github
git branch -D github-develop-advanced >/dev/null 2>&1

section "refresh-baseline：授权后刷新任务基线（issue #58）"
cd "$CLONE"
run "同步测试 develop 与 github/develop" 0 bash -c \
  'git -C "$1" push --quiet --force "$2" develop:refs/heads/develop && git -C "$1" fetch --quiet "$3" develop' \
  _ "$CLONE" "$GITHUB_BARE" github
run "建 refresh 测试树（基线为当前 develop）" 0 bash "$WT" create 907 refresh-probe
WT_REF="$DSH_WT_ROOT/issue-907-refresh-probe"
BASE_OLD="$(git -C "$CLONE" rev-parse develop)"
cd "$WT_REF"
printf 'refresh probe\n' > refresh-probe.txt
git add refresh-probe.txt >/dev/null 2>&1
git -c user.email=t@t -c user.name=t commit -qm "test: refresh-baseline fixture"
run "刷新前 verify 通过" 0 bash "$WT" verify
run "刷新前 deliver 通过（旧基线）" 0 bash "$WT" deliver
run "旧基线交付记录已写入" 0 python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d.get("delivered_sha") and d.get("last_verified_sha") and d.get("verification_state")=="passed" else 1)' "$DSH_WT_STATE/tasks/907.json"
# 目标远端 develop 前进（含禁止路径 docs/agents 的上游继承改动），本地 develop 保持旧 tip；
# 随后在功能树里 rebase —— 这正是 issue #58 的现场（rebase 需用户批准，这里作为夹具模拟）。
cd "$CLONE"
git checkout --quiet -b advance-github-develop develop
printf 'upstream doc\n' >> docs/agents/issue-tracker.md
git add -A >/dev/null 2>&1
git -c user.email=t@t -c user.name=t commit -qm "docs: github develop advance fixture"
ADV_DEVELOP="$(git rev-parse HEAD)"
git push --quiet --force "$GITHUB_BARE" advance-github-develop:refs/heads/develop
git checkout --quiet develop
git branch -D advance-github-develop >/dev/null 2>&1
git fetch --quiet github develop
cd "$WT_REF"
git -c user.email=t@t -c user.name=t rebase --quiet github/develop
HEAD_AFTER_REBASE="$(git rev-parse HEAD)"
run "rebase 后 HEAD 已前进" 0 bash -c '[ "$1" != "$2" ]' _ "$HEAD_AFTER_REBASE" "$BASE_OLD"
# 复现 #58：未刷新基线时 deliver 把上游继承的 docs/agents 当成分支改动而误拦。
run_fail_with "rebase 后未刷新基线的 deliver 误报 docs/agents（#58 复现）" "docs/agents" bash "$WT" deliver
run_fail_with "未授权 refresh-baseline 被拒（fail-closed）" "授权" bash "$WT" refresh-baseline 907
run "未登记 issue 的 refresh-baseline 被拒" fail bash "$WT" refresh-baseline 999
run_fail_with "非法 issue 参数的 refresh-baseline 被拒" "正整数" bash "$WT" refresh-baseline 0
run "登记 refresh-baseline 授权（绑定 rebase 后 HEAD）" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 907 refresh-baseline "用户批准 rebase 后刷新基线"
# 脏树拒绝（工作树 / 主目录），失败尝试不得消耗授权。
printf 'dirty\n' >> refresh-probe.txt
run_fail_with "工作树脏时 refresh-baseline 被拒" "干净" bash "$WT" refresh-baseline 907
git checkout -- refresh-probe.txt
printf 'main dirty\n' > "$CLONE/main-dirty.txt"
run_fail_with "主目录脏时 refresh-baseline 被拒" "干净" bash "$WT" refresh-baseline 907
rm -f "$CLONE/main-dirty.txt"
# 授权绑定 HEAD：HEAD 变化后旧授权失效。
git -c user.email=t@t -c user.name=t commit --allow-empty -qm "test: head moves after authorization"
run_fail_with "授权绑定 HEAD：HEAD 变化后 refresh 被拒" "授权" bash "$WT" refresh-baseline 907
git reset --hard --quiet "$HEAD_AFTER_REBASE"
run "失败尝试未消耗授权" 0 python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if not d.get("authorizations",{}).get("refresh-baseline",{}).get("used_at") else 1)' "$DSH_WT_STATE/tasks/907.json"
# 新基线必须在 github/develop 历史内；旧基线必须是新基线的祖先（防任意跳变）。
run_fail_with "不在 github/develop 历史中的提交被拒" "github/develop" bash "$WT" refresh-baseline 907 "$HEAD_AFTER_REBASE"
ORPHAN_SHA="$(git -C "$WT_REF" -c user.email=t@t -c user.name=t commit-tree "$HEAD_AFTER_REBASE^{tree}" -m "selftest orphan baseline")"
run "把登记基线改成与 develop 无关联的孤立提交" 0 python3 - "$DSH_WT_STATE/tasks/907.json" "$ORPHAN_SHA" <<'PY'
import json,sys
p,orphan=sys.argv[1:3]
d=json.load(open(p)); d["baseline"]=orphan
json.dump(d,open(p,"w",encoding="utf-8"),ensure_ascii=False,indent=2)
PY
run_fail_with "旧基线不是新基线祖先时被拒（防任意跳变）" "不是新基线" bash "$WT" refresh-baseline 907
run "恢复登记基线以便成功刷新" 0 python3 - "$DSH_WT_STATE/tasks/907.json" "$BASE_OLD" <<'PY'
import json,sys
p,base=sys.argv[1:3]
d=json.load(open(p)); d["baseline"]=base
json.dump(d,open(p,"w",encoding="utf-8"),ensure_ascii=False,indent=2)
PY
run "授权后刷新基线成功" 0 bash "$WT" refresh-baseline 907
run "刷新后基线/历史正确且旧证据全部清空" 0 python3 - "$DSH_WT_STATE/tasks/907.json" "$ADV_DEVELOP" "$BASE_OLD" <<'PY'
import json,sys
p,new,old=sys.argv[1:4]
d=json.load(open(p))
assert d.get("baseline")==new, ("baseline",d.get("baseline"),new)
assert d.get("baseline_ref")=="develop", d.get("baseline_ref")
assert d.get("baseline_updated_by")=="selftest-writer", d.get("baseline_updated_by")
assert d.get("baseline_updated_at"), "缺少 baseline_updated_at"
hist=d.get("baseline_history") or []
assert hist and hist[-1].get("baseline")==old and hist[-1].get("new_baseline")==new, hist
for key in ("verification_state","verification_attempt_sha","last_verified_sha","last_report",
            "last_failed_sha","last_failed_gates","baseline_verification_state","baseline_attempt_sha",
            "last_baseline_report","last_baseline_sha","last_baseline_failed_gates",
            "delivered_sha","delivered_at"):
    assert key not in d, key
assert d.get("status")=="baseline-refreshed", d.get("status")
assert d.get("authorizations",{}).get("refresh-baseline",{}).get("used_at"), "授权未标记已使用"
PY
run "刷新基线写审计（事件列 + issue/old/new，而非仅命中 authorize 行）" 0 bash -c '
  awk -F"\t" -v old="$2" -v new="$3" '"'"'$3=="refresh-baseline" && $0 ~ ("issue=907") && index($0, old) && index($0, new) {found=1} END{exit found?0:1}'"'"' "$1"
' _ "$DSH_WT_STATE/audit.log" "$BASE_OLD" "$ADV_DEVELOP"
run_fail_with "刷新后未重新 verify 时 deliver 被拒（旧证据已作废）" "验证报告" bash "$WT" deliver
run_fail_with "同一份授权不能二次使用" "授权" bash "$WT" refresh-baseline 907
run "刷新后重新 verify" 0 bash "$WT" verify
run "刷新后 deliver 使用新基线通过（不再误报 docs）" 0 bash "$WT" deliver
run "交付摘要记录新基线" 0 bash -c 'grep -q "$2" "$1"/907-delivery-*.md' _ "$DSH_WT_STATE/reports" "$ADV_DEVELOP"
run "新基线下 PR diff 不含继承的 docs/agents" 0 bash -c 'git -C "$1" diff --quiet "$2" HEAD -- docs/agents' _ "$WT_REF" "$ADV_DEVELOP"


section "refresh-baseline：评审补强（#58 major/minor）"
cd "$CLONE"
# 远端与本地 develop 对齐到当前 develop（作为 B0），再建 908。
run "同步测试 develop 到 github/develop" 0 bash -c \
  'git -C "$1" push --quiet --force "$2" develop:refs/heads/develop && git -C "$1" fetch --quiet "$3" develop' \
  _ "$CLONE" "$GITHUB_BARE" github
B0="$(git -C "$CLONE" rev-parse develop)"
run "建评审补强测试树 908（基线 B0）" 0 bash "$WT" create 908 refresh-review
WT_RV="$DSH_WT_ROOT/issue-908-refresh-review"
cd "$WT_RV"
printf 'review probe\n' > review-probe.txt
git add review-probe.txt >/dev/null 2>&1
git -c user.email=t@t -c user.name=t commit -qm "test: refresh review fixture"
# 目标远端前进到 B1（含禁止路径 docs/agents 改动），功能树 rebase 后 HEAD 含 B1。
cd "$CLONE"
git checkout --quiet -b review-advance develop
printf 'upstream doc B1\n' >> docs/agents/issue-tracker.md
git add -A >/dev/null 2>&1
git -c user.email=t@t -c user.name=t commit -qm "docs: review advance B1"
B1="$(git rev-parse HEAD)"
git push --quiet --force "$GITHUB_BARE" review-advance:refs/heads/develop
git checkout --quiet develop
git branch -D review-advance >/dev/null 2>&1
cd "$WT_RV"
git fetch --quiet github develop
git -c user.email=t@t -c user.name=t rebase --quiet github/develop
H_RV="$(git rev-parse HEAD)"
BR_RV="$(git rev-parse --abbrev-ref HEAD)"
run "908 的 HEAD 已含 B1" 0 git merge-base --is-ancestor "$B1" "$H_RV"
# 非 integrator 不能登记 refresh-baseline 授权。
run_fail_with "非集成角色不能登记 refresh-baseline 授权" "集成" env -u DSH_WT_ROLE bash "$WT" authorize 908 refresh-baseline "非集成角色尝试"
# 先按 B1 生成有效证据（模拟刷新后的状态），再把登记基线改回 B0 以模拟 stale baseline。
run "把登记基线设为 B1 以便生成有效证据" 0 python3 - "$DSH_WT_STATE/tasks/908.json" "$B1" <<'PY2'
import json,sys
p,b=sys.argv[1:3]; d=json.load(open(p)); d["baseline"]=b
json.dump(d,open(p,"w",encoding="utf-8"),ensure_ascii=False,indent=2)
PY2
run "908 verify" 0 bash "$WT" verify
run "908 deliver" 0 bash "$WT" deliver
run "把登记基线改回 B0（保留 HEAD 与有效证据，模拟 stale baseline）" 0 python3 - "$DSH_WT_STATE/tasks/908.json" "$B0" "$B1" <<'PY3'
import json,sys
p,b0,b1=sys.argv[1:4]; d=json.load(open(p))
d["baseline"]=b0
d["authorizations"].setdefault("exception",{})["baseline_report"]="/tmp/fake-report.md"
d["baseline_verification_state"]="complete"
json.dump(d,open(p,"w",encoding="utf-8"),ensure_ascii=False,indent=2)
PY3
run "登记 refresh-baseline 授权（integrator，绑定 HEAD）" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 908 refresh-baseline "用户批准同 HEAD 刷新基线"
# 分支归属：同 SHA 其它分支 / detached HEAD 必须被拒。
git checkout --quiet -b review-other-branch
run_fail_with "同 SHA 其它分支被拒（分支归属）" "不一致" bash "$WT" refresh-baseline 908
git checkout --quiet "$BR_RV"
git checkout --quiet --detach
run_fail_with "detached HEAD 被拒（分支归属）" "分离" bash "$WT" refresh-baseline 908
git checkout --quiet "$BR_RV"
# 非写入者被拒。
run_fail_with "非写入者被拒（require_writer）" "写入者" env DSH_SESSION_ID=intruder bash "$WT" refresh-baseline 908
# 同 HEAD 刷新：证据必须被清空，deliver 因缺证据被拒（而非 SHA 不匹配）。
run "同 HEAD 刷新基线（B0 → B1）" 0 bash "$WT" refresh-baseline 908
run "同 HEAD 刷新后 HEAD 未变" 0 bash -c '[ "$1" = "$2" ]' _ "$(git rev-parse HEAD)" "$H_RV"
run "同 HEAD 刷新后证据与 exception 全部清空、status 回到未验证" 0 python3 - "$DSH_WT_STATE/tasks/908.json" "$B1" <<'PY4'
import json,sys
p,b1=sys.argv[1:3]; d=json.load(open(p))
assert d.get("baseline")==b1, d.get("baseline")
for k in ("verification_state","last_report","last_verified_sha","delivered_sha","delivered_at",
          "baseline_verification_state","last_baseline_report","last_baseline_sha"):
    assert k not in d, k
assert "exception" not in d.get("authorizations",{}), d.get("authorizations")
assert d.get("status")=="baseline-refreshed", d.get("status")
assert d.get("authorizations",{}).get("refresh-baseline",{}).get("used_at")
PY4
run_fail_with "同 HEAD 刷新后 deliver 因缺证据被拒（不是 SHA 不匹配）" "验证报告" bash "$WT" deliver
# 写失败 / 替换后不确定 / 审计失败三条失败路径（测试注入）。
run "重置基线为 B0 以复用刷新路径" 0 python3 - "$DSH_WT_STATE/tasks/908.json" "$B0" <<'PY5'
import json,sys
p,b0=sys.argv[1:3]; d=json.load(open(p)); d["baseline"]=b0
json.dump(d,open(p,"w",encoding="utf-8"),ensure_ascii=False,indent=2)
PY5
run "登记授权（写失败用例）" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 908 refresh-baseline "写失败用例"
run_fail_with "登记写入失败时明确报错" "写入失败" env DSH_WT_TEST_REFRESH_WRITE_FAIL=1 bash "$WT" refresh-baseline 908
run "写失败后登记仍是旧基线" 0 python3 - "$DSH_WT_STATE/tasks/908.json" "$B0" <<'PY6'
import json,sys
p,b0=sys.argv[1:3]; d=json.load(open(p)); sys.exit(0 if d.get("baseline")==b0 else 1)
PY6
run "登记授权（不确定提交态用例）" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 908 refresh-baseline "替换后确认失败用例"
run_fail_with "替换后确认失败时不谎报成功" "不确定" env DSH_WT_TEST_REFRESH_WRITE_FAIL=uncertain bash "$WT" refresh-baseline 908
run "不确定态下登记已更新（用于人工核对提示）" 0 python3 - "$DSH_WT_STATE/tasks/908.json" "$B1" <<'PY7'
import json,sys
p,b1=sys.argv[1:3]; d=json.load(open(p)); sys.exit(0 if d.get("baseline")==b1 else 1)
PY7
run "重置基线为 B0（审计失败用例）" 0 python3 - "$DSH_WT_STATE/tasks/908.json" "$B0" <<'PY8'
import json,sys
p,b0=sys.argv[1:3]; d=json.load(open(p)); d["baseline"]=b0
json.dump(d,open(p,"w",encoding="utf-8"),ensure_ascii=False,indent=2)
PY8
run "登记授权（审计失败用例）" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 908 refresh-baseline "审计失败用例"
run_fail_with "审计写入失败时非零退出并明确提示" "审计" env DSH_WT_TEST_REFRESH_AUDIT_FAIL=1 bash "$WT" refresh-baseline 908
# 第三祖先：远端 tip 前进但 HEAD 尚未包含 → 必须拒绝。
cd "$CLONE"
git checkout --quiet -b review-advance2 "$B1"
git -c user.email=t@t -c user.name=t commit --allow-empty -qm "test: review advance B2"
B2="$(git rev-parse HEAD)"
git push --quiet --force "$GITHUB_BARE" review-advance2:refs/heads/develop
git checkout --quiet develop
git branch -D review-advance2 >/dev/null 2>&1
cd "$WT_RV"
run "同步 github/develop 到 B2" 0 git fetch --quiet github develop
run "登记授权（第三祖先用例）" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 908 refresh-baseline "第三祖先用例"
run_fail_with "新基线不是 HEAD 祖先时被拒（第三祖先）" "不是当前 HEAD 的祖先" bash "$WT" refresh-baseline 908 "$B2"

section "结果"
say "通过 $PASS / 失败 $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
