# Android APK 构建与排障指南

本文记录 `dsh-mobile-app` 的 Android Release APK 构建流程，以及首次构建、网络代理、Gradle、缓存和签名相关的常见问题。每个 shell 代码块均假定从仓库根目录独立执行，代码块内另有 `cd` 时除外。

## 1. 当前构建基线

| 组件 | 当前项目使用版本 |
|---|---|
| Flutter | 3.47.1 stable（项目要求 3.47+） |
| Dart | 3.13.1（`pubspec.yaml` 要求 `^3.13.0`） |
| JDK | 17 |
| Android Gradle Plugin | 9.1.0 |
| Gradle Wrapper | 9.3.1 |
| Kotlin | 2.4.0 |

以仓库中的 `pubspec.yaml`、`android/settings.gradle.kts` 和 Gradle Wrapper 配置为准。升级 Flutter、AGP、Gradle 或 Kotlin 时应一起验证，避免只升级其中一项。

## 2. 构建前检查

确认 Flutter、Java 和 Android SDK 可用：

```bash
flutter --version
java -version
flutter doctor -v
```

如果工具安装在自定义目录，可在当前终端临时设置：

```bash
export JAVA_HOME=/path/to/jdk17
export ANDROID_HOME=/path/to/android-sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="/path/to/flutter/bin:$JAVA_HOME/bin:$PATH"
```

`dsh-mobile-app/android/local.properties` 至少应包含本机 SDK 路径，例如：

```properties
sdk.dir=/path/to/android-sdk
flutter.sdk=/path/to/flutter
```

`local.properties` 是本机文件，已被 Git 忽略，不应提交。

## 3. 标准 Release 构建

推荐通过 Flutter CLI 构建：

```bash
cd dsh-mobile-app
flutter pub get
flutter analyze
flutter test
flutter build apk --release
```

成功标志：命令退出码为 0，并出现 `Built ...app-release.apk`。标准产物位于：

```text
dsh-mobile-app/build/app/outputs/flutter-apk/app-release.apk
```

若只需直接调用 Android 构建链，也可使用：

```bash
cd dsh-mobile-app/android
./gradlew :app:assembleRelease --no-daemon --console=plain --max-workers=2
```

直接调用 Gradle 时，产物通常位于：

```text
dsh-mobile-app/build/app/outputs/apk/release/app-release.apk
```

直接 Gradle 构建适合排查具体 Android 任务；日常发布仍建议使用 Flutter CLI。

## 4. Google 下载必须走本地代理

首次构建会从 Google Storage 下载 Flutter Android 引擎和其他依赖。当前环境使用 HTTP 代理：

```text
http://127.0.0.1:1080/
```

### 4.1 Linux / WSL

先设置通用代理环境变量：

```bash
export HTTP_PROXY=http://127.0.0.1:1080
export HTTPS_PROXY=http://127.0.0.1:1080
export http_proxy="$HTTP_PROXY"
export https_proxy="$HTTPS_PROXY"
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
```

Java/Gradle 不一定只读取 `HTTP_PROXY`，因此构建时同时传入 JVM 代理参数：

```bash
cd dsh-mobile-app/android
./gradlew :app:assembleRelease \
  --no-daemon \
  --console=plain \
  --max-workers=2 \
  -Dhttp.proxyHost=127.0.0.1 \
  -Dhttp.proxyPort=1080 \
  -Dhttps.proxyHost=127.0.0.1 \
  -Dhttps.proxyPort=1080
```

通过 Flutter CLI 构建时，可将 JVM 参数放入 `GRADLE_OPTS`：

```bash
export GRADLE_OPTS="-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=1080 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=1080"
cd dsh-mobile-app
flutter build apk --release
```

### 4.2 Windows PowerShell

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:1080"
$env:HTTPS_PROXY = "http://127.0.0.1:1080"
$env:GRADLE_OPTS = "-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=1080 -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=1080"

cd dsh-mobile-app
flutter build apk --release
```

### 4.3 持久化 Gradle 代理（可选）

如果该机器始终需要代理，可写入用户级 `~/.gradle/gradle.properties`：

```properties
systemProp.http.proxyHost=127.0.0.1
systemProp.http.proxyPort=1080
systemProp.https.proxyHost=127.0.0.1
systemProp.https.proxyPort=1080
```

这是机器级配置，不要将个人代理配置写入项目的 `android/gradle.properties` 后提交。

### 4.4 验证代理

先确认代理能访问 Flutter Storage：

```bash
curl -x http://127.0.0.1:1080 \
  -I --max-time 15 \
  https://storage.googleapis.com/download.flutter.io/
```

返回 `HTTP/2 200` 或其他有效 HTTP 响应，说明代理链路可用。构建期间可检查 Gradle 是否连接代理：

```bash
ss -tpn | rg '127\.0\.0\.1:1080'
```

## 5. 干净重建

普通代码修改不需要每次清理。遇到缓存异常或需要确认可重复构建时执行：

```bash
cd dsh-mobile-app
flutter clean
flutter pub get
flutter analyze
flutter test
flutter build apk --release
```

也可以只清理 Android 产物：

```bash
cd dsh-mobile-app/android
./gradlew clean --no-daemon --console=plain
```

不要把删除整个 `~/.gradle/caches` 作为首选方案；这会使所有 Gradle 和 Flutter 引擎依赖重新下载。

## 6. Release 签名

正式分发必须使用固定的 release keystore。若 `android/key.properties` 不存在，项目会回退到 Debug 证书，仅适合本机测试。

生成 keystore：

```bash
cd dsh-mobile-app
keytool -genkeypair -v \
  -keystore android/app/release.jks \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10950 \
  -alias dsh
```

创建 `android/key.properties`：

```properties
storePassword=<密码>
keyPassword=<密码>
keyAlias=dsh
storeFile=app/release.jks
```

`release.jks` 与 `key.properties` 均已被 Git 忽略。不要提交，也必须安全备份；丢失或更换 keystore 后，已安装旧版本的用户无法直接覆盖升级。

检查 APK 签名：

```bash
APP_ROOT="$(git rev-parse --show-toplevel)/dsh-mobile-app"
APK="$APP_ROOT/build/app/outputs/flutter-apk/app-release.apk"
APKSIGNER="$(find "$ANDROID_HOME/build-tools" -type f -name apksigner -print | sort -V | tail -1)"
"$APKSIGNER" \
  verify --verbose --print-certs "$APK"
```

至少应看到 `Verifies`、签名方案结果和正确的证书摘要。`CN=Android Debug` 表示当前使用的是 Debug 回退签名，不应作为正式发布包。如果 `APKSIGNER` 为空，请先通过 Android SDK Manager 安装 Android SDK Build-Tools。

## 7. 产物校验

构建完成后建议记录文件大小、SHA-256 和签名信息：

```bash
APK="$(git rev-parse --show-toplevel)/dsh-mobile-app/build/app/outputs/flutter-apk/app-release.apk"
stat "$APK"
sha256sum "$APK"
file "$APK"
```

发布前还应确认：

- `pubspec.yaml` 中的 `version: X.Y.Z+BUILD` 正确；
- 使用预期的 release 证书，而不是 Debug 证书；
- SHA-256 与发布清单一致；
- 用相同签名覆盖安装旧版本成功；
- 自动更新的检查、下载、签名预检和安装流程已真机验证。

## 8. 常见问题与处理办法

### 8.1 构建长时间停在 `:app:mergeReleaseNativeLibs`

**现象**：普通日志只显示以下一行，数分钟没有新输出：

```text
> Task :app:mergeReleaseNativeLibs
```

**常见原因**：Gradle 正在后台下载 Flutter 的 ARMv7、ARM64 和 x86_64 引擎 JAR。普通日志不显示下载进度，看起来像死锁。本项目曾在这里等待，实际请求地址为 `storage.googleapis.com/download.flutter.io`。

**诊断**：

```bash
cd dsh-mobile-app/android
./gradlew :app:mergeReleaseNativeLibs \
  --no-daemon --console=plain --max-workers=2 --info
```

若 `--info` 输出出现 `Downloading https://storage.googleapis.com/...`，说明任务没有死锁，只是在下载。

**处理**：按第 4 节同时配置环境变量和 JVM 代理参数，然后保持单个构建进程运行。首次下载可能需要 5～15 分钟；缓存完成后后续构建会明显加快。

### 8.2 `curl` 能走代理，但 Gradle 仍然很慢或超时

**原因**：代理环境变量只证明 `curl` 配置正确，Java/Gradle 可能未读取它们。

**处理**：除 `HTTP_PROXY` 和 `HTTPS_PROXY` 外，再设置 `GRADLE_OPTS`，或向 Gradle 传入以下参数：

```text
-Dhttp.proxyHost=127.0.0.1
-Dhttp.proxyPort=1080
-Dhttps.proxyHost=127.0.0.1
-Dhttps.proxyPort=1080
```

`proxyHost` 只写主机名或 IP，不要写 `http://`；协议只出现在 `HTTP_PROXY` 的 URL 中。

### 8.3 多个 Gradle 构建互相等待或提示锁被占用

**现象**：日志出现 cache lock、daemon busy，或多个构建都没有进度。

**处理**：不要同时运行多个 Flutter/Gradle 构建。先确认进程：

```bash
pgrep -af 'GradleDaemon|GradleWrapperMain|flutter'
```

停止当前项目的 Gradle daemon：

```bash
cd dsh-mobile-app/android
./gradlew --stop
```

确认旧构建已退出后，只启动一个新构建。不要盲目结束系统中属于其他项目的 Java 进程。

### 8.4 Kotlin 增量缓存损坏

**现象**：出现 `Could not close incremental caches`、缓存文件无法关闭或增量编译状态异常。

**处理**：项目已在 `android/gradle.properties` 设置 `kotlin.incremental=false`。若仍发生：

```bash
cd dsh-mobile-app
flutter clean
flutter pub get
flutter build apk --release
```

### 8.5 `flutter: command not found`、`java: not found` 或 JDK 版本错误

**处理**：把 Flutter 和 JDK 17 加入 `PATH`，并设置 `JAVA_HOME`。随后重新执行：

```bash
flutter --version
java -version
flutter doctor -v
```

当前 Android 构建链以 JDK 17 为基线，不要随意切换到过旧 JDK。

### 8.6 `SDK location not found` 或 `flutter.sdk not set`

**处理**：检查 `dsh-mobile-app/android/local.properties`，确认 `sdk.dir` 和 `flutter.sdk` 是本机存在的绝对路径。该文件不可直接复制其他机器的路径。

### 8.7 AGP 9 / Kotlin 弃用警告

**现象**：日志提示 `android.builtInKotlin=false`、`android.newDsl=false` 或 `org.jetbrains.kotlin.android` 将弃用。

**说明**：在当前 Flutter 3.47.1 模板和依赖组合中，这些是迁移警告，不是本次构建失败原因。只要最终出现 `BUILD SUCCESSFUL`，可以正常产出 APK。

**处理**：不要为了消除警告单独删除配置或升级单个插件。后续迁移 Built-in Kotlin 时，应一起验证 Flutter、AGP、Kotlin 和 `mobile_scanner` 等插件，并完成完整构建与真机回归。

### 8.8 插件 Manifest 或 Android API 弃用警告

依赖插件可能提示 Manifest 的 `package` 属性被忽略，应用 Kotlin 代码也可能提示旧 Android API 弃用。这些警告不会阻止当前构建，但升级依赖时应复查。判断构建是否成功应以退出码、`BUILD SUCCESSFUL` 和 APK 校验为准。

### 8.9 构建成功但手机提示签名不一致

**原因**：新 APK 与手机已安装版本使用了不同 keystore，常见于正式签名与 Debug 回退签名混用。

**处理**：

- 正式升级：使用与旧版本完全相同的 keystore、alias 和密码重新构建；
- 无法找回旧 keystore：只能卸载旧 App 后重新安装，并重新扫码配置；
- 构建后用 `apksigner verify --print-certs` 对比证书 SHA-256。

### 8.10 `apksigner` 提示 `java: not found`

`apksigner` 自身也需要 Java。临时补充 JDK 17 到 `PATH`：

```bash
export JAVA_HOME=/path/to/jdk17
export PATH="$JAVA_HOME/bin:$PATH"
apksigner verify --verbose --print-certs app-release.apk
```

### 8.11 磁盘或内存不足

Flutter、Gradle、Android SDK、NDK 和中间产物会占用数 GB 空间。检查：

```bash
df -h .
free -h
```

优先清理当前项目产物：

```bash
cd dsh-mobile-app
flutter clean
```

不要随意删除整个 Android SDK、Flutter SDK 或 Gradle 用户缓存。

## 9. 本次成功构建记录

2026-08-24 在 Linux 环境完成一次 Release 构建：

- 分支：`feature/app-auto-update`；
- 构建命令：直接执行 `:app:assembleRelease`；
- Google 下载通过 `http://127.0.0.1:1080/`；
- 首次构建耗时：11 分 33 秒；
- Gradle 结果：`BUILD SUCCESSFUL`，366 个任务中 310 个执行、56 个命中缓存；
- APK 大小：72,966,782 bytes；
- SHA-256：`f5d0966cf219792bc23e0e71607d3b2f55456401abf9e4ad48ab55a747f1fe48`；
- 因没有 `android/key.properties`，该次产物使用 Debug 回退证书，仅用于测试；
- `apksigner` 验证结果为 v2 签名通过、v1 未启用。

该哈希只对应这一次本地产物。代码、依赖、版本号或签名变化后，APK 大小与哈希都会改变。
