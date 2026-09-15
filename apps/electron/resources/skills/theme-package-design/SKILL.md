---
name: theme-package-design
description: Create complete portable TokenBird theme packs or Harness-compatible skins with offline assets and readable light/dark styling.
---

# Theme package design

Read `~/.tokenbird/docs/themes.md` before changing a theme.

Create a complete package, not only a color suggestion. Define a valid `theme-pack.json` or Harness-compatible `skin.json`, include every referenced image, font, CSS, or JavaScript asset, and keep manifest paths relative to the package root.

Prefer declarative CSS, explain any optional script behavior, and validate offline import with no network dependency. Check contrast and readability in light and dark surfaces. Do not overwrite an installed package unless the user explicitly asks; create a new folder or previewable archive by default.
