param(
    [string]$ServerUrl = "wss://agent.goldgom.top:50003",
    [switch]$Release,
    [switch]$SkipToolchainInstall,
    [switch]$SkipServerRuntimeDownload
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$androidRoot = $PSScriptRoot
$sdkRoot = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$bunAndroidVersion = "1.3.14"
$claudeSdkVersion = "0.3.220"

function Find-Jdk17 {
    $candidates = @()
    if ($env:JAVA_HOME) { $candidates += $env:JAVA_HOME }
    $candidates += @(
        "C:\Program Files\Android\Android Studio\jbr",
        (Join-Path $projectRoot ".toolchains\android\jdk17")
    )
    foreach ($candidate in $candidates) {
        $java = Join-Path $candidate "bin\java.exe"
        if (Test-Path $java) {
            $previousPreference = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            $version = (& $java -version 2>&1 | Out-String)
            $ErrorActionPreference = $previousPreference
            if ($version -match 'version "17\.') { return $candidate }
        }
    }
    return $null
}

$jdkHome = Find-Jdk17
if (-not $jdkHome -and -not $SkipToolchainInstall) {
    & (Join-Path $androidRoot "tools\bootstrap-toolchain.ps1")
    $jdkHome = Find-Jdk17
}
if (-not $jdkHome) {
    throw "JDK 17 is required. Run apps/android/tools/bootstrap-toolchain.ps1 or set JAVA_HOME to a JDK 17 installation."
}
if (-not (Test-Path $sdkRoot)) {
    throw "Android SDK not found at $sdkRoot. Set ANDROID_HOME or install the Android SDK command-line tools."
}
if (-not (Test-Path (Join-Path $sdkRoot "platforms\android-36"))) {
    throw "Android SDK platform android-36 is missing at $sdkRoot. Install it with sdkmanager."
}

# Build and bundle the browser frontend so the APK does not require the remote
# server to host HTML, JavaScript, CSS, or font assets.
Push-Location $projectRoot
try {
    & bun run webui:build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    # The Android app owns the server lifecycle, but the server itself still
    # runs as JavaScript under Bun's Android runtime. Build the two subprocess
    # entrypoints before bundling the main server so local sessions can spawn
    # them from the app-private server directory.
    Push-Location (Join-Path $projectRoot "packages\pi-agent-server")
    try {
        & bun run build
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }
    Push-Location (Join-Path $projectRoot "packages\session-mcp-server")
    try {
        & bun run build
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } finally {
        Pop-Location
    }

    $serverAssetRoot = Join-Path $androidRoot "app\src\main\assets\server"
    if (Test-Path $serverAssetRoot) { Remove-Item -Recurse -Force $serverAssetRoot }
    New-Item -ItemType Directory -Force $serverAssetRoot | Out-Null

    # Bundle the headless server into one JS file. sharp and markitdown-js are
    # deliberately external: both depend on desktop/native components and are
    # loaded only when the corresponding optional image/document feature is
    # used. The Claude Agent SDK JavaScript is bundled here as well; its native
    # ARM64 executable is copied below because Android has no npm platform
    # package that can be resolved from node_modules at runtime.
    $serverEntry = Join-Path $serverAssetRoot "server.js"
    & bun build --target=bun --external=markitdown-js --external=sharp --outfile=$serverEntry (Join-Path $projectRoot "packages\server\src\index.ts")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    $resourceRoot = Join-Path $serverAssetRoot "resources"
    New-Item -ItemType Directory -Force $resourceRoot | Out-Null
    $electronResourceRoot = Join-Path $projectRoot "apps\electron\resources"
    foreach ($resourceName in @("config-defaults.json", "docs", "permissions", "skills", "themes", "tool-icons")) {
        $resourceSource = Join-Path $electronResourceRoot $resourceName
        if (Test-Path $resourceSource) {
            Copy-Item $resourceSource (Join-Path $resourceRoot $resourceName) -Recurse -Force
        }
    }

    # Pi and session MCP are spawned by the server using the Android Bun
    # executable, so they must be present in the extracted server root.
    $piDest = Join-Path $resourceRoot "pi-agent-server"
    $sessionDest = Join-Path $resourceRoot "session-mcp-server"
    New-Item -ItemType Directory -Force $piDest, $sessionDest | Out-Null
    Copy-Item (Join-Path $projectRoot "packages\pi-agent-server\dist\index.js") (Join-Path $piDest "index.js") -Force
    Copy-Item (Join-Path $projectRoot "packages\session-mcp-server\dist\index.js") (Join-Path $sessionDest "index.js") -Force

    # Claude Agent SDK >= 0.2.113 launches a native `claude` executable. The
    # SDK publishes a Linux ARM64 binary but no Android npm package. Download
    # it during the build and ship it as an extracted app asset. Keeping this
    # out of git avoids committing a ~270 MB generated binary to the repository.
    $claudeSdkRoot = Join-Path $projectRoot ".toolchains\android\claude-agent-sdk-linux-arm64-$claudeSdkVersion"
    $claudeSdkSource = Join-Path $claudeSdkRoot "package\claude"
    if (-not (Test-Path $claudeSdkSource)) {
        if ($SkipServerRuntimeDownload) {
            throw "Claude Agent SDK ARM64 binary not found at $claudeSdkSource. Remove -SkipServerRuntimeDownload to download it."
        }
        $claudeSdkArchive = Join-Path $projectRoot ".toolchains\android\claude-agent-sdk-linux-arm64-$claudeSdkVersion.tgz"
        if (-not (Test-Path $claudeSdkArchive)) {
            New-Item -ItemType Directory -Force (Split-Path $claudeSdkArchive) | Out-Null
            Write-Output "Downloading Claude Agent SDK $claudeSdkVersion ARM64 runtime..."
            & curl.exe -L --fail --output $claudeSdkArchive "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-arm64/-/claude-agent-sdk-linux-arm64-$claudeSdkVersion.tgz"
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        if (Test-Path $claudeSdkRoot) { Remove-Item -Recurse -Force $claudeSdkRoot }
        New-Item -ItemType Directory -Force $claudeSdkRoot | Out-Null
        & tar.exe -xzf $claudeSdkArchive -C $claudeSdkRoot
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    if (-not (Test-Path $claudeSdkSource)) {
        throw "Claude Agent SDK archive did not contain $claudeSdkSource."
    }
    $claudeDest = Join-Path $resourceRoot "claude-agent-sdk"
    New-Item -ItemType Directory -Force $claudeDest | Out-Null
    Copy-Item $claudeSdkSource (Join-Path $claudeDest "claude") -Force

    $bridgeSource = Join-Path $electronResourceRoot "bridge-mcp-server\index.js"
    if (Test-Path $bridgeSource) {
        $bridgeDest = Join-Path $resourceRoot "bridge-mcp-server"
        New-Item -ItemType Directory -Force $bridgeDest | Out-Null
        Copy-Item $bridgeSource (Join-Path $bridgeDest "index.js") -Force
    }
    # Include both runtime versions so LocalAgentServer re-extracts assets
    # after a Claude SDK update instead of retaining a stale executable.
    Set-Content -Path (Join-Path $serverAssetRoot "version.txt") -Value "$bunAndroidVersion-claude-$claudeSdkVersion" -NoNewline

    # Bun publishes a native Android runtime rather than a Windows host
    # executable. Store it as a JNI library so Android extracts it into the
    # app's executable nativeLibraryDir; the Java launcher executes that file.
    $jniRoot = Join-Path $androidRoot "app\src\main\jniLibs\arm64-v8a"
    New-Item -ItemType Directory -Force $jniRoot | Out-Null
    $bunRuntime = Join-Path $jniRoot "libbun.so"
    $bunArchive = Join-Path $projectRoot ".toolchains\android\bun-linux-aarch64-android.zip"
    $bunExtractRoot = Join-Path $projectRoot ".toolchains\android\bun-linux-aarch64-android-$bunAndroidVersion"
    $bunSource = Join-Path $bunExtractRoot "bun-linux-aarch64-android\bun"
    if (-not (Test-Path $bunSource)) {
        if ($SkipServerRuntimeDownload) {
            throw "Android Bun runtime not found at $bunSource. Remove -SkipServerRuntimeDownload to download it."
        }
        New-Item -ItemType Directory -Force (Split-Path $bunArchive) | Out-Null
        if (-not (Test-Path $bunArchive)) {
            Write-Output "Downloading Bun Android runtime $bunAndroidVersion..."
            & curl.exe -L --fail --output $bunArchive "https://github.com/oven-sh/bun/releases/download/bun-v$bunAndroidVersion/bun-linux-aarch64-android.zip"
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        Expand-Archive -Path $bunArchive -DestinationPath $bunExtractRoot -Force
    }
    if (-not (Test-Path $bunSource)) { throw "Bun Android runtime archive did not contain $bunSource." }
    Copy-Item $bunSource $bunRuntime -Force
} finally {
    Pop-Location
}
$assetRoot = Join-Path $androidRoot "app\src\main\assets\webui"
if (Test-Path $assetRoot) { Remove-Item -Recurse -Force $assetRoot }
New-Item -ItemType Directory -Force $assetRoot | Out-Null
$webuiDist = Join-Path $projectRoot "apps\webui\dist"
# Source maps are useful during web development but are not needed in the APK.
# Excluding them keeps the embedded WebView bundle small and avoids shipping
# several hundred MB of debugging data.
Get-ChildItem -LiteralPath $webuiDist -Recurse -File |
    Where-Object { $_.Extension -ne ".map" } |
    ForEach-Object {
        $relativePath = $_.FullName.Substring($webuiDist.Length).TrimStart("\", "/")
        $destination = Join-Path $assetRoot $relativePath
        $destinationDirectory = Split-Path -Parent $destination
        New-Item -ItemType Directory -Force $destinationDirectory | Out-Null
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    }

$env:JAVA_HOME = $jdkHome
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$task = if ($Release) { "assembleRelease" } else { "assembleDebug" }
# The WebView assets are replaced on every build. Clean first so Gradle's
# incremental ZIP packager cannot retain deleted hashed chunks as unreferenced
# data in the APK.
$gradleArgs = @("clean", $task, "-PserverUrl=$ServerUrl")

Push-Location $androidRoot
try {
    & .\gradlew.bat @gradleArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

$variant = if ($Release) { "release" } else { "debug" }
$apkCandidates = @(
    (Join-Path $androidRoot "app\build\outputs\apk\$variant\app-$variant.apk"),
    (Join-Path $androidRoot "app\build\outputs\apk\$variant\app-$variant-unsigned.apk")
)
$apk = $apkCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $apk) { throw "Gradle completed but no $variant APK was found." }
$outputDir = Join-Path $projectRoot "dist\android"
New-Item -ItemType Directory -Force $outputDir | Out-Null
$outputName = if ($Release -and $apk.EndsWith("-unsigned.apk")) { "craft-agent-$variant-unsigned.apk" } else { "craft-agent-$variant.apk" }
$outputApk = Join-Path $outputDir $outputName
Copy-Item $apk $outputApk -Force
Write-Output "APK: $outputApk"
