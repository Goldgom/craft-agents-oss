---
name: browser-automation
description: Operate TokenBird's in-app browser for UI-driven work, forms, downloads, inspection, and fallback access when APIs are unsuitable.
---

# Browser automation

Use this skill only when `browser_tool` is present. Read `~/.tokenbird/docs/browser-tools.md` before the first browser call in a session; calls are blocked until that prerequisite is satisfied.

Prefer connected sources for repeatable integrations and automations. Use the browser for one-off UI work, login-protected or dynamic pages, and gaps in API coverage.

Start with `browser_tool open`, navigate, then take a `snapshot`. Interact through fresh `@eN` references and snapshot again after navigation or major DOM changes. Run `browser_tool --help` when syntax is uncertain. Commands can be batched with semicolons, but a batch stops after navigation.

Useful advanced operations include `find`, `click-at`, `drag`, `type`, `key`, clipboard/paste, console and network inspection, explicit waits, annotated or region screenshots, deterministic resizing, downloads, scrolling, and JavaScript evaluation.

Prefer snapshots to screenshots for interaction. At completion choose the lifecycle action deliberately: `close` destroys the window, `release` leaves it for the user, and `hide` preserves it for later work.
