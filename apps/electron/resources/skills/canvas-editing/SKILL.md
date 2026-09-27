---
name: canvas-editing
description: Create and edit TokenBird drawing sessions through canvas_tool, including images, layers, selections, adjustments, AI painting, and GPT canvas assistance.
---

# Canvas editing

Use `canvas_tool` for drawing sessions. Start with `list_sessions` and `get_state`; when the user names a specific drawing session, pass its `sessionId` and call `select_session` before editing it. Work from the returned layer IDs and selection coordinates instead of guessing.

The desktop client owns canvas projects. `imagePath`, `projectPath`, and `outputPath` are paths on that client. Import an image with `import_image`, then inspect the new layer. Use `set_selection` for local edits and `clear_selection` for a whole-canvas adjustment. `adjust` changes visible layers in the selection, or all visible layers when there is no selection. Use `undo` or `redo` if the result is unsuitable.

For AI painting, use `set_parameters` to choose an image connection, model, channel group, prompt and candidate count. `generate` supports `generate`, `inpaint`, `outpaint`, and `cutout`; inpaint and outpaint require a selection and a visible source layer. If multiple candidates are returned, ask which candidate index to apply. `ask_gpt` asks the selected text model about the active drawing session and returns advice; it does not apply the proposed edit. Apply an approved suggestion with the appropriate canvas action.

Use `choose_candidate` when the user identifies one of the returned candidate indexes. `list_history` returns prior image metadata with a cursor; `add_history`, `reuse_prompt`, and `download_history` use a `generationId` from that list.

Use `save_project` for an editable `.tbcanvas` file and `export_png` for a flattened image. Export paths must be absolute and new; the tool will not replace an existing file. Never use `delete_session` without the user's explicit intent; the tool also requires `confirm=true`.
