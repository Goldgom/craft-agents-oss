# Windows 7 / PowerShell 2.0 / .NET 3.5 compatible. No ConvertFrom-Json,
# Expand-Archive, setx, or downloads. Never run third-party setup during tests.
param(
    [Parameter(Mandatory=$true)][string]$PayloadDirectory,
    [Parameter(Mandatory=$true)][string]$SelectionFile,
    [string]$StateRoot = (Join-Path $env:APPDATA 'TokenBird-Win7-Local'),
    [switch]$DryRun,
    [switch]$ExtractOnly
)
$ErrorActionPreference = 'Stop'

function Read-Ini([string]$File) {
    $result = @{}
    $section = ''
    foreach ($line in [IO.File]::ReadAllLines($File)) {
        if ($line -match '^\[([^\]]+)\]$') {
            $section = $matches[1]
            $result[$section] = @{}
        } elseif ($line -match '^([^=]+)=(.*)$' -and $section) {
            $result[$section][$matches[1]] = $matches[2]
        }
    }
    return $result
}
function Write-Ini([string]$File, [hashtable]$Data) {
    $lines = New-Object 'System.Collections.Generic.List[string]'
    foreach ($section in ($Data.Keys | Sort-Object)) {
        $lines.Add('[' + $section + ']')
        foreach ($key in ($Data[$section].Keys | Sort-Object)) {
            $value = [string]$Data[$section][$key]
            if ($value -match '[\r\n]') { throw 'Invalid INI value' }
            $lines.Add($key + '=' + $value)
        }
    }
    $tempFile = $File + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllLines($tempFile, $lines.ToArray(), [Text.Encoding]::Unicode)
    # PowerShell 2 may coerce a null string argument into an illegal empty path.
    if ([IO.File]::Exists($File)) { [IO.File]::Replace($tempFile, $File, ($File + '.previous')) }
    else { [IO.File]::Move($tempFile, $File) }
}
function Get-Hash([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    # .NET 3.5 HashAlgorithm exposes IDisposable.Dispose explicitly, not as
    # a public method. PowerShell 2 cannot invoke $sha.Dispose(). Clear() is
    # public on both old and new .NET and releases the same hash resources.
    finally { $stream.Close(); $sha.Clear() }
}
function Log([string]$Message) {
    $line = [DateTime]::Now.ToString('s') + ' ' + $Message
    Write-Host $line
    if (!$DryRun) { [IO.File]::AppendAllText($logFile, $line + [Environment]::NewLine, [Text.Encoding]::UTF8) }
}
function Get-NativeInstallerLaunch([string]$Id, $Spec, [string]$File, [string]$LogsDirectory) {
    # Explicit Normal is essential when the orchestration PowerShell is hidden.
    # Let EXE manifests/native UI request elevation; Python's per-user install
    # must not be forced into another administrator's profile by outer RunAs.
    $launch = @{ FilePath = $File; Verb = 'Open'; WindowStyle = 'Normal'; PassThru = $true; WorkingDirectory = [IO.Path]::GetDirectoryName($File) }
    if ($Spec['kind'] -eq 'update') {
        $launch['FilePath'] = Join-Path $env:SystemRoot 'System32\wusa.exe'
        $launch['Verb'] = 'RunAs'
        $launch['ArgumentList'] = @(('"' + $File + '"'), '/norestart')
    } elseif ($Id -eq 'python') {
        # Burn /log preserves the full interactive UI and captures bootstrap,
        # prerequisite and MSI failures in an accessible persistent directory.
        $launch['ArgumentList'] = @('/log', ('"' + (Join-Path $LogsDirectory 'python-setup.log') + '"'))
    }
    return $launch
}
function Wait-NativeInstaller($Process) {
    if (!$Process) { throw 'Native installer did not return a process handle' }
    # Cache the handle before waiting: Windows PowerShell can otherwise lose
    # ExitCode for a fast or ShellExecute-launched process and report null.
    $handle = $Process.Handle
    $Process.WaitForExit()
    $Process.Refresh()
    $code = $Process.ExitCode
    if ($null -eq $code) { throw 'Native installer exit code unavailable; inspect the native setup log' }
    return [int]$code
}
function Merge-UserPath([string]$Old, [string]$Entry) {
    if ($Entry -match '[;\r\n]') { throw 'PATH entry contains a separator' }
    foreach ($part in $Old.Split(';')) {
        if ([Environment]::ExpandEnvironmentVariables($part.Trim().Trim('"').TrimEnd('\')).Equals($Entry.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { return $Old }
    }
    $new = $Entry
    if ($Old) {
        $separator = ';'
        if ($Old.EndsWith(';')) { $separator = '' }
        $new = $Old + $separator + $Entry
    }
    if ($new.Length -ge 32760) { throw 'User PATH is too long; no change was made' }
    return $new
}
function Add-UserPath([string]$Entry) {
    # .NET registry APIs avoid the NSIS string limit and setx truncation/expansion.
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
        if ($key.GetValueNames() -contains 'Path') {
            $kind = $key.GetValueKind('Path')
            if ($kind -ne [Microsoft.Win32.RegistryValueKind]::String -and $kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { throw 'Unsupported existing PATH registry type' }
        }
        $new = Merge-UserPath $old $Entry
        if ($new -ne $old) { $key.SetValue('Path', $new, $kind) }
    } finally { $key.Close() }
}
function Discover-InstalledTool([string]$Id) {
    foreach ($hive in @([Microsoft.Win32.Registry]::CurrentUser, [Microsoft.Win32.Registry]::LocalMachine)) {
        $subkey = $null
        try {
            if ($Id -eq 'git') {
                $subkey = $hive.OpenSubKey('SOFTWARE\GitForWindows')
                if ($subkey) {
                    $root = [string]$subkey.GetValue('InstallPath')
                    $exe = Join-Path $root 'bin\bash.exe'
                    if (Test-Path -LiteralPath $exe -PathType Leaf) { return @{ root=$root; executable=$exe; path=(Join-Path $root 'cmd') } }
                }
            } elseif ($Id -eq 'python') {
                $subkey = $hive.OpenSubKey('SOFTWARE\Python\PythonCore\3.8\InstallPath')
                if ($subkey) {
                    $root = [string]$subkey.GetValue('')
                    $exe = Join-Path $root 'python.exe'
                    if (Test-Path -LiteralPath $exe -PathType Leaf) { return @{ root=$root; executable=$exe; path=$root } }
                }
            } elseif ($Id -eq 'java') {
                $subkey = $hive.OpenSubKey('SOFTWARE\JavaSoft\JDK')
                if ($subkey) {
                    $version = [string]$subkey.GetValue('CurrentVersion')
                    $versionKey = $subkey.OpenSubKey($version)
                    if ($versionKey) {
                        try {
                            $root = [string]$versionKey.GetValue('JavaHome')
                            $exe = Join-Path $root 'bin\java.exe'
                            if (Test-Path -LiteralPath $exe -PathType Leaf) { return @{ root=$root; executable=$exe; path=(Join-Path $root 'bin') } }
                        } finally { $versionKey.Close() }
                    }
                }
            }
        } finally { if ($subkey) { $subkey.Close() } }
    }
    return $null
}
function Extract-Tool($spec, $choice) {
    $base = [string]$choice['directory']
    if (!$base -or $base -match '[;\r\n"%]' -or $base -notmatch '^[A-Za-z]:[\\/]') { throw 'Choose an absolute local directory without PATH separators, percent signs or quotes' }
    $base = [IO.Path]::GetFullPath($base)
    $target = Join-Path $base $spec['root']
    # Refuse overwrite, even for the same version. Never recursively delete user data.
    if (Test-Path -LiteralPath $target) { throw ('Target already exists; choose a different directory: ' + $target) }
    if ($DryRun) { Log ('Would extract to ' + $target); return $null }
    [IO.Directory]::CreateDirectory($base) | Out-Null
    $stage = Join-Path $base ('.tokenbird-extract-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    try {
        $archive = Join-Path $PayloadDirectory $spec['file']
        $output = & (Join-Path $PayloadDirectory '7za.exe') x $archive ('-o' + $stage) -y 2>&1
        $code = $LASTEXITCODE
        if ($code -ne 0) { throw ('7-Zip extraction failed: ' + $code + ' ' + ($output -join ' ')) }
        $extracted = Join-Path $stage $spec['root']
        $executable = Join-Path $extracted $spec['executable']
        if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Archive layout does not match its manifest' }
        # Only move the exact top-level directory from our unique staging area.
        [IO.Directory]::Move($extracted, $target)
    } finally {
        $resolvedStage = [IO.Path]::GetFullPath($stage)
        if ($resolvedStage.StartsWith($base.TrimEnd('\') + '\.tokenbird-extract-', [StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
    $pathEntry = $target
    if ($spec['path']) { $pathEntry = Join-Path $target $spec['path'] }
    return @{ root = $target; executable = (Join-Path $target $spec['executable']); path = $pathEntry }
}

$PayloadDirectory = [IO.Path]::GetFullPath($PayloadDirectory)
$SelectionFile = [IO.Path]::GetFullPath($SelectionFile)
$manifest = Read-Ini (Join-Path $PayloadDirectory 'manifest.ini')
$choices = Read-Ini $SelectionFile
$stateFile = Join-Path $StateRoot 'installed-tools.ini'
$logFile = Join-Path $StateRoot 'dependency-install.log'
$state = @{}
if (Test-Path -LiteralPath $stateFile) { $state = Read-Ini $stateFile }
if (!$DryRun) { [IO.Directory]::CreateDirectory($StateRoot) | Out-Null }
Log ('Environment: OS=' + [Environment]::OSVersion.Version + '; ServicePack=' + [Environment]::OSVersion.ServicePack + '; PowerShell=' + $PSVersionTable.PSVersion + '; ProcessBits=' + ([IntPtr]::Size * 8))
$failed = $false
$reboot = $false
foreach ($id in @('update', 'git', 'python', 'java', 'node', 'mingw')) {
    if (!$choices.ContainsKey($id) -or $choices[$id]['selected'] -ne '1') { continue }
    try {
        $spec = $manifest[$id]
        if (!$spec -or [IO.Path]::GetFileName($spec['file']) -ne $spec['file']) { throw 'Invalid dependency manifest' }
        $file = Join-Path $PayloadDirectory $spec['file']
        if ((Get-Hash $file) -ne $spec['sha256']) { throw ('SHA-256 mismatch: ' + $spec['file']) }
        Log ('Selected ' + $id + ': ' + $spec['file'])
        if ($spec['kind'] -eq 'archive') {
            if ((Get-Hash (Join-Path $PayloadDirectory '7za.exe')) -ne $manifest['extractor']['sha256']) { throw 'Extractor SHA-256 mismatch' }
            $tool = Extract-Tool $spec $choices[$id]
            if ($tool) {
                $state[$id] = $tool
                # Save detection paths even if the optional PATH update later fails.
                Write-Ini $stateFile $state
                if (!$ExtractOnly -and $choices[$id]['addPath'] -eq '1') { Add-UserPath $tool['path']; $reboot = $true }
                Log ('Extracted ' + $tool['root'])
            }
        } elseif ($DryRun -or $ExtractOnly) {
            $launch = Get-NativeInstallerLaunch $id $spec $file $StateRoot
            Log ('Would open native installer (not executed in verification): ' + $launch['FilePath'] + '; WindowStyle=' + $launch['WindowStyle'] + '; Verb=' + $launch['Verb'] + '; Arguments=' + ($launch['ArgumentList'] -join ' '))
        } else {
            $launch = Get-NativeInstallerLaunch $id $spec $file $StateRoot
            Log ('Opening native UI: ' + $launch['FilePath'] + '; WindowStyle=' + $launch['WindowStyle'] + '; Verb=' + $launch['Verb'] + '; Arguments=' + ($launch['ArgumentList'] -join ' '))
            $process = Start-Process @launch
            $code = Wait-NativeInstaller $process
            Log ('Native installer exit code: ' + $code + ' (0x' + $code.ToString('X8') + ')')
            if ($code -eq 3010 -or $code -eq 1641) { $reboot = $true }
            elseif ($spec['kind'] -eq 'update' -and $code -eq 2359302) { Log 'Update already installed' }
            elseif ($code -ne 0) {
                $detail = 'Installer canceled, failed, or update not applicable: ' + $code
                if ($id -eq 'python') { $detail += '. See python-setup.log and its companion MSI logs. Verify Windows 7 SP1 and required loader/UCRT updates; KB3080149 is not a Python prerequisite fix.' }
                throw $detail
            }
            if ($spec['kind'] -eq 'installer') {
                $tool = Discover-InstalledTool $id
                if ($tool) { $state[$id] = $tool; Write-Ini $stateFile $state }
                else { Log 'No registered tool path found; select it in TokenBird settings if necessary.' }
            }
        }
    } catch {
        $failed = $true
        Log ('FAILED ' + $id + ': ' + $_.Exception.Message)
    }
}
if ($reboot) { Log 'Restart Windows before using updated tools/PATH. No automatic restart is performed.' }
if ($failed) { exit 1 }
if ($reboot) { exit 3010 }
exit 0
