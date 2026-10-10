---
name: windows-desktop-control
description: Use the built-in computer_use tool to observe and operate Windows applications with screenshots, UI Automation, window focus, mouse input and Unicode keyboard input.
---

# Windows desktop control

Use `computer_use` on Windows for desktop interaction the user requested. The desktop control component ships with TokenBird and uses Windows PowerShell, Win32 and UI Automation supplied by Windows. No Python packages, third-party automation software or downloads are needed. It controls the interactive desktop of the Windows host running the session, including when the session is accessed remotely. It cannot bypass the lock screen, UAC secure desktop or application permissions.

## Built-in tool

1. Call `computer_use` with `{"action":"status"}` to check that the desktop is available.
2. Observe with `{"action":"screenshot"}` (returns an actual PNG image), `{"action":"windows"}` or `{"action":"snapshot","windowId":"..."}`. `snapshot` reads UI Automation names, roles and physical rectangles, without reading password values. Some custom-drawn apps expose few elements; use the screenshot in that case. Snapshots are bounded and may be truncated.
3. Focus the intended window with `{"action":"focus","windowId":"..."}`. Handles come from `windows`; refresh them if a window closes. `snapshot` defaults to the foreground window.
4. Perform one action and observe again to verify the outcome. All input acts on the current desktop and focused application; there is no separate background desktop.

Examples:

```json
{"action":"click","x":640,"y":420,"button":"left","count":1}
{"action":"drag","x":640,"y":420,"toX":840,"toY":520,"durationMs":400}
{"action":"scroll","x":640,"y":420,"delta":-480}
{"action":"type","text":"中文 text"}
{"action":"key","keys":"CTRL+L"}
{"action":"wait","durationMs":500}
```

Coordinates are physical virtual-desktop pixels and may be negative on multiple monitors. Screenshots default to at most 1600 pixels wide and return `left`, `top`, `width`, `height`, `imageWidth`, `imageHeight` and `scale`. Convert an image point to desktop coordinates using `x = left + imageX / scale`, `y = top + imageY / scale`. UI Automation rectangles already use physical coordinates. Use `maxWidth` (320–4096) for screenshot detail. Never click with scaled image coordinates directly.

Explore permits status, screenshots, cursor position, windows, snapshots and bounded waits. Desktop input requires Ask or Allow All; Ask displays a permission prompt unless the user has already approved this tool for the session. Restricted Super Agent nodes cannot control the host desktop outside their environment. Concurrent operations share a desktop lock, but the user's own input can still change focus: recheck the target before consequential actions.

The component removes its temporary request files and screenshots after returning the result. Screenshot image blocks may still be retained in conversation history or sent to the selected model provider as part of the task.

## Command-line companion

The bundled `desktop-control` command provides the same Windows component for explicitly requested shell workflows. Prefer the structured `computer_use` tool, which returns screenshots directly and applies action-specific permission checks.

1. Capture the desktop before acting:

   ```powershell
   desktop-control screenshot "$env:TEMP\tokenbird-desktop.png"
   ```

2. Inspect the image with the available image-viewing tool and determine physical screen coordinates. The screenshot covers the entire virtual desktop; on multi-monitor systems its JSON result includes `left` and `top`, which can be negative.
3. Perform the smallest requested interaction. Prefer keyboard navigation when it is more stable than coordinates.
4. Capture another screenshot and verify the visible result before continuing or reporting success.

## Commands

```powershell
desktop-control help
desktop-control screenshot "C:\path\desktop.png"
desktop-control position
desktop-control status
desktop-control windows
desktop-control snapshot
desktop-control focus "123456"
desktop-control move 640 420
desktop-control click 640 420 left
desktop-control click 640 420 left 2
desktop-control scroll 640 420 -480
desktop-control type "Text to enter"
desktop-control key "CTRL+L"
desktop-control key "ALT+TAB"
desktop-control key "ENTER"
desktop-control drag 640 420 840 520
```

`scroll` uses positive values to scroll up and negative values to scroll down. `key` accepts common Windows key names joined by `+`, including `CTRL`, `ALT`, `SHIFT`, `WIN`, arrows, `ENTER`, `TAB`, `ESC`, `BACKSPACE`, `DELETE`, `HOME`, `END`, `PAGEUP`, `PAGEDOWN`, and `F1`–`F24`.

Treat screenshots as potentially sensitive. Keep them in a task-scoped temporary path and do not upload or share them unless the user asks. Never enter secrets supplied for another purpose. Before a click or keystroke that sends a message, confirms a purchase, deletes data, changes security settings, or has another consequential external effect, verify the target and obtain any authorization required by the active permission mode.
