export interface AgentMessageEnvelope {
  sessionId: string
  senderName: string
  body: string
  bodyStart: number
  header: string
}

/** Recognize the complete send_agent_message envelope, never a quoted snippet. */
export function parseAgentMessage(content: string): AgentMessageEnvelope | null {
  const match = /^\[Message from session "([^"\r\n]+)" \(([^\r\n]*)\)\]\r?\nUse send_agent_message with sessionId "\1" to reply\.\r?\n\r?\n---\r?\n\r?\n/.exec(content)
  if (!match || !content.slice(match[0].length).trim()) return null
  return {
    sessionId: match[1]!,
    senderName: match[2]!.trim() || match[1]!,
    body: content.slice(match[0].length),
    bodyStart: match[0].length,
    header: match[0].replace(/\r?\n\r?\n---\r?\n\r?\n$/, ''),
  }
}
