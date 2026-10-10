import { useState } from 'react'
import type { SuperAgentConfig, SuperAgentReadiness as Readiness } from '@craft-agent/shared/super-agent'
import { useAppShellContext } from '@/context/AppShellContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormField, FormSection } from './SuperAgentForms'
import { useSuperAgentText } from './super-agent-ui'

export function SuperAgentReadiness({ config, onChange }: { config: SuperAgentConfig; onChange: (requirements: NonNullable<SuperAgentConfig['requirements']>) => void }) {
  const text = useSuperAgentText()
  const { activeWorkspaceId } = useAppShellContext()
  const requirements = config.requirements ?? { programs: [], browser: false }
  const [programText, setProgramText] = useState(requirements.programs.join(', '))
  const [result, setResult] = useState<{ fingerprint: string; readiness: Readiness }>()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const fingerprint = JSON.stringify(config)
  const current = result?.fingerprint === fingerprint ? result.readiness : undefined
  async function check() {
    if (!activeWorkspaceId || pending) return
    setPending(true); setError('')
    try {
      const snapshot = await window.electronAPI.superAgentCommand(activeWorkspaceId, { type: 'environment-check', config })
      if (snapshot.readiness) setResult({ fingerprint, readiness: snapshot.readiness })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false) }
  }
  return <FormSection title={text('requirements')} description={text('checkEnvironmentHint')}>
    <FormField label={text('requiredPrograms')} hint={text('requiredProgramsHint')}><Input value={programText} placeholder="git, bun, node, python3" onChange={event => {
      setProgramText(event.target.value)
      onChange({ ...requirements, programs: [...new Set(event.target.value.split(',').map(value => value.trim()).filter(Boolean))] })
    }} /></FormField>
    <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={requirements.browser} onChange={event => onChange({ ...requirements, browser: event.target.checked })} />{text('requireBrowser')}</label>
    <Button type="button" variant="outline" disabled={pending || !activeWorkspaceId || !config.environment.workingDirectory.trim()} onClick={() => void check()}>{text(pending ? 'working' : 'checkEnvironment')}</Button>
    {current && <div role="status" className="space-y-2 text-xs leading-5">
      <p className={current.ready ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}>{text(current.ready ? 'readinessPassed' : 'readinessFailed')}</p>
      <ul className="list-disc space-y-1 pl-5">{current.checks.map(check => <li key={check.id} className={check.ok ? 'text-muted-foreground' : 'text-destructive'}>{check.detail}</li>)}</ul>
    </div>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    <p className="text-xs leading-5 text-muted-foreground">{text('readinessScope')}</p>
  </FormSection>
}
