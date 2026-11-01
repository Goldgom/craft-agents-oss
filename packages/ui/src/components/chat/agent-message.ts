export interface AgentMessageEnvelope {
  sessionId?: string
  senderName: string
  body: string
  bodyStart: number
  header: string
}

/** Recognize complete peer/collaboration envelopes, never quoted snippets. */
export function parseAgentMessage(content: string): AgentMessageEnvelope | null {
  const match = /^\[Message from session "([^"\r\n]+)" \(([^\r\n]*)\)\]\r?\nUse send_agent_message with sessionId "\1" to reply\.\r?\n\r?\n---\r?\n\r?\n/.exec(content)
  if (match && content.slice(match[0].length).trim()) {
    return {
      sessionId: match[1]!,
      senderName: match[2]!.trim() || match[1]!,
      body: content.slice(match[0].length),
      bodyStart: match[0].length,
      header: match[0].replace(/\r?\n\r?\n---\r?\n\r?\n$/, ''),
    }
  }

  // Local collaboration and authenticated cross-server relay use distinct headers.
  const collaboration = /^\[Collaboration (?:request|report) [\w-]+ from ([^\r\n]+)\]\r?\n\r?\n/.exec(content)
    ?? /^\[Collaboration (?:request|report) from member ([\w-]+)\]\r?\nReply using the group member ID, not a session ID\.\r?\n\r?\n/.exec(content)
  if (!collaboration || !content.slice(collaboration[0].length).trim()) return null
  return {
    senderName: collaboration[1]!,
    body: content.slice(collaboration[0].length),
    bodyStart: collaboration[0].length,
    header: collaboration[0].trimEnd(),
  }
}
