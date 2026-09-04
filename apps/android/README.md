# Craft Agents Community Edition — Android

This is the Android client for Craft Agents Community Edition. It starts a loopback-only HTTP service inside the APK and bundles the `apps/webui` frontend as local assets, so the APK does not depend on the remote server hosting HTML, JavaScript, CSS, or fonts. Agent RPC, sessions, automations, models, and messaging continue to run on the configured server over WebSocket/RPC.

## Build

Requirements:

- Android SDK with platform `android-36` and build tools `36.1.0` or newer.
- JDK 17. The build script downloads a portable Temurin JDK 17 into `.toolchains/android/jdk17` when no JDK 17 is available.
- Network access on the first build so the Gradle wrapper can download Gradle 8.13, Android Gradle Plugin dependencies, and the ARM64 Android Bun runtime.

With command-line tools installed, the SDK packages can be prepared with:

```powershell
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.1.0"
```

From the repository root:

```powershell
bun run android:build
bun run android:build -- -ServerUrl "wss://your-agent-server.example:50003"
```

The signed debug APK is written to `dist/android/craft-agent-debug.apk`. Build an unsigned release variant with:

```powershell
powershell -ExecutionPolicy Bypass -File apps/android/build.ps1 -Release -ServerUrl "wss://your-agent-server.example:50003"
```

Release output is `dist/android/craft-agent-release-unsigned.apk`. Configure a private Android signing key in your release pipeline before distributing it.

The app starts a localhost-only HTTP server inside the APK and loads the bundled frontend from it. In **Local server** mode, the APK also extracts and starts the bundled ARM64 Bun backend automatically, waits for it on `127.0.0.1:9100`, and connects the frontend with a generated per-launch token. The selected profile and optional bearer token are stored locally and can be changed later with **Configure**.

The Android local backend currently targets ARM64 devices and bundles the Pi runtime. The Claude Agent SDK's native executable is **not** bundled — it is a glibc Linux binary that cannot run on Android's bionic libc, and Anthropic publishes no Android build — so the local Claude agent is unsupported on-device; the APK reports a clear error if it is requested and you should use a remote server instead. Optional desktop-native features such as Sharp image processing, Office conversion, and ripgrep are not included in the Android bundle. A LAN development server can still be configured with `ws://192.168.1.20:9100` under **Remote server**; production deployments should use `wss://`. Android skips the model onboarding screen, so model connections are managed on the selected server from Settings after connecting.
