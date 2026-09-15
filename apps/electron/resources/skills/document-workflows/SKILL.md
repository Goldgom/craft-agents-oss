---
name: document-workflows
description: Read, create, convert, inspect, compare, and edit PDF, Office, image, calendar, and other document formats with bundled CLI tools.
---

# Document workflows

Use the bundled command-line tools through the shell and run `<tool> --help` before unfamiliar operations.

- `markitdown`: universal readable conversion for DOCX, XLSX, PPTX, PDF, HTML, notebooks, mail, and legacy formats.
- `pdf-tool`: PDF extraction, information, merge, and split.
- `xlsx-tool`: spreadsheet read, write, export, and inspection.
- `docx-tool`: Word document creation and editing.
- `pptx-tool`: presentation creation, editing, extraction, and inspection.
- `img-tool`: image metadata, resize, and conversion.
- `doc-diff`: compare two documents.
- `ical-tool`: read and create calendar data.

If a normal file read fails because the file is binary, convert it with `markitdown` or the format-specific tool. Prefer an output file over large stdout and inspect the result. Preserve the source unless the user explicitly requests an in-place change; verify generated documents structurally and visually when practical.
