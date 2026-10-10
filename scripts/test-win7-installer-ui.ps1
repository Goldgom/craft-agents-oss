param([string]$Executable = (Join-Path $PSScriptRoot '..\.toolchains\win7-wizard-test.exe'), [switch]$ActualInstaller)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WizardProbe {
    public delegate bool EnumProc(IntPtr handle, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr state);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int size);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr handle, int index);
    public static bool HasVisibleStyle(IntPtr handle) { return (GetWindowLong(handle, -16) & 0x10000000) != 0; }
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr handle, uint msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint msg, IntPtr w, IntPtr l);
    public static IntPtr[] Windows(uint pid) {
        var list = new List<IntPtr>();
        EnumWindows((handle, state) => { uint found; GetWindowThreadProcessId(handle, out found); if(found == pid) list.Add(handle); return true; }, IntPtr.Zero);
        return list.ToArray();
    }
    public static IntPtr[] Children(IntPtr parent) {
        var list = new List<IntPtr>(); EnumChildWindows(parent, (handle, state) => { list.Add(handle); return true; }, IntPtr.Zero); return list.ToArray();
    }
    public static string Text(IntPtr handle) { var text = new StringBuilder(4096); GetWindowText(handle, text, text.Capacity); return text.ToString(); }
}
'@
function Wait-For($Condition) {
    $end = [DateTime]::Now.AddSeconds(15)
    while ([DateTime]::Now -lt $end) {
        $result = & $Condition
        if ($result) { return $result }
        Start-Sleep -Milliseconds 100
    }
    $diagnostic = @([WizardProbe]::Windows($script:probeProcess.Id) | ForEach-Object { [WizardProbe]::Text($_) + "`n" + (Page-Text $_) }) -join "`n---`n"
    throw ('Installer page probe timed out: ' + $diagnostic)
}
function Controls($Window) { return @([WizardProbe]::Children($Window) | Where-Object { [WizardProbe]::HasVisibleStyle($_) }) }
function Page-Text($Window) { return ((Controls $Window | ForEach-Object { [WizardProbe]::Text($_) }) -join "`n") }
function Click-Id($Window, [int]$Id) {
    $button = Controls $Window | Where-Object { [WizardProbe]::GetDlgCtrlID($_) -eq $Id -and [WizardProbe]::IsWindowEnabled($_) } | Select-Object -First 1
    if (!$button) { throw ('No enabled wizard button ' + $Id + ': ' + (Page-Text $Window)) }
    # BM_CLICK depends on an active dialog; WM_COMMAND works for hidden probes.
    [WizardProbe]::PostMessage($Window, 0x111, [IntPtr]$Id, $button) | Out-Null
}
function Start-Wizard {
    $process = Start-Process -FilePath ([IO.Path]::GetFullPath($Executable)) -ArgumentList '/currentuser' -WindowStyle Hidden -PassThru
    $script:probeProcess = $process
    try {
    $window = Wait-For { [WizardProbe]::Windows($process.Id) | Where-Object { [WizardProbe]::Text($_) -match '^TokenBird' -and (Page-Text $_).Length -gt 10 } | Select-Object -First 1 }
    for ($i = 0; $i -lt 4; $i++) {
        if ((Page-Text $window) -match '可选外部工具') { Start-Sleep -Milliseconds 300; return @{ process=$process; window=$window } }
        if ($ActualInstaller -and (Page-Text $window) -match 'Git 2.46|Python 3.8') { throw 'Unrecognized selection page; will not click Install' }
        Wait-For { Controls $window | Where-Object { [WizardProbe]::GetDlgCtrlID($_) -eq 1 -and [WizardProbe]::IsWindowEnabled($_) } | Select-Object -First 1 } | Out-Null
        Click-Id $window 1
        Start-Sleep -Milliseconds 400
    }
    throw ('Selection page not found: ' + (Page-Text $window))
    } catch {
        if (!$process.HasExited) { $process.Kill(); $process.WaitForExit() }
        throw
    }
}
function Stop-Wizard($Wizard) {
    # Kill only this uniquely launched page-test process, before any install button.
    if (!$Wizard.process.HasExited) { $Wizard.process.Kill(); $Wizard.process.WaitForExit() }
}
$wizard = Start-Wizard
try {
    $window = $wizard.window
    $text = Page-Text $window
    if ($text -notmatch '遥测' -or $text -notmatch '官方不支持 Win7') { throw ('Warnings missing/encoding broken: ' + $text) }
    foreach ($control in (Controls $window | Where-Object { [WizardProbe]::Text($_) -match '^(Git |Python |Oracle |KB308|Node.js |MinGW)' })) {
        if ([WizardProbe]::SendMessage($control, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 0) { throw 'Dependency selected by default' }
    }
    Write-Host 'PASS: actual NSIS selection page, Chinese labels, warnings and skip-all defaults'
    if (!$ActualInstaller) {
        # Harness has an empty section. It is safe to prove the skip-all route.
        Click-Id $window 1
        Wait-For { (Page-Text $window) -match '完成|已经安装' } | Out-Null
        Write-Host 'PASS: skip-all route bypasses both archive-directory pages'
    }
} finally { Stop-Wizard $wizard }
if ($ActualInstaller) { exit 0 } # Never click Install in the production installer.

$wizard = Start-Wizard
try {
    $window = $wizard.window
    foreach ($pattern in @('^Node.js ', '^MinGW')) {
        $control = Controls $window | Where-Object { [WizardProbe]::Text($_) -match $pattern } | Select-Object -First 1
        if (!$control) { throw 'Missing archive checkbox' }
        [WizardProbe]::SendMessage($control, 0xF1, [IntPtr]1, [IntPtr]::Zero) | Out-Null
    }
    Click-Id $window 1
    $warning = Wait-For { [WizardProbe]::Windows($wizard.process.Id) | Where-Object { $_ -ne $window -and (Page-Text $_) -match '仍要尝试' } | Select-Object -First 1 }
    Click-Id $warning 6
    Wait-For { (Page-Text $window) -match 'Node.js 安装目录' } | Out-Null
    $pathBox = Controls $window | Where-Object { [WizardProbe]::Text($_) -match '^添加到当前用户 PATH' } | Select-Object -First 1
    if (!$pathBox -or [WizardProbe]::SendMessage($pathBox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 0) { throw 'Node PATH must be opt-in' }
    Click-Id $window 1
    Wait-For { (Page-Text $window) -match 'MinGW 安装目录' } | Out-Null
    $pathBox = Controls $window | Where-Object { [WizardProbe]::Text($_) -match '^添加到当前用户 PATH' } | Select-Object -First 1
    if (!$pathBox -or [WizardProbe]::SendMessage($pathBox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 0) { throw 'MinGW PATH must be opt-in' }
    Click-Id $window 3
    Wait-For { (Page-Text $window) -match 'Node.js 安装目录' } | Out-Null
    Write-Host 'PASS: selected Node/MinGW pages, opt-in PATH and back navigation; no tools installed'
} finally { Stop-Wizard $wizard }
