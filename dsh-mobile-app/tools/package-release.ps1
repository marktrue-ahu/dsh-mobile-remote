# Archive a release: copies the APK and packs the plugin tarball into
# dsh-mobile-app/dist/ with versioned filenames.
# Version contract: plugin version comes from root package.json (X.Y.Z or X.Y.Z-prerelease);
# App/APK filenames only use the pubspec core X.Y.Z (+N build); carrier version is the full
# plugin version plus -app (e.g. plugin 3.2.1-alpha.1 -> App 3.2.1+24 -> carrier 3.2.1-alpha.1-app).
# A prerelease plugin must be published with an explicit tag (alpha) and must not move latest.
# Run after: flutter build apk --release
#   -CheckOnly [-DistDir <dir>] : only run the offline carrier publish preflight
#                                 (no build, never runs npm publish).
#   -DrillOnly [-DistDir <dir>] : only run the full release drill (local registry;
#                                 no build, never publishes public npm).
#   -Drill                      : after the normal build, run the full release drill;
#                                 drill failure blocks the release (fail-closed).
param(
    [switch]$CheckOnly,
    [switch]$Drill,
    [switch]$DrillOnly,
    [string]$DistDir = ''
)
$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $PSScriptRoot   # dsh-mobile-app/
$repoDir = Split-Path -Parent $appDir        # repo root

function Get-PluginPublishTag([string]$Version) {
    $match = [regex]::Match($Version, '^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$')
    if (-not $match.Success) { throw "Invalid plugin version for npm dist-tag: $Version" }
    if (-not $match.Groups[2].Success) { return 'latest' }
    $tag = ($match.Groups[2].Value -split '\.')[0]
    if ($tag -match '^\d+(?:\.\d+)*$') { return 'prerelease' }
    return $tag
}

if ($DrillOnly) {
    $drillDir = if ($DistDir) { $DistDir } else { Join-Path $appDir 'dist' }
    $drillPkg = Get-Content (Join-Path $repoDir 'package.json') -Raw | ConvertFrom-Json
    $drillPluginTag = Get-PluginPublishTag ([string]$drillPkg.version)
    Write-Output ("Release drill only (no build, no npm publish): " + $drillDir + " (plugin tag: " + $drillPluginTag + ")")
    node (Join-Path $PSScriptRoot '../../tools/npm-drill.mjs') --dist $drillDir --phases all --plugin-tag $drillPluginTag
    exit $LASTEXITCODE
}

if ($CheckOnly) {
    $checkDir = if ($DistDir) { $DistDir } else { Join-Path $appDir 'dist' }
    Write-Output ("Publish preflight only (no build, no npm publish): " + $checkDir)
    node (Join-Path $PSScriptRoot 'publish-carrier-check.mjs') $checkDir
    exit $LASTEXITCODE
}

$apk = Join-Path $appDir 'build\app\outputs\flutter-apk\app-release.apk'
if (-not (Test-Path $apk)) {
    Write-Error "APK not found: $apk - run 'flutter build apk --release' first"
    exit 1
}
$pubspec = Get-Content (Join-Path $appDir 'pubspec.yaml') -Raw
$versionMatch = [regex]::Match($pubspec, '(?m)^version:[ \t]*(\d+\.\d+\.\d+)\+(\d+)(?:[ \t]+#[^\r\n]*)?[ \t\r]*$')
if (-not $versionMatch.Success) { Write-Error 'Cannot parse version (expected X.Y.Z+N) from pubspec.yaml'; exit 1 }
$ver = $versionMatch.Groups[1].Value
$buildText = $versionMatch.Groups[2].Value
$buildNumber = [long]::Parse($buildText)
$fullVersion = "$ver+$buildText"

# Plugin version (root package.json) may be a prerelease; App/APK stay on the core X.Y.Z.
$pluginPkg = Get-Content (Join-Path $repoDir 'package.json') -Raw | ConvertFrom-Json
$pluginVersion = [string]$pluginPkg.version
$pluginMatch = [regex]::Match($pluginVersion, '^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$')
if (-not $pluginMatch.Success) {
    Write-Error "Cannot parse plugin version (expected X.Y.Z or X.Y.Z-prerelease) from package.json: $pluginVersion"
    exit 1
}
$pluginCore = $pluginMatch.Groups[1].Value
$pluginPrerelease = $pluginMatch.Groups[2].Value
if ($pluginCore -ne $ver) {
    Write-Error "App core ($ver) must match plugin core ($pluginCore); plugin=$pluginVersion pubspec=$fullVersion"
    exit 1
}
$pluginTag = Get-PluginPublishTag $pluginVersion

if ($env:MANIFEST_VERSION) {
    if ($env:ALLOW_TEST_MANIFEST_VERSION -ne '1') {
        Write-Error 'MANIFEST_VERSION is test-only; set ALLOW_TEST_MANIFEST_VERSION=1 explicitly'
        exit 1
    }
    $overrideMatch = [regex]::Match($env:MANIFEST_VERSION, '^(\d+\.\d+\.\d+)\+(\d+)$')
    if (-not $overrideMatch.Success -or $overrideMatch.Groups[1].Value -ne $ver) {
        Write-Error "Test manifest version must keep $ver and have the form X.Y.Z+N"
        exit 1
    }
    $overrideBuild = [long]::Parse($overrideMatch.Groups[2].Value)
    if ($overrideBuild -le $buildNumber) {
        Write-Error "Test manifest build must be greater than the APK build $buildNumber"
        exit 1
    }
    $fullVersion = $env:MANIFEST_VERSION
} elseif ($env:ALLOW_TEST_MANIFEST_VERSION -eq '1') {
    Write-Error 'ALLOW_TEST_MANIFEST_VERSION=1 requires MANIFEST_VERSION'
    exit 1
}
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
# 产物名由包名决定：带 scope 时是 `scope-name-ver.tgz`（斜杠换连字符），不能按固定名找。
$packed = Join-Path $dist "marktrue-dsh-mobile-remote-$pluginVersion.tgz"
$tgzOut = Join-Path $dist "dsh-mobile-remote-v$pluginVersion.tgz"
if (-not (Test-Path $packed)) {
    $candidate = Get-ChildItem -Path $dist -Filter "*-$pluginVersion.tgz" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($candidate) { $packed = $candidate.FullName }
}
if (Test-Path $packed) {
    # 命名对齐历史发布惯例：dsh-mobile-remote-vX.Y.Z.tgz（npm pack 原生输出不含 v）
    Move-Item $packed $tgzOut -Force
    Write-Output ("Archived: " + $tgzOut + " (" + [math]::Round((Get-Item $tgzOut).Length / 1KB, 0) + " KB)")
} elseif (Test-Path $tgzOut) {
    Write-Output ("Archived: " + $tgzOut + " (" + [math]::Round((Get-Item $tgzOut).Length / 1KB, 0) + " KB)")
} else {
    Write-Warning "Plugin tarball not found - check npm pack output"
}

# 3) Paired release triple (design §5.1/§5.2): from the **already-packed plugin tgz** plus the
#    APK, generate the full schema-1 paired manifest, assemble the App carrier
#    (same package name @X.Y.Z-app, dsh.appCarrier=true, no entry/platform fields/install hooks)
#    and `npm pack` it. Build order is not interchangeable: the tgz is a hard input, and the tool
#    also asserts the tgz content digest equals the current source tree, then runs the release
#    verifier in --require-carrier mode. Local `npm pack` only - never publishes to a registry.
#    PLUGIN_URL writes the tarball's download URL; without it only the file name is emitted
#    and consumers resolve it relative to the manifest location.
$manifest = Join-Path $dist 'manifest.json'
$pluginUrlArgs = @()
if ($env:PLUGIN_URL) { $pluginUrlArgs = @('--plugin-url', $env:PLUGIN_URL) }
if ($env:MANIFEST_VERSION) {
    # Test-only path (requires ALLOW_TEST_MANIFEST_VERSION=1): the manifest carries a hand-filled
    # build number higher than the real APK, to exercise the App's "update available" detection.
    # This is not a release: no carrier is built and the pairing gate is skipped; F17/R9
    # (app.version read from the APK) is enforced only on the real release path.
    node (Join-Path $PSScriptRoot 'gen-manifest.js') --apk $apkOut --version $fullVersion --plugin-tgz $tgzOut --plugin-root $repoDir --changelog (Join-Path $repoDir 'CHANGELOG.md') --out $manifest @pluginUrlArgs
    if ($LASTEXITCODE -ne 0) { Write-Error "gen-manifest.js failed with exit code $LASTEXITCODE"; exit 1 }
    node (Join-Path $PSScriptRoot 'verify-update-manifest.mjs') $dist
    if ($LASTEXITCODE -ne 0) { Write-Error "test manifest verification failed"; exit 1 }
    Write-Warning "MANIFEST_VERSION=$fullVersion is test-only / hand-filled; app carrier is NOT built for this path"
} else {
    node (Join-Path $PSScriptRoot 'build-app-carrier.mjs') --apk $apkOut --plugin-tgz $tgzOut --plugin-root $repoDir --changelog (Join-Path $repoDir 'CHANGELOG.md') --app-version $fullVersion --out-dir $dist @pluginUrlArgs
    if ($LASTEXITCODE -ne 0) { Write-Error "app carrier build / release-pairing verification failed"; exit 1 }
    # Offline publish preflight (dry-run; never runs npm publish). Publishing is manual:
    #   npm publish <dist>\<name>-X.Y.Z-app.tgz --tag app
    node (Join-Path $PSScriptRoot 'publish-carrier-check.mjs') $dist
    if ($LASTEXITCODE -ne 0) { Write-Error "carrier publish preflight failed"; exit 1 }

    # Manual publish plan (never executed by this script): carrier first (tag app), then plugin
    # with the explicit tag; prerelease tag must not move latest.
    $record = Get-Content (Join-Path $dist 'app-carrier.json') -Raw | ConvertFrom-Json
    $carrierTgz = Join-Path $dist ([string]$record.file)
    $prereleaseNote = if ($pluginTag -eq 'latest') { '' } else { '   # prerelease: does not move latest' }
    Write-Output ''
    Write-Output 'Publish plan (NOT executed by this script):'
    Write-Output ("  1) carrier : npm publish `"$carrierTgz`" --tag app")
    Write-Output ("  2) plugin  : npm publish `"$tgzOut`" --tag $pluginTag$prereleaseNote")
    Write-Output ("  plugin tag : $pluginTag ; carrier tag: app ; App/APK core: $ver ; build: $buildText")
}

if ($Drill) {
    # Explicit -Drill: full release drill after build; failure blocks the release (fail-closed).
    node (Join-Path $PSScriptRoot '../../tools/npm-drill.mjs') --dist $dist --phases all --plugin-tag $pluginTag
    if ($LASTEXITCODE -ne 0) { Write-Error "release drill failed - blocking publish"; exit 1 }
}

if ($env:UPDATE_DIR) {
    New-Item -ItemType Directory -Force -Path $env:UPDATE_DIR | Out-Null
    # 三个位置参数会被 PowerShell 判为 ParameterBindingException：必须显式 -Path/-Destination
    Copy-Item -Path @($apkOut, $tgzOut, $manifest) -Destination $env:UPDATE_DIR -Force
    Write-Output ("Copied to updateDir: " + $env:UPDATE_DIR)
}
