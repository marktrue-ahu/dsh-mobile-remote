# Archive a release: copies the APK and packs the plugin tarball into
# dsh-mobile-app/dist/ with versioned filenames. Version comes from pubspec.yaml;
# plugin version is kept in sync (App version = plugin version = git tag).
# Run after: flutter build apk --release
$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $PSScriptRoot   # dsh-mobile-app/
$repoDir = Split-Path -Parent $appDir        # repo root
$apk = Join-Path $appDir 'build\app\outputs\flutter-apk\app-release.apk'
if (-not (Test-Path $apk)) {
    Write-Error "APK not found: $apk - run 'flutter build apk --release' first"
    exit 1
}
$pubspec = Get-Content (Join-Path $appDir 'pubspec.yaml') -Raw
$ver = ([regex]::Match($pubspec, '(?m)^version:\s*(\d+\.\d+\.\d+)')).Groups[1].Value
if (-not $ver) { Write-Error 'Cannot parse version from pubspec.yaml'; exit 1 }
$buildNum = ([regex]::Match($pubspec, '(?m)^version:\s*\d+\.\d+\.\d+\+(\d+)')).Groups[1].Value
$fullVer = if ($buildNum) { "$ver+$buildNum" } else { $ver }   # manifest 版本精确到 build（热修可识别）
$dist = Join-Path $appDir 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null

# 1) App APK
$apkOut = Join-Path $dist "DSH-Remote-v$ver.apk"
Copy-Item $apk $apkOut -Force
Write-Output ("Archived: " + $apkOut + " (" + [math]::Round((Get-Item $apkOut).Length / 1MB, 1) + " MB)")

# 2) Plugin tarball (npm pack, local only - no network needed)
# npm writes notices to stderr - route them away so the script exits cleanly.
Push-Location $repoDir
try {
    $null = cmd /c "npm pack --pack-destination `"$dist`" 2>nul"
} finally {
    Pop-Location
}
$packed = Join-Path $dist "dsh-mobile-remote-$ver.tgz"
$tgzOut = Join-Path $dist "dsh-mobile-remote-v$ver.tgz"
if (Test-Path $packed) {
    # 命名对齐历史发布惯例：dsh-mobile-remote-vX.Y.Z.tgz（npm pack 原生输出不含 v）
    Move-Item $packed $tgzOut -Force
    Write-Output ("Archived: " + $tgzOut + " (" + [math]::Round((Get-Item $tgzOut).Length / 1KB, 0) + " KB)")
} elseif (Test-Path $tgzOut) {
    Write-Output ("Archived: " + $tgzOut + " (" + [math]::Round((Get-Item $tgzOut).Length / 1KB, 0) + " KB)")
} else {
    Write-Error "Plugin tarball not found - check npm pack output"; exit 1
}

# 3) manifest.json（共享生成器 gen-manifest.js：合法 JSON / 无 BOM / notes=CHANGELOG 最新条目全文 / sha256+size）
# 与 package-release.sh 完全同一生成器，保证双端产出等价。
$manifest = Join-Path $dist 'manifest.json'
node (Join-Path $PSScriptRoot 'gen-manifest.js') --apk $apkOut --version $fullVer --changelog (Join-Path $repoDir 'CHANGELOG.md') --out $manifest
if ($LASTEXITCODE -ne 0) { Write-Error "gen-manifest.js failed with exit code $LASTEXITCODE"; exit 1 }

# 4) 可选：拷入插件 updateDir（应用「主机源」更新通道）
if ($env:UPDATE_DIR) {
    New-Item -ItemType Directory -Force -Path $env:UPDATE_DIR | Out-Null
    Copy-Item $apkOut $manifest $env:UPDATE_DIR -Force
    Write-Output ("Copied to updateDir: " + $env:UPDATE_DIR)
}
