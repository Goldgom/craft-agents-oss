---
name: resource-transfer
description: Export and import portable TokenBird source and integration bundles while preserving credentials and validating scope.
---

# Resource transfer

Use `export_resources` and `import_resources` for supported integration bundles instead of copying internal files ad hoc.

Inspect the selected resources and destination before export. Treat archives as potentially sensitive metadata even when credentials are excluded. On import, validate the archive, preserve unrelated existing resources, and report conflicts or remapping.

Never claim credentials moved unless the tool result confirms it; users may need to reconnect accounts on the destination. Do not overwrite conflicting integrations without clear user intent.
