/** Shared host tools for every agent backend. */
import { getToolDefsAsJsonSchema, SESSION_TOOL_NAMES, type JsonSchemaToolDef } from '@craft-agent/session-tools-core';
import { FEATURE_FLAGS } from '../../feature-flags.ts';

export type SessionToolProxyDef = JsonSchemaToolDef;
export { SESSION_TOOL_NAMES };
export function getSessionToolProxyDefs(): SessionToolProxyDef[] {
  return getToolDefsAsJsonSchema({ prefix: 'mcp__session__', includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback });
}
