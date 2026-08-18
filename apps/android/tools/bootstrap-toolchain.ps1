param([switch]$Force)

$ErrorActionPreference = "Stop"
$androidRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$projectRoot = (Resolve-Path (Join-Path $androidRoot "../..")).Path
$toolchainRoot = Join-Path $projectRoot ".toolchains\android"
$jdkHome = Join-Path $toolchainRoot "jdk17"
$javaExe = Join-Path $jdkHome "bin\java.exe"

if ((Test-Path $javaExe) -and -not $Force) {
    Write-Output "JDK 17 already available at $jdkHome"
    exit 0
}

New-Item -ItemType Directory -Force $toolchainRoot | Out-Null
$archive = Join-Path $toolchainRoot "temurin17.zip"
$url = "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse"
Write-Output "Downloading JDK 17 from Adoptium..."
Invoke-WebRequest -Uri $url -OutFile $archive

$extractRoot = Join-Path $toolchainRoot "extracted"
if (Test-Path $extractRoot) { Remove-Item -Recurse -Force $extractRoot }
Expand-Archive -Path $archive -DestinationPath $extractRoot -Force
$extractedJdk = Get-ChildItem $extractRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName "bin\java.exe") } | Select-Object -First 1
if (-not $extractedJdk) { throw "The downloaded JDK archive did not contain a usable JDK 17." }

if (Test-Path $jdkHome) { Remove-Item -Recurse -Force $jdkHome }
Move-Item $extractedJdk.FullName $jdkHome
Remove-Item -Recurse -Force $extractRoot
Remove-Item $archive -Force
Write-Output "Installed JDK 17 at $jdkHome"
