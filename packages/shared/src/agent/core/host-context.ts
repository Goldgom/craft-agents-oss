/** Host-owned transient data travels separately from user-authored text. */
export interface HostContext {
  kind: 'super-agent'
  snapshotId: string
  text: string
}

export function formatHostContext(context: HostContext): string {
  return `<super_agent_context>\n${context.text.replace(/</g, '\\u003c')}\n</super_agent_context>`
}
