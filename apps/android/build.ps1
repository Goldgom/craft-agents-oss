param(
    [string]$ServerUrl = "https://agent.goldgom.top",
    [switch]$Release,
    [switch]$SkipToolchainInstall
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$androidRoot = $PSScriptRoot
$sdkRoot = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } elseif ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }

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

$env:JAVA_HOME = $jdkHome
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$task = if ($Release) { "assembleRelease" } else { "assembleDebug" }
$gradleArgs = @("$task", "-PserverUrl=$ServerUrl")

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
