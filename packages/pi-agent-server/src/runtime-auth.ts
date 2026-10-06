import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { InMemoryCredentialStore } from '@earendil-works/pi-ai';

/** Custom endpoint models must read the same mutable credentials as token_update. */
export async function updateCustomEndpointCredential(store: InMemoryCredentialStore, key: string): Promise<void> {
  await store.modify('custom-endpoint', async () => key ? { type: 'api_key', key } : undefined);
}

/** Covers each inference, tool continuation, retry and compaction auth resolution. */
export function installRequestAuthGuard(runtime: ModelRuntime, ensureFresh: () => Promise<void>): void {
  const getAuth = runtime.getAuth.bind(runtime);
  let checking: Promise<void> | undefined;
  runtime.getAuth = (async (model, options) => {
    options?.signal?.throwIfAborted();
    if (!checking) {
      checking = ensureFresh().finally(() => { checking = undefined; });
      // Cancellation may leave no active waiter while the shared check finishes.
      void checking.catch(() => {});
    }
    if (options?.signal) {
      const signal = options.signal;
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const abort = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
        checking!.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
      });
    } else {
      await checking;
    }
    options?.signal?.throwIfAborted();
    return typeof model === 'string' ? getAuth(model, options) : getAuth(model, options);
  }) as ModelRuntime['getAuth'];
}
