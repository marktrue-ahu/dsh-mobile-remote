# tools/proxy-env.sh — 代理环境声明的唯一实现（由 tools/worktree.sh source）。
#
# 代理地址与开关属于本机/本容器信息，**不进版本库**：放在主目录的 .env（已 gitignore）。
# 支持三类写法（值可带引号）：
#   DSH_PROXY_ENABLED=1|0          总开关，缺省 0（不设代理）
#   DSH_PROXY_HTTP=http://host:port   HTTP(S) 代理，用于环境变量形式
#   DSH_PROXY_SOCKS=socks5://host:port   SOCKS5 代理，用于 Gradle -DsocksProxy*
# 只解析这三个键，忽略其余内容；不 source，避免执行任意代码。

read_proxy_env() {
  local file="$1"
  DSH_PROXY_ENABLED=""; DSH_PROXY_HTTP=""; DSH_PROXY_SOCKS=""
  [ -f "$file" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//')"
    case "$key" in
      DSH_PROXY_ENABLED) DSH_PROXY_ENABLED="$val" ;;
      DSH_PROXY_HTTP) DSH_PROXY_HTTP="$val" ;;
      DSH_PROXY_SOCKS) DSH_PROXY_SOCKS="$val" ;;
      *) : ;;
    esac
  done < "$file"
}

# 本机回环地址：永远不走代理。
# 背景（issue #57）：`flutter test` 的 flutter_tester 通过 ws://127.0.0.1:<port> 回连
# 测试设备；若代理变量生效而没有 NO_PROXY，回连会被代理接管，门禁永久卡在
# "awaiting connection to test device"。Gradle/Node 侧的本机回连同理。
PROXY_LOOPBACK_NO_PROXY="127.0.0.1,localhost,::1"

# 把 NO_PROXY 与默认回环项合并：保留调用方已有值（不覆盖、不去重语义），
# 只追加缺失的回环项；大小写与空白不敏感。结果写入 NO_PROXY / no_proxy。
merge_no_proxy_defaults() {
  local existing="${NO_PROXY:-${no_proxy:-}}"
  local merged entry lower_existing
  if [ -z "$existing" ]; then
    merged="$PROXY_LOOPBACK_NO_PROXY"
  else
    merged="$existing"
    lower_existing=", $(printf '%s' "$existing" | tr '[:upper:]' '[:lower:]' | tr -d ' '),"
    local IFS=','
    for entry in $PROXY_LOOPBACK_NO_PROXY; do
      case "$lower_existing" in
        *",$entry,"*) : ;;
        *) merged="$merged,$entry" ;;
      esac
    done
    unset IFS
  fi
  export NO_PROXY="$merged" no_proxy="$merged"
}

# 把 .env 的代理意图落到当前 shell；无 .env 或未启用则完全不设代理。
apply_proxy_env() {
  local envfile="$1"
  read_proxy_env "$envfile"
  [ "${DSH_PROXY_ENABLED:-0}" = "1" ] || return 0
  local proxied=0
  if [ -n "${DSH_PROXY_HTTP:-}" ]; then
    export HTTP_PROXY="$DSH_PROXY_HTTP" HTTPS_PROXY="$DSH_PROXY_HTTP"
    export http_proxy="$DSH_PROXY_HTTP" https_proxy="$DSH_PROXY_HTTP"
    proxied=1
  fi
  if [ -n "${DSH_PROXY_SOCKS:-}" ]; then
    export ALL_PROXY="$DSH_PROXY_SOCKS" all_proxy="$DSH_PROXY_SOCKS"
    # Gradle/JVM 不认 ALL_PROXY，需要拆成 -DsocksProxyHost/Port。
    local hp="${DSH_PROXY_SOCKS#*://}"
    local host="${hp%%:*}"; local port="${hp##*:}"
    if [ -n "$host" ] && [ -n "$port" ] && [ "$port" != "$host" ]; then
      export GRADLE_OPTS="${GRADLE_OPTS:--DsocksProxyHost=$host -DsocksProxyPort=$port}"
    fi
    proxied=1
  fi
  [ "$proxied" = "1" ] && merge_no_proxy_defaults
  return 0
}
