#!/usr/bin/env bash
# 发布后自检（AGENT-RULES「发布」第 9 步）：等 dsh-web 被新 pid 接管 3080 后，用**真实数据**
# 抽查 bootstrap capabilities、更新端点与本次发布受影响的插件端点（不是只看 200）。
#
# 用法（必须脱离 dsh-web.service 的 cgroup，否则服务重启会把它一起 SIGTERM；见
# restart-dsh-web-service.sh 顶部说明）：
#   PID=$(ss -tlnp | grep ':3080 ' | grep -oP 'pid=\K[0-9]+' | head -1)
#   export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
#   systemd-run --user --unit=dsh-web-postcheck-$(date +%H%M%S) --collect \
#     --setenv=HOME="$HOME" /bin/bash tools/postrestart-check.sh "$PID" 240
#
# 与重启脚本同时排定即可（本脚本会轮询等待新 pid）。证据写入 $LOG（默认
# ~/.dsh/dsh-web-postrestart-check.log）；全部 PASS 退出 0，任一 FAIL 退出 1。
set -u
OLD_PID="${1:?usage: postrestart-check.sh <old_pid> [timeout_seconds]}"
TIMEOUT="${2:-240}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${LOG:-$HOME/.dsh/dsh-web-postrestart-check.log}"
PATCH_YML="${PATCH_YML:-$HOME/.dsh/profiles/web/cordis.patch.yml}"
BASE="${BASE:-http://127.0.0.1:3080}"
CURL="${CURL:-/usr/bin/curl}"
PY="${PY:-/usr/bin/python3}"

# 期望版本：默认取仓库 pubspec.yaml 的 X.Y.Z+N（发布后 manifest 应与之相同）
EXPECT_VERSION="${EXPECT_VERSION:-$(sed -nE 's/^version:[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+\+[0-9]+).*/\1/p' "$REPO_DIR/dsh-mobile-app/pubspec.yaml" | head -1)}"

FAILED=0
log() { echo "$*" >>"$LOG"; }
check() { # check <ok:0|1> <message>
  if [ "$1" -eq 0 ]; then log "PASS $2"; else log "FAIL $2"; FAILED=1; fi
}
api() { $CURL -s -m 20 -H "X-Mobile-Token: $TOKEN" "$BASE$1"; }

TOKEN="$(grep -oP 'authToken:\s*\K.*' "$PATCH_YML" 2>/dev/null | tr -d '"')"
log "=== postrestart check begin $(date '+%F %T') (old_pid=$OLD_PID expect=$EXPECT_VERSION) ==="
if [ -z "$TOKEN" ]; then
  log "FAIL 未取到 authToken（$PATCH_YML）"
  log "=== postrestart check end $(date '+%F %T') ==="
  exit 1
fi

# 1) 端口是否已由新 pid 接管
NEW_PID=""
deadline=$((SECONDS + TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
  cand="$(ss -tlnp 2>/dev/null | grep ':3080 ' | grep -oP 'pid=\K[0-9]+' | head -1)"
  if [ -n "$cand" ] && [ "$cand" != "$OLD_PID" ]; then NEW_PID="$cand"; break; fi
  sleep 1
done
if [ -z "$NEW_PID" ]; then
  check 1 "端口未由新进程接管（old_pid=$OLD_PID 仍在监听或无人监听）"
  log "=== postrestart check end $(date '+%F %T') ==="
  exit 1
fi
check 0 "端口已由新 pid 接管：$NEW_PID（旧 $OLD_PID）"
log "     新进程: $(ps -p "$NEW_PID" -o lstart=,cmd= 2>/dev/null | cut -c1-120)"

# 2) bootstrap：capabilities
api /m/api/bootstrap | $PY -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception as e: print("FAIL bootstrap 不是合法 JSON:",e); raise SystemExit
caps=(d.get("capabilities") or {})
print("PASS bootstrap ok=",d.get("ok"),"capabilities=",sorted(caps.keys()))
et=caps.get("eventTimeline") or {}
if et.get("version")!=1: print("FAIL eventTimeline capability 异常:",et)
' >>"$LOG" 2>&1

# 3) 更新端点：manifest 版本应等于仓库版本，且 size/sha256 可校验
api /m/api/update/manifest | EXPECT_VERSION="$EXPECT_VERSION" $PY -c '
import json,os,sys
d=json.load(sys.stdin); m=d.get("manifest") or {}
exp=os.environ["EXPECT_VERSION"]
ok = bool(d.get("ok")) and (not exp or m.get("version")==exp)
print(("PASS" if ok else "FAIL"),"update/manifest version=",m.get("version"),"expect=",exp,
      "size=",m.get("size"),"sha256=",str(m.get("sha256"))[:16])
' >>"$LOG" 2>&1

# 4) 真实数据抽查：会话配置（模型/推理强度）+ 模型目录
SID="$(api /m/api/sessions | $PY -c '
import json,sys
d=json.load(sys.stdin); ss=d.get("sessions") or []
print(ss[0].get("id") if ss else "")
')"
if [ -n "$SID" ]; then
  api "/m/api/session-config?sessionId=$SID" | $PY -c '
import json,sys
d=json.load(sys.stdin); c=d.get("config") or {}
print(("PASS" if d.get("ok") else "FAIL"),"session-config ok=",d.get("ok"),
      "model=",c.get("model"),"provider=",c.get("provider"),"reasoningEffort=",c.get("reasoningEffort"))
' >>"$LOG" 2>&1
else
  check 1 "无法取到真实 sessionId，session-config 未抽查"
fi
api '/m/api/catalog?refresh=1' | $PY -c '
import json,sys
d=json.load(sys.stdin); c=d.get("catalog") or {}
models=c.get("models") or d.get("models") or []
print(("PASS" if d.get("ok") else "FAIL"),"catalog?refresh=1 ok=",d.get("ok"),"models=",len(models))
' >>"$LOG" 2>&1

log "=== postrestart check end $(date '+%F %T') (failed=${FAILED}) ==="
exit "$FAILED"
