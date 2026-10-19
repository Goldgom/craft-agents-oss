import { AgentAvatar } from './SuperAgentAvatar'
import type { SuperAgentText } from './super-agent-ui'
import type { SuperAgentThinkingPhase } from './super-agent-thinking'

export function SuperAgentThinkingIndicator({ phase, avatar, name, text }: {
  phase?: SuperAgentThinkingPhase; avatar: string; name: string; text: SuperAgentText
}) {
  if (!phase) return null
  return <div role="status" aria-live="polite" className="flex items-start gap-3">
    <div className="rounded-xl ring-2 ring-primary/20 motion-safe:animate-pulse"><AgentAvatar avatar={avatar} name={name} className="size-8 rounded-lg text-base" /></div>
    <div className="flex min-h-10 items-center gap-3 rounded-2xl border border-primary/10 bg-primary/5 px-4 py-3">
      <span className="text-xs text-muted-foreground">{text(phase)}</span>
      <span aria-hidden="true" className="flex items-center gap-1">{[0, 1, 2].map(index => <span key={index} className="size-1.5 rounded-full bg-primary/70 motion-safe:animate-bounce" style={{ animationDelay: `${index * 150}ms`, animationDuration: '1s' }} />)}</span>
    </div>
  </div>
}
