#!/usr/bin/env bash
# Archive a release (Linux/WSL，与 package-release.ps1 等价)，并生成自动更新主机源的 manifest.json（App 3.0.0+8 起）。
# 用法：构建后执行 `bash dsh-mobile-app/tools/package-release.sh`；
#       设置 UPDATE_DIR=<插件 updateDir> 可将 APK+manifest 一并拷入主机更新目录。
#       `bash ... --check-only [dist目录]`：只跑 npm 载体发布前预检（不构建、不发布），
#       用于已有 dist（如 dsh-mobile-app/dist/local-3.2.0+57）的发布前确认。
#       `bash ... --drill`：正常构建后**追加发版演练**（本地 registry）；演练失败即阻断后续发布。
#       `bash ... --drill-only [dist目录]`：只演练、不构建；失败非零退出（用于预演/CI）。
#       演练需要全局 Verdaccio（npm i -g verdaccio@6.10.6）；默认不跑（需显式请求）。
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_dir="$(cd "$app_dir/.." && pwd)"

mode=""
target_dir=""
case "${1:-}" in
    --check-only) mode="check-only"; target_dir="${2:-}" ;;
    --drill-only) mode="drill-only"; target_dir="${2:-}" ;;
    --drill) mode="drill" ;;
esac

# --drill-only：只对已有发布目录跑完整发版演练（不构建、不发布）。
if [ "$mode" = "drill-only" ]; then
    drill_dist="${target_dir:-$app_dir/dist}"
    echo "Release drill only (no build, no npm publish): $drill_dist" >&2
    exec node "$app_dir/tools/npm-drill.mjs" --dist "$drill_dist" --phases all
fi

# --check-only：不构建 APK/载体，只对已有发布目录做「发布前预检」（离线、绝不 publish）。
if [ "$mode" = "check-only" ]; then
    check_dir="${target_dir:-$app_dir/dist}"
    echo "Publish preflight only (no build, no npm publish): $check_dir" >&2
    exec node "$app_dir/tools/publish-carrier-check.mjs" "$check_dir"
fi

apk="$app_dir/build/app/outputs/flutter-apk/app-release.apk"
if [ ! -f "$apk" ]; then
    echo "APK not found: $apk — run 'flutter build apk --release' first" >&2
    exit 1
fi

full_ver="$(sed -nE 's/^version:[[:space:]]*([0-9]+\.[0-9]+\.[0-9]+\+[0-9]+)([[:space:]]+#.*)?[[:space:]]*$/\1/p' "$app_dir/pubspec.yaml" | head -1)"
[ -n "$full_ver" ] || { echo "Cannot parse version (expected X.Y.Z+N) from pubspec.yaml" >&2; exit 1; }
ver="${full_ver%+*}"
build_num="${full_ver##*+}"

if [ -n "${MANIFEST_VERSION:-}" ]; then
    if [ "${ALLOW_TEST_MANIFEST_VERSION:-}" != "1" ]; then
        echo "MANIFEST_VERSION is test-only; set ALLOW_TEST_MANIFEST_VERSION=1 explicitly" >&2
        exit 1
    fi
    if [[ ! "$MANIFEST_VERSION" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\+([0-9]+)$ ]]; then
        echo "MANIFEST_VERSION must have the form X.Y.Z+N" >&2
        exit 1
    fi
    override_main="${BASH_REMATCH[1]}"
    override_build="${BASH_REMATCH[2]}"
    if [ "$override_main" != "$ver" ] || (( 10#$override_build <= 10#$build_num )); then
        echo "Test manifest version must keep $ver and use a build number greater than $build_num" >&2
        exit 1
    fi
    full_ver="$MANIFEST_VERSION"
elif [ "${ALLOW_TEST_MANIFEST_VERSION:-}" = "1" ]; then
    echo "ALLOW_TEST_MANIFEST_VERSION=1 requires MANIFEST_VERSION" >&2
    exit 1
fi

dist="$app_dir/dist"
mkdir -p "$dist"

# 1) App APK
apk_out="$dist/DSH-Remote-v$ver.apk"
cp "$apk" "$apk_out"
echo "Archived: $apk_out ($(du -h "$apk_out" | cut -f1))"

# 2) 插件 tarball（npm pack，本地无网络；输出名与 PowerShell 脚本统一）
tgz_out="$dist/dsh-mobile-remote-v$ver.tgz"
# 产物名由包名决定：带 scope 时 npm pack 输出 `scope-name-ver.tgz`（斜杠换成连字符），
# 不能再按固定名找文件——否则会误用上一次遗留的旧 tgz，生成内容对不上的清单。
pack_json="$(cd "$repo_dir" && npm pack --pack-destination "$dist" --json)"
npm_tgz="$dist/$(printf '%s' "$pack_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["filename"])')"
if [ ! -f "$npm_tgz" ]; then
    echo "npm pack 未产出预期文件：$npm_tgz" >&2
    exit 1
fi
mv -f "$npm_tgz" "$tgz_out"
if [ ! -f "$tgz_out" ]; then
    echo "Plugin tarball not found at $tgz_out" >&2
    exit 1
fi
echo "Archived: $tgz_out ($(du -h "$tgz_out" | cut -f1))"

# 3) 配对产物三件套（设计稿 §5.1/§5.2）：由**已打好的插件 tgz** + APK 生成完整 schema 1
#    配对清单（app/plugin 两段 + 顶层兼容镜像 + contentSha256），再组装并打出 App 载体
#    （同包名 @X.Y.Z-app、dsh.appCarrier=true、无运行入口/平台字段/安装钩子）。
#    构建顺序不可交换：tgz 已存在是硬输入；工具还会断言 tgz 内容标识等于当前源码，
#    并调用发布校验器（--require-carrier）复核清单/插件 tgz/APK/载体 tarball 全一致。
#    本步骤只做本地 npm pack，不会向任何 registry 发布。
#    PLUGIN_URL：把 tgz 的下载地址写进清单（GitHub Release 等托管场景）；不设则只写文件名，
#    由消费方相对清单地址解析。
manifest="$dist/manifest.json"
plugin_url_args=()
[ -n "${PLUGIN_URL:-}" ] && plugin_url_args=(--plugin-url "$PLUGIN_URL")
if [ -n "${MANIFEST_VERSION:-}" ]; then
    # 测试专用（需 ALLOW_TEST_MANIFEST_VERSION=1）：清单故意写一个“比 APK 实际构建号更高”的
    # 版本，用于验证 App 端“有新版本”的判定。这不是正式发布，因此不构建载体、不走载体配对
    # 门禁；F17/R9（app.version 从 APK 实读）只在正式发布路径强制。
    node "$app_dir/tools/gen-manifest.js" \
        --apk "$apk_out" \
        --version "$full_ver" \
        --plugin-tgz "$tgz_out" \
        --plugin-root "$repo_dir" \
        --changelog "$repo_dir/CHANGELOG.md" \
        --out "$manifest" \
        "${plugin_url_args[@]}"
    node "$app_dir/tools/verify-update-manifest.mjs" "$dist" || {
        echo "test manifest verification failed" >&2
        exit 1
    }
    echo "WARN: MANIFEST_VERSION=$full_ver is test-only / hand-filled; app carrier is NOT built for this path" >&2
else
    node "$app_dir/tools/build-app-carrier.mjs" \
        --apk "$apk_out" \
        --plugin-tgz "$tgz_out" \
        --plugin-root "$repo_dir" \
        --changelog "$repo_dir/CHANGELOG.md" \
        --app-version "$full_ver" \
        --out-dir "$dist" \
        "${plugin_url_args[@]}" || {
        echo "app carrier build / release-pairing verification failed" >&2
        exit 1
    }
    # 载体 npm 发布前预检（离线 dry-run；不发布）。发布命令必须人工执行：
    #   npm publish <dist>/<name>-X.Y.Z-app.tgz --tag app
    node "$app_dir/tools/publish-carrier-check.mjs" "$dist" || {
        echo "carrier publish preflight failed" >&2
        exit 1
    }
fi

# 3.5) 显式 --drill：构建后跑完整发版演练；演练失败即阻断后续发布（fail-closed）。
if [ "$mode" = "drill" ]; then
    node "$app_dir/tools/npm-drill.mjs" --dist "$dist" --phases all || {
        echo "release drill failed — blocking publish" >&2
        exit 1
    }
fi

# 4) 可选：拷入插件 updateDir（应用「主机源」更新通道；tgz 一并落位，使该目录自包含）
if [ -n "${UPDATE_DIR:-}" ]; then
    mkdir -p "$UPDATE_DIR"
    cp "$apk_out" "$tgz_out" "$manifest" "$UPDATE_DIR/"
    echo "Copied to updateDir: $UPDATE_DIR"
fi