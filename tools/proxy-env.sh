# tools/proxy-env.sh — 环境特定配置（代理 + 工具链路径）的唯一实现
# （由 tools/worktree.sh source，issue #57/#51）。
#
# 这些值属于本机/本容器信息，**不进版本库**：放在主目录的 .env（已 gitignore）。
# 支持的键（值可带引号）：
#   DSH_PROXY_ENABLED=1|0              总开关，缺省 0（不设代理）
#   DSH_PROXY_HTTP=http://host:port    HTTP(S) 代理，用于环境变量形式
#   DSH_PROXY_SOCKS=socks5://host:port SOCKS5 代理，用于 Gradle -DsocksProxy*
#   DSH_FLUTTER_SDK=/path               Flutter SDK（缺省 /home/mark/sdk/flutter）
#   DSH_JAVA_HOME=/path                 JDK（缺省 /home/mark/sdk/jdk17）
#   DSH_ANDROID_HOME=/path              Android SDK（缺省 /home/mark/sdk/android；
#                                        ANDROID_SDK_ROOT 始终跟随解析结果）
#   DSH_PUB_CACHE=/path                 pub 缓存（缺省 $HOME/.pub-cache）
#   DSH_GRADLE_USER_HOME=/path          Gradle 缓存（缺省 $HOME/.gradle）
# 只解析这些键，忽略其余内容；不 source，避免执行任意代码。
DSH_ENV_KEYS="DSH_PROXY_ENABLED DSH_PROXY_HTTP DSH_PROXY_SOCKS DSH_FLUTTER_SDK DSH_JAVA_HOME DSH_ANDROID_HOME DSH_PUB_CACHE DSH_GRADLE_USER_HOME"

# 本模块也可被自测直接 source：没有调用方的 die() 时给一个等价的失败出口。
if ! declare -F die >/dev/null 2>&1; then
  die() { printf '✗ %s\n' "$*" >&2; exit 1; }
fi

read_proxy_env() {
  local file="$1"
  local k; for k in $DSH_ENV_KEYS; do eval "$k=\"\""; done
  [ -e "$file" ] || return 0
  # 文件存在却读不到时不能静默降级：否则代理与工具链路径会全部丢失，而门禁照常运行，
  # 看起来"通过"却是在无配置状态下跑的。直接停下并说明原因（唯一解析点，只在这里判断）。
  [ -r "$file" ] || die ".env 存在但当前用户不可读：$file（检查属主/权限，例如 chown 给运行用户）"
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//')"
    case " $DSH_ENV_KEYS " in
      *" $key "*) eval "$key=\"\$val\"" ;;
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

# 把已解析的代理意图落到当前 shell（不读文件；供 apply_proxy_env / apply_toolchain_env
# 在同一次解析后复用，避免重复读文件与重复 fail-closed 判断）。
apply_proxy_values() {
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

# 把 .env 的代理意图落到当前 shell；无 .env 或未启用则完全不设代理。
apply_proxy_env() {
  local envfile="$1"
  read_proxy_env "$envfile"
  apply_proxy_values
}

# 把 .env 里的 SDK 路径/缓存目录落到当前 shell；未配置则回退脚本内置约定值。
# 顺序：已有环境变量 > .env > 内置默认。PATH 只追加缺失项，多次调用不累积。
apply_toolchain_env() {
  local envfile="$1"
  read_proxy_env "$envfile"
  local real_home="${REAL_HOME:-$HOME}"
  local flutter="${DSH_FLUTTER_SDK:-${FLUTTER_ROOT:-/home/mark/sdk/flutter}}"
  local java="${DSH_JAVA_HOME:-${JAVA_HOME:-/home/mark/sdk/jdk17}}"
  local android="${DSH_ANDROID_HOME:-${ANDROID_HOME:-/home/mark/sdk/android}}"
  export FLUTTER_ROOT="$flutter"
  export JAVA_HOME="$java"
  export ANDROID_HOME="$android"
  # SDK_ROOT 跟随本次解析结果，避免 .env 覆盖 ANDROID_HOME 后两者不一致。
  export ANDROID_SDK_ROOT="$android"
  export PUB_CACHE="${DSH_PUB_CACHE:-${PUB_CACHE:-$real_home/.pub-cache}}"
  export GRADLE_USER_HOME="${DSH_GRADLE_USER_HOME:-${GRADLE_USER_HOME:-$real_home/.gradle}}"
  case ":$PATH:" in *":$flutter/bin:"*) : ;; *) export PATH="$flutter/bin:$PATH" ;; esac
  case ":$PATH:" in *":$java/bin:"*) : ;; *) export PATH="$java/bin:$PATH" ;; esac
  case ":$PATH:" in *":$android/platform-tools:"*) : ;; *) export PATH="$android/platform-tools:$PATH" ;; esac
  DSH_FLUTTER_BIN="$flutter/bin"
  DSH_GRADLE_WRAPPER="$flutter/bin/cache/artifacts/gradle_wrapper"
  apply_proxy_values
}
