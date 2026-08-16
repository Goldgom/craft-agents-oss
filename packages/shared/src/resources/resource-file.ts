/**
 * Resource Bundle File Persistence
 *
 * Serializes a ResourceBundle to a portable JSON archive file
 * (`*.craft-resources.json`) and reads it back with validation.
 * This is the "打包存档" layer on top of the in-memory bundle used by
 * workspace-to-workspace transfer.
 */

import { readFileSync, writeFileSync, statSync } from 'fs';
import { MAX_BUNDLE_SIZE_BYTES } from '../utils/bundle-files.ts';
import { validateResourceBundle } from './resource-bundle.ts';
import type { ResourceBundle } from './types.ts';

/** Human-readable format marker embedded in archive files. */
export const RESOURCE_BUNDLE_FILE_MARKER = 'craft-resource-bundle';

/** Suggested file extension for archive files. */
export const RESOURCE_BUNDLE_FILE_EXTENSION = '.craft-resources.json';

/** Full bundle file shape — the on-disk envelope wraps the bundle. */
export interface ResourceBundleFile {
  /** Format marker — must match RESOURCE_BUNDLE_FILE_MARKER. */
  format: typeof RESOURCE_BUNDLE_FILE_MARKER;
  /** Bundle format version. */
  version: 1;
  bundle: ResourceBundle;
}

/** Serialize a bundle to pretty JSON text. */
export function stringifyResourceBundle(bundle: ResourceBundle): string {
  const file: ResourceBundleFile = {
    format: RESOURCE_BUNDLE_FILE_MARKER,
    version: 1,
    bundle,
  };
  return JSON.stringify(file, null, 2);
}

/**
 * Parse bundle JSON text.
 * @throws Error when the envelope or bundle contents are invalid.
 */
export function parseResourceBundle(text: string): ResourceBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON');
  }

  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as Record<string, unknown>).format !== RESOURCE_BUNDLE_FILE_MARKER
  ) {
    throw new Error(`Not a Craft resource bundle file (missing format marker "${RESOURCE_BUNDLE_FILE_MARKER}")`);
  }

  const envelope = raw as { format: string; version?: number; bundle?: unknown };
  if (envelope.version !== 1) {
    throw new Error(`Unsupported bundle file version: ${String(envelope.version)}`);
  }
  if (envelope.bundle === undefined || envelope.bundle === null) {
    throw new Error('Bundle file has no bundle payload');
  }

  const validation = validateResourceBundle(envelope.bundle);
  if (!validation.valid) {
    throw new Error(`Invalid resource bundle: ${validation.errors.join('; ')}`);
  }

  return envelope.bundle as ResourceBundle;
}

/** Write a bundle to disk as a portable JSON archive. Returns the written path. */
export function writeResourceBundleFile(filePath: string, bundle: ResourceBundle): string {
  writeFileSync(filePath, stringifyResourceBundle(bundle), 'utf-8');
  return filePath;
}

/**
 * Read a bundle archive from disk.
 * @throws Error when the file is missing, oversized, or invalid.
 */
export function readResourceBundleFile(filePath: string): ResourceBundle {
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    throw new Error(`Bundle file not found: ${filePath}`);
  }
  if (size > MAX_BUNDLE_SIZE_BYTES) {
    throw new Error(`Bundle file too large (${size} bytes > ${MAX_BUNDLE_SIZE_BYTES})`);
  }
  return parseResourceBundle(readFileSync(filePath, 'utf-8'));
}
