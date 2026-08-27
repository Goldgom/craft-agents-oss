/**
 * Adapts Craft wire credentials to shapes the Pi SDK credential resolver accepts.
 *
 * Pi SDK ≥0.81 resolves stored credentials strictly by type (pi-ai auth/resolve.ts):
 * a stored credential owns its provider — ambient/env resolution is consulted only
 * when nothing is stored — and a credential type without a matching provider auth
 * handler resolves to undefined. Two Craft wire shapes trip over this:
 *
 * - ChatGPT Plus/Pro (`openai-codex`) is OAuth-only in the SDK catalog, but Craft
 *   performs the OAuth exchange in the main process and ships the bearer access
 *   token as an `api_key` credential — unadapted, every prompt fails with
 *   "No API key found for openai-codex".
 * - Bedrock `iam` credentials match no SDK credential type, and storing them
 *   shadows the ambient AWS env vars Craft injects at spawn — unadapted, the
 *   provider reports unconfigured and prompts fail the same way.
 */

import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import type { Credential as PiSdkCredential } from '@earendil-works/pi-ai';

/** Credential union used in init and token_update messages from the main process */
export type PiCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number }
  | { type: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string };

let oauthOnlyProviderIdsCache: Set<string> | null = null;

/** Provider IDs whose SDK catalog entry declares `auth.oauth` but no `auth.apiKey`. */
function oauthOnlyProviderIds(): Set<string> {
  if (!oauthOnlyProviderIdsCache) {
    oauthOnlyProviderIdsCache = new Set(
      builtinProviders()
        .filter((p) => p.auth.oauth && !p.auth.apiKey)
        .map((p) => p.id),
    );
  }
  return oauthOnlyProviderIdsCache;
}

/**
 * Returns the credential to store for the provider, or null when nothing should
 * be stored and the provider must resolve ambiently.
 *
 * - Bearer tokens shipped as `api_key` for an OAuth-only provider are rewrapped
 *   as oauth credentials so the SDK's typed resolver accepts them. The far-future
 *   expiry keeps the SDK's own refresh path unreachable by design: the main
 *   process owns token refresh and re-injects fresh tokens via token_update.
 * - `iam` credentials are never stored: the SDK has no handler for the shape and
 *   a stored credential blocks ambient resolution, while the AWS env vars that
 *   carry the same keypair are already injected at subprocess spawn.
 *
 * Everything else passes through unchanged.
 */
export function adaptCredentialForPiSdk(provider: string, credential: PiCredential): PiSdkCredential | null {
  if (credential.type === 'api_key' && oauthOnlyProviderIds().has(provider)) {
    return { type: 'oauth', access: credential.key, refresh: '', expires: Number.MAX_SAFE_INTEGER };
  }
  if (credential.type === 'iam') {
    return null;
  }
  return credential as unknown as PiSdkCredential;
}
