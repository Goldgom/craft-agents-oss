---
name: windows-desktop-control
description: Control the visible Windows desktop with screenshots, pointer movement, mouse clicks, scrolling, text entry, and keyboard shortcuts when the user asks TokenBird to operate desktop applications.
---

# Windows desktop control

Use this skill only on Windows, only when `runshell` or `localbash` is available, and only for desktop interaction the user requested. This controls the current interactive desktop through the bundled `desktop-control` command; it does not bypass the lock screen, UAC secure desktop, application permissions, or other operating-system protections.

## Workflow

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
desktop-control move 640 420
desktop-control click 640 420 left
desktop-control click 640 420 left 2
desktop-control scroll 640 420 -480
desktop-control type "Text to enter"
desktop-control key "CTRL+L"
desktop-control key "ALT+TAB"
desktop-control key "ENTER"
```

`scroll` uses positive values to scroll up and negative values to scroll down. `key` accepts common Windows key names joined by `+`, including `CTRL`, `ALT`, `SHIFT`, `WIN`, arrows, `ENTER`, `TAB`, `ESC`, `BACKSPACE`, `DELETE`, `HOME`, `END`, `PAGEUP`, `PAGEDOWN`, and `F1`–`F24`.

Treat screenshots as potentially sensitive. Keep them in a task-scoped temporary path and do not upload or share them unless the user asks. Never enter secrets supplied for another purpose. Before a click or keystroke that sends a message, confirms a purchase, deletes data, changes security settings, or has another consequential external effect, verify the target and obtain any authorization required by the active permission mode.

