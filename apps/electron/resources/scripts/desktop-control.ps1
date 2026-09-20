param(
  [Parameter(Position = 0)]
  [string]$Action = 'help',
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
  [string[]]$Arguments
)

$ErrorActionPreference = 'Stop'

if (-not ('TokenBird.Desktop.NativeMethods' -as [type])) {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace TokenBird.Desktop {
  public static class NativeMethods {
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
  $Value | ConvertTo-Json -Compress
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
  if (-not [TokenBird.Desktop.NativeMethods]::SetCursorPos($X, $Y)) {
    throw "Unable to move the pointer to ($X, $Y)"
  }
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

switch ($Action.ToLowerInvariant()) {
  'help' {
    @'
TokenBird Windows desktop control

Usage:
  desktop-control screenshot <path>
  desktop-control position
  desktop-control move <x> <y>
  desktop-control click <x> <y> [left|right|middle] [count]
  desktop-control scroll <x> <y> <delta>
  desktop-control type <text>
  desktop-control key <CTRL+ALT+KEY>
'@
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
      $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bitmap.Dispose() }
    Write-Result @{ action = 'screenshot'; path = $outputPath; left = $bounds.Left; top = $bounds.Top; width = $bounds.Width; height = $bounds.Height }
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
    $text = $Arguments -join ' '
    [TokenBird.Desktop.NativeMethods]::SendUnicodeText($text)
    Write-Result @{ action = 'type'; characters = $text.Length }
  }
  'key' {
    $spec = Require-Argument 0 'key combination'
    $keys = @($spec.Split('+') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { Resolve-Key $_ })
    if ($keys.Count -eq 0) { throw 'The key combination is empty' }
    foreach ($key in $keys) { Send-KeyEvent $key $false }
    [array]::Reverse($keys)
    foreach ($key in $keys) { Send-KeyEvent $key $true }
    Write-Result @{ action = 'key'; keys = $spec.ToUpperInvariant() }
  }
  default { throw "Unknown action: $Action. Run 'desktop-control help' for usage." }
}
