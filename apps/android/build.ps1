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

    # Keep the Android startup graph split into small ESM chunks. Loading the
    # previous 20+ MB single-file bundle can leave Bun compiling indefinitely
    # on some Android 12 vendor runtimes before the first JS statement runs.
    # Messaging is disabled in local Android mode, and Claude Code has no
    # Android native executable, so neither dependency belongs in the APK's
    # eager server graph.
    & bun build `
        --target=bun `
        --format=esm `
        --splitting `
        --external=markitdown-js `
        --external=sharp `
        --external=@craft-agent/messaging-gateway `
        --external=@anthropic-ai/claude-agent-sdk `
        --entry-naming=server.js `
        --chunk-naming=chunks/[name]-[hash].[ext] `
        --outdir=$serverAssetRoot `
        (Join-Path $projectRoot "packages\server\src\index.ts")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    # Static imports still reference the Claude SDK even though Android rejects
    # Claude sessions before use. Resolve those imports to a tiny fail-fast ESM
    # shim instead of parsing and shipping the 1.8 MB desktop SDK.
    $claudeStubSource = Join-Path $androidRoot "runtime-stubs\anthropic-claude-agent-sdk"
    $claudeStubDest = Join-Path $serverAssetRoot "node_modules\@anthropic-ai\claude-agent-sdk"
    New-Item -ItemType Directory -Force (Split-Path -Parent $claudeStubDest) | Out-Null
    Copy-Item -LiteralPath $claudeStubSource -Destination $claudeStubDest -Recurse -Force

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

    $bridgeSource = Join-Path $electronResourceRoot "bridge-mcp-server\index.js"
    if (Test-Path $bridgeSource) {
        $bridgeDest = Join-Path $resourceRoot "bridge-mcp-server"
        New-Item -ItemType Directory -Force $bridgeDest | Out-Null
        Copy-Item $bridgeSource (Join-Path $bridgeDest "index.js") -Force
    }
    # The marker must follow the server bundle as well as Bun. A Bun-only
    # marker leaves stale server code installed when an app update keeps the
    # same runtime version.
    $bundleHashLines = Get-ChildItem -LiteralPath $serverAssetRoot -Recurse -File |
        Sort-Object FullName |
        ForEach-Object {
            $relative = $_.FullName.Substring($serverAssetRoot.Length).TrimStart("\", "/")
            "$relative`:$((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash)"
        }
    $bundleHashBytes = [Text.Encoding]::UTF8.GetBytes(($bundleHashLines -join "`n"))
    $bundleHasher = [Security.Cryptography.SHA256]::Create()
    try {
        $bundleHash = -join ($bundleHasher.ComputeHash($bundleHashBytes) | ForEach-Object { $_.ToString("x2") })
    } finally {
        $bundleHasher.Dispose()
    }
    Set-Content -Path (Join-Path $serverAssetRoot "version.txt") -Value "$bunAndroidVersion-$($bundleHash.Substring(0, 16))" -NoNewline

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

    # Bun probes close_range(2) during startup. A few Android 12 vendor
    # seccomp profiles (including vivo PD1981) kill that syscall instead of
    # returning ENOSYS, so Bun never reaches its fallback. Build a tiny
    # LD_PRELOAD compatibility library that rejects only close_range before it
    # reaches the kernel. LocalAgentServer loads it for the Bun child process.
    $ndkRoot = Join-Path $sdkRoot "ndk"
    $ndk = Get-ChildItem -LiteralPath $ndkRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object { [version]$_.Name } -Descending |
        Select-Object -First 1
    if (-not $ndk) {
        throw "Android NDK is required to build the Bun seccomp compatibility library. Install it with sdkmanager 'ndk;28.2.13676358'."
    }
    $androidClang = Join-Path $ndk.FullName "toolchains\llvm\prebuilt\windows-x86_64\bin\aarch64-linux-android28-clang.cmd"
    if (-not (Test-Path $androidClang)) {
        throw "Android ARM64 compiler not found at $androidClang."
    }
    $compatSource = Join-Path $androidRoot "runtime\bun-seccomp-compat.c"
    $compatRuntime = Join-Path $jniRoot "libbun_seccomp_compat.so"
    & $androidClang -shared -fPIC -O2 -Wall -Wextra -Werror -o $compatRuntime $compatSource
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Write-Output "Bundled Bun $bunAndroidVersion supports local mode on Android API 28 and newer; API 26/27 remain supported in remote mode."
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
$outputName = if ($Release -and $apk.EndsWith("-unsigned.apk")) { "tokenbird-$variant-unsigned.apk" } else { "tokenbird-$variant.apk" }
$outputApk = Join-Path $outputDir $outputName
Copy-Item $apk $outputApk -Force
Write-Output "APK: $outputApk"
