#!/usr/bin/env bash
# 由 agent 以 setsid 分离运行：给会话留出收尾时间后重启 systemd 托管的 dsh-web。
# 只发 SIGTERM，不自己拉起进程——由 dsh-web.service 的 Restart=always 用正确参数重启。
set -u
LOG="$HOME/.dsh/dsh-web-restart.log"
TARGET_PID="${1:?usage: restart-dsh-web-service.sh <pid> [delay]}"
DELAY="${2:-20}"

sleep "$DELAY"
echo "=== service restart begin $(date '+%F %T') ===" >> "$LOG"

if ! ps -p "$TARGET_PID" -o cmd= 2>/dev/null | grep -q 'bin/dsh'; then
  echo "target pid $TARGET_PID is no longer a dsh process; aborting" >> "$LOG"
  echo "=== service restart end $(date '+%F %T') ===" >> "$LOG"
  exit 0
fi

echo "stopping pid $TARGET_PID ($(ps -p "$TARGET_PID" -o cmd= | cut -c1-100))" >> "$LOG"
kill -TERM "$TARGET_PID" 2>/dev/null

for i in $(seq 1 120); do
  if ! kill -0 "$TARGET_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
if kill -0 "$TARGET_PID" 2>/dev/null; then
  echo "force killing $TARGET_PID" >> "$LOG"
  kill -KILL "$TARGET_PID" 2>/dev/null
fi

NEW_PID=""
for i in $(seq 1 120); do
  NEW_PID="$( { ss -tlnp 2>/dev/null | grep ':3080 ' | grep -oP 'pid=\K[0-9]+'; } | head -1 )"
  [ -n "$NEW_PID" ] && break
  sleep 0.5
done

if [ -n "$NEW_PID" ]; then
  echo "smoke OK: port 3080 up (pid $NEW_PID)" >> "$LOG"
else
  echo "SMOKE FAIL: port 3080 not listening after restart" >> "$LOG"
fi
echo "=== service restart end $(date '+%F %T') ===" >> "$LOG"
