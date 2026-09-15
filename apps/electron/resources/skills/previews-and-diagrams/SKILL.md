---
name: previews-and-diagrams
description: Render Mermaid diagrams and local HTML, PDF, image, or Markdown files as native previews, including multi-item tab sets.
---

# Previews and diagrams

Read the matching local reference before advanced output: `~/.tokenbird/docs/mermaid.md`, `html-preview.md`, `pdf-preview.md`, `image-preview.md`, or `markdown-preview.md`.

Use Mermaid when relationships, sequence, hierarchy, state, schema, or trends are clearer visually. Choose direction for the content, keep one concept per diagram, split oversized diagrams, and validate complex syntax with `mermaid_validate`.

For file previews, emit the corresponding fenced block with JSON containing an absolute `src` and optional `title`: `html-preview`, `pdf-preview`, `image-preview`, or `markdown-preview`. Write or transform content to a permitted session path first. Use source `render_template` when a source guide provides a template.

All preview types accept `items` instead of `src` for lazy tabbed comparison; each item needs an absolute `src` and may include a short `label`.

Use HTML preview for rich generated content, PDF preview for existing PDF files, image preview for supported local images, and Markdown preview for files that should be rendered rather than pasted raw. Respect the sandbox and do not assume unsupported image formats render.
