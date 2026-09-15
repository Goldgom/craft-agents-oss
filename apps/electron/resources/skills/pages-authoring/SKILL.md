---
name: pages-authoring
description: Create and maintain persistent TokenBird Pages, live data stores, refresh jobs, and secure source-action grants.
---

# Pages authoring

Read `~/.tokenbird/docs/pages.md` before creating a Page or authoring Page HTML.

Use `list_pages`, `get_page`, `create_page`, `update_page`, and `write_page_data`; do not edit `pages/{slug}` directly because tools maintain digests, watchers, and UI state. Confirm before `delete_page` because deletion is permanent.

Choose `static`, `interactive`, or `live`. Supply a complete standalone HTML document with inline CSS and JavaScript and no external network dependencies. A live page reads only the generated `data/snapshot.json` containing KV values and timestamped numeric series.

Implement the `craft-pages/v1` postMessage bridge: announce `ready`, then accept `init` and replacement `data` snapshots using the provided nonce. Copy the canonical snippet from the local Pages documentation.

Pages never contain credentials. Source actions must go through the bridge with user-approved, expiring grants bound to the exact content digest; changing content invalidates grants. Publishing is a user action.
