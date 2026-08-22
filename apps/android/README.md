# Craft Agents Community Edition — Android

This is the Android client for Craft Agents Community Edition. It starts a loopback-only HTTP service inside the APK and bundles the `apps/webui` frontend as local assets, so the APK does not depend on the remote server hosting HTML, JavaScript, CSS, or fonts. Agent RPC, sessions, automations, models, and messaging continue to run on the configured server over WebSocket/RPC.

## Build

Requirements:

- Android SDK with platform `android-36` and build tools `36.1.0` or newer.
- JDK 17. The build script downloads a portable Temurin JDK 17 into `.toolchains/android/jdk17` when no JDK 17 is available.
- Network access on the first build so the Gradle wrapper can download Gradle 8.13 and Android Gradle Plugin dependencies.

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

The app starts a localhost-only HTTP server inside the APK and loads the bundled frontend from it. On first launch, the server home lets the user choose and independently configure a **Local server** or **Remote server** profile. The selected profile and optional bearer token are stored locally and can be changed later with **Configure**.

“Local server” means a Craft Agent backend already running on the Android device or local network; the loopback HTTP server bundled in the APK serves frontend assets only. A LAN development server can use `ws://192.168.1.20:9100`; production deployments should use `wss://`. Android skips the model onboarding screen, so model connections are managed on the selected server from Settings after connecting.
