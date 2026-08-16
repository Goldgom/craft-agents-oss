# Theme Configuration Guide

This guide explains how to customize the visual theme of Craft Agent.

## Overview

Craft Agent uses a 6-color theme system with support for both app-level defaults and per-workspace overrides.

### Theme Hierarchy

1. **App default**: Selected in Settings → Appearance → Default Theme
2. **Workspace override**: Per-workspace theme in Settings → Appearance → Workspace Themes
3. **Preset themes**: `~/.craft-agent/themes/{name}.json` - Complete theme packages
4. **Theme overrides**: `~/.craft-agent/theme.json` - Override specific colors (app-level)

Workspaces without a custom theme inherit the app default. All settings are optional - the app has sensible built-in defaults.

## Workspace Themes

Each workspace can have its own color theme that overrides the app default. Configure in Settings → Appearance:

- **Default Theme**: Sets the app-wide default (used by all workspaces without an override)
- **Workspace Themes**: Per-workspace overrides, choose "Use Default" or select a specific theme

### Storage Location

Workspace theme preferences are stored in the workspace config:

```
~/.craft-agent/workspaces/{id}/config.json
```

```json
{
  "id": "ws_abc123",
  "name": "My Project",
  "defaults": {
    "colorTheme": "nord"
  }
}
```

When `colorTheme` is omitted or undefined, the workspace inherits the app default.

## 6-Color System

| Color | Purpose | Usage |
|-------|---------|-------|
| `background` | Surface/page background | Light/dark surface color |
| `foreground` | Text and icons | Primary text color |
| `accent` | Brand color, Execute mode | Highlights, active states, purple UI elements |
| `info` | Warnings, Ask mode | Amber indicators, attention states |
| `success` | Connected status | Green checkmarks, success states |
| `destructive` | Errors, delete actions | Red alerts, failed states |

## Color Formats

Any valid CSS color format is supported:
- **Hex**: `#8b5cf6`, `#8b5cf6cc` (with alpha)
- **RGB**: `rgb(139, 92, 246)`, `rgba(139, 92, 246, 0.8)`
- **HSL**: `hsl(262, 83%, 58%)`
- **OKLCH**: `oklch(0.58 0.22 293)` (recommended)
- **Named**: `purple`, `rebeccapurple`

**Recommendation**: Use OKLCH for perceptually uniform colors that look consistent across light/dark modes.

## Theme Override File

Create `~/.craft-agent/theme.json` to override specific colors:

```json
{
  "accent": "oklch(0.58 0.22 293)",
  "dark": {
    "accent": "oklch(0.65 0.22 293)"
  }
}
```

All fields are optional. Only specify colors you want to override.

## Dark Mode

The `dark` object provides optional overrides for dark mode. When the user's system is in dark mode:
1. Base colors (top-level) are used as defaults
2. Any colors defined in `dark` override the base colors

This allows partial dark mode customization - only override what needs to differ.

## Preset Themes

Preset themes are complete theme packages stored at `~/.craft-agent/themes/`. Each preset is a JSON file with theme colors and metadata.

### Preset Theme Schema

```json
{
  "name": "Dracula",
  "description": "A dark theme with vibrant colors",
  "author": "Zeno Rocha",
  "license": "MIT",
  "source": "https://draculatheme.com",
  "supportedModes": ["dark"],

  "background": "oklch(0.22 0.02 280)",
  "foreground": "oklch(0.95 0.01 270)",
  "accent": "oklch(0.70 0.20 320)",
  "info": "oklch(0.78 0.14 70)",
  "success": "oklch(0.72 0.18 145)",
  "destructive": "oklch(0.65 0.22 28)",

  "shikiTheme": {
    "light": "github-light",
    "dark": "dracula"
  }
}
```

### Preset Metadata Fields

| Field | Description |
|-------|-------------|
| `name` | Display name for the theme |
| `description` | Short description |
| `author` | Theme creator |
| `license` | License type (MIT, etc.) |
| `source` | URL to original theme |
| `supportedModes` | Array of `"light"`, `"dark"`, or both |
| `shikiTheme` | Syntax highlighting theme (light/dark variants) |

### Installing Preset Themes

1. Download or create a theme JSON file
2. Save it to `~/.craft-agent/themes/{name}.json`
3. Select the theme in Settings → Appearance

## Scenic Mode

Scenic mode displays a full-window background image with glass-style panels. This creates a visually immersive experience.

### Enabling Scenic Mode

```json
{
  "mode": "scenic",
  "backgroundImage": "mountains.jpg",

  "background": "oklch(0.15 0.02 270 / 0.8)",
  "paper": "oklch(0.18 0.02 270 / 0.6)",
  "navigator": "oklch(0.12 0.02 270 / 0.7)",
  "popoverSolid": "oklch(0.18 0.02 270)"
}
```

### Scenic Mode Properties

| Property | Description |
|----------|-------------|
| `mode` | Set to `"scenic"` (default is `"solid"`) |
| `backgroundImage` | Image filename (relative to theme file) or URL |

### Surface Colors for Glass Panels

Scenic mode benefits from semi-transparent surface colors:

| Color | Purpose |
|-------|---------|
| `paper` | AI messages, cards, elevated content |
| `navigator` | Left sidebar background |
| `input` | Input field background |
| `popover` | Dropdowns, modals, context menus |
| `popoverSolid` | Guaranteed 100% opaque popover background |

**Note:** Scenic themes automatically force dark mode for better contrast with background images.

## Theme Packs

Theme packs bundle artwork with a JSON manifest — background image, chat panel
texture, sidebar texture, and basic style settings — so a single folder can
restyle the whole window. Manage them in Settings → Appearance → Theme Packs
(导入/删除/切换), or drop folders into the theme packs directory manually.

### Storage Location

```
~/.craft-agent/theme-packs/<pack-id>/
├── theme-pack.json     # manifest (see schema below)
├── background.png      # optional: 背景图片
├── chat.png            # optional: 聊天框贴图
├── sidebar.png         # optional: 侧边栏贴图
└── preview/light.webp  # optional previews shown in settings
```

### Manifest (theme-pack.json)

```json
{
  "name": "星空漫游",
  "author": "me",
  "tagline": "深空背景 + 蕾丝侧栏",
  "description": "…",
  "version": 1,
  "tags": ["space"],
  "mode": "scenic",
  "background": { "light": "background.png", "dark": "background-night.png" },
  "backgroundImage": "background.png",
  "chatTexture": "chat.png",
  "sidebarTexture": "sidebar.png",
  "characters": { "left": "char-left.png", "right": "char-right.png" },
  "preview": { "light": "preview/light.webp", "dark": "preview/dark.webp" },
  "style": {
    "backgroundSize": "cover",
    "backgroundPosition": "center",
    "backgroundBlur": 0,
    "chatOpacity": 0.9,
    "chatBlend": "normal",
    "sidebarOpacity": 0.85,
    "sidebarBlend": "normal",
    "textureSize": "auto",
    "texturePosition": "center",
    "textureRepeat": "no-repeat",
    "chatTextureSize": "auto",
    "chatTexturePosition": "center bottom",
    "sidebarTextureSize": "auto",
    "sidebarTexturePosition": "top left",
    "borderRadius": "12px"
  },
  "colors": {
    "accent": "oklch(0.58 0.22 293)",
    "background": "oklch(0.15 0.02 270 / 0.8)",
    "dark": { "accent": "oklch(0.65 0.22 293)" }
  }
}
```

| Field | Purpose |
|-------|---------|
| `name` / `nameEn` | Display name |
| `author`, `tagline`, `description`, `tags` | Metadata |
| `mode` | `"scenic"` (full-window artwork) or `"solid"` |
| `background.light` / `background.dark` | Background images per color mode (win over `backgroundImage`) |
| `backgroundImage` | Single background image (used when `background` is absent) |
| `chatTexture` | Chat texture — pasted onto the input box (composer frame) |
| `sidebarTexture` | Sidebar texture, path relative to the pack dir |
| `characters` | Character standees (立绘): `{ "left": …, "right": … }` anchored to the window bottom corners |
| `preview.light` / `preview.dark` | Thumbnails shown in Settings → Appearance |
| `style` | Basic style settings (sizes, opacities, blend modes, radius) — all optional |
| `colors` | Same 6-color + surface system as preset themes, incl. `dark` overrides |

Textures are **constrained to their natural size by default**
(`textureSize: "auto"`) — they are never stretched or cropped to cover the
panel. `texturePosition` / `textureSize` set both areas at once;
`chatTexturePosition`/`chatTextureSize` and `sidebarTexturePosition`/
`sidebarTextureSize` override each area individually. Character standees use
`characterHeight` / `characterBottom` / `characterOpacity` (defaults mirror
DSH: `clamp(560px, 96vh, 1180px)` height, slightly tucked below the edge).

### DSH Skin Compatibility

Folders that follow the DeepSeek Harness Web GUI skin layout are detected
automatically — you can import e.g. the `maid-atelier` folder from
[Small-tailqwq/dsh-deep-whale](https://github.com/Small-tailqwq/dsh-deep-whale)
directly:

- `skin.json` metadata is mapped to the pack manifest
  (`id` → pack id, `name`/`nameEn`, `author`, `tagline`, `description`,
  `tags`, `accent` → `colors.accent`, `preview.light`/`dark` → previews).
- Artwork is discovered by filename convention under `assets/`:
  `*palace-day*`/`*day*` → light background, `*palace-night*`/`*night*` →
  dark background, `*sidebar*` → sidebar texture, `*composer*`/`*frame*` →
  chat texture, `*maid-left*`/`*character-left*`/`*chibi-left*` → left
  character standee (right analog for the right side).
- The skin is imported in scenic mode with a subtle glass overlay. Layout
  follows the skin's own conventions: the backdrop is anchored
  `center top / cover`, the sidebar corner sprite is drawn at its fixed
  `130px` size in the top-left corner, the composer frame is pasted onto
  the input box (width-fit, top-anchored), and character standees hang from
  the window's bottom corners behind the app UI.

**Security note:** only the declarative `skin.json` and image files are read.
A DSH skin's executable plugin code (`lib/`, `src/`) is copied verbatim but
never loaded or executed by Craft.

## Default Theme

The built-in default theme uses OKLCH colors optimized for accessibility:

**Light Mode:**
- Background: `oklch(0.98 0.003 265)` - Very light gray with slight purple tint
- Foreground: `oklch(0.185 0.01 270)` - Near-black for high contrast
- Accent: `oklch(0.58 0.22 293)` - Vibrant purple
- Info: `oklch(0.75 0.16 70)` - Warm amber
- Success: `oklch(0.55 0.17 145)` - Clear green
- Destructive: `oklch(0.58 0.24 28)` - Alert red

**Dark Mode:**
- Background: `oklch(0.145 0.015 270)` - Deep dark with purple tint
- Foreground: `oklch(0.95 0.01 270)` - Near-white
- Accent/Info/Success/Destructive: Slightly brighter versions for visibility

## Examples

### Minimal: Just change accent color
```json
{
  "accent": "#3b82f6"
}
```

### Custom brand colors
```json
{
  "accent": "oklch(0.55 0.25 250)",
  "info": "oklch(0.70 0.15 200)",
  "dark": {
    "accent": "oklch(0.65 0.25 250)",
    "info": "oklch(0.75 0.12 200)"
  }
}
```

### High contrast theme
```json
{
  "background": "#ffffff",
  "foreground": "#000000",
  "dark": {
    "background": "#000000",
    "foreground": "#ffffff"
  }
}
```

## Live Updates

Theme changes are applied immediately - no restart needed. Edit theme.json and the UI updates automatically.

## Creating a Theme

1. Create `~/.craft-agent/theme.json` for overrides or `~/.craft-agent/themes/{name}.json` for a preset
2. Add only the colors you want to customize
3. Optionally add `dark` overrides for dark mode

**Tips:**
- Start with just `accent` to quickly personalize
- Use OKLCH for predictable color behavior
- Test in both light and dark modes
- Keep contrast ratios accessible (foreground vs background)

## Troubleshooting

**Theme not applying:**
- Verify JSON syntax is valid
- Check file is in correct location (`~/.craft-agent/theme.json` for overrides, `~/.craft-agent/themes/` for presets)
- Ensure color values are valid CSS colors

**Colors look wrong in dark mode:**
- Add explicit `dark` overrides
- OKLCH colors may need higher lightness values for dark mode
- Check if preset has `supportedModes` that excludes your current mode

**Background image not showing:**
- Ensure `mode` is set to `"scenic"`
- Check image path is relative to theme file or a valid URL
- Verify image file exists and is readable

## OKLCH Color Reference

OKLCH format: `oklch(lightness chroma hue)`
- **Lightness**: 0-1 (0 = black, 1 = white)
- **Chroma**: 0-0.4 (0 = gray, higher = more saturated)
- **Hue**: 0-360 (color wheel angle)

Common hues:
- Red: ~25
- Orange: ~70
- Yellow: ~100
- Green: ~145
- Cyan: ~195
- Blue: ~250
- Purple: ~293
- Pink: ~330
