/**
 * Theme Pack Configuration
 *
 * A theme pack bundles artwork (background image, chat texture, sidebar
 * texture) with a JSON manifest describing basic style settings. Packs live
 * in `~/.craft-agent/theme-packs/<pack-id>/`.
 *
 * Format (native):
 * ```
 * theme-packs/my-pack/
 *   theme-pack.json     # manifest (see ThemePackManifest)
 *   background.png      # optional artwork, paths relative to pack dir
 *   chat.png
 *   sidebar.png
 *   preview/light.webp
 * ```
 *
 * DSH skin compatibility:
 * Skins distributed for DeepSeek Harness Web GUI (e.g.
 * github.com/Small-tailqwq/dsh-deep-whale) ship a `skin.json` and WebP
 * artwork under `assets/` / `preview/`. Such folders are detected as theme
 * packs automatically: only the DECLARATIVE parts are read (skin.json +
 * images) — the plugin's executable JS (`lib/`, `src/`) is never loaded or
 * executed. The mapping:
 *   skin.json.id / name / nameEn / author / tagline / description / tags / accent
 *   assets/*palace-day* or *day*  → background (light)
 *   assets/*palace-night* or *night* → background (dark)
 *   assets/*sidebar*              → sidebar texture
 *   assets/*composer* or *frame*  → chat texture
 *   preview/light.webp + preview/dark.webp → previews
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, cpSync, rmSync } from 'fs';
import { join, basename, extname } from 'path';
import { CONFIG_DIR } from './paths.ts';
import { debug } from '../utils/debug.ts';
import type { ThemeOverrides } from './theme.ts';

// Style types + defaults live in a browser-safe module so the renderer can
// import them without pulling node:fs / node:os into the client bundle.
export type { ThemePackStyle } from './theme-pack-style.ts';
export { DEFAULT_THEME_PACK_STYLE } from './theme-pack-style.ts';
import type { ThemePackStyle } from './theme-pack-style.ts';

// ============================================================
// Types
// ============================================================

/** Native theme pack manifest (theme-pack.json). */
export interface ThemePackManifest {
  name: string;
  nameEn?: string;
  author?: string;
  tagline?: string;
  description?: string;
  version?: number;
  tags?: string[];
  /** Preview images relative to the pack dir. */
  preview?: { light?: string; dark?: string };
  /** Scenic background. `background` (light/dark pair) wins over single `backgroundImage`. */
  background?: { light?: string; dark?: string };
  backgroundImage?: string;
  /** Chat panel texture, relative to the pack dir. */
  chatTexture?: string;
  /** Sidebar texture, relative to the pack dir. */
  sidebarTexture?: string;
  /** Character standees (立绘) anchored to the window bottom corners. */
  characters?: { left?: string; right?: string };
  /** Basic style settings. */
  style?: ThemePackStyle;
  /**
   * Color overrides — same 6-color + surface system as preset themes,
   * including optional `dark` overrides, `mode` and Shiki config.
   */
  colors?: ThemeOverrides & {
    shikiTheme?: { light?: string; dark?: string };
    supportedModes?: ('light' | 'dark')[];
  };
  /** Set for packs synthesized from a DSH skin.json. */
  source?: 'dsh';
}

/** A parsed, on-disk theme pack. */
export interface ThemePack {
  id: string;
  dir: string;
  manifest: ThemePackManifest;
  /** How the manifest was produced. */
  source: 'native' | 'dsh';
}

/**
 * Declarative DSH skin metadata (the JSON part of a dsh skin package).
 * The skin's executable plugin code is deliberately NOT represented.
 */
export interface DshSkinManifest {
  id?: string;
  name?: string;
  nameEn?: string;
  author?: string;
  tagline?: string;
  description?: string;
  tags?: string[];
  accent?: string;
  bodyAttr?: string;
  preview?: { light?: string; dark?: string };
  order?: number;
}

/** A theme pack asset read as a data URL (ready for CSS). */
export interface ThemePackAsset {
  path: string;
  mimeType: string;
  dataUrl: string;
}

// ============================================================
// Paths & discovery
// ============================================================

const MANIFEST_FILENAMES = ['theme-pack.json', 'skin.json'] as const;

/** Root directory where theme packs are installed. */
export function getThemePacksDir(): string {
  // Read env dynamically so tests can isolate via CRAFT_CONFIG_DIR.
  return join(process.env.CRAFT_CONFIG_DIR || CONFIG_DIR, 'theme-packs');
}

/** Ensure the theme packs directory exists and return it. */
export function ensureThemePacksDir(): string {
  const dir = getThemePacksDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Sanitize an arbitrary id/folder name into a safe pack id. */
export function sanitizePackId(id: string): string {
  const cleaned = id
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || 'theme-pack';
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);

function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(name).toLowerCase());
}

/** List image files in a directory (non-recursive). */
function listImages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => {
      const p = join(dir, f);
      return statSync(p).isFile() && isImageFile(f);
    });
  } catch {
    return [];
  }
}

/**
 * Pick the first image in `dir` whose filename contains any of `needles`.
 * Returns the filename (not full path).
 */
function findImageByNeedle(dir: string, needles: string[]): string | null {
  const files = listImages(dir);
  for (const needle of needles) {
    const hit = files.find((f) => f.toLowerCase().includes(needle));
    if (hit) return hit;
  }
  return null;
}

// ============================================================
// DSH skin.json → native manifest synthesis
// ============================================================

/**
 * Synthesize a native ThemePackManifest from a DSH skin.json and the
 * artwork conventions of dsh skin packages. Never touches executable code.
 */
export function convertDshSkinToManifest(
  skin: DshSkinManifest,
  packDir: string,
): ThemePackManifest {
  const assetsDir = join(packDir, 'assets');
  const previewDir = join(packDir, 'preview');

  const day = findImageByNeedle(assetsDir, ['palace-day', '-day', 'day-', 'light']);
  const night = findImageByNeedle(assetsDir, ['palace-night', '-night', 'night-', 'dark']);
  const sidebar = findImageByNeedle(assetsDir, ['sidebar']);
  const chat = findImageByNeedle(assetsDir, ['composer', 'frame', 'chat']);
  const charLeft = findImageByNeedle(assetsDir, ['maid-left', 'character-left', 'chibi-left']);
  const charRight = findImageByNeedle(assetsDir, ['maid-right', 'character-right', 'chibi-right']);
  const previewLight = skin.preview?.light
    ?? findImageByNeedle(previewDir, ['light'])
  const previewDark = skin.preview?.dark
    ?? findImageByNeedle(previewDir, ['dark'])

  const manifest: ThemePackManifest = {
    name: skin.name || skin.nameEn || skin.id || 'DSH Skin',
    ...(skin.nameEn ? { nameEn: skin.nameEn } : {}),
    ...(skin.author ? { author: skin.author } : {}),
    ...(skin.tagline ? { tagline: skin.tagline } : {}),
    ...(skin.description ? { description: skin.description } : {}),
    ...(skin.tags?.length ? { tags: skin.tags } : {}),
    source: 'dsh',
  };

  if (day || night) {
    manifest.background = {
      ...(day ? { light: `assets/${day}` } : {}),
      ...(night ? { dark: `assets/${night}` } : {}),
    };
    // DSH skins are full-window artwork → scenic with glass panels.
    manifest.colors = { ...(manifest.colors ?? {}), mode: 'scenic' };
  }

  if (sidebar) manifest.sidebarTexture = `assets/${sidebar}`;
  if (chat) manifest.chatTexture = `assets/${chat}`;

  if (charLeft || charRight) {
    manifest.characters = {
      ...(charLeft ? { left: `assets/${charLeft}` } : {}),
      ...(charRight ? { right: `assets/${charRight}` } : {}),
    };
  }

  const lightPreview = previewLight ? (skin.preview?.light ?? `preview/${previewLight}`) : undefined;
  const darkPreview = previewDark ? (skin.preview?.dark ?? `preview/${previewDark}`) : undefined;
  if (lightPreview || darkPreview) {
    manifest.preview = {
      ...(lightPreview ? { light: lightPreview } : {}),
      ...(darkPreview ? { dark: darkPreview } : {}),
    };
  }

  if (skin.accent) {
    manifest.colors = { ...(manifest.colors ?? {}), accent: skin.accent };
  }

  // DSH skins are dark-leaning scenic artwork; keep glass subtle by default.
  // Constrain raster ornaments like the skin itself does: the sidebar corner
  // sprite is drawn at a fixed 130px, and the composer frame is pasted onto
  // the input box (width-fit, top-anchored so the bow shows) rather than
  // stretched across the whole chat column.
  manifest.style = {
    backgroundBlur: 0,
    chatOpacity: 0.88,
    sidebarOpacity: 0.8,
    // Mirror the skin's own backdrop: anchored top-center, cover.
    backgroundPosition: 'center top',
    backgroundSize: 'cover',
    // Natural-size textures, anchored like the original skin.
    textureSize: 'auto',
    sidebarTextureSize: '130px',
    sidebarTexturePosition: 'top left',
    chatTextureSize: '100% auto',
    chatTexturePosition: 'center top',
  };

  return manifest;
}

// ============================================================
// Loading & listing
// ============================================================

/**
 * Load a single theme pack by id. Supports both the native
 * `theme-pack.json` and DSH `skin.json` manifest layouts.
 */
export function loadThemePack(id: string): ThemePack | null {
  const safeId = sanitizePackId(id);
  const dir = join(getThemePacksDir(), safeId);
  if (!existsSync(dir)) return null;

  for (const filename of MANIFEST_FILENAMES) {
    const manifestPath = join(dir, filename);
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (filename === 'skin.json') {
        const manifest = convertDshSkinToManifest(raw as DshSkinManifest, dir);
        return { id: safeId, dir, manifest, source: 'dsh' };
      }
      return { id: safeId, dir, manifest: raw as ThemePackManifest, source: 'native' };
    } catch (error) {
      debug(`[theme-pack] Failed to parse ${manifestPath}:`, error);
      return null;
    }
  }
  return null;
}

/** List all installed theme packs. */
export function listThemePacks(): ThemePack[] {
  const root = getThemePacksDir();
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((entry) => statSync(join(root, entry)).isDirectory())
      .map((entry) => loadThemePack(entry))
      .filter((pack): pack is ThemePack => pack !== null);
  } catch {
    return [];
  }
}

// ============================================================
// Assets
// ============================================================

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

/** Maximum asset size served as a data URL (8 MB). */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/**
 * Resolve an asset reference (relative to the pack dir) to an absolute path.
 * Rejects references escaping the pack directory.
 */
export function resolveThemePackAssetPath(packId: string, asset: string): string | null {
  const safeId = sanitizePackId(packId);
  const packDir = join(getThemePacksDir(), safeId);
  if (!packDir || !asset) return null;

  const normalizedAsset = asset.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!normalizedAsset) return null;

  const absolute = join(packDir, normalizedAsset);
  const dirPrefix = packDir.endsWith('/') || packDir.endsWith('\\') ? packDir : packDir + '/';
  const backPrefix = packDir.endsWith('\\') ? packDir : packDir + '\\';
  if (!(absolute.startsWith(dirPrefix) || absolute.startsWith(backPrefix))) return null;

  return existsSync(absolute) ? absolute : null;
}

/**
 * Read a theme pack asset as a data URL for CSS injection.
 * Returns null for missing files, non-image files, or oversized assets.
 */
export function readThemePackAsset(packId: string, asset: string): ThemePackAsset | null {
  const path = resolveThemePackAssetPath(packId, asset);
  if (!path) return null;
  const ext = extname(path).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) return null;
  try {
    const stats = statSync(path);
    if (stats.size > MAX_ASSET_BYTES) {
      debug(`[theme-pack] Asset too large (${stats.size} bytes): ${path}`);
      return null;
    }
    const dataUrl = `data:${mimeType};base64,${readFileSync(path).toString('base64')}`;
    return { path, mimeType, dataUrl };
  } catch (error) {
    debug(`[theme-pack] Failed to read asset ${path}:`, error);
    return null;
  }
}

// ============================================================
// Import
// ============================================================

/**
 * Import an external folder (a DSH skin dir or a native pack dir) into the
 * theme packs directory. Detects the manifest layout; returns null when the
 * folder contains neither skin.json nor theme-pack.json.
 *
 * The whole folder is copied verbatim — including the plugin's JS for DSH
 * skins — but Craft only ever reads the declarative manifest + images and
 * never executes the copied code.
 */
export function importThemePackFromFolder(sourceDir: string): ThemePack | null {
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) return null;

  const hasNative = existsSync(join(sourceDir, 'theme-pack.json'));
  const hasDsh = existsSync(join(sourceDir, 'skin.json'));
  if (!hasNative && !hasDsh) return null;

  let packId: string;
  if (hasNative) {
    try {
      const raw = JSON.parse(readFileSync(join(sourceDir, 'theme-pack.json'), 'utf-8')) as ThemePackManifest;
      packId = sanitizePackId(raw.name ?? basename(sourceDir));
    } catch {
      packId = sanitizePackId(basename(sourceDir));
    }
  } else {
    try {
      const raw = JSON.parse(readFileSync(join(sourceDir, 'skin.json'), 'utf-8')) as DshSkinManifest;
      packId = sanitizePackId(raw.id ?? raw.nameEn ?? raw.name ?? basename(sourceDir));
    } catch {
      packId = sanitizePackId(basename(sourceDir));
    }
  }

  const targetDir = join(ensureThemePacksDir(), packId);
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });

  // Copy verbatim (images, manifests, previews, NOTICE/LICENSE included).
  cpSync(sourceDir, targetDir, { recursive: true });

  return loadThemePack(packId);
}

/** Delete an installed theme pack. */
export function deleteThemePack(packId: string): boolean {
  const safeId = sanitizePackId(packId);
  const dir = join(getThemePacksDir(), safeId);
  if (!existsSync(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (error) {
    debug(`[theme-pack] Failed to delete ${dir}:`, error);
    return false;
  }
}
