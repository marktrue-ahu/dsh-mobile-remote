#!/usr/bin/env bash
# 工作树生命周期管理（AGENT-RULES「工作树生命周期」）。
#
# 一个 issue = 一个分支 = 一棵工作树 = 一个写入者；不同 issue 并行，集成与发布串行。
# 本脚本是**协作式防护**：检查角色、工作树归属、脏树与并发限额，用于防误操作。
# 所有 agent 以同一系统用户运行，脚本无法阻止绕过——绕过即违规（见 AGENT-RULES）。
#
# 用法（在主目录 /home/mark/projects/dsh-mobile-remote 调用；init/verify 在任何树里调用）：
#   tools/worktree.sh create <issue> <短名> [--kind feature|fix] [--writer <身份>]
#   tools/worktree.sh init                     # 当前树：装依赖、补构建环境
#   tools/worktree.sh verify                   # 当前树：仅干净树验证，报告原子落盘
#   tools/worktree.sh verify-baseline <issue>  # 临时检出登记基线，同环境复跑门禁留证
#   tools/worktree.sh deliver                  # 当前树：必须有对应 SHA 的验证/批准例外证据
#   tools/worktree.sh integrate <issue>        # 只合并已交付且 SHA 未变的任务
#   tools/worktree.sh cleanup <issue> <PR>     # 核验 PR 已合并且 head SHA 一致后清理
#   tools/worktree.sh authorize <issue> <动作> <批准理由> # 记录人工批准意向并绑定当前 SHA
#   tools/worktree.sh authorize-exception <issue> <sha> <门禁> <基线报告> <批准理由>
#   tools/worktree.sh status [issue|--all]     # 查看任务登记与授权
#
# 环境变量（一般不设）：
#   DSH_WT_MAIN          主目录（默认：git 报告的 main worktree）
#   DSH_WT_ROOT          新工作树存放目录（默认 <主目录父级>/dsh-mobile-remote-worktrees）
#   DSH_WT_STATE         运行状态目录（默认 ~/.local/state/dsh-mobile-remote-workflow）
#   DSH_WT_ALLOW_SYNTHETIC=1  允许合成门禁（仅供 tools/worktree-selftest.sh 使用）
set -uo pipefail

REAL_HOME="${HOME}"
SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

# ── 基础工具 ──
die() { printf '✗ %s\n' "$*" >&2; exit 1; }
info() { printf '  %s\n' "$*"; }
ok() { printf '✓ %s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }

need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令：$1"; }
for c in git python3 flock; do need "$c"; done

gitq() { git --no-optional-locks "$@"; }

# 主目录：git worktree list 的第一项恒为主工作树
detect_main() {
  local first
  first="$(gitq worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p')"
  [ -n "$first" ] || die "不在 Git 仓库中（cd 到主目录或任一工作树后重试）"
  printf '%s' "$first"
}
MAIN_DIR="${DSH_WT_MAIN:-$(detect_main)}"
WT_ROOT="${DSH_WT_ROOT:-$(dirname "$MAIN_DIR")/dsh-mobile-remote-worktrees}"
STATE_DIR="${DSH_WT_STATE:-$REAL_HOME/.local/state/dsh-mobile-remote-workflow}"
TASKS_DIR="$STATE_DIR/tasks"
LOCK_DIR="$STATE_DIR/locks"
REPORTS_DIR="$STATE_DIR/reports"
AUDIT_LOG="$STATE_DIR/audit.log"

# 当前工作树（按 cwd 判定）；不在任何工作树时为空
current_worktree() { gitq rev-parse --show-toplevel 2>/dev/null || true; }
current_branch() { gitq rev-parse --abbrev-ref HEAD 2>/dev/null || true; }

# 写入者身份：优先 DSH 会话标识，其次系统用户
WHOAMI_ID="${DSH_SESSION_ID:-$(id -un)}"
ROLE="${DSH_WT_ROLE:-implementer}" # 默认实施者；集成执行者用 DSH_WT_ROLE=integrator

# 禁止进入功能分支的文件（上游没有这些文件体系，携带会造成 PR 噪声）
FORBIDDEN_PATHS=(AGENTS.md AGENT-RULES.md CONTEXT.md docs/adr docs/agents docs/design)

init_state_dirs() { mkdir -p "$TASKS_DIR" "$LOCK_DIR" "$REPORTS_DIR"; }

audit() { # audit <事件> <详情...>
  init_state_dirs
  printf '%s\t%s\t%s\t%s\n' "$(date '+%F %T')" "$WHOAMI_ID" "$1" "${2:-}" >>"$AUDIT_LOG"
}

task_file() { printf '%s/%s.json' "$TASKS_DIR" "$1"; }

json_get() { # json_get <文件> <点路径> [默认值]
  python3 - "$1" "$2" "${3-}" <<'PY'
import json,sys
path, default = sys.argv[2], (sys.argv[3] if len(sys.argv)>3 else "")
try: doc=json.load(open(sys.argv[1]))
except Exception: print(default); raise SystemExit
cur=doc
for key in path.split('.'):
    if isinstance(cur,dict) and key in cur: cur=cur[key]
    else: print(default); raise SystemExit
print("" if cur is None else cur)
PY
}

atomic_json_write() { # atomic_json_write <文件>；通过 stdin 接收 JSON，原子替换
  python3 -c 'import json,os,sys,tempfile
path=sys.argv[1]; obj=json.loads(sys.stdin.read()); directory=os.path.dirname(path) or "."
fd,tmp=tempfile.mkstemp(prefix="."+os.path.basename(path)+".",suffix=".tmp",dir=directory)
try:
 f=os.fdopen(fd,"w",encoding="utf-8")
 with f: json.dump(obj,f,ensure_ascii=False,indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno())
 os.replace(tmp,path); dfd=os.open(directory,os.O_DIRECTORY)
 try: os.fsync(dfd)
 finally: os.close(dfd)
except BaseException:
 try: os.unlink(tmp)
 except OSError: pass
 raise' "$1"
}

json_set() { # json_set <文件> <点路径> <值>；原子更新，调用者应持任务锁
  python3 -c 'import json,sys
f,path,value=sys.argv[1:4]
with open(f,encoding="utf-8") as src: doc=json.load(src)
cur=doc; keys=path.split(".")
for k in keys[:-1]: cur=cur.setdefault(k,{})
cur[keys[-1]]=value
json.dump(doc,sys.stdout,ensure_ascii=False)' "$1" "$2" "$3" | atomic_json_write "$1"
}

json_remove_keys() { # json_remove_keys <文件> <key...>；原子更新
  local f="$1"; shift
  python3 -c 'import json,sys
with open(sys.argv[1],encoding="utf-8") as src: doc=json.load(src)
for key in sys.argv[2:]: doc.pop(key,None)
json.dump(doc,sys.stdout,ensure_ascii=False)' "$f" "$@" | atomic_json_write "$f"
}

json_task_transition() { # 原子更新验证事务：<file> <verify-begin|verify-pass|verify-fail|baseline-begin|baseline-finish> <args...>
  local f="$1" op="$2"; shift 2
  python3 - "$f" "$op" "$@" <<'PY' | atomic_json_write "$f"
import json,sys
f,op=sys.argv[1:3]; args=sys.argv[3:]
with open(f,encoding="utf-8") as src: d=json.load(src)
if op=="verify-begin":
    sha,run_id=args; d["verification_state"]="running"; d["verification_attempt_sha"]=sha; d["verification_run_id"]=run_id
    d.pop("last_verified_sha",None); d.pop("last_report",None); d["status"]="verifying"
elif op=="verify-pass":
    sha,report,run_id=args; d["verification_state"]="passed"; d["verification_attempt_sha"]=sha; d["verification_run_id"]=run_id
    d["last_verified_sha"]=sha; d["last_report"]=report; d["status"]="verified"
    d.pop("last_failed_sha",None); d.pop("last_failed_gates",None)
elif op=="verify-fail":
    sha,report,gates,run_id=args; d["verification_state"]="failed"; d["verification_attempt_sha"]=sha; d["verification_run_id"]=run_id
    d["last_report"]=report; d["last_failed_sha"]=sha; d["last_failed_gates"]=gates; d["status"]="verify-failed"
    d.pop("last_verified_sha",None)
elif op=="baseline-begin":
    sha,run_id=args; d["baseline_verification_state"]="running"; d["baseline_attempt_sha"]=sha; d["baseline_run_id"]=run_id
    d.pop("last_baseline_report",None); d.pop("last_baseline_sha",None); d.pop("last_baseline_failed_gates",None)
elif op=="baseline-finish":
    sha,report,gates,run_id=args; d["baseline_verification_state"]="complete"; d["baseline_attempt_sha"]=sha; d["baseline_run_id"]=run_id
    d["last_baseline_report"]=report; d["last_baseline_sha"]=sha; d["last_baseline_failed_gates"]=gates
else: raise ValueError("unknown task transition: "+op)
json.dump(d,sys.stdout,ensure_ascii=False)
PY
}

report_has_commit() { # <报告> <sha>
  python3 - "$1" "$2" <<'PY'
import sys
try: text=open(sys.argv[1],encoding="utf-8").read()
except OSError: raise SystemExit(1)
raise SystemExit(0 if f"- 提交：`{sys.argv[2]}`" in text.splitlines() else 1)
PY
}
# 门禁集合：required 为真实门禁，synthetic 仅供 tools/worktree-selftest.sh 的临时克隆。
REQUIRED_GATES=(flutter-analyze flutter-test timeline-contract account-usage kotlin-usage-panel)
SYNTHETIC_GATES=(synthetic-pass synthetic-plugin-path synthetic-flutter synthetic-heavy-a synthetic-heavy-b)
GATES_MARK_PREFIX='<!--GATES '

# 报告里内嵌唯一权威的门禁结果：<!--GATES {json}-->
# 只认这一行；文本摘要（通过/失败）不参与判定，避免"报告被截断仍算绿"。
report_gate_query() { # <报告> <模式 required|synthetic> <查询>
  python3 - "$@" <<'PY'
import json,sys
path,mode,query=sys.argv[1:4]
expected={"required":["flutter-analyze","flutter-test","timeline-contract","account-usage","kotlin-usage-panel"],
          "synthetic":["synthetic-pass","synthetic-plugin-path","synthetic-flutter","synthetic-heavy-a","synthetic-heavy-b"]}
if mode not in expected: raise SystemExit(8)
try: lines=open(path,encoding="utf-8").read().splitlines()
except OSError: raise SystemExit(2)
tags=[l for l in lines if l.startswith("<!--GATES ") and l.endswith("-->")]
if len(tags)!=1: raise SystemExit(3)
try: doc=json.loads(tags[0][len("<!--GATES "):-len("-->")])
except Exception: raise SystemExit(4)
if doc.get("mode")!=mode: raise SystemExit(5)
res=doc.get("results")
if not isinstance(res,dict): raise SystemExit(6)
want=expected[mode]
for g in want:
    if g not in res or not isinstance(res[g],dict): raise SystemExit(7)
    if res[g].get("status") not in ("pass","fail"): raise SystemExit(7)
    if not res[g].get("kind"): raise SystemExit(7)
allowed=set(expected["required"]) | set(expected["synthetic"]) | {"synthetic-fail"}
if set(res)-allowed: raise SystemExit(7)
# 失败/类别查询要把"可选但确实运行过"的门禁（如 synthetic-fail）计入，
# 否则失败集合会被算成空、例外登记随之错配。all-pass 仍只要求必需集合。
report_set=list(want)
extra=[g for g in sorted(set(res)-set(want)) if res[g]["status"]!="pass"]
if query in ("failing","kinding"): report_set=report_set+extra
if query=="mode": print(doc["mode"])
elif query=="failing": print(",".join(g for g in report_set if res[g]["status"]!="pass"))
elif query=="kinds": print(",".join("%s:%s"%(g,res[g]["kind"]) for g in report_set))
elif query=="kinding": print(",".join("%s:%s"%(g,res[g]["kind"]) for g in report_set if res[g]["status"]!="pass"))
# 全绿要求必需门禁都 status=pass 且 kind=executed：伪造 skipped 冒充 pass 必须被拒。
elif query=="all-pass":
    ok=all(res[g]["status"]=="pass" and res[g]["kind"]=="executed" for g in want)
    raise SystemExit(0 if ok else 1)
elif query.startswith("status:"): print(res.get(query.split(":",1)[1],{}).get("status",""))
elif query.startswith("kind:"): print(res.get(query.split(":",1)[1],{}).get("kind",""))
else: raise SystemExit(8)
PY
}

report_failed_gates() { # <报告> [模式]；结构不合法时返回非 0
  report_gate_query "$1" "${2:-required}" failing
}

# 校验报告结构完整（唯一 GATES 行、必需门禁齐全、无越权门禁）。
report_validate() { # <报告> <模式>
  report_gate_query "$1" "${2:-required}" mode >/dev/null
}
# 报告模式是否可用于当前上下文：真实仓库只认 required；合成报告仅在自己的临时克隆里有效。
report_mode_acceptable() { # <报告>
  local mode; mode="$(report_gate_query "$1" required mode 2>/dev/null)" && return 0
  mode="$(report_gate_query "$1" synthetic mode 2>/dev/null)" || return 1
  [ "$mode" = "synthetic" ] && synthetic_gate_allowed
}
report_evidence_mode() { # 输出当前上下文下该报告应使用的模式
  report_gate_query "$1" required mode 2>/dev/null && return 0
  report_gate_query "$1" synthetic mode 2>/dev/null && return 0
  return 1
}

json_dump() { python3 -c 'import json,sys;print(json.dumps(json.load(open(sys.argv[1])),ensure_ascii=False,indent=2))' "$1"; }

json_create_task() { # <file> <issue> <short> <branch> <path> <kind> <baseline> <writer>
  python3 - "$@" <<'PY'
import datetime,json,os,sys,tempfile
path,issue,short,branch,wt,kind,baseline,writer=sys.argv[1:9]
doc={"issue":issue,"short":short,"branch":branch,"path":wt,"kind":kind,
     "baseline":baseline,"baseline_ref":"main","writer":writer,"role":"implementer",
     "created_at":datetime.datetime.now().strftime("%F %T"),"status":"creating","authorizations":{}}
directory=os.path.dirname(path)
fd,tmp=tempfile.mkstemp(prefix="."+os.path.basename(path)+".",suffix=".tmp",dir=directory)
try:
    with os.fdopen(fd,"w",encoding="utf-8") as f:
        json.dump(doc,f,ensure_ascii=False,indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno())
    # O_EXCL reservation in create's issue lock prevents overwrite of an existing record.
    if os.path.exists(path): raise FileExistsError(path)
    os.link(tmp,path); os.unlink(tmp)
except BaseException:
    try: os.unlink(tmp)
    except OSError: pass
    raise
PY
}

# 每个 issue 一个跨进程锁：串行化创建、验证、状态更新和清理，防止登记/报告互相覆盖。
task_lock_acquire() { # task_lock_acquire <数字 issue>
  local issue="$1"
  mkdir -p "$LOCK_DIR"
  exec 7>"$LOCK_DIR/task-$issue.lock" || die "无法打开任务锁"
  flock -x -w 120 7 || die "等待 issue #$issue 任务锁超时；另一个生命周期操作仍在运行"
}
task_lock_release() { flock -u 7 2>/dev/null || true; eval 'exec 7>&-' 2>/dev/null || true; }

branch_head() { gitq -C "$MAIN_DIR" rev-parse --verify "refs/heads/$1^{commit}" 2>/dev/null || true; }
require_registered_branch() { # <issue> <worktree> <branch>
  local expected; expected="$(json_get "$(task_file "$1")" branch)"
  [ "$3" = "$expected" ] || die "当前分支 $3 与 issue #$1 登记分支 $expected 不一致"
  [ "$(gitq -C "$2" rev-parse --show-toplevel 2>/dev/null)" = "$(json_get "$(task_file "$1")" path)" ] || \
    die "当前工作树路径与 issue #$1 登记路径不一致"
}

# 合成门禁只允许在自测用的临时克隆里运行。真实仓库即使设置了环境变量也必须走真实门禁，
# 否则"设两个变量"就等于跳过全部 Flutter/Node/Gradle 门禁。
CANONICAL_MAIN="/home/mark/projects/dsh-mobile-remote"
CANONICAL_STATE="$REAL_HOME/.local/state/dsh-mobile-remote-workflow"
# 真实仓库的 .git 目录：即使用 DSH_WT_MAIN 指向别处，也能识别出这就是真实仓库。
canonical_git_common_dir() { realpath "$CANONICAL_MAIN/.git" 2>/dev/null || true; }
current_git_common_dir() { realpath "$(gitq rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null || true; }
is_real_repo_context() {
  [ "$MAIN_DIR" = "$CANONICAL_MAIN" ] && return 0
  [ "$STATE_DIR" = "$CANONICAL_STATE" ] && return 0
  local cur canon; cur="$(current_git_common_dir)"; canon="$(canonical_git_common_dir)"
  [ -n "$cur" ] && [ -n "$canon" ] && [ "$cur" = "$canon" ] && return 0
  return 1
}
synthetic_gate_allowed() {
  [ "${DSH_WT_SYNTHETIC_GATES:-0}" = "1" ] || return 1
  [ "${DSH_WT_ALLOW_SYNTHETIC:-0}" = "1" ] || return 1
  is_real_repo_context && return 1
  return 0
}
gate_mode_expected() { # 当前上下文允许/期望的门禁模式
  if synthetic_gate_allowed; then printf 'synthetic'; else printf 'required'; fi
}
require_real_gates_context() { # 真实仓库/真实状态目录里禁止合成门禁
  if [ "${DSH_WT_SYNTHETIC_GATES:-0}" = "1" ] || [ "${DSH_WT_ALLOW_SYNTHETIC:-0}" = "1" ]; then
    synthetic_gate_allowed || die "拒绝在真实仓库或真实状态目录运行合成门禁；真实门禁必须实际执行"
  fi
}

# 生成物目录的跨树隔离检查：绝对路径 + 硬链接 + 任意层级的树外软链。
# 安装前后各跑一次，因为 npm/flutter 安装本身可能新建指向树外的链接。
verify_tree_link_isolation() { # <工作树> <用途>
  local wt="$1" what="${2:-该操作}" generated linked link target
  [ ! -L "$wt/node_modules" ] || die "$what：node_modules 是软链（$(readlink "$wt/node_modules")），拒绝共享目录"
  for generated in "$wt/node_modules" "$wt/dsh-mobile-app/.dart_tool" "$wt/dsh-mobile-app/build" "$wt/dsh-mobile-app/android/.gradle"; do
    [ ! -L "$generated" ] || die "$what：$generated 是目录软链，拒绝共享生成物"
    [ -d "$generated" ] || continue
    linked="$(find "$generated" -type f -links +1 -print -quit 2>/dev/null)"
    [ -z "$linked" ] || die "$what：生成物目录含硬链接文件（$linked），拒绝跨树共享"
    while IFS= read -r link; do
      [ -n "$link" ] || continue
      target="$(realpath "$link" 2>/dev/null || true)"
      case "$target" in
        "$wt"/*) ;;
        *) die "$what：生成物目录存在指向工作树外的软链：$link → $target" ;;
      esac
    done < <(find "$generated" -type l -print 2>/dev/null)
  done
}

require_task() { # require_task <issue>  init_state_dirs
  [ -f "$(task_file "$1")" ] || die "没有 issue #$1 的任务登记（先 create，或检查编号）"
}

require_role_integrator() {
  [ "$ROLE" = "integrator" ] || die "该操作仅限集成/发布执行者（当前角色：$ROLE）。由用户指派后以 DSH_WT_ROLE=integrator 运行"
}

# 只有登记写入者能写这棵树；人工接管记录必须绑定当前 HEAD。
require_writer() { # require_writer <issue> <worktree> <branch>
  local issue="$1" wt="$2" branch="$3" f writer head scope
  f="$(task_file "$issue")"; writer="$(json_get "$f" writer)"
  require_registered_branch "$issue" "$wt" "$branch"
  [ "$writer" = "$WHOAMI_ID" ] && return 0
  if [ "${DSH_WT_TAKEOVER:-0}" = "1" ]; then
    head="$(gitq -C "$wt" rev-parse HEAD)"; scope="$(json_get "$f" authorizations.takeover.scope_sha)"
    [ -n "$scope" ] && [ "$scope" = "$head" ] || die "接管授权缺失或已过期；先取得用户批准并绑定当前 HEAD"
    warn "以已记录的接管授权操作 issue #$issue（原写入者：$writer）"
    return 0
  fi
  die "issue #$issue 的写入者是 $writer，当前身份 $WHOAMI_ID 无权写入。接管需用户批准"
}

require_authorization() { # require_authorization <issue> <动作> <scope SHA>
  local f granted scope
  f="$(task_file "$1")"
  granted="$(json_get "$f" "authorizations.$2.granted_at")"
  scope="$(json_get "$f" "authorizations.$2.scope_sha")"
  [ -n "$granted" ] && [ "$scope" = "$3" ] || \
    die "缺少或过期授权：$2（issue #$1，要求提交 $3）。先取得用户明确批准并登记该提交范围"
}

task_has_valid_gate_evidence() { # task_has_valid_gate_evidence <task file> <sha>
  local task="$1" sha="$2" report verified state failed exception baseline_report report_fails baseline_fails
  local report_kinds baseline_kinds mode
  report="$(json_get "$task" last_report)"; verified="$(json_get "$task" last_verified_sha)"
  state="$(json_get "$task" verification_state)"
  [ -f "$report" ] && report_has_commit "$report" "$sha" || return 1
  mode="$(report_evidence_mode "$report")" || return 1
  # 真实上下文不接受合成门禁报告。
  if [ "$mode" = "synthetic" ] && ! synthetic_gate_allowed; then return 1; fi
  report_validate "$report" "$mode" || return 1
  report_fails="$(report_failed_gates "$report" "$mode")" || return 1
  if [ "$state" = "passed" ] && [ "$verified" = "$sha" ] && [ -z "$report_fails" ]; then return 0; fi
  failed="$(json_get "$task" last_failed_sha)"; exception="$(json_get "$task" authorizations.exception.granted_sha)"
  baseline_report="$(json_get "$task" authorizations.exception.baseline_report)"
  [ -f "$baseline_report" ] || return 1
  [ "$(report_evidence_mode "$baseline_report")" = "$mode" ] || return 1
  report_validate "$baseline_report" "$mode" || return 1
  baseline_fails="$(report_failed_gates "$baseline_report" "$mode")" || return 1
  [ "$(json_get "$task" baseline_verification_state)" = "complete" ] && \
    [ "$(json_get "$task" baseline_attempt_sha)" = "$(json_get "$task" baseline)" ] && \
    report_has_commit "$baseline_report" "$(json_get "$task" baseline)" || return 1
  # 关键：失败门禁必须"真的执行过并失败"（kind=executed）。跳过/缺失不可用基线红灯顶替。
  report_kinds="$(report_gate_query "$report" "$mode" kinding)" || return 1
  baseline_kinds="$(report_gate_query "$baseline_report" "$mode" kinding)" || return 1
  [ -n "$report_kinds" ] && [ "$report_kinds" = "$baseline_kinds" ] || return 1
  case "$report_kinds" in *skipped*|*missing*|*not-run*|*lock-timeout*|*source-changed*) return 1 ;; esac
  [ "$state" = "failed" ] && [ "$failed" = "$sha" ] && [ "$exception" = "$sha" ] && \
    [ "$baseline_report" = "$(json_get "$task" last_baseline_report)" ] && \
    [ "$(json_get "$task" authorizations.exception.baseline_sha)" = "$(json_get "$task" baseline)" ] && \
    [ "$report_fails" = "$(json_get "$task" last_failed_gates)" ] && \
    [ "$(json_get "$task" authorizations.exception.gates)" = "$report_fails" ] && \
    [ "$baseline_fails" = "$report_fails" ] && \
    [ "$baseline_fails" = "$(json_get "$task" last_baseline_failed_gates)" ]
}

# 脏树守卫：不自动 stash/restore/clean，不吞掉现场
require_clean_tree() { # require_clean_tree <目录> <用途>
  local dir="$1" what="${2:-该操作}" dirty
  dirty="$(gitq -C "$dir" status --porcelain 2>/dev/null)"
  if [ -n "$dirty" ]; then
    warn "$what 要求工作树干净，但 $dir 有未提交改动："
    printf '%s\n' "$dirty" | sed 's/^/    /' >&2
    die "已停止，未改动任何文件。请自行提交或处理这些改动后再重试"
  fi
}

# ── 并发限额（flock 多锁）──
# 轻量检查不限；Flutter 全量 ≤2；Gradle/APK 构建 ≤1，且**与 flutter-test 互斥**。
# 按内存上限保守互斥：Gradle daemon jvmargs 上限约 12.5G，本机物理内存 15G。
# 曾观察到一次 59.5 分钟 Gradle stall，但同一 verify 内门禁是顺序执行，现有证据不能确认根因。
# 互斥只保证不同工作树并行运行时不叠加 Flutter 全测与 Gradle；shared/exclusive 表达该约束。
#
# ⚠ 两个坑（自测已抓到）：
#   1) 必须在**当前 shell** 持有 fd——放进 $(...) 会让锁随 sub shell 释放，限额静默失效；
#   2) 多把锁要**一次性全拿或全放**，且等待期间不持有任何锁，避免死锁。
SLOT_FDS=()
_lock_open() { # _lock_open <fd> <文件> <exclusive|shared>
  local fd="$1" file="$2" mode="$3"
  eval "exec $fd>\"\$file\"" 2>/dev/null || return 1
  if [ "$mode" = "shared" ]; then
    eval "flock -sn $fd" 2>/dev/null || { eval "exec $fd>&-" 2>/dev/null; return 1; }
  else
    eval "flock -n $fd" 2>/dev/null || { eval "exec $fd>&-" 2>/dev/null; return 1; }
  fi
  SLOT_FDS+=("$fd")
  return 0
}
release_locks() {
  local fd
  for fd in ${SLOT_FDS[@]+"${SLOT_FDS[@]}"}; do eval "exec $fd>&-" 2>/dev/null || true; done
  SLOT_FDS=()
}
acquire_locks() { # acquire_locks <超时秒> <规格...>
  # 规格：<base>:exclusive | <base>:shared | <base>:slots:N（占 base.1..N 中任一空闲槽）
  local timeout="$1"; shift
  [[ "$timeout" =~ ^[0-9]{1,5}$ ]] || return 1
  local deadline=$(( SECONDS + timeout )) spec base mode i want got next ok
  while :; do
    SLOT_FDS=(); next=8; ok=1
    for spec in "$@"; do
      base="${spec%%:*}"; mode="${spec#*:}"
      case "$mode" in
        exclusive|shared)
          _lock_open "$next" "$LOCK_DIR/$base.lock" "$mode" || { ok=0; break; }
          next=$((next+1)) ;;
        slots:*)
          want="${mode##*:}"; got=0; i=1
          while [ "$i" -le "$want" ]; do
            if _lock_open "$next" "$LOCK_DIR/$base.$i.lock" exclusive; then got=1; break; fi
            i=$((i+1))
          done
          [ "$got" = "1" ] || { ok=0; break; }
          next=$((next+1)) ;;
        *) ok=0; break ;;
      esac
    done
    [ "$ok" = "1" ] && return 0
    release_locks
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 0.5
  done
}

# ── create ──
cmd_create() {
  local issue="${1:-}" short="${2:-}" kind="feature" writer="$WHOAMI_ID"
  shift 2 2>/dev/null || true
  while [ $# -gt 0 ]; do
    case "$1" in
      --kind) [ "$#" -ge 2 ] || die "--kind 缺少 feature|fix 值"; kind="$2"; shift 2 ;;
      --writer) [ "$#" -ge 2 ] || die "--writer 缺少身份值"; writer="$2"; shift 2 ;;
      *) die "未知参数：$1" ;;
    esac
  done
  [ -n "$issue" ] && [ -n "$short" ] || die "用法：tools/worktree.sh create <issue> <短名> [--kind feature|fix] [--writer <身份>]"
  [[ "$issue" =~ ^[1-9][0-9]{0,9}$ ]] || die "issue 必须是正整数"
  case "$kind" in feature|fix) ;; *) die "--kind 只能是 feature 或 fix" ;; esac
  [[ "$short" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || die "短名只能是 1-64 个小写字母/数字/连字符"
  [[ "$writer" =~ ^[A-Za-z0-9][A-Za-z0-9._@:-]{0,127}$ ]] || die "writer 身份格式无效"

  init_state_dirs
  task_lock_acquire "$issue"
  cd "$MAIN_DIR" || die "无法进入主目录 $MAIN_DIR"
  local cur; cur="$(current_branch)"
  [ "$cur" = "develop" ] || die "主目录必须固定在 develop 上（当前：$cur）"
  require_clean_tree "$MAIN_DIR" "create"

  mkdir -p "$WT_ROOT" || die "无法创建工作树根目录 $WT_ROOT"
  WT_ROOT="$(cd "$WT_ROOT" && pwd -P)" || die "无法规范化工作树根路径"
  local branch="$kind/$short"
  local path="$WT_ROOT/issue-$issue-$short"
  local task; task="$(task_file "$issue")"
  [ -f "$task" ] && die "issue #$issue 已有任务登记：$(json_get "$task" path)"
  gitq show-ref --verify --quiet "refs/heads/$branch" && die "分支 $branch 已存在"
  [ -e "$path" ] && die "路径已存在：$path"

  # 基线：main 必须与 github/main 同步（不自动快进，避免静默改变基线）
  gitq fetch --quiet github 2>/dev/null || die "无法 fetch github/main，不能证明基线是最新；create 已停止"
  local main_sha gh_sha
  main_sha="$(gitq rev-parse main)"
  gh_sha="$(gitq rev-parse --verify github/main 2>/dev/null)" || die "缺少 github/main 远端跟踪引用；拒绝猜测基线"
  if [ "$main_sha" != "$gh_sha" ]; then
    warn "本地 main ($(gitq rev-parse --short main)) 与 github/main ($(gitq rev-parse --short github/main)) 不一致"
    die "先按「上游同步」把 main 快进到 github/main，再建树（避免用陈旧基线开工）"
  fi

  # 基线不得携带禁止进入功能分支的文件
  local hit=""
  for p in "${FORBIDDEN_PATHS[@]}"; do
    if gitq ls-tree -r --name-only main -- "$p" | grep -q .; then hit="$hit $p"; fi
  done
  if [ -n "$hit" ]; then
    warn "基线 main 已跟踪这些文件：$hit"
    die "它们不应随功能分支进入上游 PR。请用户决定如何处理（删除/迁移）后再建树"
  fi

  info "创建 $branch → $path（基线 main@$(gitq rev-parse --short main)）"
  # 先原子保留 issue 登记，其他 create 在同 issue 锁下只能看到 creating 并拒绝重入。
  json_create_task "$task" "$issue" "$short" "$branch" "$path" "$kind" "$main_sha" "$writer" || die "无法原子登记 issue #$issue"
  if ! gitq worktree add -b "$branch" "$path" "$main_sha" >/dev/null; then
    rm -f "$task"
    die "git worktree add 失败；已撤销本次任务登记"
  fi
  json_set "$task" status created || die "工作树已创建，但任务状态写入失败；保留现场并停止"
  audit create "issue=$issue branch=$branch path=$path baseline=$(gitq rev-parse --short main)"
  ok "已建树并登记：issue #$issue（写入者 $writer）"
  info "下一步：cd $path && $SCRIPT_PATH init"
  task_lock_release
}

# ── init ──
cmd_init() {
  local wt; wt="$(current_worktree)"
  [ -n "$wt" ] || die "init 需要在工作树内运行"
  [ "$wt" != "$MAIN_DIR" ] || die "init 只用于功能工作树，不用于主目录 develop"
  local task generated linked link target
  task="$(task_file_for_path "$wt")"
  [ -n "$task" ] || die "当前工作树未登记，拒绝 init"
  local issue; issue="$(json_get "$task" issue)"
  task_lock_acquire "$issue"
  task="$(task_file_for_path "$wt")"
  [ -n "$task" ] || die "任务登记在等待锁期间已变化"
  local branch; branch="$(gitq -C "$wt" rev-parse --abbrev-ref HEAD)"
  case "$branch" in feature/*|fix/*) ;; *) die "当前分支 $branch 不是 feature/fix，拒绝 init" ;; esac
  require_writer "$issue" "$wt" "$branch"
  case "$(json_get "$task" status)" in created|initialized) ;; *) die "任务状态为 $(json_get "$task" status)，不能重新 init" ;; esac
  cd "$wt" || die "无法进入已登记工作树 $wt"

  # 独立产物：拒绝沿用其它工作树的软链/硬链接。检查始终使用登记的绝对路径，
  # 与调用者当前位于仓库根或子目录无关。
  verify_tree_link_isolation "$wt" "init（安装前）"
  if [ -e "$wt/dsh-mobile-app/.dart_tool/package_config.json" ]; then
    [ ! -L "$wt/dsh-mobile-app/.dart_tool/package_config.json" ] || die "package_config.json 是软链，拒绝共享生成物"
    local links; links="$(stat -c %h "$wt/dsh-mobile-app/.dart_tool/package_config.json" 2>/dev/null || echo 1)"
    [ "$links" -le 1 ] || die "package_config.json 是硬链接（links=$links），拒绝共享生成物"
    local linked; linked="$(find "$wt/dsh-mobile-app/.dart_tool" -type f -links +1 -print -quit 2>/dev/null)"
    [ -z "$linked" ] || die ".dart_tool 含硬链接文件：$linked"
  fi

  # 环境：agent 的非交互 shell 不带镜像变量，这里补上。
  # ⚠ 关键：**必须跟随 pubspec.lock 记录的源**，不能无条件强制镜像。
  # 功能分支从 main 开，main 的 lock 记的是 pub.dev；若用镜像跑 pub get，pub 会重写 lock
  # 的每个 url（实测 143 行，还夹带包版本升级），直接污染 PR。缓存里两种源都有，跟随即可。
  export PUB_CACHE="${PUB_CACHE:-$REAL_HOME/.pub-cache}"
  export PATH="/home/mark/sdk/flutter/bin:/home/mark/sdk/jdk17/bin:$PATH"
  export JAVA_HOME="${JAVA_HOME:-/home/mark/sdk/jdk17}"
  export ANDROID_HOME="${ANDROID_HOME:-/home/mark/sdk/android}"
  export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
  export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$REAL_HOME/.gradle}"
  export GRADLE_OPTS="${GRADLE_OPTS:--Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=1080 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=1080}"
  local lock="$wt/dsh-mobile-app/pubspec.lock"
  if [ -f "$lock" ]; then
    if grep -q 'pub\.dev' "$lock"; then
      export PUB_HOSTED_URL="https://pub.dev"
    else
      export PUB_HOSTED_URL="https://pub.flutter-io.cn"
    fi
    info "pub 源跟随 pubspec.lock：$PUB_HOSTED_URL（不重写 lock）"
  fi
  export FLUTTER_STORAGE_BASE_URL="${FLUTTER_STORAGE_BASE_URL:-https://storage.flutter-io.cn}"

  info "1/3 安装服务端依赖（本树独立 node_modules，共享下载缓存）"
  ( exec 7>&-; cd "$wt" && npm install --no-audit --no-fund --no-package-lock --loglevel=error ) || die "npm install 失败"
  [ -e "$wt/node_modules/@deepseek-ai/schemastery" ] || warn "node_modules 里没有 @deepseek-ai/schemastery，服务端契约测试可能无法导入 lib/index.js"

  info "2/3 解析 Flutter 依赖（PUB_CACHE=$PUB_CACHE）"
  ( exec 7>&-; cd "$wt/dsh-mobile-app" && flutter pub get >/dev/null ) || die "flutter pub get 失败"

  # 安装会创建新的链接（例如 file: 本地依赖会软链到树外目录），因此必须复查一遍。
  verify_tree_link_isolation "$wt" "init（安装后）"

  info "3/3 补齐 Gradle wrapper（被 gitignore，新树不会自带）"
  local wrapper_dir="$wt/dsh-mobile-app/android/gradle/wrapper"
  local sdk_wrapper="/home/mark/sdk/flutter/bin/cache/artifacts/gradle_wrapper"
  local main_wrapper="$MAIN_DIR/dsh-mobile-app/android/gradle/wrapper/gradle-wrapper.jar"
  if [ ! -x "$wt/dsh-mobile-app/android/gradlew" ]; then
    [ -f "$sdk_wrapper/gradlew" ] || die "缺少 gradlew 且 SDK 缓存里没有：$sdk_wrapper"
    cp -p "$sdk_wrapper/gradlew" "$wt/dsh-mobile-app/android/gradlew"
    cp -p "$sdk_wrapper/gradlew.bat" "$wt/dsh-mobile-app/android/gradlew.bat" 2>/dev/null || true
    chmod +x "$wt/dsh-mobile-app/android/gradlew"
    info "已补齐 gradlew"
  else
    info "gradlew 已存在，保持不动"
  fi
  # gradle-wrapper.jar 常被单独漏掉：只有 gradlew 而没有 jar 时，Gradle 会报
  # "Could not find or load main class org.gradle.wrapper.GradleWrapperMain"。
  if [ ! -f "$wrapper_dir/gradle-wrapper.jar" ]; then
    mkdir -p "$wrapper_dir"
    cp -p "$sdk_wrapper/gradle/wrapper/gradle-wrapper.jar" "$wrapper_dir/" 2>/dev/null || \
      cp -p "$main_wrapper" "$wrapper_dir/" || die "无法补齐 gradle-wrapper.jar"
    info "已补齐 gradle-wrapper.jar"
  fi
  [ -f "$wrapper_dir/gradle-wrapper.properties" ] || \
    cp -p "$MAIN_DIR/dsh-mobile-app/android/gradle/wrapper/gradle-wrapper.properties" "$wrapper_dir/" 2>/dev/null || true

  # 构建生成物不应污染 git status。上游 .gitignore 未覆盖 .kotlin/ 等目录，
  # 但我们**不改上游 .gitignore**（那会进 PR）——改用本机 exclude（共享文件，不随提交走）。
  local exclude; exclude="$(gitq -C "$wt" rev-parse --git-path info/exclude 2>/dev/null)"
  if [ -n "$exclude" ] && [ -f "$exclude" ]; then
    local added=0
    for pat in 'dsh-mobile-app/android/.kotlin/' 'dsh-mobile-app/.flutter-plugins-dependencies'; do
      if ! grep -qxF "$pat" "$exclude" 2>/dev/null; then printf '%s\n' "$pat" >>"$exclude"; added=1; fi
    done
    [ "$added" = "1" ] && info "已把构建生成物加入本机 .git/info/exclude（不进 PR）"
  fi

  # 不应提交的生成物：确认它们没有进入 Git 视野
  local pollution
  pollution="$(gitq -C "$wt" status --porcelain --ignored=no | grep -vE '^\?\? (node_modules/|dsh-mobile-app/\.dart_tool/|dsh-mobile-app/build/|dsh-mobile-app/android/\.gradle/)' || true)"
  if [ -n "$pollution" ]; then
    warn "init 产生了需要留意的改动："; printf '%s\n' "$pollution" | sed 's/^/    /' >&2
  fi

  local task; task="$(task_file_for_path "$wt")"
  [ -n "$task" ] && { json_set "$task" status initialized; json_set "$task" initialized_at "$(date '+%F %T')"; }
  audit init "path=$wt branch=$branch"
  ok "初始化完成：$branch"
  task_lock_release
}

# 依据工作树路径反查任务登记
task_file_for_path() {
  local wt="$1" f found=""
  shopt -s nullglob
  for f in "$TASKS_DIR"/*.json; do
    if [ "$(json_get "$f" path)" = "$wt" ]; then
      [ -z "$found" ] || { shopt -u nullglob; die "多个任务登记指向同一工作树 $wt；拒绝猜测归属"; }
      found="$f"
    fi
  done
  shopt -u nullglob
  [ -n "$found" ] && printf '%s' "$found"
}

# ── verify ──
# 门禁分两类（见 AGENT-RULES）：隔离测试进任务门禁；真实服务测试不进自动门禁。
run_gates() { # run_gates <工作树> <报告临时文件> <required|synthetic>
  local wt="$1" report="$2" synthetic="${3:-0}"
  local -a results=()
  local pass=0 fail=0 report_error=0
  # 结构化门禁结果：唯一权威来源，文本摘要仅供人读。
  declare -A GATE_STATUS=() GATE_KIND=()
  : >"$report" || { warn "无法创建验证报告临时文件：$report"; return 2; }

  # 隔离测试状态；插件路径也显式指向当前树，不能继承部署 profile 覆盖。
  local iso_home="$STATE_DIR/tmp-home/$$-$RANDOM"
  mkdir -p "$iso_home" || { warn "无法创建隔离 HOME"; return 2; }
  export HOME="$iso_home" DSH_HOME="$iso_home/.dsh"
  export XDG_CONFIG_HOME="$iso_home/.config" XDG_CACHE_HOME="$iso_home/.cache" XDG_DATA_HOME="$iso_home/.local/share"
  export DSH_MOBILE_PLUGIN="$wt/lib/index.js"
  local lock="$wt/dsh-mobile-app/pubspec.lock"
  if [ -f "$lock" ] && grep -q 'pub\.dev' "$lock"; then export PUB_HOSTED_URL="https://pub.dev"
  else export PUB_HOSTED_URL="${PUB_HOSTED_URL:-https://pub.flutter-io.cn}"; fi
  export FLUTTER_STORAGE_BASE_URL="${FLUTTER_STORAGE_BASE_URL:-https://storage.flutter-io.cn}"
  export PUB_CACHE="$REAL_HOME/.pub-cache"
  export PATH="/home/mark/sdk/flutter/bin:/home/mark/sdk/jdk17/bin:$PATH"
  export JAVA_HOME="${JAVA_HOME:-/home/mark/sdk/jdk17}"
  export ANDROID_HOME="${ANDROID_HOME:-/home/mark/sdk/android}"
  export ANDROID_SDK_ROOT="$ANDROID_HOME"
  export GRADLE_USER_HOME="$REAL_HOME/.gradle"
  export GRADLE_OPTS="${GRADLE_OPTS:--Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=1080 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=1080}"

  report_printf() { # printf-style report writer; every I/O error is fatal to verification evidence
    local fmt="$1"; shift
    printf "$fmt" "$@" >>"$report" || { report_error=1; return 1; }
  }
  # kind 区分"真的跑过且通过"与"根本没用运行"——下游据此拒绝拿跳过当绿灯。
  record() { # record <门禁> <pass|fail> <executed|skipped|missing|lock-timeout|source-changed> [说明]
    local name="$1" status="$2" kind="$3" note="${4:-}"
    GATE_STATUS["$name"]="$status"; GATE_KIND["$name"]="$kind"
    if [ "$status" = "pass" ]; then results+=("PASS  $name"); pass=$((pass+1))
    else results+=("FAIL  $name ($kind${note:+：$note})"); fail=$((fail+1)); fi
  }
  report_fail() { # report_fail <门禁> <原因> <kind>
    local name="$1" reason="$2" kind="${3:-missing}"
    report_printf '### %s\n\nFAIL: %s\n\n' "$name" "$reason" || true
    record "$name" fail "$kind" "$reason"
  }
  gate() { # gate <名称> <锁规格> <超时> <命令...>
    local name="$1" lockspec="$2" timeout="$3"; shift 3
    local rc=0 out specs=()
    if [ "$lockspec" != "-" ]; then
      IFS=',' read -r -a specs <<<"$lockspec"
      if ! acquire_locks "$timeout" "${specs[@]}"; then
        report_printf '### %s\n\nFAIL: 等锁超时（%ss）：%s\n\n' "$name" "$timeout" "$lockspec" || true
        record "$name" fail "lock-timeout"; return 1
      fi
    fi
    report_printf '### %s\n\n```\n$ %s\n' "$name" "$*" || true
    # Gate children/daemons must not inherit locks: the gate shell owns them for the full
    # command lifetime; an inherited FD could let a long-lived Gradle daemon retain a lock.
    out="$(for held_fd in "${SLOT_FDS[@]}"; do eval "exec $held_fd>&-"; done; exec 6>&- 7>&-; "$@" 2>&1)" || rc=$?
    report_printf '%s\n```\n\n退出码：%s\n\n' "$out" "$rc" || true
    release_locks
    if [ "$rc" -eq 0 ]; then record "$name" pass executed; else record "$name" fail executed "exit=$rc"; fi
  }
  emit_gates_marker() { # 唯一权威结果行；必须在报告收尾前写入
    local mode name json="{"
    if [ "${synthetic:-0}" = "1" ]; then mode="synthetic"; else mode="required"; fi
    local first=1
    # 记录所有出现过的门禁（含跨模式的跳过/缺失标记），由 mode 决定哪一组是"必需"。
    local all_names=("${REQUIRED_GATES[@]}" "${SYNTHETIC_GATES[@]}")
    [ -n "${GATE_STATUS[synthetic-fail]:-}" ] && all_names+=("synthetic-fail")
    for name in "${all_names[@]}"; do
      [ -n "${GATE_STATUS[$name]:-}" ] || continue
      [ "$first" = "1" ] || json+=","
      first=0
      json+="\"$name\":{\"status\":\"${GATE_STATUS[$name]}\",\"kind\":\"${GATE_KIND[$name]:-not-run}\"}"
    done
    json+="}"
    report_printf '%s{"mode":"%s","results":%s}-->\n' "$GATES_MARK_PREFIX" "$mode" "$json" || { report_error=1; return 1; }
  }

  local current_head; current_head="$(gitq -C "$wt" rev-parse HEAD)"
  report_printf '# 验证报告：%s\n\n- 工作树：`%s`\n- 提交：`%s`\n- 时间：%s\n- 隔离 HOME：`%s`\n\n---\n\n' "$(gitq -C "$wt" rev-parse --abbrev-ref HEAD)" "$wt" "$current_head" "$(date '+%F %T')" "$iso_home" || true

  if [ "$synthetic" = "1" ]; then
    gate "synthetic-pass" - 60 true
    gate "synthetic-plugin-path" - 60 bash -c 'test "$DSH_MOBILE_PLUGIN" = "$1"' _ "$wt/lib/index.js"
    # 此门禁真实走 flutter-test 的 slots:2 + shared 锁；marker/sleep 仅供并发自测观测重叠。
    gate "synthetic-flutter" "flutter-test:slots:2,gradle-build:shared" "${DSH_WT_SLOT_TIMEOUT:-5}" \
      bash -c 'if [ -n "${DSH_WT_TEST_GATE_MARKER:-}" ]; then : > "$DSH_WT_TEST_GATE_MARKER"; fi; sleep "${DSH_WT_TEST_GATE_SLEEP:-0}"'
    gate "synthetic-heavy-a" "gradle-build:exclusive" "${DSH_WT_SLOT_TIMEOUT:-5}" true
    gate "synthetic-heavy-b" "gradle-build:exclusive" "${DSH_WT_SLOT_TIMEOUT:-5}" true
    if [ -f "$wt/.selftest-fail-gate" ] || { [ "${DSH_WT_ALLOW_SYNTHETIC:-0}" = "1" ] && [ "${DSH_WT_TEST_BASELINE_FAIL_GATE:-}" = "synthetic-fail" ]; }; then
      gate "synthetic-fail" - 60 false
    fi
    if [ "${DSH_WT_SKIP_GRADLE:-0}" = "1" ] || [ -f "$wt/.selftest-skip-gradle" ]; then
      report_fail "kotlin-usage-panel" "显式跳过不可用于验证" skipped
    fi
    [ "${DSH_WT_TEST_MISSING_GRADLE:-0}" = "1" ] && report_fail "kotlin-usage-panel" "缺少 gradlew" missing || true
    [ "${DSH_WT_TEST_MISSING_TIMELINE:-0}" = "1" ] && report_fail "timeline-contract" "当前树缺少必需脚本" missing || true
  else
    gate "flutter-analyze" - 900 bash -c 'cd "$1/dsh-mobile-app" && flutter analyze --no-pub --no-fatal-infos' _ "$wt"
    gate "flutter-test" "flutter-test:slots:2,gradle-build:shared" 1800 \
      bash -c 'cd "$1/dsh-mobile-app" && flutter test --no-pub' _ "$wt"
    if [ -f "$wt/tools/timeline-contract-check.mjs" ]; then
      gate "timeline-contract" - 600 bash -c 'cd "$1" && DSH_MOBILE_PLUGIN="$1/lib/index.js" node tools/timeline-contract-check.mjs' _ "$wt"
    else report_fail "timeline-contract" "当前树缺少必需脚本" missing; fi
    if [ -f "$wt/tools/account-usage-check.mjs" ]; then
      gate "account-usage" - 600 bash -c 'cd "$1" && node tools/account-usage-check.mjs' _ "$wt"
    else report_fail "account-usage" "当前树缺少必需脚本" missing; fi
    # gradlew 与显式跳过是"未执行"，必须与"执行后失败"区分：下游例外只接受 executed。
    if [ ! -x "$wt/dsh-mobile-app/android/gradlew" ]; then
      report_fail "kotlin-usage-panel" "缺少 gradlew；必须先运行 init" missing
    elif [ "${DSH_WT_SKIP_GRADLE:-0}" = "1" ]; then
      report_fail "kotlin-usage-panel" "DSH_WT_SKIP_GRADLE=1 跳过了必需门禁" skipped
    else
      gate "kotlin-usage-panel" "gradle-build:exclusive" 5400 \
        bash -c 'cd "$1/dsh-mobile-app/android" && ./gradlew :app:testDebugUnitTest --tests "com.dsh.remote.UsagePanelModelTest" --offline' _ "$wt"
    fi
  fi

  emit_gates_marker || report_error=1
  printf '\n---\n\n## 结果\n\n' >>"$report" || report_error=1
  for r in "${results[@]}"; do printf -- '- `%s`\n' "$r" >>"$report" || report_error=1; done
  printf '\n通过 %s / 失败 %s\n' "$pass" "$fail" >>"$report" || report_error=1
  rm -rf "$iso_home"
  printf '%s\n' "${results[@]}"
  if [ "$report_error" -ne 0 ]; then warn "验证报告写入失败；拒绝认定门禁状态"; return 2; fi
  return $(( fail > 0 ? 1 : 0 ))
}

cmd_verify() {
  local wt; wt="$(current_worktree)"
  [ -n "$wt" ] || die "verify 需要在工作树内运行"
  [ "$wt" != "$MAIN_DIR" ] || die "verify 用于功能工作树；主目录门禁见「发布」一节"
  local task; task="$(task_file_for_path "$wt")"
  [ -n "$task" ] || die "当前工作树没有任务登记（未经 create 创建？）"
  local issue; issue="$(json_get "$task" issue)"
  task_lock_acquire "$issue"
  task="$(task_file_for_path "$wt")"
  local branch; branch="$(gitq -C "$wt" rev-parse --abbrev-ref HEAD)"
  case "$branch" in feature/*|fix/*) ;; *) die "当前分支 $branch 不是 feature/fix" ;; esac
  require_writer "$issue" "$wt" "$branch"
  case "$(json_get "$task" status)" in integrated|cleaned) die "任务已集成/清理，不再接受功能树验证" ;; esac
  require_clean_tree "$wt" "verify（门禁证据必须对应干净提交）"

  init_state_dirs
  require_real_gates_context
  local head_start sha report report_tmp synthetic run_id
  head_start="$(gitq -C "$wt" rev-parse HEAD)"; sha="${head_start:0:12}"
  run_id="$(date +%s%N)-$$-$RANDOM"
  report="$REPORTS_DIR/$issue-$sha-$run_id.md"
  report_tmp="$(mktemp "$REPORTS_DIR/.$issue-$sha-$run_id.XXXXXX.tmp")" || die "无法创建验证报告临时文件"
  if synthetic_gate_allowed; then synthetic=1; else synthetic=0; fi
  json_task_transition "$task" verify-begin "$head_start" "$run_id" || { rm -f "$report_tmp"; die "无法原子开始验证状态事务"; }

  info "运行门禁（报告：$report）"
  local rc=0 gate_out=""
  gate_out="$(run_gates "$wt" "$report_tmp" "$synthetic")" || rc=$?
  local head_end dirty_end
  head_end="$(gitq -C "$wt" rev-parse HEAD)"
  dirty_end="$(gitq -C "$wt" status --porcelain)"
  if [ "$head_end" != "$head_start" ] || [ -n "$dirty_end" ]; then
    rc=1
    # Gate report already contains a footer; record source-integrity failure explicitly as a separate section.
    gate_out+=$'\nFAIL  verify-source-integrity (HEAD changed or tree became dirty during gates)'
    printf '\n## 源树完整性校验\n\n- `FAIL  verify-source-integrity (HEAD changed/tree dirty)`\n' >>"$report_tmp" || rc=2
  fi
  if [ "$rc" -eq 2 ] || [ ! -s "$report_tmp" ]; then
    rm -f "$report_tmp"
    warn "验证报告未能完整写入；验证状态保持 running，deliver/integrate 会拒绝"
    task_lock_release
    return 2
  fi
  if [ "$head_end" != "$head_start" ] || [ -n "$dirty_end" ]; then
    rm -f "$report_tmp"
    warn "门禁期间源树变化；不发布报告，验证事务保持 running"
    task_lock_release
    return 1
  fi
  if [ -d "$report" ] || [ -L "$report" ] || ! mv -f "$report_tmp" "$report"; then
    rm -f "$report_tmp"
    warn "验证报告目标异常或无法原子发布；验证事务保持 running"
    task_lock_release
    return 2
  fi
  [ -f "$report" ] || { warn "验证报告最终文件缺失"; task_lock_release; return 2; }

  printf '%s\n' "$gate_out"
  local gate_mode; if [ "$synthetic" = "1" ]; then gate_mode=synthetic; else gate_mode=required; fi
  if [ "$rc" -eq 0 ]; then
    # 双重校验：报告结构必须合法，且每项必需门禁都是"真的跑过并通过"。
    report_validate "$report" "$gate_mode" || die "验证报告结构不合法，拒绝标记 verified"
    report_gate_query "$report" "$gate_mode" all-pass || die "报告未包含全部必需门禁通过结果，拒绝标记 verified"
    json_task_transition "$task" verify-pass "$head_start" "$report" "$run_id" || die "无法原子完成验证状态事务；保持 running"
    audit verify "issue=$issue sha=$sha result=pass mode=$gate_mode"
    ok "门禁全绿：$report"
    task_lock_release
  else
    local failed; failed="$(report_failed_gates "$report" "$gate_mode")" || die "无法从验证报告解析失败门禁"
    json_task_transition "$task" verify-fail "$head_start" "$report" "$failed" "$run_id" || die "无法原子记录验证失败；保持 running"
    audit verify "issue=$issue sha=$sha result=fail gates=$failed"
    warn "门禁失败，未标记为 verified：$report"
    task_lock_release
    return 1
  fi
}

# ── deliver ──
cmd_deliver() {
  local wt; wt="$(current_worktree)"
  [ -n "$wt" ] || die "deliver 需要在工作树内运行"
  local task; task="$(task_file_for_path "$wt")"
  [ -n "$task" ] || die "当前工作树没有任务登记"
  local issue; issue="$(json_get "$task" issue)"
  task_lock_acquire "$issue"
  task="$(task_file_for_path "$wt")"
  [ -n "$task" ] || die "任务登记在等待锁期间已变化"
  local branch; branch="$(gitq -C "$wt" rev-parse --abbrev-ref HEAD)"
  require_writer "$issue" "$wt" "$branch"
  case "$(json_get "$task" status)" in integrated|cleaned) die "任务已集成/清理，不再接受二次交付" ;; esac
  require_clean_tree "$wt" "deliver"

  local baseline head behind count commit_list
  baseline="$(json_get "$task" baseline)"
  head="$(gitq -C "$wt" rev-parse HEAD)"
  [ "$head" != "$baseline" ] || die "分支相对基线没有任何提交"
  local expected_branch; expected_branch="$(json_get "$task" branch)"
  [ "$branch" = "$expected_branch" ] || die "当前分支 $branch 与 issue #$issue 登记分支 $expected_branch 不一致"
  count="$(gitq -C "$wt" rev-list --count "$baseline"..HEAD)" || die "无法计算交付提交范围"
  commit_list="$(gitq -C "$wt" log --oneline "$baseline"..HEAD)" || die "无法读取提交列表"

  local leaks=""
  for p in "${FORBIDDEN_PATHS[@]}"; do
    gitq -C "$wt" ls-tree -r --name-only HEAD -- "$p" | grep -q . && leaks="$leaks $p"
  done
  [ -n "$leaks" ] && die "提交里出现了不应进入上游的文件：$leaks（请从提交中移除）"
  behind="$(gitq -C "$wt" rev-list --count "HEAD..main" 2>/dev/null || echo '?')"

  local verified_sha failed_sha failed_gates exc_sha exc_gates exc_baseline_report exc_baseline_sha baseline_gates report_path verification_state baseline_state report_fails baseline_report_fails report_kinds baseline_kinds
  verified_sha="$(json_get "$task" last_verified_sha)"
  failed_sha="$(json_get "$task" last_failed_sha)"
  failed_gates="$(json_get "$task" last_failed_gates)"
  exc_sha="$(json_get "$task" authorizations.exception.granted_sha)"
  exc_gates="$(json_get "$task" authorizations.exception.gates)"
  exc_baseline_report="$(json_get "$task" authorizations.exception.baseline_report)"
  exc_baseline_sha="$(json_get "$task" authorizations.exception.baseline_sha)"
  baseline_gates="$(json_get "$task" last_baseline_failed_gates)"
  report_path="$(json_get "$task" last_report)"
  verification_state="$(json_get "$task" verification_state)"
  baseline_state="$(json_get "$task" baseline_verification_state)"
  local head_short; head_short="$(gitq -C "$wt" rev-parse --short HEAD)"
  local using_exception=0
  # 报告必须是结构完整的门禁报告；真实上下文只认真实门禁报告，截断/伪造一律拒绝。
  [ -f "$report_path" ] && report_has_commit "$report_path" "$head" || die "当前 SHA 的验证报告不存在或 SHA 不匹配"
  local evidence_mode; evidence_mode="$(report_evidence_mode "$report_path")" || die "验证报告结构不完整（缺少唯一门禁结果块），拒绝交付"
  if [ "$evidence_mode" = "synthetic" ] && ! synthetic_gate_allowed; then
    die "验证报告来自合成门禁，不能用于真实仓库交付"
  fi
  report_validate "$report_path" "$evidence_mode" || die "验证报告结构不完整（缺少唯一门禁结果块），拒绝交付"
  report_fails="$(report_failed_gates "$report_path" "$evidence_mode")" || die "无法核对验证报告结果"
  report_kinds="$(report_gate_query "$report_path" "$evidence_mode" kinding)" || die "无法核对验证报告门禁类别"

  if [ "$verification_state" = "passed" ] && [ -n "$verified_sha" ] && [ "$verified_sha" = "$head" ] && [ -z "$report_fails" ]; then
    report_gate_query "$report_path" "$evidence_mode" all-pass || die "报告未显示全部必需门禁通过，拒绝交付"
  elif [ "$verification_state" = "failed" ] && [ -n "$failed_sha" ] && [ "$failed_sha" = "$head" ] && \
       [ -n "$exc_sha" ] && [ "$exc_sha" = "$head" ] && [ "$report_fails" = "$failed_gates" ] && \
       [ "$exc_baseline_report" = "$(json_get "$task" last_baseline_report)" ] && \
       [ -f "$exc_baseline_report" ] && [ "$exc_baseline_sha" = "$baseline" ] && \
       [ "$baseline_gates" = "$failed_gates" ] && [ "$baseline_state" = "complete" ]; then
    # 例外只对"确实执行过并失败"的门禁成立；跳过/缺失不构成基线红灯等价物。
    [ "$(report_evidence_mode "$exc_baseline_report")" = "$evidence_mode" ] || die "基线报告模式与验证报告不一致，拒绝例外交付"
    report_validate "$exc_baseline_report" "$evidence_mode" || die "基线报告结构不完整，拒绝例外交付"
    baseline_kinds="$(report_gate_query "$exc_baseline_report" "$evidence_mode" kinding)" || die "无法核对基线报告门禁类别"
    [ -n "$report_kinds" ] && [ "$report_kinds" = "$baseline_kinds" ] || \
      die "当前失败与基线失败的执行类别不一致（$report_kinds vs $baseline_kinds），拒绝例外交付"
    case "$report_kinds" in
      *skipped*|*missing*|*not-run*|*lock-timeout*|*source-changed*)
        die "存在未实际执行的门禁（$report_kinds）：跳过或缺失不能借基线红灯开例外" ;;
    esac
    baseline_report_fails="$(report_failed_gates "$exc_baseline_report" "$evidence_mode")" || die "无法核对基线报告结果"
    [ "$baseline_report_fails" = "$failed_gates" ] && report_has_commit "$exc_baseline_report" "$baseline" || \
      die "基线报告内容不匹配登记的失败集合/SHA"
    case ",$exc_gates," in
      *",$failed_gates,"*) ;;
      *) die "例外批准的门禁（$exc_gates）与最近实际失败（$failed_gates）不一致，已拒绝交付" ;;
    esac
    using_exception=1
    warn "以有基线证据且已记录理由的例外交付：$failed_gates（仅本提交）"
  elif [ -n "$failed_sha" ] && [ "$failed_sha" = "$head" ]; then
    die "当前提交 verify 失败：$failed_gates。需先 verify-baseline 留证，再取得用户批准的例外"
  else
    [ -n "$verified_sha" ] && warn "最近验证 SHA $(gitq -C "$wt" rev-parse --short "$verified_sha") 与当前 $head_short 不同"
    die "缺少对应当前提交的验证报告或有效例外，拒绝交付"
  fi

  local summary="$REPORTS_DIR/$issue-delivery-$head_short.md" summary_tmp
  summary_tmp="$(mktemp "$REPORTS_DIR/.$issue-delivery.XXXXXX.tmp")" || die "无法创建交付摘要临时文件"
  {
    printf '# 交付摘要：issue #%s\n\n' "$issue"
    printf -- '- 分支：`%s`\n- 工作树：`%s`\n- 基线：`%s`（%s）\n- 提交：`%s`（共 %s 个）\n- 落后 main：%s 个提交\n- 验证报告：`%s`\n- 写入者：%s\n- 门禁结果：%s\n\n## 提交列表\n\n' \
      "$branch" "$wt" "$baseline" "$(json_get "$task" baseline_ref)" "$head" "$count" "$behind" "$report_path" "$(json_get "$task" writer)" "$report_kinds"
    printf '%s\n' "$commit_list" | sed 's/^/- /'
    if [ "$using_exception" = "1" ]; then
      printf '\n## ⚠ 以已批准基线例外交付\n\n失败门禁：`%s`（提交 `%s`；理由：%s）\n基线报告：`%s`\n' \
        "$failed_gates" "$head_short" "$(json_get "$task" authorizations.exception.note)" "$(json_get "$task" authorizations.exception.baseline_report)"
    fi
    printf '\n## 尚需用户授权\n\n推送双远端、rebase、强拉、合并 develop、发布\n'
  } >"$summary_tmp" || { rm -f "$summary_tmp"; die "交付摘要写入失败；状态未更新"; }
  [ -s "$summary_tmp" ] || { rm -f "$summary_tmp"; die "交付摘要为空；状态未更新"; }
  [ ! -d "$summary" ] && [ ! -L "$summary" ] || { rm -f "$summary_tmp"; die "交付摘要目标不是普通文件；状态未更新"; }
  mv -f "$summary_tmp" "$summary" || { rm -f "$summary_tmp"; die "无法原子发布交付摘要；状态未更新"; }
  [ -f "$summary" ] || die "交付摘要最终文件缺失；状态未更新"
  [ "$(gitq -C "$wt" rev-parse HEAD)" = "$head" ] || die "生成摘要期间 HEAD 变化，拒绝交付"
  require_clean_tree "$wt" "deliver（生成摘要后）"
  json_set "$task" status delivered || die "无法记录 delivered 状态"
  json_set "$task" delivered_at "$(date '+%F %T')" || die "无法记录交付时间"
  json_set "$task" delivered_sha "$head" || die "无法记录交付 SHA"
  audit deliver "issue=$issue sha=$head_short commits=$count"
  ok "交付记录已原子生成：$summary"
  [ "$behind" != "0" ] && [ "$behind" != "?" ] && warn "分支落后 main $behind 个提交；rebase 需用户批准"
  info "下一步：取得用户授权后推送双远端（tools/worktree.sh authorize $issue push <理由>）"
  task_lock_release
}

# ── integrate ──
cmd_integrate() {
  local issue="${1:-}"; [ -n "$issue" ] || die "用法：tools/worktree.sh integrate <issue>"
  [[ "$issue" =~ ^[1-9][0-9]{0,9}$ ]] || die "issue 必须是正整数"
  require_role_integrator
  require_task "$issue"
  task_lock_acquire "$issue"
  local task; task="$(task_file "$issue")"
  local branch path delivered_sha status branch_sha
  branch="$(json_get "$task" branch)"; path="$(json_get "$task" path)"
  status="$(json_get "$task" status)"; delivered_sha="$(json_get "$task" delivered_sha)"
  [ "$status" = "delivered" ] || die "issue #$issue 状态为 $status；必须先 deliver 才能 integrate"
  [ -n "$delivered_sha" ] || die "任务登记缺少 delivered_sha"
  [ -d "$path" ] || die "功能工作树不存在：$path"
  [ "$(gitq -C "$path" rev-parse --show-toplevel)" = "$path" ] || die "工作树路径登记与实际路径不符"
  [ "$(gitq -C "$path" rev-parse --abbrev-ref HEAD)" = "$branch" ] || die "功能树当前分支不等于登记分支 $branch"
  branch_sha="$(gitq -C "$path" rev-parse HEAD)"
  [ "$branch_sha" = "$delivered_sha" ] && [ "$(branch_head "$branch")" = "$delivered_sha" ] || \
    die "分支 HEAD 已从交付 SHA 改变；重新 verify/deliver 并重新授权"
  task_has_valid_gate_evidence "$task" "$delivered_sha" || die "交付 SHA 缺少有效验证证据或已批准例外；拒绝合并"
  require_authorization "$issue" integrate "$delivered_sha"
  require_clean_tree "$path" "integrate（功能树）"

  mkdir -p "$LOCK_DIR"
  exec 6>"$LOCK_DIR/integrate.lock"
  flock -x -w 120 6 || die "等待全局集成锁超时"
  cd "$MAIN_DIR" || die "无法进入主目录"
  [ "$(current_branch)" = "develop" ] || die "主目录必须固定在 develop"
  require_clean_tree "$MAIN_DIR" "integrate（主目录）"
  local develop_before; develop_before="$(gitq rev-parse HEAD)"

  info "合并已交付 SHA $delivered_sha（$branch）→ develop（--no-ff）"
  # Merge the immutable, authorized SHA rather than re-resolving the mutable branch ref.
  if ! gitq merge --no-ff --no-edit "$delivered_sha" >/dev/null; then
    warn "合并出现冲突——已在主目录停下，冲突文件："
    gitq diff --name-only --diff-filter=U | sed 's/^/    /' >&2
    die "机械性冲突可自行解决并复测；涉及语义请用户批准取舍。禁止整块 ours/theirs"
  fi
  local merge_sha; merge_sha="$(gitq rev-parse HEAD)"
  ok "已合并：$(gitq log --oneline -1)"

  info "合并后集成门禁（功能分支绿灯不替代 develop 门禁）"
  require_real_gates_context
  local report="$REPORTS_DIR/$issue-integration-${merge_sha:0:12}.md" report_tmp synthetic
  report_tmp="$(mktemp "$REPORTS_DIR/.$issue-integration.XXXXXX.tmp")" || die "无法创建集成报告临时文件"
  if synthetic_gate_allowed; then synthetic=1; else synthetic=0; fi
  local gate_out="" rc=0
  gate_out="$(run_gates "$MAIN_DIR" "$report_tmp" "$synthetic")" || rc=$?
  if [ "$rc" -ne 0 ] || [ "$(gitq rev-parse HEAD)" != "$merge_sha" ] || [ -n "$(gitq status --porcelain)" ]; then
    rm -f "$report_tmp"
    audit integrate "issue=$issue merge=$merge_sha result=fail"
    die "集成门禁失败或 develop 在门禁期间变化；develop 已包含合并 $merge_sha，暂停发布并人工处理"
  fi
  [ ! -d "$report" ] && [ ! -L "$report" ] || { rm -f "$report_tmp"; die "集成报告目标异常，状态未更新"; }
  mv -f "$report_tmp" "$report" || { rm -f "$report_tmp"; die "集成报告发布失败，状态未更新"; }
  [ -f "$report" ] || die "集成报告缺失，拒绝标记 integrated"
  # 集成报告同样必须结构完整且真跑过全部门禁。
  local gate_mode; if [ "$synthetic" = "1" ]; then gate_mode=synthetic; else gate_mode=required; fi
  report_validate "$report" "$gate_mode" || die "集成报告结构不完整，拒绝标记 integrated"
  report_gate_query "$report" "$gate_mode" all-pass || die "集成报告未包含全部必需门禁通过结果，拒绝标记 integrated"
  [ "$(gitq -C "$path" rev-parse HEAD)" = "$delivered_sha" ] && [ "$(branch_head "$branch")" = "$delivered_sha" ] || \
    die "功能分支在集成期间变化；develop 只合入已批准 SHA $delivered_sha，任务未标记 integrated"
  json_set "$task" integrated_sha "$merge_sha" || die "无法记录集成 SHA"
  json_set "$task" integrated_at "$(date '+%F %T')" || die "无法记录集成时间"
  json_set "$task" status integrated || die "无法记录集成状态"
  audit integrate "issue=$issue develop_before=$develop_before merge=$merge_sha result=pass"
  ok "集成完成并通过门禁：$report"
  flock -u 6 2>/dev/null || true; exec 6>&-
  task_lock_release
}

github_pr_is_merged() { # <PR number> <delivered SHA> <branch>
  local pr="$1" expected_sha="$2" branch="$3" repo="${DSH_WT_UPSTREAM_REPO:-201222-L/dsh-mobile-remote}" payload
  [[ "$pr" =~ ^[1-9][0-9]{0,8}$ ]] || { warn "PR 编号必须是正整数"; return 1; }
  if [ "${DSH_WT_ALLOW_SYNTHETIC:-0}" = "1" ] && [ -n "${DSH_WT_TEST_MERGED_PR:-}" ]; then
    if [ "$DSH_WT_TEST_MERGED_PR" = "$pr:$expected_sha:$branch" ]; then
      warn "selftest 合成已合并 PR 核验"; return 0
    fi
    warn "selftest 合成 PR 的 SHA/分支不匹配"; return 1
  fi
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { warn "DSH_WT_UPSTREAM_REPO 格式无效"; return 1; }
  command -v curl >/dev/null 2>&1 || { warn "需要 curl 才能核验 GitHub PR 合并状态"; return 1; }
  payload="$(curl --fail --silent --show-error --connect-timeout 5 --max-time 20 \
    -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/pulls/$pr")" || {
      warn "无法读取 $repo PR #$pr；拒绝清理"; return 1;
    }
  printf '%s' "$payload" | python3 -c 'import json,sys
p=json.load(sys.stdin); expected,branch=sys.argv[1:3]
valid=(p.get("merged_at") is not None and p.get("state")=="closed" and
       p.get("base",{}).get("ref")=="main" and
       p.get("head",{}).get("ref")==branch and
       p.get("head",{}).get("sha")==expected)
if not valid:
 print("PR 未合并到 main，或 PR head ref/SHA 与已交付分支不匹配",file=sys.stderr); raise SystemExit(1)' \
    "$expected_sha" "$branch"
}

# ── cleanup ──
cmd_cleanup() {
  local issue="${1:-}" pr="${2:-}"
  [ -n "$issue" ] && [ -n "$pr" ] || die "用法：tools/worktree.sh cleanup <issue> <已合并 PR 编号>"
  [[ "$issue" =~ ^[1-9][0-9]{0,9}$ ]] || die "issue 必须是正整数"
  require_role_integrator
  require_task "$issue"
  task_lock_acquire "$issue"
  cd "$MAIN_DIR" || die "无法进入主目录"
  [ "$(current_branch)" = "develop" ] || die "cleanup 需要主目录固定在 develop"
  require_clean_tree "$MAIN_DIR" "cleanup（主目录）"
  local task; task="$(task_file "$issue")"
  local branch path status delivered_sha branch_sha remote remote_sha delete_scope
  branch="$(json_get "$task" branch)"; path="$(json_get "$task" path)"
  status="$(json_get "$task" status)"; delivered_sha="$(json_get "$task" delivered_sha)"
  case "$status" in integrated|cleaned) ;; *) die "任务状态为 $status；cleanup 仅接受已集成任务" ;; esac
  [ -n "$delivered_sha" ] || die "缺少 delivered_sha，拒绝清理"
  branch_sha="$(branch_head "$branch")"
  [ "$branch_sha" = "$delivered_sha" ] || die "分支 HEAD 已改变；拒绝删除不同于已交付 SHA 的内容"
  require_authorization "$issue" cleanup "$delivered_sha"
  github_pr_is_merged "$pr" "$delivered_sha" "$branch" || die "PR 合并证据未通过核验；未删除任何内容"
  branch_sha="$(branch_head "$branch")"
  [ "$branch_sha" = "$delivered_sha" ] || die "PR 核验期间分支 SHA 变化；拒绝清理"
  if [ -d "$path" ]; then
    [ "$(gitq -C "$path" rev-parse --abbrev-ref HEAD)" = "$branch" ] || die "工作树分支与登记不符"
    [ "$(gitq -C "$path" rev-parse HEAD)" = "$delivered_sha" ] || die "工作树 HEAD 与已交付 SHA 不符"
    require_clean_tree "$path" "cleanup"
    gitq worktree remove "$path" || die "git worktree remove 失败；未删除分支"
  fi

  # 在 branch-delete 之前先持久化清理事实；若状态盘写失败，仍保留本地分支。
  json_set "$task" cleanup_pr "$pr" || die "无法记录已核验 PR；保留分支"
  json_set "$task" status cleaned || die "无法记录清理状态；保留分支"
  json_set "$task" cleaned_at "$(date '+%F %T')" || die "无法记录清理时间；保留分支"

  delete_scope="$(json_get "$task" authorizations.branch-delete.scope_sha)"
  if [ "$delete_scope" = "$delivered_sha" ] && [ "$(branch_head "$branch")" = "$delivered_sha" ]; then
    # 永不 branch -D 兜底；如果 Git 认为分支未合并，就保留其唯一副本并报告。
    if gitq branch -d "$branch" >/dev/null 2>&1; then
      info "已删除本地分支 $branch"
      for remote in github origin; do
        if gitq remote get-url "$remote" >/dev/null 2>&1; then
          remote_sha="$(gitq ls-remote "$remote" "refs/heads/$branch" 2>/dev/null | awk 'NR==1 {print $1}')"
          if [ "$remote_sha" != "$delivered_sha" ]; then
            warn "远端 $remote/$branch SHA 与已批准 SHA 不同或分支不存在；不删除"
            continue
          fi
          # Lease 检查在服务端更新 ref 的原子操作中再次确认，避免 ls-remote 后的竞态。
          gitq push --force-with-lease="refs/heads/$branch:$delivered_sha" "$remote" ":refs/heads/$branch" >/dev/null 2>&1 || \
            warn "远端 $remote/$branch 删除失败/已变化；保留远端状态"
        fi
      done
    else
      warn "本地分支 $branch 尚未被当前 develop 认定为已合并；保留分支，不使用 -D"
    fi
  else
    info "保留本地/远端分支（需另行批准 branch-delete 并绑定 $delivered_sha）"
  fi
  audit cleanup "issue=$issue branch=$branch sha=$delivered_sha pr=$pr"
  ok "已核验合并 PR #$pr；工作树清理完成（任务登记保留）"
  task_lock_release
}

# ── authorize / status ──
cmd_authorize() {
  local issue="${1:-}" action="${2:-}" note="${3:-}"
  [ -n "$issue" ] && [ -n "$action" ] && [ -n "$note" ] || die "用法：tools/worktree.sh authorize <issue> <动作> <用户批准理由>\n授权是人工批准的审计记录，不是身份验证；理由必填并绑定当前分支 SHA。"
  [[ "$issue" =~ ^[1-9][0-9]{0,9}$ ]] || die "issue 必须是正整数"
  [[ "$note" != *$'\n'* && "$note" != *$'\r'* && "$note" != *$'\t'* ]] || die "理由不能包含换行或控制分隔符"
  case "$action" in
    push|force-push|rebase|integrate|cleanup|branch-delete|release|deploy|restart|takeover) ;;
    *) die "未知动作：$action" ;;
  esac
  case "$action" in
    integrate|cleanup|branch-delete|release|deploy|restart|force-push|takeover) require_role_integrator ;;
  esac
  require_task "$issue"
  task_lock_acquire "$issue"
  local task; task="$(task_file "$issue")"
  local branch path status scope delivered
  branch="$(json_get "$task" branch)"; path="$(json_get "$task" path)"
  scope="$(branch_head "$branch")"; status="$(json_get "$task" status)"; delivered="$(json_get "$task" delivered_sha)"
  [ -n "$scope" ] || die "登记分支 $branch 不存在"
  [ "$scope" = "$(gitq -C "$MAIN_DIR" rev-parse "refs/heads/$branch")" ] || die "分支 SHA 无法核对"
  case "$action" in
    integrate) [ "$status" = "delivered" ] && [ "$delivered" = "$scope" ] || die "integrate 授权仅能绑定已交付的当前 SHA" ;;
    cleanup) [ "$status" = "integrated" ] && [ "$delivered" = "$scope" ] || die "cleanup 授权仅能绑定已集成且未变化的 delivered SHA" ;;
    branch-delete) [[ "$status" = integrated || "$status" = cleaned ]] && [ "$delivered" = "$scope" ] || die "branch-delete 授权仅能绑定已集成、未变化的 delivered SHA" ;;
  esac
  python3 - "$task" "$action" "$scope" "$note" "$WHOAMI_ID" <<'PY' | atomic_json_write "$task"
import datetime,json,sys
f,action,scope,note,by=sys.argv[1:6]
with open(f,encoding="utf-8") as src: doc=json.load(src)
doc.setdefault("authorizations",{})[action]={"granted_at":datetime.datetime.now().strftime("%F %T"),
  "scope_sha":scope,"note":note,"recorded_by":by}
json.dump(doc,sys.stdout,ensure_ascii=False)
PY
  audit authorize "issue=$issue action=$action scope=$scope recorded_by=$WHOAMI_ID note=$note"
  ok "已记录授权意向：issue #$issue → $action，绑定 ${scope:0:12}"
  warn "脚本记录授权与调用者自述，无法验证是否确由用户批准；必须以对话中的用户明确批准为准"
  task_lock_release
}

# 在任务创建时记录的 baseline SHA 上重跑同一门禁，作为基线例外的可核验证据。
cmd_verify_baseline() {
  local issue="${1:-}"; [ -n "$issue" ] || die "用法：tools/worktree.sh verify-baseline <issue>"
  [[ "$issue" =~ ^[1-9][0-9]{0,9}$ ]] || die "issue 必须是正整数"
  require_task "$issue"
  task_lock_acquire "$issue"
  local task; task="$(task_file "$issue")"
  local path branch baseline baseline_short base_wt synthetic
  path="$(json_get "$task" path)"; branch="$(gitq -C "$(json_get "$task" path)" rev-parse --abbrev-ref HEAD)"; baseline="$(json_get "$task" baseline)"
  require_writer "$issue" "$path" "$branch"
  baseline_short="${baseline:0:12}"
  local run_id; run_id="$(date +%s%N)-$$-$RANDOM"
  require_real_gates_context
  if synthetic_gate_allowed; then synthetic=1; else synthetic=0; fi
  [ "$synthetic" = "1" ] || [ "${DSH_WT_SKIP_GRADLE:-0}" != "1" ] || die "baseline comparison must run every required gate; DSH_WT_SKIP_GRADLE is not allowed"
  json_task_transition "$task" baseline-begin "$baseline" "$run_id" || die "无法原子开始 baseline 测量状态"
  base_wt="$STATE_DIR/baseline-worktrees/issue-$issue-$run_id"
  mkdir -p "$(dirname "$base_wt")" "$REPORTS_DIR"
  [ ! -e "$base_wt" ] || die "基线临时工作树路径已存在：$base_wt"
  gitq worktree add --detach "$base_wt" "$baseline" >/dev/null || die "无法创建 baseline 临时工作树"
  # 实验树也必须登记为"正在测量"，任何中途退出都不能留下旧证据。
  local baseline_clean_before baseline_head_before
  baseline_head_before="$baseline"
  baseline_clean_before="$(gitq -C "$base_wt" status --porcelain)"

  local rc=0 setup_rc=0 report_tmp final_report gate_out
  report_tmp="$(mktemp "$REPORTS_DIR/.$issue-baseline.XXXXXX.tmp")" || { gitq worktree remove "$base_wt" >/dev/null 2>&1 || true; die "无法创建 baseline 报告临时文件"; }
  if [ "$synthetic" != "1" ]; then
    export PUB_CACHE="${PUB_CACHE:-$REAL_HOME/.pub-cache}"
    export PATH="/home/mark/sdk/flutter/bin:/home/mark/sdk/jdk17/bin:$PATH"
    export JAVA_HOME="${JAVA_HOME:-/home/mark/sdk/jdk17}"
    export ANDROID_HOME="${ANDROID_HOME:-/home/mark/sdk/android}"
    export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
    export GRADLE_USER_HOME="${GRADLE_USER_HOME:-$REAL_HOME/.gradle}"
    export FLUTTER_STORAGE_BASE_URL="${FLUTTER_STORAGE_BASE_URL:-https://storage.flutter-io.cn}"
    local lock="$base_wt/dsh-mobile-app/pubspec.lock"
    if grep -q 'pub\.dev' "$lock"; then export PUB_HOSTED_URL=https://pub.dev
    else export PUB_HOSTED_URL=https://pub.flutter-io.cn; fi
    (exec 7>&-; cd "$base_wt" && npm install --no-audit --no-fund --no-package-lock --loglevel=error) || setup_rc=1
    [ "$setup_rc" -ne 0 ] || (exec 7>&-; cd "$base_wt/dsh-mobile-app" && flutter pub get >/dev/null) || setup_rc=1
    local wrapper_dir="$base_wt/dsh-mobile-app/android/gradle/wrapper"
    local sdk_wrapper="/home/mark/sdk/flutter/bin/cache/artifacts/gradle_wrapper"
    mkdir -p "$wrapper_dir"
    if [ -x "$sdk_wrapper/gradlew" ]; then cp -p "$sdk_wrapper/gradlew" "$base_wt/dsh-mobile-app/android/gradlew" && chmod +x "$base_wt/dsh-mobile-app/android/gradlew" || setup_rc=1; else setup_rc=1; fi
    if [ -f "$sdk_wrapper/gradle/wrapper/gradle-wrapper.jar" ]; then cp -p "$sdk_wrapper/gradle/wrapper/gradle-wrapper.jar" "$wrapper_dir/" || setup_rc=1; else setup_rc=1; fi
    # Keep the baseline's tracked distribution URL/version; never copy develop's wrapper config.
    if [ ! -f "$wrapper_dir/gradle-wrapper.properties" ]; then
      gitq -C "$base_wt" show "$baseline:dsh-mobile-app/android/gradle/wrapper/gradle-wrapper.properties" \
        >"$wrapper_dir/gradle-wrapper.properties" 2>/dev/null || setup_rc=1
    fi
  fi
  # 依赖安装本身不得改动基线跟踪文件；否则测的就不是这个基线提交。
  if [ "$setup_rc" -eq 0 ]; then
    if [ "$(gitq -C "$base_wt" rev-parse HEAD)" != "$baseline_head_before" ] || [ -n "$(gitq -C "$base_wt" status --porcelain)" ]; then
      warn "基线依赖安装改动了跟踪文件；该测量不代表 $baseline_short"
      rc=3
    fi
  else
    warn "基线依赖安装失败；无法在该基线上留证"
    rc=2
  fi
  if [ "$rc" -eq 0 ]; then
    gate_out="$(cd "$base_wt" && run_gates "$base_wt" "$report_tmp" "$synthetic")" || rc=$?
  elif [ "$rc" -ne 2 ]; then
    printf 'baseline source tree changed before gates\n' >"$report_tmp" || rc=2
    gate_out="FAIL  baseline-source-integrity"
  fi
  # 门禁结束必须仍在同一提交且干净，否则证据无效。
  local baseline_head_after baseline_dirty_after
  baseline_head_after="$(gitq -C "$base_wt" rev-parse HEAD 2>/dev/null || echo '')"
  baseline_dirty_after="$(gitq -C "$base_wt" status --porcelain 2>/dev/null)"
  if [ "$baseline_head_after" != "$baseline_head_before" ] || [ -n "$baseline_dirty_after" ] || [ -n "$baseline_clean_before" ]; then
    warn "基线测量期间源树被改动或起始就不干净；不登记该证据"
    rc=3
  fi
  # rc 语义：0=全绿；1=门禁失败（这正是基线红灯，是有效证据）；2=依赖/报告/环境失败；3=源树不干净或 HEAD 变化。
  if [ "$rc" -ge 2 ] || [ ! -s "$report_tmp" ]; then
    rm -f "$report_tmp"
    gitq worktree remove --force "$base_wt" >/dev/null 2>&1 || warn "baseline 临时工作树需手动检查：$base_wt"
    task_lock_release
    die "baseline 证据无效（rc=$rc）：仅在干净、依赖装好且 HEAD 未变的基线上才能留证"
  fi
  final_report="$REPORTS_DIR/$issue-baseline-$baseline_short-$run_id.md"
  local combined; combined="$(mktemp "$REPORTS_DIR/.$issue-baseline-combined.XXXXXX.tmp")" || die "无法创建组合报告"
  {
    printf '# Baseline verification\n- Issue: #%s\n- Baseline SHA: `%s`\n- Measured at: %s\n\n' "$issue" "$baseline" "$(date '+%F %T')"
    cat "$report_tmp"
  } >"$combined" || { rm -f "$report_tmp" "$combined"; die "无法组合 baseline 报告"; }
  [ -s "$combined" ] || { rm -f "$report_tmp" "$combined"; die "baseline 报告为空"; }
  [ ! -d "$final_report" ] && [ ! -L "$final_report" ] || { rm -f "$report_tmp" "$combined"; die "baseline 报告目标异常"; }
  mv -f "$combined" "$final_report" || { rm -f "$report_tmp" "$combined"; die "无法原子发布 baseline 报告"; }
  rm -f "$report_tmp"
  if ! gitq worktree remove --force "$base_wt" >/dev/null 2>&1; then
    rm -f "$final_report"
    task_lock_release
    die "基线临时工作树无法移除（$base_wt）；证据未登记，请人工处理后重跑 verify-baseline"
  fi
  report_has_commit "$final_report" "$baseline" || die "baseline 报告提交 SHA 不匹配；证据状态保持 running"
  local baseline_mode; if [ "$synthetic" = "1" ]; then baseline_mode=synthetic; else baseline_mode=required; fi
  report_validate "$final_report" "$baseline_mode" || die "baseline 报告结构不完整；证据状态保持 running"
  local failed; failed="$(report_failed_gates "$final_report" "$baseline_mode")" || die "无法从 baseline 报告解析失败门禁"
  json_task_transition "$task" baseline-finish "$baseline" "$final_report" "$failed" "$run_id" || die "无法原子登记 baseline 报告，状态保持 running"
  audit verify-baseline "issue=$issue baseline=$baseline gates=$failed"
  ok "基线门禁证据已保存：$final_report（失败：${failed:-无}）"
  task_lock_release
}

# 门禁例外必须有同一环境、同一基线提交的实测报告，并且失败门禁集合完全一致。
cmd_authorize_exception() {
  local issue="${1:-}" sha="${2:-}" gates="${3:-}" baseline_report="${4:-}" note="${5:-}"
  [ -n "$issue" ] && [ -n "$sha" ] && [ -n "$gates" ] && [ -n "$baseline_report" ] && [ -n "$note" ] || \
    die "用法：tools/worktree.sh authorize-exception <issue> <提交SHA> <失败门禁> <baseline-report路径> <用户批准理由>"
  [[ "$issue" =~ ^[1-9][0-9]{0,9}$ ]] || die "issue 必须是正整数"
  [[ "$note" != *$'\n'* && "$note" != *$'\r'* && "$note" != *$'\t'* ]] || die "理由不能包含换行或控制分隔符"
  require_task "$issue"
  task_lock_acquire "$issue"
  local task; task="$(task_file "$issue")"
  local actual_sha actual_gates baseline baseline_sha baseline_gates branch path current_report current_gates baseline_state current_kinds baseline_kinds
  actual_sha="$(json_get "$task" last_failed_sha)"; actual_gates="$(json_get "$task" last_failed_gates)"
  require_role_integrator
  baseline="$(json_get "$task" baseline)"; branch="$(json_get "$task" branch)"; path="$(json_get "$task" path)"
  [ "$(json_get "$task" verification_state)" = "failed" ] || die "最近 verify 未完成为失败（可能仍在运行/中断）；先重新验证"
  [ "$sha" = "$actual_sha" ] || die "例外 SHA 不等于最近失败 SHA"
  local current_branch; current_branch="$(gitq -C "$path" rev-parse --abbrev-ref HEAD)"
  require_registered_branch "$issue" "$path" "$current_branch"
  [ "$sha" = "$(gitq -C "$path" rev-parse HEAD)" ] || die "失败后提交已变化，例外失效"
  [ "$gates" = "$actual_gates" ] || die "例外门禁集合与实际失败集合不一致"
  current_report="$(json_get "$task" last_report)"
  [ -f "$current_report" ] && report_has_commit "$current_report" "$sha" || die "最近失败报告缺失或 SHA 不匹配"
  local exc_mode; exc_mode="$(report_evidence_mode "$current_report")" || die "最近失败报告结构不完整"
  if [ "$exc_mode" = "synthetic" ] && ! synthetic_gate_allowed; then die "合成门禁报告不能用于真实仓库例外"; fi
  report_validate "$current_report" "$exc_mode" || die "最近失败报告结构不完整"
  current_gates="$(report_failed_gates "$current_report" "$exc_mode")" || die "无法解析失败报告"
  [ "$current_gates" = "$gates" ] || die "失败报告实际门禁集合与登记失败集合不一致"
  current_kinds="$(report_gate_query "$current_report" "$exc_mode" kinding)" || die "无法解析失败报告门禁类别"
  # 跳过或缺失的门禁不属于"基线红灯"，不能靠同名基线失败开例外。
  case "$current_kinds" in
    *skipped*|*missing*|*not-run*|*lock-timeout*|*source-changed*)
      die "当前失败包含未实际执行的门禁（$current_kinds）：跳过/缺失不可作为基线例外" ;;
  esac
  [ "$baseline_report" = "$(json_get "$task" last_baseline_report)" ] && [ -f "$baseline_report" ] || die "报告不是本任务最近一次 verify-baseline 产生的报告"
  baseline_state="$(json_get "$task" baseline_verification_state)"
  [ "$baseline_state" = "complete" ] || die "baseline 验证正在运行或中断，不能授权例外"
  baseline_sha="$(json_get "$task" last_baseline_sha)"; baseline_gates="$(json_get "$task" last_baseline_failed_gates)"
  [ "$baseline_sha" = "$baseline" ] && [ "$(json_get "$task" baseline_attempt_sha)" = "$baseline" ] || die "基线报告 SHA 与任务创建基线不一致"
  [ "$baseline_gates" = "$gates" ] || die "基线失败门禁（$baseline_gates）与当前失败（$gates）不完全一致"
  report_validate "$baseline_report" "$exc_mode" || die "baseline 报告结构不完整"
  baseline_kinds="$(report_gate_query "$baseline_report" "$exc_mode" kinding)" || die "无法解析 baseline 报告门禁类别"
  [ -n "$current_kinds" ] && [ "$current_kinds" = "$baseline_kinds" ] || \
    die "当前失败与基线失败的执行类别不一致（$current_kinds vs $baseline_kinds）"
  [ "$(report_failed_gates "$baseline_report" "$exc_mode")" = "$gates" ] && report_has_commit "$baseline_report" "$baseline" || die "baseline 报告实际失败集合/SHA 不匹配"
  python3 - "$task" "$sha" "$gates" "$baseline_report" "$baseline" "$note" "$WHOAMI_ID" <<'PY' | atomic_json_write "$task"
import datetime,json,sys
f,sha,gates,report,baseline,note,by=sys.argv[1:8]
with open(f,encoding="utf-8") as src: doc=json.load(src)
doc.setdefault("authorizations",{})["exception"]={"granted_at":datetime.datetime.now().strftime("%F %T"),
  "granted_sha":sha,"gates":gates,"baseline_report":report,"baseline_sha":baseline,"note":note,"recorded_by":by}
json.dump(doc,sys.stdout,ensure_ascii=False)
PY
  audit authorize-exception "issue=$issue sha=$sha gates=$gates baseline=$baseline"
  ok "已记录经基线实测支持的例外：issue #$issue ${sha:0:12} → $gates"
  warn "此处记录理由与证据，不验证人工批准来源；必须先获用户明确批准"
  task_lock_release
}

cmd_status() {
  init_state_dirs
  local target="${1:-}"
  shopt -s nullglob
  local files=("$TASKS_DIR"/*.json)
  shopt -u nullglob
  [ "${#files[@]}" -gt 0 ] || { info "还没有任务登记"; return 0; }
  local f
  for f in "${files[@]}"; do
    local issue; issue="$(json_get "$f" issue)"
    [ -n "$target" ] && [ "$target" != "--all" ] && [ "$target" != "$issue" ] && continue
    printf 'issue #%s  [%s]\n' "$issue" "$(json_get "$f" status)"
    printf '  分支 %s\n  路径 %s\n  写入者 %s\n  基线 %s\n' \
      "$(json_get "$f" branch)" "$(json_get "$f" path)" "$(json_get "$f" writer)" "$(json_get "$f" baseline)"
    local auth; auth="$(json_get "$f" authorizations)"
    [ "$auth" != "" ] && [ "$auth" != "{}" ] && printf '  授权 %s\n' "$(python3 -c "
import json,sys;d=json.load(open(sys.argv[1])).get('authorizations',{})
print(', '.join(sorted(d.keys())) or '（无）')" "$f")"
    printf '  最近验证 %s\n' "$(json_get "$f" last_verified_sha)"
  done
}

usage() {
  cat <<'USAGE'
工作树生命周期管理（AGENT-RULES「工作树生命周期」）。

一个 issue = 一个分支 = 一棵工作树 = 一个写入者；不同 issue 并行，集成与发布串行。
本脚本是协作式防护：检查角色、工作树归属、脏树与并发限额，用于防误操作。
所有 agent 以同一系统用户运行，脚本无法阻止绕过——绕过即违规（见 AGENT-RULES）。

用法（create/integrate 在主目录调用；init/verify/deliver 在任何工作树里调用）：

  tools/worktree.sh create <issue> <短名> [--kind feature|fix] [--writer <身份>]
  tools/worktree.sh init                     # 当前树：装依赖、补构建环境（不共享生成物）
  tools/worktree.sh verify                   # 当前树：干净树跑门禁，原子写证据
  tools/worktree.sh verify-baseline <issue>  # 登记的基线 SHA 同环境复跑门禁留证
  tools/worktree.sh deliver                  # 必须有对应当前 SHA 的验证/批准例外证据
  tools/worktree.sh integrate <issue>        # 只合并已交付且 SHA 未变化的任务
  tools/worktree.sh cleanup <issue> <PR>     # 核验上游 PR 合并和 head SHA 后清理
  tools/worktree.sh authorize <issue> <动作> <批准理由>
                                             # 记录人工批准意向，绑定当前分支 SHA
  tools/worktree.sh authorize-exception <issue> <提交> <失败门禁> <基线报告> <批准理由>
                                             # 基线报告同门禁实测后，记录指定 SHA 的例外
  tools/worktree.sh status [issue|--all]     # 查看任务登记与授权

授权动作：push force-push rebase integrate cleanup branch-delete release deploy restart takeover

环境变量（一般不设）：
  DSH_WT_ROLE=integrator    以集成/发布执行者身份运行（integrate 必需）
  DSH_WT_MAIN               主目录（默认：git 报告的 main worktree）
  DSH_WT_ROOT               新工作树存放目录（默认 <主目录父级>/dsh-mobile-remote-worktrees）
  DSH_WT_STATE              运行状态目录（默认 ~/.local/state/dsh-mobile-remote-workflow）
  DSH_WT_ALLOW_SYNTHETIC=1  允许合成门禁（仅供 tools/worktree-selftest.sh 使用）
USAGE
}

case "${1:-}" in
  create) shift; cmd_create "$@" ;;
  init) shift; cmd_init "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  verify-baseline) shift; cmd_verify_baseline "$@" ;;
  deliver) shift; cmd_deliver "$@" ;;
  integrate) shift; cmd_integrate "$@" ;;
  cleanup) shift; cmd_cleanup "$@" ;;
  authorize) shift; cmd_authorize "$@" ;;
  authorize-exception) shift; cmd_authorize_exception "$@" ;;
  status) shift; cmd_status "$@" ;;
  ""|-h|--help|help) usage ;;
  *) die "未知子命令：$1（用 --help 查看用法）" ;;
esac
