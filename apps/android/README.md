# TokenBird Community Edition — Android

Android / Windows 功能对照与当前平台限制：[FEATURE_PARITY.md](FEATURE_PARITY.md)。

This is the Android client for TokenBird Community Edition. It starts a loopback-only HTTP service inside the APK and bundles the `apps/webui` frontend as local assets, so the APK does not depend on the remote server hosting HTML, JavaScript, CSS, or fonts. Agent RPC, sessions, automations, models, and messaging continue to run on the configured server over WebSocket/RPC.

## Background work and display

Local chat runs in an independent foreground service, so closing or recreating the activity does not terminate its backend. An app-private task counter lets a service worker keep the CPU awake only while work is active, including when the WebView is suspended. Settings provides a background execution authorization entry; on vivo/iQOO also allow **High background power usage** in the system background power controls. Display language is saved in native preferences and restored before the WebUI renders, even if its loopback port changes. Image messages can preview stored originals when Android cannot generate thumbnails, and image-only messages omit empty text bubbles.

## Build

Requirements:

- Android SDK with platform `android-36`, build tools `36.1.0` or newer, and an Android NDK (the build script uses it for the ARM64 Bun compatibility layer).
- JDK 17. The build script downloads a portable Temurin JDK 17 into `.toolchains/android/jdk17` when no JDK 17 is available.
- Network access on the first build so the Gradle wrapper can download Gradle 8.13, Android Gradle Plugin dependencies, and the ARM64 Android Bun runtime.

With command-line tools installed, the SDK packages can be prepared with:

```powershell
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.1.0" "ndk;28.2.13676358"
```

From the repository root:

```powershell
bun run android:build
bun run android:build -- -ServerUrl "wss://your-agent-server.example:50003"
```

The signed debug APK is written to `dist/android/tokenbird-debug.apk`.

## 发布版打包与签名

本地发布流程在 **Windows / PowerShell + JDK 17** 上运行，重新构建 WebUI、本地服务器、Pi / MCP 和 ARM64 Bun 运行库。发布版必须配置签名；缺少密钥、密码或 alias 时会在构建资源前失败。直接运行 Gradle release 任务也执行此检查。

### 1. 准备发布密钥

已有发布密钥时直接复用。首次发布可以运行：

```powershell
powershell -ExecutionPolicy Bypass -File apps/android/tools/create-release-key.ps1
```

脚本通过隐藏输入收集密码，默认生成 `%LOCALAPPDATA%/TokenBird/signing/release.p12`，alias 为 `tokenbird`，不会覆盖已有文件。也可传入 `-KeystorePath` 和 `-KeyAlias`；自动化生成可通过 `ANDROID_KEYSTORE_PASSWORD` 提供密码。生成的 PKCS12 私钥密码与密钥库密码相同。

备份密钥、alias 和密码。后续更新必须保持相同应用 ID 和签名密钥；从 debug 签名迁移到 release 签名不能直接覆盖安装。需要先导出用户数据，或使用独立的 debug 包名并行测试。

### 2. 配置签名

```powershell
Copy-Item apps/android/signing.properties.example apps/android/signing.properties
```

填写复制后的配置。`storeFile` 使用绝对路径，或相对于 properties 文件的路径；Windows 路径请使用 `/`。`signing.properties` 和常见密钥文件扩展名已加入 Git 忽略规则。其他文件名的私密配置请存放在仓库外。

也可设置环境变量（优先于 properties 中对应字段）：

| 环境变量 | properties 字段 | 用途 |
| --- | --- | --- |
| `ANDROID_KEYSTORE_PATH` | `storeFile` | 密钥文件 |
| `ANDROID_KEYSTORE_PASSWORD` | `storePassword` | 密钥库密码 |
| `ANDROID_KEY_ALIAS` | `keyAlias` | 签名密钥 alias |
| `ANDROID_KEY_PASSWORD` | `keyPassword` | 私钥密码 |
| `ANDROID_SIGNING_PROPERTIES` | — | 可选自定义配置文件路径 |

脚本也支持 `-SigningProperties C:/private/signing.properties`。密码不通过命令行 `-P` 参数传递，不会复制到 APK / AAB 中。

### 3. 校验与构建

```powershell
# 只验证密钥库、alias、密码与版本参数
powershell -ExecutionPolicy Bypass -File apps/android/build.ps1 -Release -ValidateOnly

# 可直接安装的签名 APK
bun run android:release -- -VersionCode 5 -VersionName "26.10.20"

# 签名 APK 和用于应用商店的 AAB
bun run android:bundle -- -VersionCode 5 -VersionName "26.10.20"

# 只生成 AAB，自定义服务器默认地址
powershell -ExecutionPolicy Bypass -File apps/android/build.ps1 -Release -Artifact Aab -VersionCode 5 -ServerUrl "wss://your-agent-server.example:50003"

# 汇总入口沿用相同签名配置，默认生成 release APK
bun run build:all android --release
```

`VersionCode` 必须为 1–2100000000，每次发布更新时递增；也可通过 `ANDROID_VERSION_CODE` / `ANDROID_VERSION_NAME` 配置。默认值来自 Android Gradle 配置。只改变 `VersionName` 不能替代递增 `VersionCode`。

产物写入 `dist/android/`：`tokenbird-release.apk`、`tokenbird-release.aab`，以及各自的 `.sha256` 校验文件。脚本先检查 APK 的 ZIP 对齐并逐项验证 v1 / v2 / v3 签名，AAB 则验证全部内容条目的 JAR 签名及签名证书一致性，验证通过才复制到发布目录。Release 关闭 debuggable。AAB 不能直接安装到手机；应用商店或 bundletool 需要从 AAB 生成设备安装包。

### 4. GitHub Actions

`.github/workflows/android.yml` 在 Windows runner 上复用完整本地构建脚本。push 构建 debug APK；手动运行时开启 `release`、填写版本号，生成签名 APK + AAB。

在仓库 Actions Secrets 配置以下四项：

- `ANDROID_KEYSTORE_BASE64`：发布密钥文件的 Base64 内容。
- `ANDROID_KEYSTORE_PASSWORD`：密钥库密码。
- `ANDROID_KEY_ALIAS`：密钥 alias。
- `ANDROID_KEY_PASSWORD`：私钥密码。

在本机转换密钥并复制 Base64 到剪贴板：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:LOCALAPPDATA/TokenBird/signing/release.p12")) | Set-Clipboard
```

CI 临时密钥在任务结束时删除；验证后的构建产物上传到 Actions artifacts，不会自动发布到应用商店。

## 安装失败排查

厂商安装器的 `解析软件包时出现问题 (33) / packageInfo is null` 表示读取包信息失败，单凭此提示不能定位签名、文件损坏还是厂商扫描器问题。先确认安装的是 `.apk`，核对下载文件与发布产物的 SHA256；`.aab` 和下载错误页不能直接安装。客户端不依赖 GMS，缺少 Google Play 服务不是预期的安装阻碍。

Android 11 起，面向 API 30 及以上的应用至少需要 v2 签名，只有 v1 不够；较新系统没有普遍强制使用 v3。v3 主要提供签名密钥轮换能力。本项目发布包同时提供 v1 / v2 / v3；这不保证解决所有厂商安装器的解析失败。

- 当前 APK 最低支持 Android 8.0（API 26），只包含 `arm64-v8a` 原生运行库；32 位 ARM / x86 系统不兼容。CPU 支持 64 位不代表系统一定支持 ARM64 应用。
- 使用 `apksigner verify --verbose --print-certs <apk>` 检查签名，`aapt dump badging <apk>` 检查 manifest、系统要求和 ABI。
- 覆盖安装失败要核对现有包的签名与 versionCode。不要为解决签名冲突直接卸载并丢失本地会话数据。
- 通过 `adb install -r <apk>` 获取系统错误码，并查看 `adb logcat` 中 PackageManager / PackageInstaller 的解析错误。`NO_MATCHING_ABIS`、`UPDATE_INCOMPATIBLE`、`VERSION_DOWNGRADE` 与 `PARSE_FAILED_*` 对应不同原因。
- 如果 APK 签名及包结构正常，而某厂商文件扫描器仍失败，比较从系统文件管理器安装与 ADB 安装结果，保留型号、系统版本、安装来源和系统日志后再判断。

### 小米 / MIUI 优化

`packageInfo is null` 出现在安装前读取包信息的阶段。Android 的 `getPackageArchiveInfo` 在解析失败时也会返回 `null`，此提示不能单独证明 MIUI 优化开关造成了失败。MIUI / HyperOS 的厂商扫描、安装来源和文件读取路径可以作为排查方向；缺少目标设备日志时，不能把关闭 MIUI 优化当成已验证的修复。

应用尚未安装时，TokenBird 的 Java / JavaScript 代码不会执行，因此应用不能自行修复系统安装器或切换 MIUI 优化。打包侧可以修复签名、损坏的包结构、资源格式和 ABI 不匹配；当前发布流程已提供 v1 / v2 / v3 签名及对齐验证。不要为排查盲目降低 targetSdk、关闭系统扫描或禁用原生库提取；后者会使内置 Bun 无法执行。

在 Windows 上连接出问题的小米、开启 USB 调试并授权电脑，然后运行：

```powershell
# 默认只检查 APK、读取手机信息和现有安装日志
powershell -ExecutionPolicy Bypass -File apps/android/tools/diagnose-install.ps1

# 使用手机上实际安装失败的文件进行检查
powershell -ExecutionPolicy Bypass -File apps/android/tools/diagnose-install.ps1 -ApkPath "C:/Downloads/tokenbird.apk"

# 可选：尝试覆盖安装，获取 Android 的真实失败码（不会卸载或清除数据）
powershell -ExecutionPolicy Bypass -File apps/android/tools/diagnose-install.ps1 -TryInstall
```

多台设备连接时加 `-Serial <adb设备序列号>`。报告在 `.build/android-install-diagnostics/<随机ID>/`，包含 APK SHA256、解析/签名/对齐结果、系统版本、CPU ABI、可读取的 MIUI 优化属性、目标应用信息和安装相关日志。属性不存在不代表开关已关闭；脚本不会修改系统设置或清空日志。

| 诊断结果 | 处理方向 |
| --- | --- |
| APK 在电脑上也无法解析、签名无效或 SHA256 不同 | 重新构建或重新下载完整签名 APK |
| `CPU_ABI_NOT_SUPPORTED` / `INSTALL_FAILED_NO_MATCHING_ABIS` | 当前系统不支持本包 ARM64 ABI；需要匹配架构的包 |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 已安装版本的签名不同；保留数据并使用原签名更新 |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | 使用更高 versionCode 的包 |
| `INSTALL_PARSE_FAILED_*` | 按完整错误及 PackageManager 日志修复对应格式、manifest 或签名问题 |
| ADB 安装成功，系统文件管理器安装失败 | 缩小到图形安装器、安装来源权限、厂商扫描等路径；仍不能仅凭此认定是 MIUI 优化 |

如需比较 MIUI 优化开关的影响，应保持手机、APK SHA256 和安装来源一致，并记录两种状态的结果；仅在关闭状态安装成功也只能说明相关性，需要结合安装器日志定位具体策略。

## App behavior

The app starts a localhost-only HTTP server inside the APK and loads the bundled frontend from it. Every fresh launch opens **Local chat** directly on supported devices and starts a new conversation; reloading a page preserves its current conversation. The APK extracts and starts the bundled ARM64 Bun backend on an available loopback port and connects with a generated per-launch token. Use the left drawer's mode entry to switch to **Server mode** later; URL and token fields are shown only there. Remote credentials are retained locally, but do not change the next fresh launch's local default. Devices that cannot run the local backend open the mode picker instead.

The Android interface starts with a light RGB palette compatible with older WebViews and retains a persistent light/dark switch in the drawer (Settings also supports following the system theme). The native configuration pages and system bars follow the selected theme. It has a persistent app bar, a left drawer with searchable recent and starred conversations, and a touch-sized composer. The app bar offers workspace selection and a new conversation action; additional tools and server configuration stay in the drawer.

The chat composer stays available while a reply is running, with a stop button and compact context action that fit narrow phones. The Android Pi bundle disables the SDK's desktop native clipboard loader; Android clipboard access belongs to the WebView. Runtime startup has a 45-second deadline so a stalled child produces an error and can be retried instead of leaving a conversation busy indefinitely. System locale extensions (such as Android Bun's `en-US-u-va-posix`) are handled when formatting the prompt's language preference.

App dialogs, including canvas and mind-map connection prompts, open as fullscreen pages on Android. Their height follows the visible viewport when the keyboard opens; long forms remain scrollable, and closing controls stay visible. App-owned native permission and ADB confirmations also use fullscreen windows. Android's system permission prompts and file pickers remain system-managed.

On the canvas, pinch with two fingers to zoom (10–400%) and drag both fingers to pan, regardless of the selected tool. Single-finger input keeps using the selected tool; choose the hand tool for single-finger panning. Starting a two-finger gesture cancels the unfinished edit, and lifting one finger does not resume painting. Zoom buttons and Fit to content remain available.

Drawer entries for skills, sources, projects, sessions, automations, and settings open their lists first. Sources show existing integrations in the active workspace, with API/MCP/local filters; selecting a row opens its details. Compact Back returns to the same list and preserves its filter. Standalone agent, script-monitor, and tool management pages render their controls in the visible content panel.

The drawer's recent and starred conversations include only sessions with message history. Empty sessions created when opening local chat or starting a new conversation stay out of the drawer until a message exists; titles and creation timestamps alone do not qualify. Existing sessions are not deleted by this display filter.

If the installed app uses a different signing key, preserve it and its data by building a separate debug app: `powershell -ExecutionPolicy Bypass -File apps/android/build.ps1 -DebugApplicationIdSuffix .dev`. This produces `dist/android/tokenbird-debug-device.apk`, package `top.goldgom.tokenbird.dev`, named **词元鸟 · 调试**. WebView inspection is enabled only in debug builds.

The Android local backend currently targets ARM64 devices on **Android 9 (API 28) or newer** and bundles the Pi runtime. The official Bun Android binary imports API 28 libc symbols, so Android 8.0/8.1 devices remain supported as remote clients but the app disables local mode there instead of attempting a process that cannot start. The Claude Agent SDK's native executable is **not** bundled — it is a glibc Linux binary that cannot run on Android's bionic libc, and Anthropic publishes no Android build — so the local Claude agent is unsupported on-device; the APK reports a clear error if it is requested and you should use a remote server instead. Optional desktop-native features such as Sharp image processing, Office conversion, and ripgrep are not included in the Android bundle. A LAN development server can still be configured with `ws://192.168.1.20:9100` under **Server mode**; production deployments should use `wss://`. Android skips the model onboarding screen, so model connections are managed on the selected server from Settings after connecting.
