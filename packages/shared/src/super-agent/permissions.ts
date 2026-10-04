import type { SuperAgentEnvironment, SuperAgentNode } from './types'

/** Resolve team defaults into the capabilities actually applied to each node. */
export function superAgentNodePermissions(environment: SuperAgentEnvironment, role: SuperAgentNode['role']): SuperAgentEnvironment['permissions'] {
  if (environment.fullControl === true) return { readFiles: true, writeFiles: true, runPrograms: true, browser: true }
  return { ...environment.permissions, writeFiles: role === 'worker' && environment.permissions.writeFiles,
    runPrograms: role === 'worker' && environment.permissions.runPrograms }
}
