# Craft Agent Android

This is a small Android WebView client for the Craft Agent server. It reuses the existing `apps/webui` application at runtime, so the APK contains no duplicate agent or messaging implementation.

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
bun run android:build -- -ServerUrl "https://your-agent-server.example"
```

The signed debug APK is written to `dist/android/craft-agent-debug.apk`. Build an unsigned release variant with:

```powershell
powershell -ExecutionPolicy Bypass -File apps/android/build.ps1 -Release -ServerUrl "https://your-agent-server.example"
```

Release output is `dist/android/craft-agent-release-unsigned.apk`. Configure a private Android signing key in your release pipeline before distributing it.

The app also exposes a **Change server** action in its toolbar. The URL is persisted locally and can include a port, for example `http://192.168.1.20:9100` for a local server. Cleartext HTTP is enabled for local development; production deployments should use HTTPS.
