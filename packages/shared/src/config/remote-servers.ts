/**
 * Remote server profiles (远程服务器配置).
 *
 * A client-local registry of remote Craft Agent servers the user can connect
 * to. Fully isolated from the remote servers' own data — each profile is just
 * a URL + bearer token + display name stored in the client's config dir.
 *
 * These are ONLY used by local clients (Electron main process). The headless
 * server never reads this file.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CONFIG_DIR } from './paths.ts';
import { atomicWriteFileSync } from '../utils/files.ts';

export interface RemoteServerProfile {
  /** Stable client-local id. */
  id: string;
  name: string;
  /** ws://host:port or wss://host:port — no trailing slash. */
  url: string;
  /** Bearer token for the remote server. */
  token: string;
  createdAt: number;
  updatedAt: number;
  /** Last successful connection attempt (epoch ms). */
  lastConnectedAt?: number;
  /** Optional client-local SFTP connection used for file transfers. */
  sftp?: RemoteServerSftpConfig;
}

export type RemoteServerSftpAuthMethod = 'password' | 'privateKey';

export interface RemoteServerSftpConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  authMethod: RemoteServerSftpAuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  /** Remote paths are restricted to this root. Empty means the SSH home directory. */
  remoteRoot?: string;
}

export interface RemoteServerSftpInput {
  enabled: boolean;
  host?: string;
  port?: number;
  username?: string;
  authMethod?: RemoteServerSftpAuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  remoteRoot?: string;
}

/** Public profile DTO — token is stripped for renderer consumption. */
export interface RemoteServerProfileInfo {
  id: string;
  name: string;
  url: string;
  createdAt: number;
  updatedAt: number;
  lastConnectedAt?: number;
  hasToken: boolean;
  sftp?: {
    enabled: boolean;
    host: string;
    port: number;
    username: string;
    authMethod: RemoteServerSftpAuthMethod;
    privateKeyPath?: string;
    remoteRoot?: string;
    hasPassword: boolean;
    hasPassphrase: boolean;
  };
}

export function getRemoteServersPath(): string {
  // Read the override dynamically so tests and embedded clients can isolate
  // their local profile registry even if config modules were loaded earlier.
  return join(process.env.CRAFT_CONFIG_DIR || CONFIG_DIR, 'remote-servers.json');
}

/** Load all profiles (raw, including tokens — main process only). */
export function loadRemoteServerProfiles(): RemoteServerProfile[] {
  const remoteServersFile = getRemoteServersPath();
  if (!existsSync(remoteServersFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(remoteServersFile, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return [];

    // Validate each entry independently. A stale or manually edited profile
    // must not prevent otherwise healthy servers (or local server mode) from
    // being loaded. In particular, invalid URLs would otherwise be passed to
    // the thin-client preload and abort the whole renderer during startup.
    return parsed.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const profile = value as Partial<RemoteServerProfile>;
      if (
        typeof profile.id !== 'string'
        || typeof profile.name !== 'string'
        || !profile.name.trim()
        || typeof profile.url !== 'string'
      ) return [];
      try {
        const url = normalizeServerUrl(profile.url);
        const parsedUrl = new URL(url);
        if (!parsedUrl.hostname) return [];
        const normalized: RemoteServerProfile = {
          ...profile,
          name: profile.name.trim(),
          url,
          token: typeof profile.token === 'string' ? profile.token : '',
        } as RemoteServerProfile;

        // SFTP is optional. Ignore malformed SFTP data while retaining the
        // server profile so the main remote-server picker remains usable.
        if (profile.sftp !== undefined && !isValidSftpConfig(profile.sftp)) {
          delete normalized.sftp;
        }
        return [normalized];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function isValidSftpConfig(value: unknown): value is RemoteServerSftpConfig {
  if (!value || typeof value !== 'object') return false;
  const config = value as Partial<RemoteServerSftpConfig>;
  const port = config.port;
  return typeof config.enabled === 'boolean'
    && typeof config.host === 'string'
    && typeof port === 'number'
    && Number.isInteger(port)
    && port >= 1
    && port <= 65535
    && typeof config.username === 'string'
    && (config.authMethod === 'password' || config.authMethod === 'privateKey')
    && (config.password === undefined || typeof config.password === 'string')
    && (config.privateKeyPath === undefined || typeof config.privateKeyPath === 'string')
    && (config.passphrase === undefined || typeof config.passphrase === 'string')
    && (config.remoteRoot === undefined || typeof config.remoteRoot === 'string');
}

function persistProfiles(profiles: RemoteServerProfile[]): void {
  atomicWriteFileSync(getRemoteServersPath(), JSON.stringify(profiles, null, 2));
}

/** Normalize a ws/wss URL. Throws on invalid input. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!/^wss?:\/\/[^\s/$.?#].[^\s]*$/i.test(trimmed)) {
    throw new Error('Server URL must be ws:// or wss:// (e.g. ws://1.2.3.4:50003)');
  }
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') || !parsed.hostname) {
      throw new Error('invalid protocol or hostname');
    }
  } catch {
    throw new Error('Server URL must be ws:// or wss:// (e.g. ws://1.2.3.4:50003)');
  }
  return trimmed;
}

export function upsertRemoteServerProfile(
  input: { id?: string; name: string; url: string; token?: string; sftp?: RemoteServerSftpInput },
): RemoteServerProfile {
  const name = input.name.trim();
  if (!name) throw new Error('Server name is required');
  const url = normalizeServerUrl(input.url);

  const profiles = loadRemoteServerProfiles();
  const existing = input.id ? profiles.find((p) => p.id === input.id) : undefined;
  const now = Date.now();
  const sftp = normalizeSftpConfig(input.sftp, existing?.sftp, url);

  const profile: RemoteServerProfile = {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    url,
    // Keep the old token when the input leaves it blank on update.
    token: input.token !== undefined && input.token !== '' ? input.token : (existing?.token ?? ''),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastConnectedAt: existing?.lastConnectedAt,
    ...(sftp ? { sftp } : {}),
  };

  const next = profiles.filter((p) => p.id !== profile.id);
  next.push(profile);
  persistProfiles(next);
  return profile;
}

function normalizeSftpConfig(
  input: RemoteServerSftpInput | undefined,
  existing: RemoteServerSftpConfig | undefined,
  serverUrl: string,
): RemoteServerSftpConfig | undefined {
  if (input === undefined) return existing;

  const inferredHost = new URL(serverUrl).hostname;
  const host = (input.host ?? existing?.host ?? inferredHost).trim();
  const port = input.port ?? existing?.port ?? 22;
  const username = (input.username ?? existing?.username ?? '').trim();
  const authMethod = input.authMethod ?? existing?.authMethod ?? 'password';

  if (!host) throw new Error('SFTP host is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SFTP port must be between 1 and 65535');
  }
  if (input.enabled && !username) throw new Error('SFTP username is required');

  const password = input.password?.trim() || existing?.password;
  const privateKeyPath = input.privateKeyPath?.trim() || existing?.privateKeyPath;
  const passphrase = input.passphrase?.trim() || existing?.passphrase;
  const remoteRoot = input.remoteRoot !== undefined
    ? input.remoteRoot.trim()
    : existing?.remoteRoot;

  if (input.enabled && authMethod === 'password' && !password) {
    throw new Error('SFTP password is required');
  }
  if (input.enabled && authMethod === 'privateKey' && !privateKeyPath) {
    throw new Error('SFTP private key path is required');
  }

  return {
    enabled: input.enabled,
    host,
    port,
    username,
    authMethod,
    ...(password ? { password } : {}),
    ...(privateKeyPath ? { privateKeyPath } : {}),
    ...(passphrase ? { passphrase } : {}),
    ...(remoteRoot ? { remoteRoot } : {}),
  };
}

export function deleteRemoteServerProfile(id: string): boolean {
  const profiles = loadRemoteServerProfiles();
  const next = profiles.filter((p) => p.id !== id);
  if (next.length === profiles.length) return false;
  persistProfiles(next);
  return true;
}

export function getRemoteServerProfile(id: string): RemoteServerProfile | undefined {
  return loadRemoteServerProfiles().find((p) => p.id === id);
}

export function markRemoteServerConnected(id: string): void {
  const profiles = loadRemoteServerProfiles();
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return;
  profile.lastConnectedAt = Date.now();
  persistProfiles(profiles);
}

/** Strip tokens for renderer consumption. */
export function toProfileInfo(profile: RemoteServerProfile): RemoteServerProfileInfo {
  return {
    id: profile.id,
    name: profile.name,
    url: profile.url,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    lastConnectedAt: profile.lastConnectedAt,
    hasToken: profile.token.length > 0,
    ...(profile.sftp
      ? {
          sftp: {
            enabled: profile.sftp.enabled,
            host: profile.sftp.host,
            port: profile.sftp.port,
            username: profile.sftp.username,
            authMethod: profile.sftp.authMethod,
            ...(profile.sftp.privateKeyPath ? { privateKeyPath: profile.sftp.privateKeyPath } : {}),
            ...(profile.sftp.remoteRoot ? { remoteRoot: profile.sftp.remoteRoot } : {}),
            hasPassword: Boolean(profile.sftp.password),
            hasPassphrase: Boolean(profile.sftp.passphrase),
          },
        }
      : {}),
  };
}
