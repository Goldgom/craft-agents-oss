# Build-host pure/mocked tests. Never launch installers or show fixture windows.
$ErrorActionPreference = 'Stop'
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../apps/win7-local/installer/install-dependencies.ps1') -Raw
$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Get-NativeInstallerLaunch', 'Wait-NativeInstaller')) {
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([ScriptBlock]::Create($function.Extent.Text))
}
foreach ($id in @('git', 'java', 'python')) {
    $launch = Get-NativeInstallerLaunch $id @{kind='installer'} ('D:\payload with spaces\' + $id + '.exe') 'D:\logs with spaces'
    if ($launch.WindowStyle -ne 'Normal' -or $launch.Verb -ne 'Open' -or !$launch.PassThru) { throw 'Native UI launch policy broken' }
    if ($launch.WorkingDirectory -ne 'D:\payload with spaces') { throw 'Working directory broken' }
    if (($launch.ArgumentList -join ' ') -match '(?i)/(quiet|passive|silent|verysilent)|(^|\s)/s(\s|$)') { throw 'Silent setup argument present' }
    if ($id -eq 'python') {
        if ($launch.ArgumentList.Count -ne 2 -or $launch.ArgumentList[0] -ne '/log' -or $launch.ArgumentList[1] -ne '"D:\logs with spaces\python-setup.log"') { throw 'Python interactive logging broken' }
    } elseif ($launch.ContainsKey('ArgumentList')) { throw 'Unexpected Git/Java arguments' }
}
$update = Get-NativeInstallerLaunch 'update' @{kind='update'} 'D:\update.msu' 'D:\logs'
if ($update.Verb -ne 'RunAs' -or $update.WindowStyle -ne 'Normal' -or $update.ArgumentList[1] -ne '/norestart') { throw 'MSU interactive launch broken' }
$process = New-Object PSObject -Property @{ Handle=123; ExitCode=0; Waited=$false; Refreshed=$false }
$process | Add-Member ScriptMethod WaitForExit { $this.Waited = $true }
$process | Add-Member ScriptMethod Refresh { $this.Refreshed = $true }
if ((Wait-NativeInstaller $process) -ne 0 -or !$process.Waited -or !$process.Refreshed) { throw 'Installer wait/exit-code handling broken' }
$process.ExitCode = 1602
if ((Wait-NativeInstaller $process) -ne 1602) { throw 'Cancellation code lost' }
$process.ExitCode = $null
$caught = $false
try { Wait-NativeInstaller $process } catch { $caught = $true }
if (!$caught) { throw 'Unknown exit code falsely reported success' }
# A harmless real Windows process checks the handle/exit-code path as well.
# Its window stays hidden and it performs no install or filesystem operation.
$real = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList '/c exit /b 1602' -WindowStyle Hidden -PassThru
try {
    if ((Wait-NativeInstaller $real) -ne 1602) { throw 'Real process exit code lost' }
} finally { $real.Dispose() }
Write-Host 'PASS: visible Git/Java/Python native UI policy, no silent flags, Python current-user logging, interactive MSU, process wait and cancellation/unknown codes'
