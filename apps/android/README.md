# TokenBird Community Edition — Android

Android / Windows 功能对照与当前平台限制：[FEATURE_PARITY.md](FEATURE_PARITY.md)。

This is the Android client for TokenBird Community Edition. It starts a loopback-only HTTP service inside the APK and bundles the `apps/webui` frontend as local assets, so the APK does not depend on the remote server hosting HTML, JavaScript, CSS, or fonts. Agent RPC, sessions, automations, models, and messaging continue to run on the configured server over WebSocket/RPC.

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

The signed debug APK is written to `dist/android/tokenbird-debug.apk`. Build an unsigned release variant with:

```powershell
powershell -ExecutionPolicy Bypass -File apps/android/build.ps1 -Release -ServerUrl "wss://your-agent-server.example:50003"
```

Release output is `dist/android/tokenbird-release-unsigned.apk`. Configure a private Android signing key in your release pipeline before distributing it.

The app starts a localhost-only HTTP server inside the APK and loads the bundled frontend from it. Every fresh launch opens **Local chat** directly on supported devices and starts a new conversation; reloading a page preserves its current conversation. The APK extracts and starts the bundled ARM64 Bun backend on an available loopback port and connects with a generated per-launch token. Use the left drawer's mode entry to switch to **Server mode** later; URL and token fields are shown only there. Remote credentials are retained locally, but do not change the next fresh launch's local default. Devices that cannot run the local backend open the mode picker instead.

The Android interface starts with a light RGB palette compatible with older WebViews and retains a persistent light/dark switch in the drawer (Settings also supports following the system theme). The native configuration pages and system bars follow the selected theme. It has a persistent app bar, a left drawer with searchable recent and starred conversations, and a touch-sized composer. The app bar offers workspace selection and a new conversation action; additional tools and server configuration stay in the drawer.

App dialogs, including canvas and mind-map connection prompts, open as fullscreen pages on Android. Their height follows the visible viewport when the keyboard opens; long forms remain scrollable, and closing controls stay visible. App-owned native permission and ADB confirmations also use fullscreen windows. Android's system permission prompts and file pickers remain system-managed.

On the canvas, pinch with two fingers to zoom (10–400%) and drag both fingers to pan, regardless of the selected tool. Single-finger input keeps using the selected tool; choose the hand tool for single-finger panning. Starting a two-finger gesture cancels the unfinished edit, and lifting one finger does not resume painting. Zoom buttons and Fit to content remain available.

Drawer entries for skills, sources, projects, sessions, automations, and settings open their lists first. Sources show existing integrations in the active workspace, with API/MCP/local filters; selecting a row opens its details. Compact Back returns to the same list and preserves its filter. Standalone agent, script-monitor, and tool management pages render their controls in the visible content panel.

The drawer's recent and starred conversations include only sessions with message history. Empty sessions created when opening local chat or starting a new conversation stay out of the drawer until a message exists; titles and creation timestamps alone do not qualify. Existing sessions are not deleted by this display filter.

If the installed app uses a different signing key, preserve it and its data by building a separate debug app: `powershell -ExecutionPolicy Bypass -File apps/android/build.ps1 -DebugApplicationIdSuffix .dev`. This produces `dist/android/tokenbird-debug-device.apk`, package `top.goldgom.tokenbird.dev`, named **词元鸟 · 调试**. WebView inspection is enabled only in debug builds.

The Android local backend currently targets ARM64 devices on **Android 9 (API 28) or newer** and bundles the Pi runtime. The official Bun Android binary imports API 28 libc symbols, so Android 8.0/8.1 devices remain supported as remote clients but the app disables local mode there instead of attempting a process that cannot start. The Claude Agent SDK's native executable is **not** bundled — it is a glibc Linux binary that cannot run on Android's bionic libc, and Anthropic publishes no Android build — so the local Claude agent is unsupported on-device; the APK reports a clear error if it is requested and you should use a remote server instead. Optional desktop-native features such as Sharp image processing, Office conversion, and ripgrep are not included in the Android bundle. A LAN development server can still be configured with `ws://192.168.1.20:9100` under **Server mode**; production deployments should use `wss://`. Android skips the model onboarding screen, so model connections are managed on the selected server from Settings after connecting.
