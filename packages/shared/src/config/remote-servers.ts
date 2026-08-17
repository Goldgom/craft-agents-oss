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
}

const REMOTE_SERVERS_FILE = join(CONFIG_DIR, 'remote-servers.json');

export function getRemoteServersPath(): string {
  return REMOTE_SERVERS_FILE;
}

/** Load all profiles (raw, including tokens — main process only). */
export function loadRemoteServerProfiles(): RemoteServerProfile[] {
  if (!existsSync(REMOTE_SERVERS_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(REMOTE_SERVERS_FILE, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (p): p is RemoteServerProfile =>
          !!p &&
          typeof p === 'object' &&
          typeof (p as RemoteServerProfile).id === 'string' &&
          typeof (p as RemoteServerProfile).url === 'string',
      )
      .map((p) => ({ ...p, token: typeof p.token === 'string' ? p.token : '' }));
  } catch {
    return [];
  }
}

function persistProfiles(profiles: RemoteServerProfile[]): void {
  atomicWriteFileSync(REMOTE_SERVERS_FILE, JSON.stringify(profiles, null, 2));
}

/** Normalize a ws/wss URL. Throws on invalid input. */
export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!/^wss?:\/\/[^\s/$.?#].[^\s]*$/i.test(trimmed)) {
    throw new Error('Server URL must be ws:// or wss:// (e.g. ws://1.2.3.4:50003)');
  }
  return trimmed;
}

export function upsertRemoteServerProfile(
  input: { id?: string; name: string; url: string; token?: string },
): RemoteServerProfile {
  const name = input.name.trim();
  if (!name) throw new Error('Server name is required');
  const url = normalizeServerUrl(input.url);

  const profiles = loadRemoteServerProfiles();
  const existing = input.id ? profiles.find((p) => p.id === input.id) : undefined;
  const now = Date.now();

  const profile: RemoteServerProfile = {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    url,
    // Keep the old token when the input leaves it blank on update.
    token: input.token !== undefined && input.token !== '' ? input.token : (existing?.token ?? ''),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastConnectedAt: existing?.lastConnectedAt,
  };

  const next = profiles.filter((p) => p.id !== profile.id);
  next.push(profile);
  persistProfiles(next);
  return profile;
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
  };
}
