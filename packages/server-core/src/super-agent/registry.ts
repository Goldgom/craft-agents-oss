import { superAgentResourceScope } from '@tokenbird/shared/super-agent/resource-scope'
import { SuperAgentResourceStore } from './SuperAgentResourceStore'
import { SUPER_AGENT_COLLABORATION_SKILL } from '@tokenbird/session-tools-core/super-agent-tools'
import { isAbsolute, join, relative, sep } from 'node:path'
import { access, realpath } from 'node:fs/promises'
import { CONFIG_DIR } from '@tokenbird/shared/config/paths'
import { spawn } from 'node:child_process'
import { getLlmConnection, getModelsForProviderType, getWorkspaceByNameOrId, isImageGenerationModelId } from '@tokenbird/shared/config'
import { getCredentialManager } from '@tokenbird/shared/credentials'
import { loadWorkspaceSources } from '@tokenbird/shared/sources'
import { loadAllSkills, loadSkillBySlug } from '@tokenbird/shared/skills'
import type { SuperAgentConfig, SuperAgentEnvironment } from '@tokenbird/shared/super-agent'
import type { ISessionManager } from '../handlers/session-manager-interface'
import { SuperAgentService } from './SuperAgentService'
import { describeSuperAgentResources } from './SuperAgentResources'
import { SuperAgentEnvironments } from './SuperAgentEnvironments'
import { MicrosoftAgentWorkflow } from './MicrosoftAgentWorkflow'
import { setSessionOperationRecorder } from '@tokenbird/shared/agent'
import { resolveSessionAgentRuntime } from '@tokenbird/shared/config/llm-connections'
import { getConfiguredAgentFrameworkProfile, nativeCodexTransportCompatible } from '@tokenbird/shared/agent-plugins/frameworks'
import { getAgentPluginDescriptor } from '@tokenbird/shared/agent-plugins/catalog'
import { loadBackendFrameworkConfiguration } from '@tokenbird/shared/agent-plugins'
import { resolveNativeCodexBinary } from '@tokenbird/shared/codex/binary-resolver'

const services = new WeakMap<ISessionManager, { service: SuperAgentService; environments: SuperAgentEnvironments }>()
const closedHosts = new WeakSet<ISessionManager>()

async function validateExecutionRoot(workspaceId: string, environment: SuperAgentEnvironment): Promise<void> {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Workspace not found')
  const root = await realpath(environment.workingDirectory)
  const contains = (parent: string, child: string) => {
    const rel = relative(parent, child)
    return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  }
  for (const protectedRoot of [await realpath(workspace.rootPath), await realpath(CONFIG_DIR)]) {
    if (contains(root, protectedRoot) || contains(protectedRoot, root)) throw new Error('Choose a project folder separate from TokenBird configuration, credentials and coordination data')
  }
}

export async function validateSuperAgentCatalog(workspaceId: string, config: SuperAgentConfig): Promise<void> {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Workspace not found')
  await validateExecutionRoot(workspaceId, config.environment)
  const sources = new Set(loadWorkspaceSources(config.architecture === 'dynamic' ? superAgentResourceScope(workspace.rootPath).rootPath : workspace.rootPath).map(source => source.config.slug))
  const credentials = getCredentialManager()
  const configuredModels = [...config.nodes.filter(node => !node.dynamic), ...(config.modelPool ?? []).filter(entry => entry.enabled).map(entry => ({ ...entry, name: entry.name, skillSlugs: entry.skillSlugs, sourceSlugs: entry.sourceSlugs }))]
  for (const node of configuredModels) {
    const connection = getLlmConnection(node.llmConnection)
    if (!connection) throw new Error(`AI connection not found: ${node.llmConnection}`)
    resolveSessionAgentRuntime(connection, node.agentRuntime)
    const skills = (node.skillSlugs ?? []).map(slug => {
      const skill = loadSkillBySlug(workspace.rootPath, slug, config.environment.workingDirectory)
      if (!skill) throw new Error(`Skill not found: ${slug}`)
      return skill
    })
    if (skills.reduce((size, skill) => size + skill.content.length, 0) > 128_000) throw new Error(`Assigned skill instructions for ${node.name} exceed 128 KB`)
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
  const resources = new SuperAgentResourceStore(getCredentialManager(), async (workspaceId, text, automationId, runId) => { await service.command(workspaceId, { type: 'automation-work', text, automationId, runId }) })
  const service = new SuperAgentService({
    actionGates: true,
    upgradeArchitecture: true,
    rebuildArchitecture: true,
    accessResources: async (workspaceId, operation, value) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error('Workspace not found')
      const result = await resources.access(workspaceId, workspace.rootPath, operation, value)
      const scope = superAgentResourceScope(workspace.rootPath)
      host.setupConfigWatcher(scope.rootPath, workspaceId)
      host.notifyConfigFileChange(scope.rootPath, 'automations.json')
      return result
    },
    workflow: new MicrosoftAgentWorkflow(),
    describeResources: (workspaceId, config) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error('Workspace not found')
      return describeSuperAgentResources(config.architecture === 'dynamic' ? superAgentResourceScope(workspace.rootPath).rootPath : workspace.rootPath, config, workspace.rootPath)
    },
    describeNodeBackend: node => {
      const connection = getLlmConnection(node.llmConnection)
      if (!connection) return undefined
      const runtime = resolveSessionAgentRuntime(connection, node.agentRuntime)
      const compatibility = runtime === 'codex' && (!nativeCodexTransportCompatible(connection) || !resolveNativeCodexBinary())
      const settings = loadBackendFrameworkConfiguration(runtime)
      const profile = getConfiguredAgentFrameworkProfile(compatibility ? 'pi' : runtime, settings, true)
      return { runtime, name: getAgentPluginDescriptor(runtime)?.name ?? runtime,
        execution: compatibility ? 'Pi compatibility loop' : 'native framework loop',
        strengths: profile?.strengths, suitableTasks: profile?.suitableTasks,
        limitations: [...(profile?.limitations ?? []), ...(compatibility ? ['Native Codex features are unavailable on this connection'] : [])],
        features: settings?.features, nativeOptions: settings?.nativeOptions, assignedSkills: node.skillSlugs ?? [], skillsDelivery: 'TokenBird node system instructions',
        ...(runtime === 'codex' && !compatibility ? { toolExecution: 'TokenBird policy-enforced host tools; no native execution environment' } : {}) }
    },
    describeNodeSkills: (workspaceId, config, node) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error('Workspace not found')
      const available = loadAllSkills(workspace.rootPath, config.environment.workingDirectory)
      return [...new Set([SUPER_AGENT_COLLABORATION_SKILL, ...(node.skillSlugs ?? [])])].flatMap(slug => {
        const skill = available.find(skill => skill.slug === slug)
        return skill ? [{ slug, name: skill.metadata.name, description: skill.metadata.description }] : []
      })
    },
    resolveNodeSkills: (workspaceId, config, node) => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error('Workspace not found')
      return [...new Set([SUPER_AGENT_COLLABORATION_SKILL, ...(node.skillSlugs ?? [])])].map(slug => {
        const skill = loadSkillBySlug(workspace.rootPath, slug, config.environment.workingDirectory)
        if (!skill) throw new Error(`Skill not found: ${slug}`)
        return { slug, content: skill.content }
      })
    },
    host: {
      createSession: async (workspaceId, options, internal) => {
        const workspace = getWorkspaceByNameOrId(workspaceId)
        if (internal?.resourceScope && workspace) await resources.initialize(workspace.rootPath)
        return host.createSession(workspaceId, options, internal)
      },
      getSession: sessionId => host.getSession(sessionId),
      getSessions: workspaceId => host.getSessions(workspaceId),
      getSuperAgentSessionIds: (workspaceId, nodeId) => host.getSuperAgentSessionIds?.(workspaceId, nodeId) ?? [],
      deleteSession: (sessionId, guard) => host.deleteSession(sessionId, guard),
      sendMessage: (sessionId, message, context, hidden) => host.sendMessage(sessionId, message, undefined, undefined, { collaborationDispatch: true, superAgentContext: context, hidden }),
      cancelProcessing: (sessionId, silent) => host.cancelProcessing(sessionId, silent),
      onSessionComplete: listener => host.onSessionComplete(listener),
      onSessionEvent: listener => host.onSessionEvent(listener),
      respondToPermission: (sessionId, requestId, allowed, alwaysAllow) => host.respondToPermission(sessionId, requestId, allowed, alwaysAllow),
      getSessionFinalText: sessionId => host.getSessionFinalText(sessionId),
      ensureSuperAgentSessionSettings: (sessionId, settings) => host.ensureSuperAgentSessionSettings(sessionId, settings),
      setSessionThinkingLevel: (sessionId, level) => host.setSessionThinkingLevel(sessionId, level),
      setSuperAgentFullControl: (workspaceId, fullControl) => host.setSuperAgentFullControl(workspaceId, fullControl),
      clearSuperAgentPermissionGrants: workspaceId => host.clearSuperAgentPermissionGrants(workspaceId),
      applySessionPolicy: async (sessionId, policy) => {
        if (!host.applySessionPolicy) throw new Error('This host does not support Super Agent execution policies')
        const session = await host.getSession(sessionId)
        if (!session) throw new Error('Node session not found')
        const environment = environmentConfigs.get(session.workspaceId)
        if (!environment) throw new Error('Node environment has not been validated')
        const executor = await environments.prepareSession(session.workspaceId, environment, policy)
        await host.applySessionPolicy(sessionId, { ...policy, ...(policy.resourceScope === 'super-agent' ? { skillWorkspaceRootPath: getWorkspaceByNameOrId(session.workspaceId)?.rootPath } : {}), containerExecutor: executor })
        setSessionOperationRecorder(sessionId, request => service.prepareNodeOperation(session.workspaceId, sessionId, request))
      },
    },
    rootForWorkspace: workspaceId => {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (!workspace) throw new Error('Workspace not found')
      if (workspace.id !== workspaceId) throw new Error('Use the canonical workspace ID for Super Agent')
      return workspace.rootPath
    },
    checkReadiness: async (workspaceId, config, force) => {
      await validateExecutionRoot(workspaceId, config.environment)
      return environments.checkReadiness(workspaceId, config, host.hasSuperAgentBrowserSupport?.(workspaceId) === true, force)
    },
    validateConfig: validateSuperAgentCatalog,
    onReset: async workspaceId => {
      environmentConfigs.delete(workspaceId)
      await environments.reconcile(workspaceId, null)
    },
    onConfigChanged: async workspaceId => {
      const current = (await service.get(workspaceId)).config
      if (current) {
        await environments.reconcile(workspaceId, current)
        if (current.architecture === 'dynamic') {
          const workspace = getWorkspaceByNameOrId(workspaceId)
          if (workspace) { const scope = await resources.initialize(workspace.rootPath); host.setupConfigWatcher(scope.rootPath, workspaceId) }
        }
      }
    },
    resolveEnvironment: async (workspaceId, environment) => {
      await validateExecutionRoot(workspaceId, environment)
      environmentConfigs.set(workspaceId, environment)
      return environments.resolve(workspaceId, environment)
    },
    spawnScript: async ({ workspaceId, environment, script, path, approvedContent }) => {
      if (environment.kind === 'sandbox') return environments.spawnScript(workspaceId, environment, path, script.args, approvedContent)
      // A VM workspace's server is already inside the chosen VM. Reuse its OS
      // executor only after the environment adapter has verified that host mode.
      const resolved = await environments.resolve(workspaceId, environment)
      if (!resolved.status.available || (environment.kind !== 'folder' && resolved.status.isolation !== 'remote-vm')) throw new Error(resolved.status.detail)
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
    try { await access(join(workspace.rootPath, 'super-agent', 'state.json')) }
    catch { try { await access(join(workspace.rootPath, 'super-agent', 'commit.json')) } catch { continue } }
    try {
      const snapshot = await service.get(workspace.id)
      if (snapshot.config?.architecture === 'dynamic') {
        const scope = await new SuperAgentResourceStore().initialize(workspace.rootPath)
        host.setupConfigWatcher(scope.rootPath, workspace.id)
      }
    } catch (error) { onError(error) }
  }
}

export async function cleanupSuperAgents(host: ISessionManager): Promise<void> {
  closedHosts.add(host)
  const entry = services.get(host)
  if (!entry) return
  services.delete(host)
  try { await entry.service.cleanup() } finally { await entry.environments.cleanup() }
}
