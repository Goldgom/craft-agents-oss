import type { SuperAgentEnvironment, SuperAgentNode, SuperAgentPermissionGrant, SuperAgentScript } from './types'
import type { SessionPolicyPermissionScope } from '@craft-agent/core/types'
import { z } from 'zod'

export const SuperAgentPermissionGrantSchema = z.object({
  id: z.string().min(1).max(200), nodeId: z.string().min(1).max(64), description: z.string().max(4_000),
  scope: z.object({
    kind: z.enum(['file_read', 'file_write', 'program']),
    target: z.string().min(1).max(64_000), toolName: z.string().min(1).max(200),
    operation: z.string().min(1).max(64_000),
    boundary: z.enum(['environment', 'outside-environment', 'client', 'host', 'source']),
  }).strict(),
  environmentKey: z.string().min(1).max(16_000), createdAt: z.number().finite().min(0),
}).strict()

export function canShareSuperAgentPermission(scope?: SessionPolicyPermissionScope): boolean {
  return !!scope && !scope.actionGate && ['file_read', 'file_write', 'program'].includes(scope.kind)
}

export function superAgentPermissionEnvironmentKey(environment: SuperAgentEnvironment): string {
  return JSON.stringify([environment.kind, environment.workingDirectory, environment.sandbox?.runtime,
    environment.sandbox?.image, environment.vm?.workspaceId])
}

/** Bind the user Run action to the exact displayed script and execution boundary. */
export function superAgentScriptOperation(environment: SuperAgentEnvironment, script: SuperAgentScript): string {
  return JSON.stringify([superAgentPermissionEnvironmentKey(environment), environment.fullControl === true,
    environment.permissions.readFiles, environment.permissions.writeFiles, environment.permissions.runPrograms, environment.permissions.browser,
    script.id, script.path, script.args, script.nodeId, script.timeoutSeconds])
}

export function matchesSuperAgentPermissionGrant(grant: SuperAgentPermissionGrant, scope: SessionPolicyPermissionScope,
  environment: SuperAgentEnvironment): boolean {
  return canShareSuperAgentPermission(scope) && grant.environmentKey === superAgentPermissionEnvironmentKey(environment)
    && grant.scope.kind === scope.kind && grant.scope.toolName === scope.toolName
    && grant.scope.target === scope.target && grant.scope.operation === scope.operation && grant.scope.boundary === scope.boundary
}

/** Resolve team defaults into the capabilities actually applied to each node. */
export function superAgentNodePermissions(environment: SuperAgentEnvironment, role: SuperAgentNode['role']): SuperAgentEnvironment['permissions'] {
  if (role !== 'worker') return { readFiles: false, writeFiles: false, runPrograms: false, browser: false }
  if (environment.fullControl === true) return { readFiles: true, writeFiles: true, runPrograms: true, browser: true }
  return { ...environment.permissions, writeFiles: role === 'worker' && environment.permissions.writeFiles,
    runPrograms: role === 'worker' && environment.permissions.runPrograms }
}
