import { join } from 'node:path'
import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { getLlmConnection, getModelsForProviderType, getWorkspaceByNameOrId, isImageGenerationModelId } from '@craft-agent/shared/config'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { loadWorkspaceSources } from '@craft-agent/shared/sources'
import type { SuperAgentConfig, SuperAgentEnvironment } from '@craft-agent/shared/super-agent'
import type { ISessionManager } from '../handlers/session-manager-interface'
import { SuperAgentService } from './SuperAgentService'
import { SuperAgentEnvironments } from './SuperAgentEnvironments'

const services = new WeakMap<ISessionManager, { service: SuperAgentService; environments: SuperAgentEnvironments }>()
const closedHosts = new WeakSet<ISessionManager>()

export async function validateSuperAgentCatalog(workspaceId: string, config: SuperAgentConfig): Promise<void> {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Workspace not found')
  const sources = new Set(loadWorkspaceSources(workspace.rootPath).map(source => source.config.slug))
  const credentials = getCredentialManager()
  for (const node of config.nodes) {
    const connection = getLlmConnection(node.llmConnection)
    if (!connection) throw new Error(`AI connection not found: ${node.llmConnection}`)
    if (connection.authType !== 'none' && !await credentials.hasLlmCredentials(connection.slug, connection.authType)) {
      throw new Error(`Sign in to the AI connection: ${connection.name}`)
    }
    const models = connection.models?.length ? connection.models : getModelsForProviderType(connection.providerType, connection.piAuthProvider)
    const available = new Set(models.map(model => typeof model === 'string' ? model : model.id))
    if (!available.size && connection.defaultModel) available.add(connection.defaultModel)
    const group = connection.oauthProvider === 'tokennest' ? connection.channelGroups?.find(group => group.id === connection.channelGroup) : undefined
    if (isImageGenerationModelId(node.model) || !available.has(node.model) || (group?.models?.length && !group.models.includes(node.model))) {
      throw new Error(`Model ${node.model} is not available in ${connection.name}'s configured group`)
    }
    for (const slug of node.sourceSlugs) if (!sources.has(slug)) throw new Error(`Data source not found: ${slug}`)
  }
  for (const slug of config.sourceSlugs) if (!sources.has(slug)) throw new Error(`Data source not found: ${slug}`)
  if (!config.environment.fullControl && config.environment.kind === 'sandbox' && config.environment.permissions.runPrograms && !config.environment.permissions.readFiles) {
    throw new Error('Sandbox programs require file read permission')
  }
}

export function getSuperAgentService(host: ISessionManager): SuperAgentService {
  if (closedHosts.has(host)) throw new Error('Super Agent host is shutting down')
  const existing = services.get(host)
  if (existing) return existing.service
  const environments = new SuperAgentEnvironments({ isVmHost: process.env.TOKENBIRD_EXECUTION_HOST === 'vm' })
  const environmentConfigs = new Map<string, SuperAgentEnvironment>()
  const service = new SuperAgentService({
    host: {
      createSession: (workspaceId, options) => host.createSession(workspaceId, options),
      getSession: sessionId => host.getSession(sessionId),
      getSessions: workspaceId => host.getSessions(workspaceId),
      deleteSession: (sessionId, guard) => host.deleteSession(sessionId, guard),
      sendMessage: (sessionId, message) => host.sendMessage(sessionId, message),
      cancelProcessing: (sessionId, silent) => host.cancelProcessing(sessionId, silent),
      onSessionComplete: listener => host.onSessionComplete(listener),
      onSessionEvent: listener => host.onSessionEvent(listener),
      respondToPermission: (sessionId, requestId, allowed, alwaysAllow) => host.respondToPermission(sessionId, requestId, allowed, alwaysAllow),
      getSessionFinalText: sessionId => host.getSessionFinalText(sessionId),
      ensureSuperAgentSessionSettings: (sessionId, settings) => host.ensureSuperAgentSessionSettings(sessionId, settings),
      setSuperAgentFullControl: (workspaceId, fullControl) => host.setSuperAgentFullControl(workspaceId, fullControl),
      applySessionPolicy: async (sessionId, policy) => {
        if (!host.applySessionPolicy) throw new Error('This host does not support Super Agent execution policies')
        const session = await host.getSession(sessionId)
        if (!session) throw new Error('Node session not found')
        const environment = environmentConfigs.get(session.workspaceId)
        if (!environment) throw new Error('Node environment has not been validated')
        const executor = await environments.prepareSession(session.workspaceId, environment, policy)
        await host.applySessionPolicy(sessionId, { ...policy, containerExecutor: executor })
      },
    },
    rootForWorkspace: workspaceId => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error('Workspace not found')
      if (workspace.id !== workspaceId) throw new Error('Use the canonical workspace ID for Super Agent')
      return workspace.rootPath
    },
    validateConfig: validateSuperAgentCatalog,
    onConfigChanged: async workspaceId => {
      const current = (await service.get(workspaceId)).config
      if (current) await environments.reconcile(workspaceId, current)
    },
    resolveEnvironment: async (workspaceId, environment) => {
      environmentConfigs.set(workspaceId, environment)
      return environments.resolve(workspaceId, environment)
    },
    spawnScript: async ({ workspaceId, environment, script, path }) => {
      if (environment.kind === 'sandbox') return environments.spawnScript(workspaceId, environment, path, script.args)
      // A VM workspace's server is already inside the chosen VM. Reuse its OS
      // executor only after the environment adapter has verified that host mode.
      const resolved = await environments.resolve(workspaceId, environment)
      if (!resolved.status.available || resolved.status.isolation !== 'remote-vm') throw new Error(resolved.status.detail)
      if (!environment.fullControl && !Object.values(environment.permissions).every(Boolean)) throw new Error('VM host scripts require all environment permissions')
      const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
      const commands: Record<string, [string, string[]]> = {
        '.js': [process.execPath, [path]], '.mjs': [process.execPath, [path]], '.cjs': [process.execPath, [path]],
        '.py': [process.platform === 'win32' ? 'python' : 'python3', [path]], '.sh': ['bash', [path]],
        '.ps1': [process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-File', path]],
      }
      const command = commands[extension]
      if (!command) throw new Error('Unsupported VM script extension')
      const env: NodeJS.ProcessEnv = {}
      for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key]
      if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
      const child = spawn(command[0], [...command[1], ...script.args], { cwd: resolved.workingDirectory, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], shell: false })
      return { child, stop: async () => {
        if (process.platform === 'win32' && child.pid) {
          await new Promise<void>((done, reject) => {
            if (child.exitCode != null || child.signalCode != null) { done(); return }
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false })
            killer.once('error', reject)
            killer.once('close', code => {
              if (code === 0 || child.exitCode != null || child.signalCode != null) done()
              else reject(new Error(`VM script process tree could not be stopped (taskkill ${code})`))
            })
          })
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
        }
      } }
    },
  })
  services.set(host, { service, environments })
  return service
}

/** Restore configured teams on server start so idle monitoring does not require an open page. */
export async function restoreSuperAgents(host: ISessionManager, onError: (error: unknown) => void): Promise<void> {
  await host.waitForInit()
  if (closedHosts.has(host)) return
  const service = getSuperAgentService(host)
  for (const workspace of host.getWorkspaces()) {
    try { await access(join(workspace.rootPath, 'super-agent', 'state.json')) } catch { continue }
    try { await service.get(workspace.id) } catch (error) { onError(error) }
  }
}

export async function cleanupSuperAgents(host: ISessionManager): Promise<void> {
  closedHosts.add(host)
  const entry = services.get(host)
  if (!entry) return
  services.delete(host)
  try { await entry.service.cleanup() } finally { await entry.environments.cleanup() }
}
