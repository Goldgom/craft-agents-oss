/** User-selected files exchanged over the initiating client's RPC connection. */
export interface ClientFileRequest {
  reason: string;
  allowMultiple?: boolean;
  extensions?: string[];
}

export interface ClientFileSelection {
  canceled: boolean;
  files: Array<{ name: string; base64: string; mimeType?: string }>;
}

export interface SavedClientFiles {
  canceled: boolean;
  files: Array<{ name: string; path: string; size: number; mimeType?: string }>;
}

export const CLIENT_FILE_MAX_COUNT = 5;
export const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const CLIENT_FILE_TIMEOUT_MS = 300_000;

export function validateClientFileRequest(input: ClientFileRequest): ClientFileRequest {
  if (!input || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 240
    || (input.allowMultiple !== undefined && typeof input.allowMultiple !== 'boolean')
    || (input.extensions !== undefined && (!Array.isArray(input.extensions) || input.extensions.length > 20
      || input.extensions.some(ext => typeof ext !== 'string' || !/^[a-zA-Z0-9]{1,16}$/.test(ext))))) {
    throw new Error('Invalid file request');
  }
  return { reason: input.reason.trim(), allowMultiple: input.allowMultiple ?? true, extensions: input.extensions };
}
