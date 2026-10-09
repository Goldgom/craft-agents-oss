import { getCredentialManager } from '@craft-agent/shared/credentials';
import { validateNativeCredentialId, validateNativeCredentialChanges } from '@craft-agent/shared/credentials/native-validation';
import type { CredentialManager } from '@craft-agent/shared/credentials';
import type { BrowserPaneFns } from '@craft-agent/shared/agent';
import { executeShell } from '@craft-agent/session-tools-core';
import type { SavedCredentialArgs } from '@craft-agent/session-tools-core';

/** Host-only operations. Neither model nor renderer receives stored secrets. */
export async function runSavedCredentialOperation(
  workspaceId: string,
  args: SavedCredentialArgs,
  options: { manager?: CredentialManager; browser?: BrowserPaneFns; workingDirectory?: string } = {},
): Promise<unknown> {
  const manager = options.manager ?? getCredentialManager();
  if (args.action === 'list') {
    const entries = [];
    for (const id of await manager.list({ type: 'saved_credential', workspaceId })) {
      validateNativeCredentialId(id);
      const credential = await manager.get(id);
      if (credential) entries.push({ name: id.name, kind: credential.credentialKind ?? 'secret', username: credential.username, url: credential.credentialUrl });
    }
    return entries;
  }
  const id = validateNativeCredentialId({ type: 'saved_credential', workspaceId, name: args.name });
  const credential = await manager.get(id);
  if (!credential) throw new Error('Credential not found');
  const fieldValue = (field: 'username' | 'secret') => {
    const value = field === 'username' ? credential.username : credential.value;
    if (!value) throw new Error('Credential field is empty');
    return value;
  };
  if (args.action === 'fill') {
    if (!options.browser || !args.ref || !args.field || !credential.credentialUrl) throw new Error('Browser target and saved website required');
    const saved = new URL(credential.credentialUrl);
    const snapshot = await options.browser.snapshot();
    if (!['http:', 'https:'].includes(saved.protocol) || new URL(snapshot.url).origin !== saved.origin) throw new Error('Website mismatch');
    await options.browser.fill(args.ref, fieldValue(args.field), { expectedOrigin: saved.origin, sensitive: args.field === 'secret' });
    return { filled: true, name: args.name, field: args.field };
  }
  if (args.action === 'run') {
    if (!args.command || !args.env || !Object.keys(args.env).length || Object.keys(args.env).length > 20) throw new Error('Command and credential environment required');
    const env: Record<string, string> = {};
    for (const [key, field] of Object.entries(args.env)) {
      if (!/^TB_CRED_[A-Z0-9_]+$/.test(key) || !['username', 'secret'].includes(field)) throw new Error('Invalid credential environment');
      env[key] = fieldValue(field);
    }
    const result = await executeShell({ command: args.command, cwd: args.cwd ?? options.workingDirectory, timeoutMs: args.timeoutMs }, env);
    // Do not return stdout/stderr: the executed program could echo/encode credentials.
    return { name: args.name, exitCode: result.exitCode, timedOut: result.timedOut };
  }
  throw new Error('Unsupported credential operation');
}

export async function saveRequestedCredential(workspaceId: string, request: {
  savedCredentialName?: string; savedCredentialKind?: 'password' | 'api-key' | 'secret'; sourceUrl?: string;
}, response: { username?: string; password?: string; value?: string }, manager = getCredentialManager()): Promise<void> {
  const kind = request.savedCredentialKind ?? 'password';
  if (kind === 'password' && !response.username?.trim()) throw new Error('Username required');
  const changes = validateNativeCredentialChanges([{
    op: 'upsert',
    id: { type: 'saved_credential', workspaceId, name: request.savedCredentialName },
    credential: { value: kind === 'password' ? response.password : response.value,
      username: kind === 'password' ? response.username!.trim() : null,
      credentialKind: kind, credentialUrl: request.sourceUrl ?? null },
  }]);
  await manager.applyChanges(changes);
}
