/** Validated bulk updates for existing sources. Secret values never appear in errors. */
import { getCredentialManager } from '../credentials/index.ts';
import { getSourceCredentialManager } from './credential-manager.ts';
import { loadSource, markSourceAuthenticated } from './storage.ts';
import { isApiOAuthProvider, type LoadedSource } from './types.ts';

export interface SourceCredentialUpdate {
  sourceSlug: string;
  credential: string;
}

export interface SourceCredentialBatchResult {
  saved: number;
  /** Credentials committed successfully, but these source badges need a retry. */
  statusUpdateFailed: string[];
}

export function validateSourceCredential(source: LoadedSource, value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024 * 1024) {
    throw new Error('Credential must be a non-empty string of at most 1 MiB');
  }
  const { config } = source;
  const authType = config.type === 'mcp' ? config.mcp?.authType : config.api?.authType;
  const headerNames = config.type === 'mcp' ? config.mcp?.headerNames : config.api?.headerNames;
  if (config.type === 'local' || config.mcp?.transport === 'stdio'
    || (config.type === 'api' && (authType === 'none' || authType === undefined))
    || ((authType === 'none' || authType === undefined) && !headerNames?.length)) {
    throw new Error('This source does not use saved credentials');
  }
  if ((authType === 'oauth' && !headerNames?.length) || (config.type === 'api' && isApiOAuthProvider(config.provider))) {
    throw new Error('Use the OAuth sign-in flow for this source');
  }
  if (authType === 'basic' || headerNames?.length) {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new Error('Credential must be a JSON object'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Credential must be a JSON object');
    const data = parsed as Record<string, unknown>;
    if (authType === 'basic') {
      if (typeof data.username !== 'string' || !data.username.trim() || typeof data.password !== 'string') {
        throw new Error('Basic credentials require a username and password');
      }
      // Password bytes, including leading/trailing spaces, are significant.
      return JSON.stringify({ username: data.username, password: data.password });
    }
    if (!headerNames!.every(name => Object.hasOwn(data, name) && typeof data[name] === 'string' && (data[name] as string).trim()
      && !/[\x00-\x1f\x7f\u0100-\uffff]/.test(data[name] as string))) {
      throw new Error('Credential is missing one or more required headers, or contains an invalid header value');
    }
    return JSON.stringify(Object.fromEntries(headerNames!.map(name => [name, data[name]])));
  }
  if (config.type === 'api' && authType === 'query') {
    // Query credentials are percent-encoded, never placed into HTTP headers.
    // Unicode/control characters are safe here, but lone surrogates cannot be encoded.
    const credential = value.trim();
    try { encodeURIComponent(credential); } catch { throw new Error('Credential must contain valid Unicode'); }
    return credential;
  }
  if (/[\x00-\x1f\x7f\u0100-\uffff]/.test(value)) throw new Error('Credential must not contain line breaks');
  return value.trim();
}

export async function saveSourceCredentialBatch(
  workspaceRootPath: string,
  entries: SourceCredentialUpdate[],
): Promise<SourceCredentialBatchResult> {
  if (!Array.isArray(entries) || !entries.length || entries.length > 100) throw new Error('Provide between 1 and 100 credentials');
  const seen = new Set<string>();
  const sourceManager = getSourceCredentialManager();
  // Resolve and validate the entire request before the first write.
  const writes = entries.map((entry, index) => {
    if (!entry || typeof entry.sourceSlug !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(entry.sourceSlug)) {
      throw new Error(`Invalid source identifier at entry ${index + 1}`);
    }
    if (seen.has(entry.sourceSlug)) throw new Error(`Duplicate source at entry ${index + 1}`);
    seen.add(entry.sourceSlug);
    const source = loadSource(workspaceRootPath, entry.sourceSlug);
    if (!source) throw new Error(`Source not found at entry ${index + 1}`);
    return { id: sourceManager.getCredentialId(source), credential: { value: validateSourceCredential(source, entry.credential) } };
  });
  await getCredentialManager().setMany(writes);
  const statusUpdateFailed: string[] = [];
  for (const { sourceSlug } of entries) {
    try {
      if (!markSourceAuthenticated(workspaceRootPath, sourceSlug)) statusUpdateFailed.push(sourceSlug);
    } catch { statusUpdateFailed.push(sourceSlug); }
  }
  return { saved: entries.length, statusUpdateFailed };
}
