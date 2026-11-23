import { act } from 'react'
import { createRoot } from 'react-dom/client'
import i18next from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import en from '../../../../../../packages/shared/src/i18n/locales/en.json'
import type { VideoExecuteRequest, VideoProject, VideoStudioState } from '@tokenbird/shared/video'
import StudioVideo from './StudioVideo'

declare global { interface Window { runVideoStudioChecks: () => Promise<string[]>; videoStudioContext: unknown; keepVideoStudioForScreenshot?: boolean } }

/** Exercise the actual controls against a host fixture, without external generation charges. */
window.runVideoStudioChecks = async () => {
  const i18n = i18next.createInstance()
  await i18n.use(initReactI18next).init({ lng: 'en', keySeparator: false, resources: { en: { translation: en } } })
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const before = environment.IS_REACT_ACT_ENVIRONMENT; environment.IS_REACT_ACT_ENVIRONMENT = true
  const calls: VideoExecuteRequest[] = []
  const state: VideoStudioState = {
    version: 1,
    providers: [{ id: 'provider-1', name: 'Video service', kind: 'runway', baseUrl: 'https://example.test/v1', model: 'gen4.5', hasApiKey: true, createdAt: 1, updatedAt: 1 }],
    memories: [{ id: 'memory-1', name: 'Hero', kind: 'person', description: 'Blue jacket', imageAssetIds: [], enabled: true, createdAt: 1, updatedAt: 1 }],
    projects: ['one', 'two'].map(id => ({ id, name: `Project ${id}`, script: 'A hero walks through a city.', preferences: 'Cinematic', providerId: 'provider-1', aspectRatio: '16:9', memoryIds: [], shots: [{ id: `shot-${id}`, title: 'Opening', prompt: 'Walk through a city', durationSeconds: 5, memoryIds: [] }], createdAt: 1, updatedAt: 1 })),
    assets: [{ id: 'video-1', name: 'clip.mp4', mimeType: 'video/mp4', bytes: 5, path: '/fixture/clip.mp4', createdAt: 1 }], jobs: [],
  }
  window.videoStudioContext = {
    activeWorkspaceId: 'workspace-1', workspaceDefaultLlmConnection: 'agent-1',
    llmConnections: [{ slug: 'agent-1', name: 'Analysis agent', isAuthenticated: true, authType: 'api_key', providerType: 'openai', defaultModel: 'text-model', models: ['text-model'] }],
  }
  window.electronAPI = {
    executeVideo: async (request: VideoExecuteRequest) => {
      calls.push(structuredClone(request))
      const args = request.args ?? {}
      if (args.workspaceId !== 'workspace-1') throw new Error('Missing workspace identity')
      if (request.action === 'state') return structuredClone(state)
      if (request.action === 'save_project') {
        const index = state.projects.findIndex(project => project.id === args.id)
        const project = { ...(index >= 0 ? state.projects[index] : state.projects[0]), ...args, id: args.id ?? `new-${state.projects.length}` } as VideoProject
        if (index >= 0) state.projects[index] = project; else state.projects.push(project)
        return structuredClone(project)
      }
      if (request.action === 'analyze' || request.action === 'generate_project' || request.action === 'generate_shot' || request.action === 'edit') {
        if (request.action === 'analyze') {
          const project = state.projects.find(project => project.id === args.projectId)!
          project.memoryIds = ['memory-1']; project.shots = [{ id: 'analyzed-shot', title: 'City arrival', prompt: 'A hero in a blue jacket enters the neon-lit city. Slow tracking shot, cinematic light, consistent face and clothes.', narration: 'A new story begins.', durationSeconds: 5, memoryIds: ['memory-1'], providerTaskId: 'saved-provider-task', providerId: 'provider-1', status: 'generating' }]
        }
        const job = { id: `job-${state.jobs.length}`, kind: request.action, status: 'completed', progress: 100, message: 'Complete', createdAt: 1, updatedAt: 1 }
        state.jobs.push(job as VideoStudioState['jobs'][number]); return job
      }
      if (request.action === 'import_asset') {
        const asset = { id: `import-${state.assets.length}`, name: String(args.name), mimeType: String(args.mimeType), bytes: atob(String(args.bytesBase64)).length, path: '/fixture/imported', createdAt: 1 }
        state.assets.push(asset); return asset
      }
      if (request.action === 'save_provider') return { ...args, id: 'provider-new' }
      if (request.action === 'export_asset') return { name: 'clip.mp4', mimeType: 'video/mp4', bytesBase64: btoa('video'), offset: 0, totalBytes: 5, eof: true }
      throw new Error(`Unexpected fixture action ${request.action}`)
    },
  } as typeof window.electronAPI
  const node = document.createElement('div'); node.style.height = '100vh'; document.body.appendChild(node)
  const root = createRoot(node)
  const assert = (value: unknown, message: string) => { if (!value) throw new Error(message) }
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  const until = async (predicate: () => boolean) => { const deadline = Date.now() + 5000; while (!predicate()) { if (Date.now() > deadline) throw new Error('UI action did not settle'); await settle() } }
  const button = (label: string, scope: ParentNode = node) => Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent?.trim() === label)
  const click = async (label: string, scope: ParentNode = node) => { const found = button(label, scope); assert(found && !found.disabled, `Missing or disabled control ${label}`); await act(async () => found!.click()); await settle() }
  const input = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) })
  }
  try {
    await act(async () => root.render(<I18nextProvider i18n={i18n}><StudioVideo /></I18nextProvider>)); await settle()
    assert(node.textContent?.includes('Project one'), 'Initial project did not load')
    await input(node.querySelector('input')!, 'Unsaved project title')
    await act(async () => (node.querySelector('[aria-label="Refresh"]') as HTMLButtonElement).click()); await settle()
    assert((node.querySelector('input') as HTMLInputElement).value === 'Unsaved project title', 'Refresh overwrote unsaved project changes')
    await click('Project two')
    assert(calls.some(call => call.action === 'save_project' && call.args?.name === 'Unsaved project title'), 'Project switch lost unsaved changes')
    const scriptInput = node.querySelector('input[type=file]') as HTMLInputElement
    const beforeImport = calls.length
    await act(async () => { const transfer = new DataTransfer(); transfer.items.add(new File(['Imported story with a new hero'], 'story.txt', { type: 'text/plain' })); scriptInput.files = transfer.files; scriptInput.dispatchEvent(new Event('change', { bubbles: true })) }); await settle()
    await until(() => calls.slice(beforeImport).some(call => call.action === 'analyze'))
    const importedCalls = calls.slice(beforeImport)
    const savedScript = importedCalls.find(call => call.action === 'save_project')
    assert(savedScript?.args?.script === 'Imported story with a new hero' && (savedScript.args.shots as unknown[]).length === 0, 'Script import did not save new text and replace obsolete shots')
    assert(importedCalls.some(call => call.action === 'analyze' && call.args?.projectId === 'two' && call.args.connectionSlug === 'agent-1'), 'Script import did not automatically start the selected agent')
    await click('Create storyboard with agent')
    const analyze = calls.find(call => call.action === 'analyze')
    assert(analyze?.args?.projectId === 'two' && analyze.args.connectionSlug === 'agent-1' && analyze.args.model === 'text-model', 'Analysis did not use selected project and agent')
    await click('Make full video')
    assert(calls.some(call => call.action === 'generate_project' && call.args?.projectId === 'two'), 'One-click video action did not reach host')
    await click('Continue saved task')
    const resumed = calls.find(call => call.action === 'generate_shot')
    assert(resumed?.args?.shotId === 'analyzed-shot' && resumed.args.regenerate !== true, 'Continuing a saved task unexpectedly submits a paid regeneration')
    await click('Regenerate')
    await click('Confirm new submission', document.querySelector('[role=dialog]')!)
    assert(calls.filter(call => call.action === 'generate_shot').at(-1)?.args?.regenerate === true, 'Explicit regeneration did not bypass stale task reuse guard')
    await click('Media & editing')
    const fileInput = node.querySelector('input[type=file]') as HTMLInputElement
    await act(async () => { const transfer = new DataTransfer(); transfer.items.add(new File(['subtitle'], 'dialogue.SRT', { type: '' })); fileInput.files = transfer.files; fileInput.dispatchEvent(new Event('change', { bubbles: true })) }); await settle()
    await until(() => calls.some(call => call.action === 'import_asset'))
    const imported = calls.find(call => call.action === 'import_asset')
    assert(imported?.args?.mimeType === 'application/x-subrip' && atob(String(imported.args.bytesBase64)) === 'subtitle', 'File import lost MIME or bytes')
    const source = node.querySelector('input[type=checkbox]:not(:disabled)') as HTMLInputElement
    await act(async () => source.click())
    const numbers = Array.from(node.querySelectorAll<HTMLInputElement>('input[type=number]'))
    await input(numbers[0]!, '2'); await input(numbers[1]!, '6')
    await click('Process media')
    const edit = calls.find(call => call.action === 'edit')
    assert(edit?.args?.startSeconds === 2 && edit.args.durationSeconds === 4 && edit.args.format === 'mp4' && (edit.args.inputAssetIds as string[])[0] === 'video-1', 'Trim controls sent incorrect FFmpeg arguments')
    await click('Generation services'); await click('Add generation service')
    const dialog = document.querySelector('[role=dialog]')!
    const key = dialog.querySelector('input[type=password]') as HTMLInputElement
    await input(key, 'temporary-fixture-secret'); await click('Save', dialog)
    assert(calls.some(call => call.action === 'save_provider' && call.args?.apiKey === 'temporary-fixture-secret'), 'Provider key did not reach encrypted host storage')
    assert(!JSON.stringify(localStorage).includes('temporary-fixture-secret'), 'Provider key leaked to localStorage')
    assert(!document.querySelector('input[type=password]'), 'Provider key was retained in mounted form after save')
    if (window.keepVideoStudioForScreenshot) { await click('Script & storyboard'); await settle() }
    return ['dirty draft survives refresh', 'project switch saves current draft', 'script import persists exact text and automatically analyzes with selected agent', 'actual analysis and generation commands', 'saved task resume preserves identity and explicit regeneration submits true', 'subtitle import preserves MIME and bytes', 'trim controls use exact FFmpeg arguments', 'provider credential leaves the form without localStorage persistence']
  } finally { if (!window.keepVideoStudioForScreenshot) { await act(async () => root.unmount()); node.remove() } environment.IS_REACT_ACT_ENVIRONMENT = before }
}
