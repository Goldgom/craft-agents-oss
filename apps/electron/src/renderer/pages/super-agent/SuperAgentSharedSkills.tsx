import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppShellContext } from '@/context/AppShellContext'
import { SkillsListPanel } from '@/components/app-shell/SkillsListPanel'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import { Button } from '@/components/ui/button'
import SkillInfoPage from '../SkillInfoPage'
import type { LoadedSkill } from '../../../shared/types'

export function SuperAgentSharedSkills({ workspaceId, workingDirectory }: { workspaceId: string; workingDirectory?: string }) {
  const { t } = useTranslation()
  const { workspaces } = useAppShellContext()
  const workspace = workspaces.find(item => item.id === workspaceId)
  const [skills, setSkills] = useState<LoadedSkill[]>([])
  const [selected, setSelected] = useState<string>()
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const load = () => { void window.electronAPI.getSkills(workspaceId, workingDirectory).then(value => { if (alive) { setSkills(value); setError('') } }).catch(error => { if (alive) setError(String(error)) }) }
    load()
    const off = window.electronAPI.onSkillsChanged(id => { if (id === workspaceId) load() })
    return () => { alive = false; off() }
  }, [workspaceId, workingDirectory])
  return <div className="flex h-full min-h-0 flex-col">
    {error && <p role="alert" className="p-4 text-sm text-destructive">{error}</p>}
    {workspace && <div className="p-3"><EditPopover trigger={<Button variant="outline">{t('skillsList.addSkill')}</Button>} {...getEditConfig('add-skill', workspace.rootPath)} /></div>}
    <div className="flex min-h-0 flex-1">
      <SkillsListPanel className="w-64 shrink-0" skills={skills} workspaceId={workspaceId} workspaceRootPath={workspace?.rootPath} selectedSkillSlug={selected}
        onSkillClick={skill => setSelected(skill.slug)} onDeleteSkill={slug => { void window.electronAPI.deleteSkill(workspaceId, slug).then(() => { setSkills(items => items.filter(item => item.slug !== slug)); if (selected === slug) setSelected(undefined) }).catch(error => setError(String(error))) }} />
      {selected && <div className="min-w-0 flex-1"><SkillInfoPage key={selected} skillSlug={selected} workspaceId={workspaceId} workingDirectory={workingDirectory} /></div>}
    </div>
  </div>
}
