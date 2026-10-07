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
slot_is_locked() { # exclusive try fails while any shared/exclusive holder owns the lock
  local f="$1"
  exec 5>"$f"
  if flock -n 5; then flock -u 5; exec 5>&-; return 1; fi
  exec 5>&-
  return 0
}

# ── 夹具：临时克隆 + 本地 main/github-main 引用 ──
CLONE="$TMP/repo"
git clone --no-hardlinks --quiet "$REPO_SRC" "$CLONE" || { say "克隆失败"; exit 1; }
cd "$CLONE"
git fetch --quiet origin 'refs/heads/*:refs/remotes/origin/*' 2>/dev/null || true
MAIN_SHA="$(git rev-parse origin/main 2>/dev/null || git rev-parse origin/develop)"
git branch -f main "$MAIN_SHA" >/dev/null
git update-ref refs/remotes/github/main "$MAIN_SHA"   # 模拟 github/main（create 会比对）
git checkout --quiet develop

# 假 github 远端：本地裸仓库，让 create 的 `git fetch github` 离线且可控
GITHUB_BARE="$TMP/github.git"
git init --bare --quiet "$GITHUB_BARE"
if git remote | grep -qx github; then git remote set-url github "$GITHUB_BARE"
else git remote add github "$GITHUB_BARE"; fi

# 被测脚本可能是尚未提交的新文件：拷进克隆的 tools/ 并提交到 **develop**（不是 main）
mkdir -p "$CLONE/tools"
cp -p "$REPO_SRC/tools/worktree.sh" "$REPO_SRC/tools/worktree-selftest.sh" "$CLONE/tools/"
git add tools/worktree.sh tools/worktree-selftest.sh >/dev/null 2>&1
git -c user.email=selftest@local -c user.name=selftest commit -qm "test: selftest fixture" >/dev/null 2>&1

# main 必须来自真正的 origin/main（不含 AGENTS/CONTEXT/决策文档），
# 再把工具提交上去，模拟"工具已在 develop/main 版本化"。
if git rev-parse --verify --quiet origin/main >/dev/null; then
  git checkout --quiet -B main origin/main
  cp -p "$REPO_SRC/tools/worktree.sh" "$REPO_SRC/tools/worktree-selftest.sh" "$CLONE/tools/"
  git add tools/worktree.sh tools/worktree-selftest.sh >/dev/null 2>&1
  git -c user.email=selftest@local -c user.name=selftest commit -qm "chore(tools): selftest fixture on main" >/dev/null 2>&1
else
  git branch -f main develop >/dev/null
fi
git checkout --quiet develop
git push --quiet "$GITHUB_BARE" main:refs/heads/main
git fetch --quiet github
MAIN_SHA="$(git rev-parse main)"

# 自测用状态目录/工作树目录：全部隔离在 TMP，不碰真实状态
export DSH_WT_MAIN="$CLONE"
export DSH_WT_ROOT="$TMP/worktrees"
export DSH_WT_STATE="$TMP/state"
export DSH_WT_ALLOW_SYNTHETIC=1
export DSH_WT_SYNTHETIC_GATES=1
export DSH_SESSION_ID="selftest-writer"
WT="$CLONE/tools/worktree.sh"

say "worktree.sh 自测（临时克隆：$CLONE）"
say "基线 main = $(git rev-parse --short main)"

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
# 无 --base 时不得出现依赖字段：普通任务不能被误标为"依赖分支例外"。
run "无 --base 时不登记依赖分支" 0 python3 -c '
import json,sys
d=json.load(open(sys.argv[1])); assert "depends_on" not in d, d' "$DSH_WT_STATE/tasks/900.json"

section "规则入口不得落入工作树"
for f in AGENTS.md AGENT-RULES.md CONTEXT.md docs/adr docs/agents docs/design; do
  [ -e "$WT1/$f" ] && { FAIL=$((FAIL+1)); say "  FAIL  $f 出现在新工作树里"; } \
                   || { PASS=$((PASS+1)); say "  PASS  $f 未落入工作树"; }
done

section "依赖分支例外（--base）"
# 造一个「未上游化的依赖分支」：从 main 开分支并加一个提交，模拟 issue #14 的情形。
DEP_BRANCH="feature/dep-probe"
git -C "$CLONE" branch -f "$DEP_BRANCH" main >/dev/null 2>&1
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
run "--base 已在 main 上的分支被拒" fail bash "$WT" create 890 ancestor --base feature/selftest-one
run "--base 建树成功" 0 bash "$WT" create 891 baseprobe --base "$DEP_BRANCH"
WT_BASE="$DSH_WT_ROOT/issue-891-baseprobe"
[ "$(git -C "$WT_BASE" rev-parse HEAD)" = "$DEP_SHA" ] \
  && { PASS=$((PASS+1)); say "  PASS  工作树起点等于依赖分支 SHA"; } \
  || { FAIL=$((FAIL+1)); say "  FAIL  起点不是依赖分支 SHA"; }
[ -f "$WT_BASE/dep-only.txt" ] \
  && { PASS=$((PASS+1)); say "  PASS  依赖分支的文件确实存在于新树（用例非空跑）"; } \
  || { FAIL=$((FAIL+1)); say "  FAIL  依赖分支内容缺失"; }
# 关键语义：baseline 仍指上游 main，依赖分支另记。
TASK_BASE="$DSH_WT_STATE/tasks/891.json"
python3 - "$TASK_BASE" "$(git -C "$CLONE" rev-parse main)" "$DEP_BRANCH" "$DEP_SHA" <<'PY' \
  && { PASS=$((PASS+1)); say "  PASS  baseline 仍指上游 main，并登记依赖分支与其 SHA"; } \
  || { FAIL=$((FAIL+1)); say "  FAIL  baseline/依赖分支登记不正确"; }
import json,sys
p,main_sha,dep,dep_sha=sys.argv[1:5]
d=json.load(open(p))
assert d.get("baseline")==main_sha, ("baseline 不是 main", d.get("baseline"), main_sha)
assert d.get("baseline_ref")=="main", d.get("baseline_ref")
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
run "报告被截断后 integrate 必须被拒" fail env DSH_WT_ROLE=integrator bash "$WT" integrate 900
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
git -C "$WT1" reset --hard -q "$MAIN_SHA"
run "恢复基线后相对基线无提交" fail bash "$WT" deliver

section "verify 脏树、原子报告与 deliver"
run "无提交时 deliver 被拒" fail bash "$WT" deliver
echo "selftest" > selftest-file.txt
git add -A >/dev/null 2>&1
git -c user.email=t@t -c user.name=t commit -qm "test: selftest commit" >/dev/null 2>&1
CURRENT_SHA="$(git -C "$WT1" rev-parse --short=12 HEAD)"
DELIVERY_SHORT="$(git -C "$WT1" rev-parse --short HEAD)"
run "确认已产生提交" 0 bash -c '[ "$(git -C "$1" rev-parse HEAD)" != "$2" ]' _ "$WT1" "$MAIN_SHA"
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

section "真实多进程槽位上限与 shared/exclusive 互斥"
LOCK="$DSH_WT_STATE/locks"
mkdir -p "$LOCK"
run "无外部占用时合成门禁无死锁" 0 bash "$WT" verify
exec 9>"$LOCK/gradle-build.lock"; flock -x -n 9
run "外部 exclusive 阻止 flutter shared 门禁" fail env DSH_WT_SLOT_TIMEOUT=2 bash "$WT" verify
exec 9>&-
exec 8>"$LOCK/gradle-build.lock"; flock -s -n 8
run "外部 shared 阻止 gradle exclusive 门禁" fail env DSH_WT_SLOT_TIMEOUT=2 bash "$WT" verify
exec 8>&-
TIMEOUT_MARKER="$TMP/timeout-injection-ran"
run "并发锁 timeout 环境值拒绝表达式注入" fail env DSH_WT_SLOT_TIMEOUT="\$(touch $TIMEOUT_MARKER)" bash "$WT" verify
[ ! -e "$TIMEOUT_MARKER" ] && { PASS=$((PASS+1)); say "  PASS  非数字 timeout 未执行命令替换"; } || { FAIL=$((FAIL+1)); say "  FAIL  timeout 值执行了命令"; }

# 三个不同 issue 的 verify 进程同时竞争 slots:2；第三个不得进入 synthetic-flutter，
# 直到前两个释放至少一个槽位。marker 是门禁命令真实开始时才创建的。
cd "$CLONE"
run "创建并发测试树 A" 0 bash "$WT" create 910 slot-a
run "创建并发测试树 B" 0 bash "$WT" create 911 slot-b
run "创建并发测试树 C" 0 bash "$WT" create 912 slot-c
A="$DSH_WT_ROOT/issue-910-slot-a"; B="$DSH_WT_ROOT/issue-911-slot-b"; C="$DSH_WT_ROOT/issue-912-slot-c"
(cd "$A" && env DSH_WT_TEST_GATE_SLEEP=1 DSH_WT_TEST_GATE_MARKER="$TMP/A.started" bash "$WT" verify >"$TMP/A.log" 2>&1) & PA=$!
(cd "$B" && env DSH_WT_TEST_GATE_SLEEP=1 DSH_WT_TEST_GATE_MARKER="$TMP/B.started" bash "$WT" verify >"$TMP/B.log" 2>&1) & PB=$!
BOTH=0
for _ in $(seq 1 120); do
  if slot_is_locked "$LOCK/flutter-test.1.lock" && slot_is_locked "$LOCK/flutter-test.2.lock"; then BOTH=1; break; fi
  sleep 0.05
done
[ "$BOTH" -eq 1 ] && { PASS=$((PASS+1)); say "  PASS  两个 verify 进程同时占用两个 Flutter slots"; } || { FAIL=$((FAIL+1)); say "  FAIL  未观察到两个并发 slot 持有者"; }
(cd "$C" && env DSH_WT_SLOT_TIMEOUT=10 DSH_WT_TEST_GATE_MARKER="$TMP/C.started" bash "$WT" verify >"$TMP/C.log" 2>&1) & PC=$!
sleep 0.2
[ ! -e "$TMP/C.started" ] && { PASS=$((PASS+1)); say "  PASS  第三个 Flutter 门禁在两个 slots 占满时未启动"; } || { FAIL=$((FAIL+1)); say "  FAIL  第三个 Flutter 门禁越过 slots:2 上限"; }
wait "$PA"; RCA=$?; wait "$PB"; RCB=$?; wait "$PC"; RCC=$?
[ "$RCA" -eq 0 ] && [ "$RCB" -eq 0 ] && [ "$RCC" -eq 0 ] \
  && { PASS=$((PASS+1)); say "  PASS  前两个完成后第三个取得释放的 slot 并通过"; } \
  || { FAIL=$((FAIL+1)); say "  FAIL  并发 verify exit=$RCA/$RCB/$RCC"; cat "$TMP/A.log" "$TMP/B.log" "$TMP/C.log"; }
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
make_report "$SKIP_BASELINE" "$(git -C "$WT1" rev-parse "$MAIN_SHA" 2>/dev/null || git -C "$CLONE" rev-parse main)" executed
python3 - "$DSH_WT_STATE/tasks/900.json" "$SKIP_CURRENT" "$SKIP_BASELINE" "$(git -C "$CLONE" rev-parse main)" <<'PY'
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
run "脏树 integrator 合并被拒" fail env DSH_WT_ROLE=integrator bash "$WT" integrate 900
git checkout -- README.md

section "禁带文件泄漏检查"
mkdir -p docs/adr && echo "secret" > docs/adr/9999-leak.md
git add -A >/dev/null 2>&1 && git -c user.email=t@t -c user.name=t commit -qm "docs: leak"
run "提交里含 docs/adr 时 deliver 被拒" fail bash "$WT" deliver
git rm -rq docs/adr && git -c user.email=t@t -c user.name=t commit -qm "revert: leak"

section "集成只接受最新已交付 SHA 与匹配授权"
cd "$WT1"
run "基于旧 delivered_sha 的分支更新不能直接 integrate" fail env DSH_WT_ROLE=integrator bash "$WT" integrate 900
run "修复后的分支提交重新 verify" 0 bash "$WT" verify
run "deliver 更新到当前 SHA" 0 bash "$WT" deliver
DELIVERED_SHA="$(git -C "$WT1" rev-parse HEAD)"
cd "$CLONE"
run "非集成角色 integrate 被拒" fail bash "$WT" integrate 900
run "集成角色但无授权被拒" fail env DSH_WT_ROLE=integrator bash "$WT" integrate 900
run "登记 integrate 授权" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 900 integrate "用户批准集成此 SHA"
cd "$WT1"
git -c user.email=t@t -c user.name=t commit --allow-empty -qm "test: advance after authorization"
cd "$CLONE"
run "授权后分支 SHA 变化不能 integrate" fail env DSH_WT_ROLE=integrator bash "$WT" integrate 900
cd "$WT1"
run "新 SHA verify/deliver" 0 bash "$WT" verify
run "新 SHA deliver" 0 bash "$WT" deliver
DELIVERED_SHA="$(git -C "$WT1" rev-parse HEAD)"
cd "$CLONE"
run "旧 SHA 授权不能用于新 SHA" fail env DSH_WT_ROLE=integrator bash "$WT" integrate 900
run "为新 SHA 登记 integrate 授权" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 900 integrate "用户批准最新交付 SHA"
run "集成执行者合并精确交付分支并跑门禁" 0 env DSH_WT_ROLE=integrator bash "$WT" integrate 900
run "develop 已含已交付分支提交" 0 bash -c 'git -C "$1" merge-base --is-ancestor feature/selftest-one develop' _ "$CLONE"

section "cleanup 要求已合并且 head SHA 匹配的 PR"
run "无授权 cleanup 被拒" fail env DSH_WT_ROLE=integrator bash "$WT" cleanup 900 777
run "登记 cleanup 授权" 0 env DSH_WT_ROLE=integrator bash "$WT" authorize 900 cleanup "用户批准清理已合并 PR"
run "PR head SHA 不匹配时不删工作树" fail env DSH_WT_ROLE=integrator DSH_WT_TEST_MERGED_PR="777:wrong-sha:feature/selftest-one" bash "$WT" cleanup 900 777
[ -d "$WT1" ] && { PASS=$((PASS+1)); say "  PASS  PR 证据不匹配时工作树保留"; } || { FAIL=$((FAIL+1)); say "  FAIL  PR 不匹配却删除工作树"; }
# 交付之后分支又前进（复核补正常在集成之后落地）：此时证据换成「上游 PR 记录 + 上游包含性」。
# 安全方向：上游 main 还没包含该分支时，即使 PR 记录匹配也必须拒绝。
git -C "$WT1" commit --allow-empty -qm "test: drift after delivery"
DRIFT_SHA="$(git -C "$WT1" rev-parse HEAD)"
run "漂移且上游未包含时拒绝登记 cleanup 授权" fail env DSH_WT_ROLE=integrator bash "$WT" authorize 900 cleanup "试图把授权绑到漂移 SHA"
run "交付后分支前进但上游未包含 → 拒绝清理" fail env DSH_WT_ROLE=integrator DSH_WT_TEST_MERGED_PR="777:$DRIFT_SHA:feature/selftest-one" bash "$WT" cleanup 900 777
[ -d "$WT1" ] && { PASS=$((PASS+1)); say "  PASS  上游未包含时工作树保留"; } || { FAIL=$((FAIL+1)); say "  FAIL  上游未包含却删除工作树"; }
git -C "$WT1" reset --hard --quiet "$DELIVERED_SHA"
run "核验合并 PR 后 cleanup 成功" 0 env DSH_WT_ROLE=integrator DSH_WT_TEST_MERGED_PR="777:$DELIVERED_SHA:feature/selftest-one" bash "$WT" cleanup 900 777
[ -d "$WT1" ] && { FAIL=$((FAIL+1)); say "  FAIL  工作树仍在"; } || { PASS=$((PASS+1)); say "  PASS  工作树已移除"; }
if git -C "$CLONE" show-ref --verify --quiet refs/heads/feature/selftest-one; then
  PASS=$((PASS+1)); say "  PASS  未授权 branch-delete 时保留本地分支"
else
  FAIL=$((FAIL+1)); say "  FAIL  未授权时分支被删除"
fi

section "基线含禁带文件时拒绝建树"
cd "$CLONE"
git checkout --quiet -B leaky-main main
printf 'x\n' > AGENT-RULES.md
# AGENT-RULES.md 在本机被 gitignore，必须 -f 才能真的进入基线提交（否则用例是空跑）
run "把 AGENT-RULES.md 强加进基线提交" 0 bash -c 'cd "$1" && git add -f AGENT-RULES.md && git -c user.email=t@t -c user.name=t commit -qm "chore: leak base"' _ "$CLONE"
run "确认基线确实带上了该文件" 0 bash -c 'cd "$1" && git ls-tree -r --name-only leaky-main -- AGENT-RULES.md | grep -q AGENT-RULES.md' _ "$CLONE"
git branch -f main leaky-main >/dev/null
git push --quiet --force "$GITHUB_BARE" leaky-main:refs/heads/main
git fetch --quiet github
git checkout --quiet develop
run "基线含 AGENT-RULES.md → create 被拒" fail bash "$WT" create 902 leaky-base
run "被拒后没有留下工作树" fail bash -c '[ -d "$1" ]' _ "$DSH_WT_ROOT/issue-902-leaky-base"
git branch -f main "$MAIN_SHA" >/dev/null
git branch -D leaky-main >/dev/null 2>&1
git push --quiet --force "$GITHUB_BARE" main:refs/heads/main
git fetch --quiet github

section "main 与 github/main 不一致时拒绝建树"
# github/main 推进到 develop，制造 main 落后
git push --quiet --force "$GITHUB_BARE" develop:refs/heads/main
git fetch --quiet github
run "main 落后 github/main → create 被拒" fail bash "$WT" create 903 stale-base
git push --quiet --force "$GITHUB_BARE" main:refs/heads/main
git fetch --quiet github

section "结果"
say "通过 $PASS / 失败 $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
