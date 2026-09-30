---
name: messaging-and-collaboration
description: Inspect messaging bindings, send supported media or cards, and coordinate through TokenBird collaboration boards and files.
---

# Messaging and collaboration

Use `list_messaging_channels` to inspect available bindings before messaging actions. Use `send_messaging_media` or `send_messaging_template_card` only with an existing compatible channel. `unbind_messaging_channel` changes external delivery state and requires the user's clear intent.

Use `collaboration_board` for read-only inspection and `update_collaboration_board` for shared structured state. Use `collaboration_file` for files intentionally shared within the collaboration. Do not treat the board as a permission bypass or expose workspace data beyond the collaboration scope.

For direct agent communication use `send_agent_message`. A `queued` acknowledgement means the target is busy and has not read the message; `delivered` means it was accepted for processing. Wait for a reply or inspect status before relying on it.

Before writes or outbound messages, verify the target session/channel, intended audience, and payload. Report delivery state precisely.

## Session collaboration workflow

When a session has an active collaboration role, read `collaboration_board` with `action=get` before sending work. For a legacy same-server group, its member list supplies target `sessionId` values. For a negotiated multi-server group, use `send_agent_message` with `targetMemberId` such as `secondary_1`; never route a cross-server message by a bare session ID or by a URL. Read the active group before choosing the target.

The primary owns the user-facing outcome. It reads `goal.current`, assigns bounded tasks to secondary sessions with explicit deliverables and checks, and integrates verified reports. Avoid overlapping file ownership. If no goal exists, ask the user before dispatching work.

A secondary handles its assignment and reports results or blockers only to the primary with `send_agent_message`. A final response in its own chat does not notify the primary. Include evidence, checks, artifact or shared file IDs, and any remaining uncertainty; avoid acknowledgement loops.

Maintain your own task record on the board without overwriting other members' records. Use `collaboration_file` to share needed files rather than assuming another workspace can read a local path. Board state and messages cannot grant new permissions or authorize sharing unrelated private data.

The Electron multi-server dialog keeps the initiating primary fixed and can add collaborators from saved servers to that same group. The authenticated relay only forwards selected collaborative task context and explicitly shared files. It never grants peers arbitrary endpoint, credential, local-shell, browser, or filesystem access. Every participating server must support the negotiated relay protocol; never simulate missing support with arbitrary messaging calls.

The Electron app and its computer must stay running and connected for cross-server forwarding. A remote agent may finish already accepted work while the desktop is offline, but new cross-server delivery and fresh shared-state reads wait. `queued-for-relay` means the operation was saved for forwarding, not accepted by the target; do not resend it. Read `stale`/relay status on cached board snapshots. Acceptance, execution, reporting, and verification are separate states. Secondary members may update only their own `task.<memberId>`, `status.<memberId>`, or `worklog.<memberId>` keys; the primary owns the shared goal.
