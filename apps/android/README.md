# TokenBird Community Edition — Android

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

The app starts a localhost-only HTTP server inside the APK and loads the bundled frontend from it. On every fresh launch it first asks whether to use **Local mode** or **Server mode**; URL and token fields are shown only for Server mode. In Local mode, the APK extracts and starts the bundled ARM64 Bun backend on an available loopback port and connects with a generated per-launch token. The selected profile and optional bearer token are stored locally and can be changed later from Settings.

The Android local backend currently targets ARM64 devices on **Android 9 (API 28) or newer** and bundles the Pi runtime. The official Bun Android binary imports API 28 libc symbols, so Android 8.0/8.1 devices remain supported as remote clients but the app disables local mode there instead of attempting a process that cannot start. The Claude Agent SDK's native executable is **not** bundled — it is a glibc Linux binary that cannot run on Android's bionic libc, and Anthropic publishes no Android build — so the local Claude agent is unsupported on-device; the APK reports a clear error if it is requested and you should use a remote server instead. Optional desktop-native features such as Sharp image processing, Office conversion, and ripgrep are not included in the Android bundle. A LAN development server can still be configured with `ws://192.168.1.20:9100` under **Server mode**; production deployments should use `wss://`. Android skips the model onboarding screen, so model connections are managed on the selected server from Settings after connecting.
