---
name: structured-data
description: Present structured results as interactive datatables or spreadsheets and process large datasets without flooding the conversation context.
---

# Structured data

Read `~/.tokenbird/docs/data-tables.md` before working with 20 or more rows.

Use `datatable` for sortable/filterable query results and comparisons. Use `spreadsheet` for financial or export-oriented grids. Use a Markdown table only for very small, simple data.

Supported column types include `text`, `number`, `currency`, `percent`, `boolean`, `date`, and `badge`. Currency values are raw numbers and percentages are decimals.

For 20 or more rows, call `transform_data` to produce a JSON file in the session data directory, then emit a `datatable` or `spreadsheet` block with the absolute returned path in `src`. The JSON may be a row array or `{ "rows": [...] }`; inline columns and title override file values. This avoids placing the dataset in the prompt.

`transform_data` runs isolated Python, Node, or Bun code, accepts session-relative input files, and writes to the session data directory. Keep scripts deterministic and include only needed fields.
