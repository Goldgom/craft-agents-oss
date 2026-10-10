param(
  [Parameter(Position = 0)]
  [string]$Action = 'help',
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$Arguments,
  [string]$RequestPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = $null
if ($RequestPath) {
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $Action = [string]$request.action
  $Arguments = switch ($Action) {
    'screenshot' { @([string]$request.outputPath) }
    'move' { @([string]$request.x, [string]$request.y) }
    'click' { @([string]$request.x, [string]$request.y, $(if ($request.button) { $request.button } else { 'left' }), $(if ($request.count) { [string]$request.count } else { '1' })) }
    'scroll' { @([string]$request.x, [string]$request.y, [string]$request.delta) }
    'type' { @([string]$request.text) }
    'key' { @([string]$request.keys) }
    'drag' { @([string]$request.x, [string]$request.y, [string]$request.toX, [string]$request.toY) }
    'focus' { @([string]$request.windowId) }
    default { @() }
  }
}

if (-not ('TokenBird.Desktop.NativeMethods' -as [type])) {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace TokenBird.Desktop {
  public static class NativeMethods {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr handle, out RECT rect);
    private delegate bool EnumWindowsCallback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] private static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, uint length, out uint required);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    public class WindowInfo {
      public string windowId, title;
      public uint processId;
      public int x, y, width, height;
      public bool foreground, minimized;
    }
    public static bool IsDesktopAvailable() {
      IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
      if (desktop == IntPtr.Zero) return false;
      try {
        var name = new StringBuilder(256); uint required;
        return GetUserObjectInformation(desktop, 2, name, 512, out required)
          && String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase)
          && Environment.UserInteractive;
      } finally { CloseDesktop(desktop); }
    }
    public static WindowInfo[] GetWindows() {
      var windows = new List<WindowInfo>();
      IntPtr foreground = GetForegroundWindow();
      EnumWindows(delegate(IntPtr handle, IntPtr parameter) {
        if (!IsWindowVisible(handle)) return true;
        var title = new StringBuilder(1024);
        GetWindowText(handle, title, title.Capacity);
        if (title.Length == 0) return true;
        uint pid; RECT rect;
        GetWindowThreadProcessId(handle, out pid); GetWindowRect(handle, out rect);
        windows.Add(new WindowInfo { windowId = handle.ToInt64().ToString(), title = title.ToString(), processId = pid,
          x = rect.Left, y = rect.Top, width = rect.Right - rect.Left, height = rect.Bottom - rect.Top,
          foreground = handle == foreground, minimized = IsIconic(handle) });
        return true;
      }, IntPtr.Zero);
      return windows.ToArray();
    }
    public static void FocusWindow(IntPtr handle) {
      if (IsIconic(handle)) ShowWindow(handle, 9);
      if (SetForegroundWindow(handle)) return;
      uint pid;
      uint foregroundThread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
      uint targetThread = GetWindowThreadProcessId(handle, out pid);
      uint currentThread = GetCurrentThreadId();
      bool attachedForeground = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
      bool attachedTarget = targetThread != currentThread && targetThread != foregroundThread && AttachThreadInput(currentThread, targetThread, true);
      try { BringWindowToTop(handle); SetForegroundWindow(handle); }
      finally {
        if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
        if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
      }
    }
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint inputCount, INPUT[] inputs, int inputSize);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
      public int X;
      public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT {
      public uint type;
      public InputUnion data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion {
      [FieldOffset(0)]
      public KEYBDINPUT keyboard;
      // INPUT must also reserve MOUSEINPUT (32 bytes on x64), even for keyboard
      // input. Omitting it produces an invalid cbSize and breaks Unicode typing.
      [FieldOffset(0)]
      public MOUSEINPUT mouse;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
      public int x, y;
      public uint data, flags, time;
      public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT {
      public ushort virtualKey;
      public ushort scanCode;
      public uint flags;
      public uint time;
      public UIntPtr extraInfo;
    }

    public static void SendUnicodeText(string text) {
      var inputs = new List<INPUT>(text.Length * 2);
      foreach (char character in text) {
        inputs.Add(new INPUT {
          type = 1,
          data = new InputUnion { keyboard = new KEYBDINPUT { scanCode = character, flags = 0x0004 } }
        });
        inputs.Add(new INPUT {
          type = 1,
          data = new InputUnion { keyboard = new KEYBDINPUT { scanCode = character, flags = 0x0004 | 0x0002 } }
        });
      }
      var array = inputs.ToArray();
      if (array.Length > 0 && SendInput((uint)array.Length, array, Marshal.SizeOf(typeof(INPUT))) != array.Length) {
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Unable to send Unicode keyboard input");
      }
    }
  }
}
'@
}

try {
  [void][TokenBird.Desktop.NativeMethods]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch {
  try { [void][TokenBird.Desktop.NativeMethods]::SetProcessDPIAware() } catch { }
}

function Write-Result([hashtable]$Value) {
  $Value | ConvertTo-Json -Compress -Depth 10
}

function Require-Argument([int]$Index, [string]$Name) {
  if ($Arguments.Count -le $Index -or [string]::IsNullOrWhiteSpace($Arguments[$Index])) {
    throw "Missing argument: $Name"
  }
  return $Arguments[$Index]
}

function Parse-Coordinate([int]$Index, [string]$Name) {
  $raw = Require-Argument $Index $Name
  $value = 0
  if (-not [int]::TryParse($raw, [ref]$value)) {
    throw "Invalid integer for ${Name}: $raw"
  }
  return $value
}

function Set-Pointer([int]$X, [int]$Y) {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if (-not $bounds.Contains($X, $Y)) { throw "Coordinates ($X, $Y) are outside the virtual desktop" }
  if (-not [TokenBird.Desktop.NativeMethods]::SetCursorPos($X, $Y)) {
    throw "Unable to move the pointer to ($X, $Y)"
  }
}

function Resolve-Window([string]$Id) {
  $handle = if ($Id) { [IntPtr]([long]$Id) } else { [TokenBird.Desktop.NativeMethods]::GetForegroundWindow() }
  if (-not [TokenBird.Desktop.NativeMethods]::IsWindow($handle)) { throw 'Window no longer exists; list windows again' }
  return $handle
}

if ($Action -notin @('help', 'status') -and -not [TokenBird.Desktop.NativeMethods]::IsDesktopAvailable()) {
  throw 'The interactive desktop is locked, unavailable or on a secure screen. Unlock it and dismiss UAC before retrying.'
}

function Send-KeyEvent([byte]$VirtualKey, [bool]$KeyUp) {
  $flags = if ($KeyUp) { 0x0002 } else { 0 }
  [TokenBird.Desktop.NativeMethods]::keybd_event($VirtualKey, 0, $flags, [UIntPtr]::Zero)
}

function Resolve-Key([string]$Name) {
  $normalized = $Name.Trim().ToUpperInvariant()
  $aliases = @{
    'CTRL' = 0x11; 'CONTROL' = 0x11; 'ALT' = 0x12; 'SHIFT' = 0x10
    'WIN' = 0x5B; 'WINDOWS' = 0x5B; 'ENTER' = 0x0D; 'RETURN' = 0x0D
    'TAB' = 0x09; 'ESC' = 0x1B; 'ESCAPE' = 0x1B; 'SPACE' = 0x20
    'BACKSPACE' = 0x08; 'DELETE' = 0x2E; 'DEL' = 0x2E; 'INSERT' = 0x2D
    'HOME' = 0x24; 'END' = 0x23; 'PAGEUP' = 0x21; 'PAGEDOWN' = 0x22
    'LEFT' = 0x25; 'UP' = 0x26; 'RIGHT' = 0x27; 'DOWN' = 0x28
  }
  if ($aliases.ContainsKey($normalized)) { return [byte]$aliases[$normalized] }
  if ($normalized -match '^F([1-9]|1[0-9]|2[0-4])$') { return [byte](0x6F + [int]$Matches[1]) }
  if ($normalized.Length -eq 1) {
    $code = [int][char]$normalized
    if (($code -ge 0x30 -and $code -le 0x39) -or ($code -ge 0x41 -and $code -le 0x5A)) { return [byte]$code }
  }
  throw "Unsupported key name: $Name"
}

$desktopMutex = New-Object System.Threading.Mutex($false, 'Local\TokenBird.ComputerUse')
$mutexAcquired = $false
try {
  try { $mutexAcquired = $desktopMutex.WaitOne(10000) }
  catch [System.Threading.AbandonedMutexException] { $mutexAcquired = $true }
  if (-not $mutexAcquired) { throw 'Another desktop action is still running; retry after it completes' }
switch ($Action.ToLowerInvariant()) {
  'help' {
    @'
TokenBird Windows desktop control

Usage:
  desktop-control screenshot <path>
  desktop-control position
  desktop-control status
  desktop-control windows
  desktop-control snapshot
  desktop-control focus <windowId>
  desktop-control move <x> <y>
  desktop-control click <x> <y> [left|right|middle] [count]
  desktop-control scroll <x> <y> <delta>
  desktop-control type <text>
  desktop-control key <CTRL+ALT+KEY>
  desktop-control drag <x> <y> <toX> <toY>
'@
  }
  'status' {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    Write-Result @{ action = 'status'; available = [TokenBird.Desktop.NativeMethods]::IsDesktopAvailable(); component = 'TokenBird Desktop Control'; version = 1; left = $bounds.Left; top = $bounds.Top; width = $bounds.Width; height = $bounds.Height; actions = @('screenshot', 'position', 'windows', 'snapshot', 'focus', 'move', 'click', 'drag', 'scroll', 'type', 'key', 'wait') }
  }
  'windows' {
    $limit = if ($request -and $request.limit) { [int]$request.limit } else { 100 }
    $windows = @([TokenBird.Desktop.NativeMethods]::GetWindows())
    Write-Result @{ action = 'windows'; windows = @($windows | Select-Object -First $limit); truncated = $windows.Count -gt $limit }
  }
  'focus' {
    $handle = Resolve-Window (Require-Argument 0 'windowId')
    [TokenBird.Desktop.NativeMethods]::FocusWindow($handle)
    Start-Sleep -Milliseconds 150
    if ([TokenBird.Desktop.NativeMethods]::GetForegroundWindow() -ne $handle) { throw 'Windows refused foreground activation; the requested window is not focused' }
    Write-Result @{ action = 'focus'; windowId = $handle.ToInt64().ToString() }
  }
  'snapshot' {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $handle = Resolve-Window $(if ($request) { [string]$request.windowId } else { '' })
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $limit = if ($request -and $request.limit) { [int]$request.limit } else { 200 }
    $elements = New-Object System.Collections.Generic.List[object]
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@{ element = $root; depth = 0 })
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $visited = 0
    while ($queue.Count -gt 0 -and $elements.Count -lt $limit -and $timer.ElapsedMilliseconds -lt 8000 -and $visited -lt 2000) {
      $entry = $queue.Dequeue()
      $visited++
      try {
        $current = $entry.element.Current
        $rect = $current.BoundingRectangle
        if (-not $current.IsOffscreen) {
          $elements.Add(@{ name = $(if ($current.IsPassword) { '[password]' } else { $current.Name }); automationId = $current.AutomationId; className = $current.ClassName; role = $current.ControlType.ProgrammaticName; enabled = $current.IsEnabled; password = $current.IsPassword; x = $rect.X; y = $rect.Y; width = $rect.Width; height = $rect.Height })
        }
        if ($entry.depth -lt 8 -and -not $current.IsPassword) {
          $child = $walker.GetFirstChild($entry.element)
          while ($null -ne $child -and $queue.Count -lt 2000 -and $timer.ElapsedMilliseconds -lt 8000) {
            $queue.Enqueue(@{ element = $child; depth = $entry.depth + 1 })
            $child = $walker.GetNextSibling($child)
          }
        }
      } catch [System.Windows.Automation.ElementNotAvailableException] { }
    }
    Write-Result @{ action = 'snapshot'; windowId = $handle.ToInt64().ToString(); elements = @($elements.ToArray()); truncated = $queue.Count -gt 0 }
  }
  'screenshot' {
    $requestedPath = Require-Argument 0 'path'
    $outputPath = [System.IO.Path]::GetFullPath($requestedPath)
    $parent = [System.IO.Path]::GetDirectoryName($outputPath)
    if ($parent) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
      } finally { $graphics.Dispose() }
      $maxWidth = if ($request -and $request.maxWidth) { [int]$request.maxWidth } elseif ($request) { 1600 } else { $bounds.Width }
      $scale = [Math]::Min(1.0, $maxWidth / [double]$bounds.Width)
      $imageWidth = [Math]::Max(1, [int][Math]::Round($bounds.Width * $scale))
      $imageHeight = [Math]::Max(1, [int][Math]::Round($bounds.Height * $scale))
      if ($scale -lt 1) {
        $scaled = New-Object System.Drawing.Bitmap($imageWidth, $imageHeight)
        try {
          $resizer = [System.Drawing.Graphics]::FromImage($scaled)
          try {
            $resizer.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $resizer.DrawImage($bitmap, 0, 0, $imageWidth, $imageHeight)
          } finally { $resizer.Dispose() }
          $scaled.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally { $scaled.Dispose() }
      } else { $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png) }
    } finally { $bitmap.Dispose() }
    $result = @{ action = 'screenshot'; left = $bounds.Left; top = $bounds.Top; width = $bounds.Width; height = $bounds.Height; imageWidth = $imageWidth; imageHeight = $imageHeight; scale = $scale }
    if (-not $request) { $result.path = $outputPath }
    Write-Result $result
  }
  'position' {
    $point = New-Object TokenBird.Desktop.NativeMethods+POINT
    if (-not [TokenBird.Desktop.NativeMethods]::GetCursorPos([ref]$point)) { throw 'Unable to read the pointer position' }
    Write-Result @{ action = 'position'; x = $point.X; y = $point.Y }
  }
  'move' {
    $x = Parse-Coordinate 0 'x'; $y = Parse-Coordinate 1 'y'
    Set-Pointer $x $y
    Write-Result @{ action = 'move'; x = $x; y = $y }
  }
  'click' {
    $x = Parse-Coordinate 0 'x'; $y = Parse-Coordinate 1 'y'
    $button = if ($Arguments.Count -gt 2) { $Arguments[2].ToLowerInvariant() } else { 'left' }
    $count = if ($Arguments.Count -gt 3) { Parse-Coordinate 3 'count' } else { 1 }
    if ($count -lt 1 -or $count -gt 10) { throw 'Click count must be between 1 and 10' }
    $events = switch ($button) {
      'left' { @(0x0002, 0x0004) }
      'right' { @(0x0008, 0x0010) }
      'middle' { @(0x0020, 0x0040) }
      default { throw "Unsupported mouse button: $button" }
    }
    Set-Pointer $x $y
    for ($i = 0; $i -lt $count; $i++) {
      [TokenBird.Desktop.NativeMethods]::mouse_event($events[0], 0, 0, 0, [UIntPtr]::Zero)
      [TokenBird.Desktop.NativeMethods]::mouse_event($events[1], 0, 0, 0, [UIntPtr]::Zero)
      if ($count -gt 1) { Start-Sleep -Milliseconds 80 }
    }
    Write-Result @{ action = 'click'; x = $x; y = $y; button = $button; count = $count }
  }
  'scroll' {
    $x = Parse-Coordinate 0 'x'; $y = Parse-Coordinate 1 'y'; $delta = Parse-Coordinate 2 'delta'
    Set-Pointer $x $y
    $wheelData = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$delta), 0)
    [TokenBird.Desktop.NativeMethods]::mouse_event(0x0800, 0, 0, $wheelData, [UIntPtr]::Zero)
    Write-Result @{ action = 'scroll'; x = $x; y = $y; delta = $delta }
  }
  'type' {
    if ($Arguments.Count -eq 0) { throw 'Missing argument: text' }
    $text = if ($request) { [string]$request.text } else { $Arguments -join ' ' }
    [TokenBird.Desktop.NativeMethods]::SendUnicodeText($text)
    Write-Result @{ action = 'type'; characters = $text.Length }
  }
  'key' {
    $spec = Require-Argument 0 'key combination'
    $keys = @($spec.Split('+') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { Resolve-Key $_ })
    if ($keys.Count -eq 0) { throw 'The key combination is empty' }
    try { foreach ($key in $keys) { Send-KeyEvent $key $false } }
    finally {
      [array]::Reverse($keys)
      foreach ($key in $keys) { Send-KeyEvent $key $true }
    }
    Write-Result @{ action = 'key'; keys = $spec.ToUpperInvariant() }
  }
  'drag' {
    $x = Parse-Coordinate 0 'x'; $y = Parse-Coordinate 1 'y'
    $toX = Parse-Coordinate 2 'toX'; $toY = Parse-Coordinate 3 'toY'
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    if (-not $bounds.Contains($toX, $toY)) { throw 'Drag destination is outside the virtual desktop' }
    Set-Pointer $x $y
    try {
      [TokenBird.Desktop.NativeMethods]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
      $duration = if ($request -and $request.durationMs) { [int]$request.durationMs } else { 400 }
      for ($step = 1; $step -le 20; $step++) {
        Set-Pointer ([int]($x + ($toX - $x) * $step / 20)) ([int]($y + ($toY - $y) * $step / 20))
        Start-Sleep -Milliseconds ([int]($duration / 20))
      }
    } finally { [TokenBird.Desktop.NativeMethods]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
    Write-Result @{ action = 'drag'; x = $x; y = $y; toX = $toX; toY = $toY }
  }
  'wait' {
    $duration = if ($request -and $null -ne $request.durationMs) { [int]$request.durationMs } else { 500 }
    if ($duration -lt 0 -or $duration -gt 5000) { throw 'Wait must be between 0 and 5000 milliseconds' }
    Start-Sleep -Milliseconds $duration
    Write-Result @{ action = 'wait'; durationMs = $duration }
  }
  default { throw "Unknown action: $Action. Run 'desktop-control help' for usage." }
}
} finally {
  if ($mutexAcquired) { $desktopMutex.ReleaseMutex() }
  $desktopMutex.Dispose()
}
