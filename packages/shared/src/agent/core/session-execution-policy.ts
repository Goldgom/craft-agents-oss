import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { expandPath } from '../../utils/paths.ts';
import type { SuperAgentSessionPolicy } from '../../super-agent/types.ts';
import type { SessionPolicyPermissionScope } from '@craft-agent/core/types';
import { isReadOnlySystemInspection } from './system-inspection-policy.ts';
import { classifyActionGate, type ActionReview, type ActionReviewRequest } from './action-gates.ts';

export interface SessionProgramExecutor {
  runtimePath: string;
  containerId: string;
  workingDirectory: '/workspace';
}

/** Persist the grants, never a stale container handle. The runtime reattaches executors. */
export type SessionExecutionPolicy = Omit<SuperAgentSessionPolicy, 'containerExecutor'>;

export interface SessionPolicyPermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
  scope: SessionPolicyPermissionScope;
}

type OperationGrant = { key: string; pathIdentity: string; scope: SessionPolicyPermissionScope };
type RegisteredPolicy = {
  policy: SessionExecutionPolicy | null;
  executor?: SessionProgramExecutor;
  referenceFiles?: Set<string>;
  requestPermission?: (request: SessionPolicyPermissionRequest) => Promise<boolean>;
  grants?: Map<string, OperationGrant>;
  generation?: number;
  reviewAction?: (request: ActionReviewRequest) => Promise<ActionReview>;
  gates?: Map<string, { key: string; pathIdentity: string; generation: number | undefined; expiresAt: number; dispatched: boolean; executed?: boolean }>;
  recordOperation?: (request: { toolName: string; input: Record<string, unknown>; invocationId: string }) => Promise<void>;
};
const policies = new Map<string, RegisteredPolicy>();

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function normalizeSessionExecutionPolicy(input: SessionExecutionPolicy): SessionExecutionPolicy {
  if (!input || typeof input.nodeId !== 'string' || !input.nodeId.trim()
    || !['coordinator', 'orchestrator', 'worker'].includes(input.role)
    || typeof input.rootPath !== 'string' || !isAbsolute(input.rootPath)
    || input.allowSubagents !== false
    || (input.fullControl !== undefined && typeof input.fullControl !== 'boolean')
    || (input.actionGates !== undefined && input.actionGates !== true)
    || (input.protectedRoots !== undefined && (!Array.isArray(input.protectedRoots) || input.protectedRoots.length > 16 || input.protectedRoots.some(path => typeof path !== 'string' || !isAbsolute(path))))
    || (input.userIntent !== undefined && (typeof input.userIntent !== 'string' || input.userIntent.length > 64_000))
    || (input.safety !== undefined && (!input.safety || typeof input.safety.autoReview !== 'boolean' || !Array.isArray(input.safety.customRules)
      || input.safety.customRules.length > 100 || input.safety.customRules.some(rule => !rule || typeof rule.toolName !== 'string' || !rule.toolName.trim()
        || rule.toolName.length > 200 || !['deny', 'require-human'].includes(rule.effect) || typeof rule.reason !== 'string' || !rule.reason.trim() || rule.reason.length > 2_000)))
    || !Array.isArray(input.allowSources) || input.allowSources.some(slug => typeof slug !== 'string' || !slug.trim())
    || ['readFiles', 'writeFiles', 'runPrograms', 'browser'].some(key => typeof input[key as keyof SessionExecutionPolicy] !== 'boolean')) {
    throw new Error('Invalid Super Agent execution policy');
  }
  const rootPath = realpathSync(input.rootPath);
  if (!statSync(rootPath).isDirectory()) throw new Error('Super Agent environment must be an existing directory');
  if (input.actionGates) for (const path of input.protectedRoots ?? []) {
    let ancestor = resolve(path);
    const missing: string[] = [];
    while (!statExists(ancestor)) { if (dirname(ancestor) === ancestor) throw new Error('Cannot verify protected control directory'); missing.unshift(basename(ancestor)); ancestor = dirname(ancestor); }
    const protectedRoot = resolve(realpathSync(ancestor), ...missing);
    if (contained(rootPath, protectedRoot) || contained(protectedRoot, rootPath)) throw new Error('Worker environment overlaps protected control or credential data');
  }
  return Object.freeze({
    nodeId: input.nodeId,
    role: input.role,
    rootPath,
    fullControl: input.role === 'worker' && input.fullControl === true,
    ...(input.actionGates ? { actionGates: true as const, userIntent: input.userIntent ?? '', safety: Object.freeze({
      autoReview: input.safety?.autoReview === true,
      customRules: Object.freeze((input.safety?.customRules ?? []).map(rule => Object.freeze({ ...rule }))) as unknown as NonNullable<SessionExecutionPolicy['safety']>['customRules'],
    }) } : {}),
    ...(input.protectedRoots ? { protectedRoots: Object.freeze([...input.protectedRoots]) as unknown as string[] } : {}),
    // Keep the configured ceilings so turning full control off restores them.
    readFiles: input.role === 'worker' && input.readFiles,
    writeFiles: input.role === 'worker' && input.writeFiles,
    runPrograms: input.role === 'worker' && input.runPrograms,
    browser: input.role === 'worker' && input.browser,
    allowSources: Object.freeze(input.role === 'worker' ? [...new Set(input.allowSources)] : []) as unknown as string[],
    allowSubagents: false,
  });
}

function statExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** Invalid persisted policies remain registered as denied, rather than becoming unrestricted. */
export function setSessionExecutionPolicy(sessionId: string, input: SessionExecutionPolicy): SessionExecutionPolicy {
  const existing = policies.get(sessionId);
  policies.set(sessionId, { policy: null });
  const policy = normalizeSessionExecutionPolicy(input);
  const unchanged = JSON.stringify(existing?.policy) === JSON.stringify(policy);
  policies.set(sessionId, {
    policy, executor: unchanged ? existing?.executor : undefined,
    referenceFiles: unchanged ? existing?.referenceFiles : undefined,
    requestPermission: existing?.requestPermission,
    reviewAction: existing?.reviewAction,
    recordOperation: existing?.recordOperation,
    generation: (existing?.generation ?? 0) + 1,
  });
  return policy;
}

export function setSessionProgramExecutor(sessionId: string, executor?: { runtimePath: string; containerId: string; workingDirectory: string }): void {
  const registered = policies.get(sessionId);
  if (!registered?.policy) throw new Error('Apply a valid session policy before attaching a program executor');
  clearSessionPolicyGrants(sessionId);
  registered.executor = undefined;
  if (!executor) return;
  if (!isAbsolute(executor.runtimePath) || !/^(docker|podman)(\.exe)?$/i.test(basename(executor.runtimePath))
    || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(executor.containerId)
    || executor.workingDirectory !== '/workspace' || !statSync(executor.runtimePath).isFile()) {
    throw new Error('Invalid verified container executor');
  }
  registered.executor = Object.freeze({ ...executor, runtimePath: realpathSync(executor.runtimePath), workingDirectory: '/workspace' });
}

export function getSessionExecutionPolicy(sessionId: string): SessionExecutionPolicy | null | undefined {
  return policies.get(sessionId)?.policy;
}

export function hasSessionExecutionPolicy(sessionId: string): boolean { return policies.has(sessionId); }
export function hasSessionFullControl(sessionId: string): boolean { return policies.get(sessionId)?.policy?.fullControl === true; }
export function getSessionProgramExecutor(sessionId: string): SessionProgramExecutor | undefined { return policies.get(sessionId)?.executor; }
export function clearSessionExecutionPolicy(sessionId: string): void { policies.delete(sessionId); }

export function setSessionPolicyPermissionHandler(sessionId: string, handler: (request: SessionPolicyPermissionRequest) => Promise<boolean>): void {
  const registered = policies.get(sessionId);
  if (!registered?.policy) throw new Error('Apply a valid node policy before attaching a permission handler');
  registered.requestPermission = handler;
}

export function setSessionActionReviewer(sessionId: string, reviewer: (request: ActionReviewRequest) => Promise<ActionReview>): void {
  const registered = policies.get(sessionId);
  if (!registered?.policy) throw new Error('Apply a valid policy before attaching the independent reviewer');
  registered.reviewAction = reviewer;
}
export function setSessionOperationRecorder(sessionId: string, recorder: NonNullable<RegisteredPolicy['recordOperation']>): void {
  const registered = policies.get(sessionId);
  if (!registered?.policy) throw new Error('Apply a valid policy before attaching operation persistence');
  registered.recordOperation = recorder;
}
export async function recordSessionPolicyOperation(sessionId: string, toolName: string, input: Record<string, unknown>, invocationId?: string): Promise<void> {
  const registered = policies.get(sessionId);
  if (!registered?.recordOperation || classifyActionGate(toolName, input) === undefined) return;
  if (!invocationId) throw new Error('A durable operation requires a provider invocation ID');
  await registered.recordOperation({ toolName, input, invocationId });
}

export function requiresSessionOperationRecording(sessionId: string, toolName: string, input: Record<string, unknown>): boolean {
  return !!policies.get(sessionId)?.recordOperation && classifyActionGate(toolName, input) !== undefined;
}

/** Exceptions never survive a model turn, cancellation, policy change or restart. */
export function clearSessionPolicyGrants(sessionId: string): void {
  const registered = policies.get(sessionId);
  if (!registered) return;
  registered.grants?.clear();
  registered.gates?.clear();
  registered.generation = (registered.generation ?? 0) + 1;
}

/** Host-selected source/browser instruction files are a separate, exact, read-only grant. */
export function setSessionReferenceFiles(sessionId: string, paths: string[]): void {
  const registered = policies.get(sessionId);
  if (!registered?.policy) return;
  const verified = new Set<string>();
  for (const path of paths) {
    try {
      const normalized = resolve(expandPath(path));
      if (!isAbsolute(path) || !/\.md$/i.test(path) || lstatSync(path).isSymbolicLink() || realpathSync(path) !== normalized) continue;
      const info = statSync(path);
      if (info.isFile() && info.size <= 1_000_000) verified.add(normalized);
    } catch { /* A missing or unverified guide never widens filesystem access. */ }
  }
  registered.referenceFiles = verified;
}

/** Resolve missing write targets through their nearest existing parent, including junctions. */
export function checkSessionPolicyPath(policy: SessionExecutionPolicy, value: string, cwd?: string, scanDirectory = false): string | null {
  if (policy.fullControl === true && !policy.actionGates) return null;
  try {
    if (!value || value.includes('\0') || /^(?:[a-z]+:\/\/|\\\\)/i.test(value)
      || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) return 'Unsupported filesystem path';
    const expanded = expandPath(value, cwd || policy.rootPath);
    const path = resolve(cwd || policy.rootPath, expanded);
    const root = realpathSync(policy.rootPath);
    if (root !== policy.rootPath || !contained(root, path)) return 'Path is outside the node environment';
    let ancestor = path;
    const missing: string[] = [];
    while (true) {
      try { lstatSync(ancestor); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (dirname(ancestor) === ancestor) throw error;
        missing.unshift(basename(ancestor));
        ancestor = dirname(ancestor);
      }
    }
    const canonical = resolve(realpathSync(ancestor), ...missing);
    if (!contained(root, canonical)) return 'Symlink or junction escapes the node environment';
    if (scanDirectory && missing.length === 0 && statSync(canonical).isDirectory()) {
      const pending = [canonical];
      let count = 0;
      while (pending.length) {
        const directory = pending.pop()!;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (++count > 50_000) return 'Directory is too large to verify safely; select a narrower path';
          const child = join(directory, entry.name);
          if (entry.isSymbolicLink()) {
            // Search implementations differ in link traversal; reject all directory links.
            if (!contained(root, realpathSync(child)) || statSync(child).isDirectory()) return 'Search path contains an unverified symbolic link';
          } else if (entry.isDirectory()) pending.push(child);
        }
      }
    }
    return null;
  } catch { return 'Filesystem path could not be verified safely'; }
}

export type SessionPolicyToolResult = { allowed: true } | { allowed: false; reason: string };
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'find', 'ls']);
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit']);
const PURE_TOOLS = new Set(['todowrite', 'taskoutput', 'askuserquestion', 'mermaid_validate', 'get_session_info']);
const DELEGATION_TOOLS = new Set(['task', 'agent', 'spawn_agent', 'spawn_session', 'delegate', 'call_llm', 'create_task']);
const BROWSER_COMMANDS = new Set(['--help', 'open', 'navigate', 'snapshot', 'find', 'click', 'click-at', 'drag', 'fill', 'type', 'select', 'screenshot', 'screenshot-region', 'console', 'network', 'wait', 'key', 'scroll', 'back', 'forward', 'focus', 'windows', 'release', 'close', 'hide', 'window-resize', 'upload']);

function deny(reason: string): SessionPolicyToolResult { return { allowed: false, reason: `Super Agent policy: ${reason}` }; }

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function operationInput(policy: SessionExecutionPolicy, toolName: string, input: Record<string, unknown>, cwd?: string): Record<string, unknown> {
  const output = { ...input };
  delete output._intent; delete output._displayName;
  const name = toolName.split('__').at(-1)!.toLowerCase().replace(/_/g, '');
  if (toolName.startsWith('mcp__') && !toolName.startsWith('mcp__session__')) return output;
  if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
    for (const field of ['file_path', 'path', 'notebook_path']) if (typeof output[field] === 'string') output[field] = resolve(expandPath(output[field] as string, cwd || policy.rootPath));
    if (!output.file_path && !output.path && !output.notebook_path) output.path = cwd || policy.rootPath;
  }
  if (['bash', 'localbash', 'runshell'].includes(name)) output.cwd = typeof output.cwd === 'string'
    ? resolve(expandPath(output.cwd, cwd || policy.rootPath)) : cwd || policy.rootPath;
  return output;
}

function operationKey(policy: SessionExecutionPolicy, toolName: string, input: Record<string, unknown>, cwd?: string): string {
  return canonicalJson([toolName.toLowerCase(), operationInput(policy, toolName, input, cwd)]);
}

/** Bind filesystem approvals to canonical ancestors as well as the literal operation. */
function operationPathIdentity(policy: SessionExecutionPolicy, toolName: string, input: Record<string, unknown>, cwd?: string): string | undefined {
  if (toolName.startsWith('mcp__') && !toolName.startsWith('mcp__session__')) return '[]';
  const normalized = operationInput(policy, toolName, input, cwd);
  const paths = [normalized.file_path, normalized.path, normalized.notebook_path, normalized.cwd].filter(value => typeof value === 'string') as string[];
  try {
    return canonicalJson(paths.map(path => {
      if (path.includes('\0') || /^(?:[a-z]+:\/\/|\\\\)/i.test(path)) throw new Error('Invalid path');
      let ancestor = path;
      const missing: string[] = [];
      while (true) {
        try { lstatSync(ancestor); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
          missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
        }
      }
      const canonical = resolve(realpathSync(ancestor), ...missing);
      if (relative(canonical, path) !== '') throw new Error('Linked paths require a canonical path');
      // Creating a previously missing target is allowed; replacing it with an escaping link is not.
      return canonical;
    }));
  } catch { return undefined; }
}

function getOperationGrant(sessionId: string, toolName: string, input: Record<string, unknown>, cwd?: string): OperationGrant | undefined {
  const registered = policies.get(sessionId);
  if (!registered?.policy || !input || typeof input !== 'object' || Array.isArray(input)) return;
  const key = operationKey(registered.policy, toolName, input, cwd);
  const grant = registered.grants?.get(key);
  if (!grant || grant.scope.expiresAt <= Date.now() || grant.pathIdentity !== operationPathIdentity(registered.policy, toolName, input, cwd)) {
    registered.grants?.delete(key);
    return;
  }
  return grant;
}

export function getSessionPolicyGrantTarget(sessionId: string, toolName: string, input: Record<string, unknown>, cwd?: string): string | undefined {
  return getOperationGrant(sessionId, toolName, input, cwd)?.scope.target;
}

export function hasSessionPolicyToolGrant(sessionId: string, toolName: string, input: Record<string, unknown>, cwd?: string): boolean {
  return !!getOperationGrant(sessionId, toolName, input, cwd);
}

function shellAutoAllowed(registered: RegisteredPolicy, toolName: string, input: Record<string, unknown>, cwd?: string): boolean {
  if (!registered.policy || registered.policy.role !== 'worker' || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  const parts = toolName.split('__');
  const name = parts.at(-1)!.toLowerCase().replace(/_/g, '');
  if (!['bash', 'localbash', 'runshell'].includes(name) || (parts.length >= 3 && parts[1] !== 'session')
    || typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0')
    || (input.cwd !== undefined && typeof input.cwd !== 'string')) return false;
  // A safe command name is not proof of the host executable it resolves to (PATH/cwd hijacking).
  if (registered.policy.actionGates && (!registered.executor || name !== 'bash')) return false;
  if (registered.policy.fullControl === true && !registered.policy.actionGates) return true;
  if (registered.policy.role !== 'worker' || (!registered.policy.readFiles && !registered.policy.fullControl) || input.run_in_background || input.background) return false;
  // Do not silently move a sandbox inspection onto the host or client.
  if (registered.executor && name !== 'bash') return false;
  if (typeof input.cwd === 'string' && checkSessionPolicyPath(registered.policy, input.cwd, cwd)) return false;
  return isReadOnlySystemInspection(input.command, name === 'bash' ? 'posix' : process.platform === 'win32' ? 'cmd' : 'posix');
}

/** Recognizes full-control shells and AST-verified system metadata inspections. */
export function isSessionPolicyShellAutoAllowed(sessionId: string, toolName: string, input: Record<string, unknown>, cwd?: string): boolean {
  const registered = policies.get(sessionId);
  return !!registered && shellAutoAllowed(registered, toolName, input, cwd);
}

/** Only known operations can be requested; delegation and malformed inputs stay blocked. */
function permissionScope(registered: RegisteredPolicy, toolName: string, input: Record<string, unknown>, cwd?: string): SessionPolicyPermissionScope | undefined {
  const policy = registered.policy!;
  const parts = toolName.split('__');
  const canonical = parts.at(-1)!.toLowerCase();
  const name = canonical.replace(/_/g, '');
  const slug = parts.length >= 3 && parts[0] === 'mcp' ? parts[1] : undefined;
  if (slug && slug !== 'session') return;
  if (DELEGATION_TOOLS.has(canonical) || /^(?:spawn|delegate|handoff|callllm|createtask)/.test(name)) return;
  const normalized = operationInput(policy, toolName, input, cwd);
  const expiresAt = Date.now() + 10 * 60_000;
  if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
    const writing = WRITE_TOOLS.has(name);
    if (writing && policy.role !== 'worker') return;
    const paths = [normalized.file_path, normalized.path, normalized.notebook_path].filter(value => value !== undefined);
    if (paths.some(value => typeof value !== 'string') || !paths.length || operationPathIdentity(policy, toolName, input, cwd) === undefined
      || [input.file_path, input.path, input.notebook_path].some(value => typeof value === 'string' && /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value))) return;
    if (typeof input.pattern === 'string' && (isAbsolute(input.pattern) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(input.pattern))) return;
    if (['glob', 'grep', 'find', 'ls'].includes(name)) {
      for (const path of paths as string[]) {
        if (checkSessionPolicyPath({ ...policy, rootPath: path }, path, path, true)) return;
      }
    }
    return { kind: writing ? 'file_write' : 'file_read', target: (paths as string[]).join('\n'), toolName,
      operation: canonicalJson(normalized), boundary: paths.every(path => contained(policy.rootPath, path as string)) ? 'environment' : 'outside-environment', expiresAt };
  }
  if (['bash', 'localbash', 'runshell'].includes(name) && (!slug || slug === 'session')) {
    if (policy.role !== 'worker' || typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0') || input.run_in_background || input.background
      || (input.cwd !== undefined && typeof input.cwd !== 'string') || operationPathIdentity(policy, toolName, input, cwd) === undefined) return;
    return { kind: 'program', target: normalized.cwd as string, toolName, operation: canonicalJson(normalized),
      boundary: name === 'localbash' ? 'client' : registered.executor && name === 'bash' ? 'environment' : 'host', expiresAt };
  }
  if (canonical === 'browser_tool') {
    // Check the same command/path restrictions with just the missing browser flag enabled.
    const original = registered.policy;
    registered.policy = { ...policy, browser: true };
    try {
      if (!checkPolicyRules(registered, toolName, input, cwd).allowed) return;
    } finally { registered.policy = original; }
    return { kind: 'browser', target: 'browser_tool', toolName, operation: canonicalJson(input.command), boundary: 'environment', expiresAt };
  }
  // Unassigned sources need binding/authentication through settings, not an invisible temporary source.
  return;
}

/** Called by provider hooks before the synchronous pipeline, so the original call can wait and resume. */
export async function authorizeSessionPolicyTool(sessionId: string, toolName: string, input: Record<string, unknown>, cwd?: string, deniedReason?: string, invocationId?: string): Promise<SessionPolicyToolResult> {
  const gated = policies.get(sessionId);
  if (gated?.policy?.actionGates && !gated.policy.fullControl) return authorizeActionGate(sessionId, gated, toolName, input, cwd, invocationId);
  const checked = checkSessionExecutionPolicy(sessionId, toolName, input, cwd);
  if (['coordinator', 'orchestrator'].includes(getSessionExecutionPolicy(sessionId)?.role ?? '')) return checked;
  if (hasSessionFullControl(sessionId) || isSessionPolicyShellAutoAllowed(sessionId, toolName, input, cwd)) return checked;
  const result = deniedReason ? deny(deniedReason) : checked;
  if (result.allowed || hasSessionPolicyToolGrant(sessionId, toolName, input, cwd)) return { allowed: true };
  const registered = policies.get(sessionId);
  if (!registered?.policy || !registered.requestPermission || !input || typeof input !== 'object' || Array.isArray(input)) return result;
  const scope = permissionScope(registered, toolName, input, cwd);
  if (!scope) return result;
  const generation = registered.generation;
  const key = operationKey(registered.policy, toolName, input, cwd);
  const pathIdentity = operationPathIdentity(registered.policy, toolName, input, cwd);
  if (pathIdentity === undefined) return result;
  const request = { toolName, input: operationInput(registered.policy, toolName, input, cwd), reason: result.reason, scope };
  let allowed = false;
  try { allowed = await registered.requestPermission(request); } catch { /* Fail closed. */ }
  // A live full-control switch resumes the original call under the current
  // policy rather than trying to install a grant against a stale generation.
  if (allowed && hasSessionFullControl(sessionId)) return checkSessionExecutionPolicy(sessionId, toolName, input, cwd);
  if (!allowed) return deny('permission was denied or expired; report the blocked operation to the main agent');
  if (policies.get(sessionId) !== registered || generation !== registered.generation || scope.expiresAt <= Date.now()
    || pathIdentity !== operationPathIdentity(registered.policy, toolName, input, cwd)) return deny('the operation or node policy changed while awaiting approval; request again');
  registered.grants ??= new Map();
  if (registered.grants.size >= 128) registered.grants.delete(registered.grants.keys().next().value!);
  registered.grants.set(key, { key, pathIdentity, scope: Object.freeze({ ...scope }) });
  return { allowed: true };
}

async function authorizeActionGate(sessionId: string, registered: RegisteredPolicy, toolName: string, input: Record<string, unknown>, cwd?: string, invocationId?: string): Promise<SessionPolicyToolResult> {
  const checked = checkSessionExecutionPolicy(sessionId, toolName, input, cwd, invocationId);
  if (checked.allowed) return checked;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return checked;
  const policy = registered.policy!;
  const ceiling = checkPolicyRules(registered, toolName, input, cwd);
  if (!ceiling.allowed) return ceiling;
  const rules = policy.safety?.customRules.filter(rule => rule.toolName.toLowerCase() === toolName.toLowerCase()) ?? [];
  if (rules.some(rule => rule.effect === 'deny')) return checked;
  if (!invocationId || invocationId.length > 300 || registered.gates?.has(invocationId) || !registered.requestPermission) return checked;
  if ((registered.gates?.size ?? 0) >= 1_024) return deny('too many gated invocations in this turn');
  const key = operationKey(policy, toolName, input, cwd);
  const pathIdentity = operationPathIdentity(policy, toolName, input, cwd);
  if (pathIdentity === undefined) return deny('the operation path cannot be verified');
  const category = classifyActionGate(toolName, input) ?? 'unknown';
  const expiresAt = Date.now() + 10 * 60_000;
  const lease = { key, pathIdentity, generation: registered.generation, expiresAt, dispatched: true };
  registered.gates ??= new Map();
  registered.gates.set(invocationId, lease); // Pending/denied IDs cannot be replayed or raced.
  const normalized = JSON.parse(canonicalJson(operationInput(policy, toolName, input, cwd))) as Record<string, unknown>;
  const name = toolName.toLowerCase().split('__').at(-1)!;
  const scope: SessionPolicyPermissionScope = {
    kind: WRITE_TOOLS.has(name.replace(/_/g, '')) ? 'file_write' : READ_TOOLS.has(name) ? 'file_read'
      : ['bash', 'localbash', 'runshell'].includes(name.replace(/_/g, '')) ? 'program' : name === 'browser_tool' ? 'browser' : 'source',
    target: String(normalized.file_path ?? normalized.path ?? normalized.cwd ?? toolName),
    toolName, operation: canonicalJson(normalized), boundary: toolName.startsWith('mcp__') && !toolName.startsWith('mcp__session__') ? 'source' : 'environment',
    expiresAt, actionGate: { invocationId, category },
  };
  const current = () => policies.get(sessionId) === registered && registered.policy === policy && registered.generation === lease.generation
    && registered.gates?.get(invocationId) === lease && expiresAt > Date.now()
    && key === operationKey(policy, toolName, input, cwd) && pathIdentity === operationPathIdentity(policy, toolName, input, cwd)
    && checkPolicyRules(registered, toolName, input, cwd).allowed;
  if (policy.safety?.autoReview) {
    let review: ActionReview = { verdict: 'unavailable', reason: 'Independent reviewer is unavailable; human review is required.' };
    try { if (registered.reviewAction) review = await registered.reviewAction({ toolName, operation: scope.operation, category, userIntent: policy.userIntent ?? '', customRules: policy.safety.customRules }); } catch { /* Human review remains mandatory. */ }
    if (!['consistent', 'needs-human', 'deny', 'unavailable'].includes(review?.verdict) || typeof review.reason !== 'string') review = { verdict: 'unavailable', reason: 'Invalid independent review; human review is required.' };
    scope.actionGate!.review = { verdict: review.verdict, reason: review.reason.slice(0, 2_000) };
    if (hasSessionFullControl(sessionId)) return checkSessionExecutionPolicy(sessionId, toolName, input, cwd);
    if (!current()) return deny('the operation or node policy changed during independent review');
    if (review.verdict === 'deny') return deny(`independent review rejected the action: ${review.reason.slice(0, 2_000)}`);
  }
  let approved = false;
  try { approved = await registered.requestPermission({ toolName, input: normalized,
    reason: `Action Gate (${category}): human approval is required for this invocation.${rules.map(rule => ` ${rule.reason}`).join('')}${scope.actionGate!.review ? ` Independent review: ${scope.actionGate!.review.reason}` : ''}`, scope }); } catch { /* Fail closed. */ }
  if (approved && hasSessionFullControl(sessionId)) return checkSessionExecutionPolicy(sessionId, toolName, input, cwd);
  if (!approved) return deny('Action Gate was denied, cancelled or expired');
  if (!current()) return deny('the operation or node policy changed while awaiting approval; request again');
  lease.dispatched = false;
  return checkSessionExecutionPolicy(sessionId, toolName, input, cwd, invocationId);
}

/** Consume exactly once at the last provider dispatch check, after transforms. */
export function consumeSessionActionGate(sessionId: string, toolName: string, input: Record<string, unknown>, cwd?: string, invocationId?: string): SessionPolicyToolResult {
  const checked = checkSessionExecutionPolicy(sessionId, toolName, input, cwd, invocationId);
  if (!checked.allowed) return checked;
  const registered = policies.get(sessionId);
  if (registered?.policy?.actionGates && !registered.policy.fullControl && invocationId) {
    const lease = registered.gates?.get(invocationId);
    if (lease) lease.dispatched = true;
  }
  return checked;
}

/** Pi's proxy dispatch crosses IPC after PreToolUse; validate and consume that dispatch too. */
export function claimSessionActionGateDispatch(sessionId: string, toolName: string, input: Record<string, unknown>, cwd?: string, invocationId?: string): SessionPolicyToolResult {
  const registered = policies.get(sessionId);
  if (!registered?.policy?.actionGates || registered.policy.fullControl) return checkSessionExecutionPolicy(sessionId, toolName, input, cwd);
  const lease = invocationId ? registered.gates?.get(invocationId) : undefined;
  if (!lease) return checkSessionExecutionPolicy(sessionId, toolName, input, cwd);
  if (!lease.dispatched || lease.executed || lease.expiresAt <= Date.now() || lease.generation !== registered.generation
    || lease.key !== operationKey(registered.policy, toolName, input, cwd)
    || lease.pathIdentity !== operationPathIdentity(registered.policy, toolName, input, cwd)) return deny('Action Gate dispatch is missing, changed or already consumed');
  const ceiling = checkPolicyRules(registered, toolName, input, cwd);
  if (!ceiling.allowed) return ceiling;
  lease.executed = true;
  return { allowed: true };
}

/** Runs before mode overrides, source activation, interceptors, automations or input transforms. */
export function checkSessionExecutionPolicy(sessionId: string, toolName: string, input: Record<string, unknown>, cwd?: string, invocationId?: string): SessionPolicyToolResult {
  const registered = policies.get(sessionId);
  if (!registered) return { allowed: true };
  const policy = registered.policy;
  if (!policy) return deny('the persisted execution policy is invalid; configure the node again');
  if (!input || typeof input !== 'object' || Array.isArray(input)) return deny('tool input must be an object');
  if (policy.actionGates) {
    const ceiling = checkPolicyRules(registered, toolName, input, cwd);
    if (!ceiling.allowed) return ceiling;
    const rule = policy.safety?.customRules.find(rule => rule.toolName.toLowerCase() === toolName.toLowerCase() && rule.effect === 'deny');
    if (rule) return deny(`custom rule: ${rule.reason}`);
    // Full control skips every approval and review, while keeping execution boundaries.
    if (policy.fullControl) return { allowed: true };
    const category = classifyActionGate(toolName, input);
    if (category === undefined && !policy.safety?.customRules.some(rule => rule.toolName.toLowerCase() === toolName.toLowerCase())) return { allowed: true };
    const lease = invocationId ? registered.gates?.get(invocationId) : undefined;
    if (!lease || lease.dispatched || lease.expiresAt <= Date.now() || lease.generation !== registered.generation
      || lease.key !== operationKey(policy, toolName, input, cwd) || lease.pathIdentity !== operationPathIdentity(policy, toolName, input, cwd)) return deny('Action Gate requires approval for this exact invocation');
    return { allowed: true };
  }
  if (getOperationGrant(sessionId, toolName, input, cwd)) return { allowed: true };
  return checkPolicyRules(registered, toolName, input, cwd);
}

function checkPolicyRules(registered: RegisteredPolicy, toolName: string, input: Record<string, unknown>, cwd?: string): SessionPolicyToolResult {
  const policy = registered.policy!;
  const parts = toolName.split('__');
  const name = parts[parts.length - 1]!.toLowerCase().replace(/_/g, '');
  const slug = parts.length >= 3 && parts[0] === 'mcp' ? parts[1] : undefined;
  const canonical = parts[parts.length - 1]!.toLowerCase();
  if (canonical === 'computer_use') {
    return deny('Computer use controls the host desktop outside the node environment; restricted nodes cannot access it');
  }
  // The host routes existing team sessions through the durable node scheduler.
  // Messaging never creates a session or bypasses its serial turn queue.
  if (canonical === 'send_agent_message') {
    if (slug && slug !== 'session') return deny('use the session messaging tool for configured team nodes');
    if (typeof input.sessionId !== 'string' || !input.sessionId.trim()
      || typeof input.message !== 'string' || !input.message.trim() || input.message.length > 32_000
      || input.targetMemberId !== undefined || (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length))) {
      return deny('team messaging requires a sessionId and a non-empty message; reference shared files in the message instead of attachments');
    }
    return { allowed: true };
  }
  if (canonical === 'collaboration_board') {
    if (slug && slug !== 'session') return deny('use the session collaboration board for shared team data');
    return input.action === 'get' ? { allowed: true } : deny('Super Agent board writes require a final board action with expectedRevision');
  }
  if (canonical === 'super_agent_task') {
    if (slug !== 'session') return deny('use the session continuity tool');
    return policy.role === 'worker' || input.action === 'get' ? { allowed: true } : deny('only workers may update task checkpoints or artifacts');
  }
  if (policy.role !== 'worker') return deny('the main agent only understands user needs and communicates; assign reading, research, execution and verification to workers');
  if (DELEGATION_TOOLS.has(canonical) || /^(?:spawn|delegate|handoff|callllm|createtask)/.test(name)) return deny('each node uses one model process; spawning, delegation and additional model calls are disabled');
  if (name === 'webfetch' && !slug) return deny('WebFetch can call an additional summarization model; use browser_tool to fetch pages within the node model process');
  if (policy.fullControl === true && !policy.actionGates) {
    if (['bash', 'localbash', 'runshell'].includes(name) && (!slug || slug === 'session')
      && (typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0')
        || (input.cwd !== undefined && typeof input.cwd !== 'string'))) return deny('a valid program command and working directory are required');
    return { allowed: true };
  }
  if (shellAutoAllowed(registered, toolName, input, cwd)) return { allowed: true };
  if (slug && slug !== 'session') {
    if (!policy.allowSources.includes(slug)) return deny(`source "${slug}" is not assigned to this node`);
    if (/browser|playwright|puppeteer|selenium/.test(canonical) && !policy.browser && !policy.fullControl) return deny('browser access is disabled for this node');
    if (/^(?:bash|shell|exec|runshell|localbash)$|^(?:run|exec|execute)[_-]?(?:shell|bash|command|program|python|script|code)/.test(canonical)) return deny('source program execution does not provide a verified sandbox boundary');
    return { allowed: true };
  }
  if (READ_TOOLS.has(name) || WRITE_TOOLS.has(name)) {
    const writing = WRITE_TOOLS.has(name);
    const suppliedPaths = [input.file_path, input.path, input.notebook_path].filter(value => value !== undefined);
    const rawPath = suppliedPaths[0];
    const search = ['glob', 'grep', 'find', 'ls'].includes(name);
    if (suppliedPaths.some(value => typeof value !== 'string')) return deny('filesystem path must be a string');
    if (!rawPath && !search) return deny('a verifiable filesystem path is required');
    // Read only the exact docs registered by the host. Never allow a sibling, directory, link or write.
    if (name === 'read' && suppliedPaths.length && suppliedPaths.every(value => {
      try {
        const raw = value as string;
        if (raw.includes('\0') || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(raw)) return false;
        const path = expandPath(raw, cwd || policy.rootPath);
        return registered.referenceFiles?.has(path) && !lstatSync(path).isSymbolicLink() && realpathSync(path) === path;
      } catch { return false; }
    })) return { allowed: true };
    if (!(policy.fullControl || (writing ? policy.writeFiles : policy.readFiles))) return deny(`${writing ? 'file writing' : 'file reading'} is disabled for this node`);
    for (const path of suppliedPaths.length ? suppliedPaths : [cwd || policy.rootPath]) {
      const error = checkSessionPolicyPath(policy, path as string, cwd, search);
      if (error) return deny(error);
    }
    // Glob patterns can carry their own base path independently of input.path.
    const pattern = input.pattern;
    if (name === 'glob' && typeof pattern === 'string' && (isAbsolute(pattern) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(pattern))) return deny('use a relative glob pattern inside the node environment');
    return { allowed: true };
  }
  if (name === 'bash') {
    if (!policy.runPrograms && !policy.fullControl) return deny('running programs is disabled for this node');
    if (!registered.executor) return deny('running programs requires a verified sandbox executor; a working folder does not isolate host programs');
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0')) return deny('a valid program command is required');
    if (input.run_in_background || input.background) return deny('background program execution is disabled');
    if (input.cwd !== undefined && (typeof input.cwd !== 'string' || checkSessionPolicyPath(policy, input.cwd, cwd))) return deny('program working directory is outside the node environment');
    return { allowed: true };
  }
  if (canonical === 'browser_tool' || canonical.startsWith('browser_') || name === 'websearch' || name === 'webfetch') {
    if (!policy.browser && !policy.fullControl) return deny('browser access is disabled for this node');
    // WebFetch may execute a second summarization model; native aliases lack one auditable command path.
    if (canonical !== 'browser_tool') return deny('use browser_tool for browser access; native fetch and browser aliases are disabled');
    const command = input.command;
    const args = Array.isArray(command) && command.every(value => typeof value === 'string')
      ? command as string[]
      : typeof command === 'string' && !/[;\r\n\\]/.test(command) ? command.match(/"[^"]*"|'[^']*'|\S+/g)?.map(value => value.replace(/^(["'])(.*)\1$/, '$2')) : undefined;
    if (!args?.length || !BROWSER_COMMANDS.has(args[0]!.toLowerCase())) return deny('this browser command is not available to restricted nodes');
    if (args[0]!.toLowerCase() === 'navigate' && !/^https?:\/\//i.test(args[1] || '')) return deny('browser navigation requires an HTTP or HTTPS URL');
    if (args[0]!.toLowerCase() === 'upload') {
      if ((!policy.readFiles && !policy.fullControl) || args.length < 3) return deny('upload requires file reading and a verified path');
      for (const path of args.slice(2)) {
        if (!isAbsolute(path)) return deny('browser uploads require absolute paths inside the node environment');
        const error = checkSessionPolicyPath(policy, path, cwd);
        if (error) return deny(error);
      }
    }
    return { allowed: true };
  }
  if (PURE_TOOLS.has(canonical) || PURE_TOOLS.has(name)) return { allowed: true };
  return deny(`tool "${toolName}" is not part of this node's granted capabilities`);
}

function quotePosix(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

/** Pin SDK-relative file operations to the verified host folder, not SDK transcript cwd. */
export function normalizeSessionPolicyInput(sessionId: string, toolName: string, input: Record<string, unknown>, cwd?: string): Record<string, unknown> | undefined {
  const policy = policies.get(sessionId)?.policy;
  if (!policy) return undefined;
  const name = toolName.split('__').at(-1)!.toLowerCase().replace(/_/g, '');
  if (name === 'localbash' || name === 'runshell') return operationInput(policy, toolName, input, cwd);
  if (!READ_TOOLS.has(name) && !WRITE_TOOLS.has(name)) return undefined;
  const output = { ...input };
  let hasPath = false;
  for (const field of ['file_path', 'path', 'notebook_path']) {
    if (typeof input[field] === 'string') {
      output[field] = expandPath(input[field], cwd || policy.rootPath);
      hasPath = true;
    }
  }
  if (!hasPath) output.path = cwd || policy.rootPath;
  return output;
}

/** Final transform: the model's command becomes one literal argument inside the container. */
export function wrapSessionProgramInput(sessionId: string, toolName: string, input: Record<string, unknown>): Record<string, unknown> | undefined {
  const registered = policies.get(sessionId);
  if (!registered || toolName.toLowerCase() !== 'bash') return undefined;
  const executor = registered.executor;
  if (!executor) {
    if (registered.policy?.actionGates) throw new Error('Action Gate: a verified container is required for all shell execution');
    if (!(hasSessionFullControl(sessionId) || isSessionPolicyShellAutoAllowed(sessionId, toolName, input)
      || hasSessionPolicyToolGrant(sessionId, toolName, input)) || typeof input.command !== 'string') throw new Error('Verified sandbox program executor is unavailable');
    // Full control, verified inspections and exact grants may use the host shell.
    const directory = operationInput(registered.policy!, toolName, input).cwd as string;
    return { ...input, command: `cd -- ${quotePosix(process.platform === 'win32' ? directory.replace(/\\/g, '/') : directory)} && /bin/bash -c ${quotePosix(input.command)}` };
  }
  if (typeof input.command !== 'string') throw new Error('Verified sandbox program executor is unavailable');
  const executable = process.platform === 'win32' ? executor.runtimePath.replace(/\\/g, '/') : executor.runtimePath;
  // Git Bash must pass Linux container paths through to docker.exe unchanged.
  const prefix = process.platform === 'win32' ? "MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' " : '';
  return { ...input, command: prefix + [quotePosix(executable), 'exec', '--workdir', '/workspace', quotePosix(executor.containerId), '/bin/sh', '-lc', quotePosix(input.command)].join(' ') };
}
