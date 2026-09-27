#!/usr/bin/env bash
# 由 agent 分离运行：给会话留出收尾时间后重启 systemd 托管的 dsh-web。
# 只发 SIGTERM，不自己拉起进程——由 dsh-web.service 的 Restart=always 用正确参数重启。
#
# cgroup 自逃逸（2026-09-28 实测）：agent 的 bash 工具进程运行在 `/system.slice/dsh-web.service`
# 的 cgroup 内；systemd 默认 KillMode=control-group，重启时会连同 cgroup 里所有进程一起
# SIGTERM——`setsid`/`nohup` 都改不了 cgroup 归属，脚本会在重启中途被杀（smoke 日志缺失）。
# 因此先自检 cgroup：命中 dsh-web.service 就用 systemd-run --user 换到用户级瞬态单元再跑。
set -u
LOG="${LOG:-$HOME/.dsh/dsh-web-restart.log}"
TARGET_PID="${1:?usage: restart-dsh-web-service.sh <pid> [delay]}"
DELAY="${2:-20}"

# 逃逸后的子进程会先写这个 marker：父进程据此确认「单元真的起来了」，
# 否则（脚本路径/环境问题）静默失败会让重启根本没发生。
if [ -n "${DSH_RESTART_ESCAPE_MARKER:-}" ]; then
  : >"$DSH_RESTART_ESCAPE_MARKER" 2>/dev/null || true
fi

# ── 自逃逸：换到用户级瞬态单元，脱离 dsh-web.service 的 cgroup ──
if [ "${DSH_RESTART_ESCAPED:-0}" != "1" ] \
   && grep -q 'dsh-web\.service' /proc/self/cgroup 2>/dev/null; then
  # 必须用绝对路径：用户级单元的工作目录不是调用方目录，相对路径会静默失败。
  SELF="$0"
  case "$SELF" in
    /*) ;;
    *) SELF="$(cd "$(dirname "$SELF")" 2>/dev/null && pwd)/$(basename "$SELF")" ;;
  esac
  if command -v systemd-run >/dev/null 2>&1 && [ -f "$SELF" ]; then
    export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
    ESCAPE_UNIT="dsh-web-restart-self-$(date '+%Y%m%d-%H%M%S')"
    MARKER="$(mktemp -u "${TMPDIR:-/tmp}/dsh-web-escape.XXXXXX")"
    if systemd-run --user --unit="$ESCAPE_UNIT" --collect \
         --setenv=HOME="$HOME" \
         --setenv=LOG="$LOG" \
         --setenv=DSH_RESTART_ESCAPED=1 \
         --setenv=DSH_RESTART_ESCAPE_MARKER="$MARKER" \
         --setenv=PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}" \
         /bin/bash "$SELF" "$TARGET_PID" "$DELAY" >/dev/null 2>&1; then
      for i in $(seq 1 20); do
        [ -e "$MARKER" ] && break
        sleep 0.25
      done
      if [ -e "$MARKER" ]; then
        rm -f "$MARKER"
        echo "escaped to user unit $ESCAPE_UNIT (target=$TARGET_PID delay=${DELAY}s)" >> "$LOG"
        exit 0
      fi
      echo "escape unit $ESCAPE_UNIT started but never reported in; running in place (restart may be interrupted)" >> "$LOG"
    else
      echo "cgroup escape via systemd-run failed; running in place (restart may be interrupted)" >> "$LOG"
    fi
    rm -f "$MARKER"
  else
    echo "systemd-run/脚本路径不可用（SELF=$SELF）；就地运行（重启可能被中断）" >> "$LOG"
  fi
fi

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
