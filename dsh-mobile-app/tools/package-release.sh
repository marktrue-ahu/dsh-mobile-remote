#!/usr/bin/env bash
# Archive a release (Linux/WSL，与 package-release.ps1 等价)，并生成自动更新主机源的 manifest.json（App 3.0.0+8 起）。
# 用法：构建后执行 `bash dsh-mobile-app/tools/package-release.sh`；
#       设置 UPDATE_DIR=<插件 updateDir> 可将 APK+manifest 一并拷入主机更新目录。
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_dir="$(cd "$app_dir/.." && pwd)"

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
npm_tgz="$dist/dsh-mobile-remote-$ver.tgz"
tgz_out="$dist/dsh-mobile-remote-v$ver.tgz"
(cd "$repo_dir" && npm pack --pack-destination "$dist" >/dev/null)
if [ -f "$npm_tgz" ]; then
    mv -f "$npm_tgz" "$tgz_out"
fi
if [ ! -f "$tgz_out" ]; then
    echo "Plugin tarball not found at $tgz_out" >&2
    exit 1
fi
echo "Archived: $tgz_out ($(du -h "$tgz_out" | cut -f1))"

# 3) 发布清单（共享生成器：合法 JSON / 无 BOM / notes=CHANGELOG 最新条目全文 /
#    app 与 plugin 两段 + 各自 sha256 / plugin 的 contentSha256）
#    PLUGIN_URL：把 tgz 的下载地址写进清单（GitHub Release 等托管场景）；不设则只写文件名，
#    由消费方相对清单地址解析。
manifest="$dist/manifest.json"
plugin_url_args=()
[ -n "${PLUGIN_URL:-}" ] && plugin_url_args=(--plugin-url "$PLUGIN_URL")
node "$app_dir/tools/gen-manifest.js" \
    --apk "$apk_out" \
    --version "$full_ver" \
    --plugin-tgz "$tgz_out" \
    --plugin-root "$repo_dir" \
    --changelog "$repo_dir/CHANGELOG.md" \
    --out "$manifest" \
    "${plugin_url_args[@]}"

# 4) 校验清单与产物一致（fail-closed：不一致即中止发布）
node "$app_dir/tools/verify-update-manifest.mjs" "$dist" || {
    echo "manifest verification failed" >&2
    exit 1
}

# 5) 可选：拷入插件 updateDir（应用「主机源」更新通道；tgz 一并落位，使该目录自包含）
if [ -n "${UPDATE_DIR:-}" ]; then
    mkdir -p "$UPDATE_DIR"
    cp "$apk_out" "$tgz_out" "$manifest" "$UPDATE_DIR/"
    echo "Copied to updateDir: $UPDATE_DIR"
fi