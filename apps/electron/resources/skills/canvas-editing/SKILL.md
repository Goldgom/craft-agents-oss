---
name: canvas-editing
description: Generate standalone GPT Image PNGs or create and edit TokenBird drawing sessions through canvas_tool, including layers, selections, adjustments, AI painting, and GPT canvas assistance.
---

# Canvas editing

Use the `canvas_tool` tool for image generation and drawing sessions. The names below are values of its `action` parameter, not separate tools. For a standalone image, call `canvas_tool` with `action: "list_image_connections"` first. It lists only image models backed by a configured API key or an authenticated TokenNest account with an image group. If none are available, tell the user to configure drawing in AI settings or sign in to TokenNest. Then call `canvas_tool` with `action: "generate_image"`, a prompt, and optionally one listed `connectionSlug`, `model`, and `channelGroup`. Optional `size` is `1024x1024`, `1536x1024`, or `1024x1536`; `count` is 1–4. The tool saves PNGs under the agent session on the server and returns absolute paths. These are server paths in a remote workspace. Include the returned paths when presenting the result. A standalone generation does not change the canvas.

For canvas editing, start with `list_sessions` and `get_state`; when the user names a specific drawing session, pass its `sessionId` and call `select_session` before editing it. Work from the returned layer IDs and selection coordinates instead of guessing. Canvas actions require a connected desktop client with the drawing editor available.

The desktop client owns canvas projects. `imagePath`, `projectPath`, and `outputPath` are paths on that client. Import an image with `import_image`, then inspect the new layer. Use `set_selection` for local edits and `clear_selection` for a whole-canvas adjustment. `adjust` changes visible layers in the selection, or all visible layers when there is no selection. Use `undo` or `redo` if the result is unsuitable.

For AI painting on the canvas, use `set_parameters` to choose an image connection, model, channel group, prompt and candidate count. `generate` supports `generate`, `inpaint`, `outpaint`, and `cutout`; inpaint and outpaint require a selection and a visible source layer. If multiple candidates are returned, ask which candidate index to apply. `ask_gpt` asks the selected text model about the active drawing session and returns advice; it does not apply the proposed edit. Apply an approved suggestion with the appropriate canvas action.

Use `choose_candidate` when the user identifies one of the returned candidate indexes. `list_history` returns prior image metadata with a cursor; `add_history`, `reuse_prompt`, and `download_history` use a `generationId` from that list.

Use `save_project` for an editable `.tbcanvas` file and `export_png` for a flattened image. Export paths must be absolute and new; the tool will not replace an existing file. Never use `delete_session` without the user's explicit intent; the tool also requires `confirm=true`.
