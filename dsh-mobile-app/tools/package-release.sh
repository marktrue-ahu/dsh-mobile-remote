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

# pubspec 的 version 形如 3.1.3+21 → 主段 3.1.3、build 21。
# 注意：主段正则必须锚定非数字边界，否则会把 "3.1.3+21" 整串当作主段，
# 再拼 build 就变成 "3.1.3+21+21"（App 的版本比较会把它当作脏数据）。
read -r ver build_num < <(awk '/^version:/ { n = split($2, parts, "+"); ver = parts[1]; gsub(/[^0-9.]/, "", ver); build = ""; if (n > 1) { build = parts[2]; gsub(/[^0-9]/, "", build) } print ver, build; exit }' "$app_dir/pubspec.yaml")
[ -n "$ver" ] || { echo "Cannot parse version from pubspec.yaml" >&2; exit 1; }
full_ver="$ver"
if [ -n "$build_num" ]; then
    full_ver="$ver+$build_num"
fi

dist="$app_dir/dist"
mkdir -p "$dist"

# 1) App APK
apk_out="$dist/DSH-Remote-v$ver.apk"
cp "$apk" "$apk_out"
echo "Archived: $apk_out ($(du -h "$apk_out" | cut -f1))"

# 2) 插件 tarball（npm pack，本地无网络）。
#    注意：tarball 名用 package.json 的 version（3.1.3），不含 App 的 build 号（3.1.3+21），
#    故以 npm pack 的实际输出为准，不自行拼接文件名。
tgz_name="$(cd "$repo_dir" && npm pack --pack-destination "$dist" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(c)=>s+=c).on("end",()=>{try{const v=JSON.parse(s);process.stdout.write((Array.isArray(v)?v[0]:v)?.filename??"")}catch{process.stdout.write("")}})')"
if [ -z "$tgz_name" ]; then
    tgz_name="$(cd "$dist" && ls -t dsh-mobile-remote-*.tgz 2>/dev/null | head -1)"
fi
tgz_out="$dist/$tgz_name"
if [ -z "$tgz_name" ] || [ ! -f "$tgz_out" ]; then
    echo "Plugin tarball not found in $dist" >&2
    exit 1
fi
echo "Archived: $tgz_out ($(du -h "$tgz_out" | cut -f1))"

# 3) manifest.json（共享生成器：合法 JSON / 无 BOM / notes=CHANGELOG 最新条目全文 / sha256+size）
manifest="$dist/manifest.json"
node "$app_dir/tools/gen-manifest.js" \
    --apk "$apk_out" \
    --version "$full_ver" \
    --changelog "$repo_dir/CHANGELOG.md" \
    --out "$manifest"

# 4) 可选：拷入插件 updateDir（应用「主机源」更新通道）
if [ -n "${UPDATE_DIR:-}" ]; then
    mkdir -p "$UPDATE_DIR"
    cp "$apk_out" "$manifest" "$UPDATE_DIR/"
    echo "Copied to updateDir: $UPDATE_DIR"
fi