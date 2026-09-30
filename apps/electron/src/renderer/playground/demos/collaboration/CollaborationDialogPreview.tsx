import * as React from 'react'
import { CollaborationDialog } from '../../../components/app-shell/CollaborationDialog'
import type { CollaborationGroup, CollaborationSessionSelection, Session } from '../../../../shared/types'

const primary = { id: 'local-primary', workspaceId: 'local-main', workspaceName: 'Local project', name: 'Release coordinator', messages: [], isProcessing: false, lastMessageAt: 0 } as Session
const localSessions = [primary, { ...primary, id: 'reviewer', name: 'Code reviewer' }, { ...primary, id: 'reviewer', workspaceId: 'local-other', name: 'Documentation reviewer' }]

/** Synthetic UI smoke surface: no remote connections or real credentials. */
export function CollaborationDialogPreview({ scenario = 'normal' }: { scenario?: 'normal' | 'slow' | 'offline' }) {
  const [ready, setReady] = React.useState(false)
  const [open, setOpen] = React.useState(true)
  const [requests, setRequests] = React.useState<string[]>([])

  React.useEffect(() => {
    const api = window.electronAPI
    const pause = async () => {
      if (scenario === 'slow') await new Promise(resolve => setTimeout(resolve, 1200))
    }
    const create = async (server: string, primaryId: string, selections: CollaborationSessionSelection[]) => {
      await pause()
      setRequests(items => [...items, JSON.stringify({ server, primaryId, selections })])
      return { id: 'synthetic-collaboration', members: [] } as unknown as CollaborationGroup
    }
    const overrides: Partial<typeof api> = {
      getRemoteServers: async () => [{ id: 'smoke-server', name: 'Synthetic test server', url: 'wss://test.invalid', hasToken: true, createdAt: 0, updatedAt: 0 }],
      getStartupContext: async () => ({ mode: 'local' }),
      listCollaborationCandidates: async () => { await pause(); return localSessions },
      listCollaborationWorkspaces: async () => [{ id: 'local-main', name: 'Local project' }, { id: 'local-other', name: 'Other project' }],
      listRemoteCollaborationWorkspaces: async () => {
        await pause()
        if (scenario === 'offline') throw new Error('Synthetic offline server')
        return [{ id: 'remote-main', name: 'Remote project' }, { id: 'remote-empty', name: 'Empty remote project' }]
      },
      listRemoteCollaborationCandidates: async (_profileId, workspaceId) => {
        await pause()
        return workspaceId === 'remote-empty' ? [] : [
          { ...primary, id: 'remote-primary', workspaceId, name: 'Remote coordinator' },
          { ...primary, id: 'remote-reviewer', workspaceId, name: 'Remote reviewer' },
        ]
      },
      createCollaboration: async (primaryId, selections) => create('current', primaryId, selections),
      createRemoteCollaboration: async (profileId, _workspaceId, primaryId, selections) => create(profileId, primaryId, selections),
      openRemoteCollaborationWorkspace: async () => ({ ok: true, workspaceId: 'synthetic-workspace' }),
    }
    const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, api[key as keyof typeof api]]))
    Object.assign(api, overrides)
    setRequests([])
    setOpen(true)
    setReady(true)
    return () => { Object.assign(api, previous) }
  }, [scenario])

  return <div className="p-6 space-y-4 text-sm">
    <p>Synthetic collaboration smoke test. No real server, account, or agent is used.</p>
    {ready && <CollaborationDialog key={scenario} primary={primary} open={open} onOpenChange={setOpen} />}
    {!open && <button className="underline" onClick={() => setOpen(true)}>Reopen collaboration</button>}
    <p role="status">Creation requests: {requests.length}</p>
    {requests.map((request, index) => <pre key={index} className="whitespace-pre-wrap break-all">{request}</pre>)}
  </div>
}
