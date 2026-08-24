import { useEffect, useState } from 'react'
import { Terminal } from 'lucide-react'
import type { ToolIconMapping } from '../../../shared/types'
import { cn } from '@/lib/utils'

export default function CliToolsNavigator({ filter, selected }: { filter?: 'builtin' | 'custom'; selected?: string }) {
  const [tools, setTools] = useState<ToolIconMapping[]>([])
  useEffect(() => { window.electronAPI.getToolIconMappings().then(setTools).catch(() => setTools([])) }, [])
  const visible = tools.filter(tool => !filter || (tool.origin ?? 'custom') === filter)
  return (
    <div className="h-full overflow-y-auto px-2 pt-2">
      {visible.map(tool => (
        <div key={tool.id} className={cn('flex items-center gap-2 rounded-lg px-3 py-2 text-sm', selected === tool.id && 'bg-foreground/5')}>
          <Terminal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0"><div className="truncate font-medium">{tool.displayName}</div><div className="truncate text-[11px] text-muted-foreground">{tool.commands.join(', ')}</div></div>
        </div>
      ))}
    </div>
  )
}
