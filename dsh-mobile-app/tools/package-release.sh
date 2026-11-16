#!/usr/bin/env bash
# Archive a release（Linux/WSL），并生成自动更新主机源的 manifest.json（App 3.0.0+8 起）。
# Windows 手工打包入口 package-release.ps1 已于 issue #113 退役，本脚本是唯一本机打包入口。
# 用法：构建后执行 `bash dsh-mobile-app/tools/package-release.sh`；
#       版本契约：插件版本取自 root package.json（允许 X.Y.Z-prerelease）；App/APK 文件名只用
#       pubspec 的 core X.Y.Z，构建号来自 pubspec +N；载体版本=插件完整版本 + -app。
#       本脚本只本地打包 + 预检，**不发布**；公共 npm 发布由版本 tag 触发 CI
#       （.github/workflows/publish-npm.yml）完成，不在本机手工 publish。
#       UPDATE_DIR / MANIFEST_VERSION / ALLOW_TEST_MANIFEST_VERSION 已于 issue #113 退役：
#       传入即在写任何产物前 fail-closed（人工目录复制与假版本清单路径不再存在）。
#       `bash ... --check-only [dist目录]`：只跑 npm 载体发布前预检（不构建、不发布），
#       用于已有 dist（如 dsh-mobile-app/dist/local-3.2.0+57）的发布前确认。
#       `bash ... --drill`：正常构建后**追加发版演练**（本地 registry）；演练失败即阻断后续发布。
#       `bash ... --drill-only [dist目录]`：只演练、不构建；失败非零退出（用于预演/CI）。
#       演练需要全局 Verdaccio（npm i -g verdaccio@6.10.6）；默认不跑（需显式请求）。
set -euo pipefail

# 已退役的入口（issue #113）：这些环境变量曾经驱动人工更新目录复制与「假版本清单」测试路径。
# 自动更新已统一走 npm（ADR 0024），人工目录复制不再产生；假版本清单会产出与实际 APK 身份
# 不符的清单。调用方仍传入时必须在写任何产物/共享目录之前 fail-closed，不能静默忽略后让人
# 误以为旧行为仍然生效。
if [ -n "${UPDATE_DIR:-}" ]; then
    echo "UPDATE_DIR 已退役（issue #113）：人工更新目录复制不再是发布流程的一部分；" >&2
    echo "公共更新走 npm（ADR 0024）。请移除 UPDATE_DIR 后重跑。" >&2
    exit 1
fi
if [ -n "${MANIFEST_VERSION:-}" ] || [ -n "${ALLOW_TEST_MANIFEST_VERSION:-}" ]; then
    echo "MANIFEST_VERSION / ALLOW_TEST_MANIFEST_VERSION 已退役（issue #113）：" >&2
    echo "假版本清单会产出与 APK 实际身份不符的清单，已不再支持。请按真实 pubspec 版本打包。" >&2
    exit 1
fi

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_dir="$(cd "$app_dir/.." && pwd)"

plugin_tag_from_package() {
    (
        cd "$repo_dir"
        node --input-type=module -e '
            import { readFileSync } from "node:fs";
            import { pluginPublishTag } from "./dsh-mobile-app/tools/lib/release-checks.mjs";
            const version = JSON.parse(readFileSync("./package.json", "utf8")).version;
            const tag = pluginPublishTag(version);
            if (!tag) { console.error(`plugin-version-invalid: ${version}`); process.exit(1); }
            process.stdout.write(tag);
        '
    )
}

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
    drill_plugin_tag="$(plugin_tag_from_package)"
    [ -n "$drill_plugin_tag" ] || { echo "Could not derive npm drill plugin tag" >&2; exit 1; }
    echo "Release drill only (no build, no npm publish): $drill_dist (plugin tag: $drill_plugin_tag)" >&2
    exec node "$repo_dir/tools/npm-drill.mjs" --dist "$drill_dist" --phases all --plugin-tag "$drill_plugin_tag"
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

# 插件版本是发布产物版本（root package.json）；App/APK 仍只用 core `X.Y.Z`：
#   插件 3.2.1-alpha.1 ↔ App 3.2.1+24 ↔ 载体 3.2.1-alpha.1-app
plugin_version="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version ?? "")' "$repo_dir/package.json")"
if [[ ! "$plugin_version" =~ ^([0-9]+\.[0-9]+\.[0-9]+)(-([0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*))?$ ]]; then
    echo "Cannot parse plugin version (expected X.Y.Z or X.Y.Z-prerelease) from package.json: $plugin_version" >&2
    exit 1
fi
plugin_core="${BASH_REMATCH[1]}"
plugin_prerelease="${BASH_REMATCH[3]}"
if [ "$plugin_core" != "$ver" ]; then
    echo "App core ($ver) must match plugin core ($plugin_core); plugin=$plugin_version pubspec=$full_ver" >&2
    exit 1
fi
if [ -n "$plugin_prerelease" ]; then
    plugin_tag="${plugin_prerelease%%.*}"
else
    plugin_tag="latest"
fi

dist="$app_dir/dist"
mkdir -p "$dist"

# 1) App APK
apk_out="$dist/DSH-Remote-v$ver.apk"
cp "$apk" "$apk_out"
echo "Archived: $apk_out ($(du -h "$apk_out" | cut -f1))"

# 2) 插件 tarball（npm pack，本地无网络；产物名由包名决定，见下）
tgz_out="$dist/dsh-mobile-remote-v$plugin_version.tgz"
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
plugin_url_args=()
[ -n "${PLUGIN_URL:-}" ] && plugin_url_args=(--plugin-url "$PLUGIN_URL")
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
# 载体 npm 发布前预检（离线 dry-run；不发布）。实际发布由 CI 在版本 tag 触发时执行。
node "$app_dir/tools/publish-carrier-check.mjs" "$dist" || {
    echo "carrier publish preflight failed" >&2
    exit 1
}

# 3.5) 显式 --drill：构建后跑完整发版演练；演练失败即阻断后续发布（fail-closed）。
if [ "$mode" = "drill" ]; then
    node "$repo_dir/tools/npm-drill.mjs" --dist "$dist" --phases all --plugin-tag "$plugin_tag" || {
        echo "release drill failed — blocking publish" >&2
        exit 1
    }
fi

# 3.6) 产物与后续步骤（本脚本绝不发布，也不写任何共享更新目录）。
#      公共 npm 发布由版本 tag 触发 CI（.github/workflows/publish-npm.yml）；
#      本机只负责本地打包与预检。发布顺序（CI 内）：先载体，再主插件。
if [ "$mode" = "" ]; then
    echo "" >&2
    echo "Built artifacts in: $dist" >&2
    echo "  plugin tag: $plugin_tag ; carrier tag: app ; App/APK core: $ver ; build: $build_num" >&2
    echo "Publishing is NOT done here: push an authorized version tag and let CI publish." >&2
fi

# 4) 人工 updateDir 复制已于 issue #113 退役（UPDATE_DIR 在脚本开头即 fail-closed）。
#    本脚本不再写任何共享更新目录；运行时人工区读取侧不受影响。
