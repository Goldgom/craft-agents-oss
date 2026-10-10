import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SESSION_TOOL_REGISTRY } from '@craft-agent/session-tools-core';
import type { BaseAgent } from '../agent/base-agent.ts';
import type { BackendConfig } from '../agent/backend/types.ts';
import { createClaudeContext, type SessionToolContext } from '../agent/claude-context.ts';
import { attachSessionSelfManagementBindings } from '../agent/session-self-management-bindings.ts';
import { getSessionScopedToolCallbacks, setLastPlanFilePath } from '../agent/session-scoped-tools.ts';
import { runPreToolUseChecksWithPermissions } from '../agent/core/pre-tool-use.ts';
import { executeBrowserToolCommand } from '../agent/browser-tool-runtime.ts';
import { getSessionDataPath, getSessionPlansPath, getSessionPath } from '../sessions/storage.ts';
import { saveBinaryResponse } from '../utils/binary-detection.ts';
import { extractWorkspaceSlug } from '../utils/workspace.ts';
import { executeLocalAgentHostTool } from './local-tools.ts';

export interface HostToolResult { content: string; isError: boolean }

/** Composition service: native agent bridges call the same host policy and tools. */
export class AgentPluginHostTools {
  private permissions = new Map<string, { resolve: (allowed: boolean) => void; timer: ReturnType<typeof setTimeout>; command?: string }>();
  private context?: SessionToolContext;
  private generation = 0;
  private executionController = new AbortController();

  constructor(private owner: BaseAgent, private config: BackendConfig, private sessionId: string,
    private intercept: (name: string, input: Record<string, unknown>) => Promise<HostToolResult | undefined>) {}

  respondToPermission(id: string, allowed: boolean, alwaysAllow = false): void {
    const pending = this.permissions.get(id);
    if (!pending) return;
    if (allowed && alwaysAllow && pending.command) {
      const manager = this.owner.getPermissionManager();
      const base = manager.getBaseCommand(pending.command);
      if (['curl', 'wget'].includes(base)) {
        const domain = manager.extractDomainFromNetworkCommand(pending.command);
        if (domain) manager.whitelistDomain(domain);
      } else if (!manager.isDangerousCommand(base)) manager.whitelistCommand(base);
    }
    this.permissions.delete(id); clearTimeout(pending.timer); pending.resolve(allowed);
  }

  cancel(): void {
    this.generation++; this.executionController.abort(); this.executionController = new AbortController();
    for (const id of this.permissions.keys()) this.respondToPermission(id, false);
  }

  async authorize(toolName: string, input: Record<string, unknown>): Promise<{ allowed: boolean; input: Record<string, unknown>; reason?: string }> {
    const generation = this.generation;
    const root = this.config.workspace.rootPath;
    const run = () => runPreToolUseChecksWithPermissions({
      toolName, input, sessionId: this.sessionId, permissionMode: this.owner.getPermissionMode(),
      workspaceRootPath: root, workspaceId: extractWorkspaceSlug(root, this.config.workspace.id),
      plansFolderPath: getSessionPlansPath(root, this.sessionId), dataFolderPath: getSessionDataPath(root, this.sessionId),
      workingDirectory: this.config.session?.workingDirectory ?? root,
      activeSourceSlugs: this.owner.getActiveSourceSlugs(), allSourceSlugs: this.owner.getAllSources().map(source => source.config.slug),
      hasSourceActivation: !!this.owner.onSourceActivationRequest,
      permissionManager: this.owner.getPermissionManager(), prerequisiteManager: this.owner.getPrerequisiteManager(),
    });
    let checked = await run();
    if (checked.type === 'source_activation_needed') {
      if (!await this.owner.onSourceActivationRequest?.(checked.sourceSlug)) return { allowed: false, input, reason: 'Source is not active' };
      checked = await run();
    }
    if (generation !== this.generation) return { allowed: false, input, reason: 'Agent turn was stopped' };
    if (checked.type === 'block') return { allowed: false, input, reason: checked.reason };
    if (checked.type === 'prompt') {
      // A detached/headless client must never turn a missing approval UI into permission.
      if (!this.owner.onPermissionRequest) return { allowed: false, input, reason: 'Approval UI is unavailable' };
      const id = `plugin-permission-${randomUUID()}`;
      const allowed = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => this.respondToPermission(id, false), 300_000);
        this.permissions.set(id, { resolve, timer, command: checked.type === 'prompt' ? checked.command : undefined });
        try {
          this.owner.onPermissionRequest!({ requestId: id, toolName, command: checked.type === 'prompt' ? checked.command : undefined,
            description: checked.type === 'prompt' ? checked.description : toolName,
            type: checked.type === 'prompt' ? checked.promptType : undefined,
            ...(checked.type === 'prompt' ? { appName: checked.appName, reason: checked.reason, impact: checked.impact,
              requiresSystemPrompt: checked.requiresSystemPrompt, rememberForMinutes: checked.rememberForMinutes,
              commandHash: checked.commandHash, approvalTtlSeconds: checked.approvalTtlSeconds } : {}) });
        } catch { this.respondToPermission(id, false); }
      });
      return { allowed: allowed && generation === this.generation, input: checked.modifiedInput ?? input,
        reason: generation !== this.generation ? 'Agent turn was stopped' : allowed ? undefined : 'Permission denied' };
    }
    return { allowed: true, input: 'input' in checked ? checked.input : input };
  }

  async execute(toolName: string, input: Record<string, unknown>): Promise<HostToolResult> {
    const generation = this.generation;
    const signal = this.executionController.signal;
    const authorization = await this.authorize(toolName, input);
    if (generation !== this.generation) return { content: 'Agent turn was stopped', isError: true };
    if (!authorization.allowed) return { content: authorization.reason ?? 'Permission denied', isError: true };
    const args = authorization.input;
    if (toolName === 'Read') {
      if (typeof args.file_path !== 'string') return { content: 'Read requires file_path', isError: true };
      const path = resolve(this.config.session?.workingDirectory ?? this.config.workspace.rootPath, args.file_path);
      const info = await stat(path);
      if (!info.isFile() || info.size > 512 * 1024) return { content: 'Read supports text files up to 512 KB', isError: true };
      const content = await readFile(path, 'utf8');
      if (content.includes('\0')) return { content: 'Read requires a text file', isError: true };
      this.owner.getPrerequisiteManager().trackReadTool({ file_path: path });
      return { content, isError: false };
    }
    const local = await executeLocalAgentHostTool(toolName, args,
      this.config.session?.workingDirectory ?? this.config.workspace.rootPath, signal);
    if (local) return local;
    const name = toolName.replace(/^mcp__session__/, '');
    const intercepted = await this.intercept(name, args);
    if (intercepted) return intercepted;
    if (name === 'browser_tool') {
      const fns = getSessionScopedToolCallbacks(this.sessionId)?.browserPaneFns;
      if (!fns) return { content: 'Browser controls require the desktop app', isError: true };
      const result = await executeBrowserToolCommand({ command: (args.command as string | string[]) ?? '', fns, sessionId: this.sessionId });
      let content = result.output;
      if (result.image) {
        const saved = saveBinaryResponse(getSessionPath(this.config.workspace.rootPath, this.sessionId), 'plugin-browser-screenshot.png',
          Buffer.from(result.image.data, 'base64'), result.image.mimeType);
        if (saved.type === 'file_download') content += `\nSaved screenshot: ${saved.path}`;
      }
      return { content, isError: false };
    }
    const definition = SESSION_TOOL_REGISTRY.get(name);
    if (definition?.handler) {
      this.context ??= createClaudeContext({ sessionId: this.sessionId, workspacePath: this.config.workspace.rootPath,
        workspaceId: this.config.workspace.id, onPlanSubmitted: path => { setLastPlanFilePath(this.sessionId, path); this.owner.onPlanSubmitted?.(path); },
        onAuthRequest: request => this.owner.onAuthRequest?.(request as never) });
      attachSessionSelfManagementBindings(this.context, this.sessionId);
      const result = await definition.handler(this.context, args);
      return { content: result.content.map(block => block.text).join('\n'), isError: !!result.isError };
    }
    if (this.config.mcpPool?.isProxyTool(toolName)) return this.config.mcpPool.callTool(toolName, args);
    return { content: `Unknown host tool: ${toolName}`, isError: true };
  }
}
