import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';
import { generateRequestId } from '../source-helpers.ts';

export interface SavedCredentialArgs {
  action: 'list' | 'request' | 'fill' | 'run';
  name?: string;
  kind?: 'password' | 'api-key' | 'secret';
  url?: string;
  description?: string;
  field?: 'username' | 'secret';
  ref?: string;
  command?: string;
  env?: Record<string, 'username' | 'secret'>;
  cwd?: string;
  timeoutMs?: number;
}

/** The model supplies names and operations; plaintext stays inside the host. */
export async function handleSavedCredentials(ctx: SessionToolContext, args: SavedCredentialArgs): Promise<ToolResult> {
  if (!ctx.savedCredentialsFn) return errorResponse('Saved credentials are unavailable in this session.');
  try {
    if (args.action !== 'list' && !args.name) return errorResponse('A credential name is required.');
    if (args.action === 'request') {
      // Check availability and scope before displaying a secure entry form.
      const inventory = await ctx.savedCredentialsFn({ action: 'list' }) as Array<{ name: string }>;
      const replaces = inventory.some(entry => entry.name === args.name);
      ctx.callbacks.onAuthRequest({
        type: 'credential', requestId: generateRequestId('saved-cred'), sessionId: ctx.sessionId,
        sourceSlug: args.name!, sourceName: args.name!,
        savedCredentialName: args.name!, savedCredentialKind: args.kind ?? 'password',
        mode: (args.kind ?? 'password') === 'password' ? 'basic' : 'bearer',
        sourceUrl: args.url,
        description: args.description,
        hint: replaces ? 'credentialReplace' : 'credentialSave',
      });
      return successResponse('Secure credential input requested. After saving, continue with saved_credentials fill or run.');
    }
    return successResponse(JSON.stringify(await ctx.savedCredentialsFn(args)));
  } catch {
    // Errors from browser/process APIs may contain secrets; never forward them.
    return errorResponse('Credential operation failed. Check the name, website, target field, and local credential storage.');
  }
}
