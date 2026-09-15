---
name: messaging-and-collaboration
description: Inspect messaging bindings, send supported media or cards, and coordinate through TokenBird collaboration boards and files.
---

# Messaging and collaboration

Use `list_messaging_channels` to inspect available bindings before messaging actions. Use `send_messaging_media` or `send_messaging_template_card` only with an existing compatible channel. `unbind_messaging_channel` changes external delivery state and requires the user's clear intent.

Use `collaboration_board` for read-only inspection and `update_collaboration_board` for shared structured state. Use `collaboration_file` for files intentionally shared within the collaboration. Do not treat the board as a permission bypass or expose workspace data beyond the collaboration scope.

For direct agent communication use `send_agent_message`. A `queued` acknowledgement means the target is busy and has not read the message; `delivered` means it was accepted for processing. Wait for a reply or inspect status before relying on it.

Before writes or outbound messages, verify the target session/channel, intended audience, and payload. Report delivery state precisely.
