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
 * packs automatically: the declarative parts are read (skin.json + images),
 * while executable JS is retained only for an explicit renderer opt-in and
 * is never evaluated by this server-side loader. The mapping:
 *   skin.json.id / name / nameEn / author / tagline / description / tags / accent
 *   assets/*palace-day* or *day*  → background (light)
 *   assets/*palace-night* or *night* → background (dark)
 *   assets/*sidebar*              → sidebar texture
 *   assets/*composer* or *frame*  → chat texture
 *   preview/light.webp + preview/dark.webp → previews
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, cpSync, rmSync } from 'fs';
import { join, basename, extname, relative, sep } from 'path';
import { CONFIG_DIR } from './paths.ts';
import { getBundledAssetsDir } from '../utils/paths.ts';
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
  /** Optional declarative stylesheet extracted from a Harness bundle. */
  customCss?: string;
  /** Optional stylesheet files relative to the pack directory. */
  stylesheets?: string[];
  /** Body data attribute used by Harness CSS selectors (e.g. data-dsh-foo). */
  bodyAttr?: string;
  /** Optional client scripts retained for explicit compatibility loading. */
  scripts?: string[];
}

/** A parsed, on-disk theme pack. */
export interface ThemePack {
  id: string;
  dir: string;
  manifest: ThemePackManifest;
  /** How the manifest was produced. */
  source: 'native' | 'dsh';
  /** Built-in packs are read-only and shipped with the application. */
  location: 'builtin' | 'user';
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

export interface ThemePackResource {
  path: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'font' | 'stylesheet' | 'script' | 'data' | 'other';
}

/**
 * Extract CSS literals from a generated Harness client bundle without loading
 * or evaluating the JavaScript module. This keeps the visual part of a skin
 * usable while preserving the security boundary around executable plugins.
 */
function extractDshCss(packDir: string): string | undefined {
  const candidates = ['lib/client.js', 'lib/client.mjs', 'lib/client.cjs', 'dist/client.js', 'dist/client.mjs'];
  for (const relativePath of candidates) {
    const path = join(packDir, relativePath);
    if (!existsSync(path)) continue;
    try {
      const content = readFileSync(path, 'utf-8');
      if (content.length > 4 * 1024 * 1024) continue;
      const cssParts: string[] = [];
      const pattern = /(?:const|let|var)\s+css\s*=\s*("(?:\\.|[^"\\])*")/g;
      for (const match of content.matchAll(pattern)) {
        try {
          const value = JSON.parse(match[1]!);
          if (typeof value === 'string' && value.trim()) cssParts.push(value);
        } catch { /* ignore a non-JSON JS string literal */ }
      }
      if (cssParts.length) return cssParts.join('\n');
    } catch { /* optional stylesheet */ }
  }
  return undefined;
}

function detectDshScripts(packDir: string): string[] {
  return ['lib/client.js', 'lib/client.mjs', 'lib/client.cjs', 'dist/client.js', 'dist/client.mjs']
    .filter((path) => existsSync(join(packDir, path)));
}

function resolvePackRelativePath(packDir: string, reference: string): string | null {
  const normalized = reference.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized || /^(?:data:|https?:|blob:)/i.test(normalized)) return null
  const absolute = join(packDir, normalized)
  const rel = relative(packDir, absolute)
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || rel.includes(':')) return null
  return absolute
}

/**
 * Resolve optional native-pack stylesheet files into one inline stylesheet.
 * This keeps relative image/font URLs working when the renderer injects the
 * resulting CSS as a <style> element.
 */
function loadPackStylesheets(packDir: string, manifest: ThemePackManifest): ThemePackManifest {
  const cssParts: string[] = []
  if (manifest.customCss) {
    const cssReference = manifest.customCss.trim()
    const referencedPath = resolvePackRelativePath(packDir, cssReference)
    if (referencedPath && extname(referencedPath).toLowerCase() === '.css' && existsSync(referencedPath)) {
      try {
        cssParts.push(inlineCssAssetUrlsFromDir(packDir, readFileSync(referencedPath, 'utf-8'), relative(packDir, referencedPath).split(sep).join('/')))
      } catch { /* retain no stylesheet on read failure */ }
    } else {
      cssParts.push(inlineCssAssetUrlsFromDir(packDir, manifest.customCss, ''))
    }
  }
  for (const reference of manifest.stylesheets ?? []) {
    const path = resolvePackRelativePath(packDir, reference)
    if (!path || extname(path).toLowerCase() !== '.css') continue
    try {
      cssParts.push(inlineCssAssetUrlsFromDir(packDir, readFileSync(path, 'utf-8'), relative(packDir, path).split(sep).join('/')))
    } catch { /* ignore an optional stylesheet */ }
  }
  const { stylesheets: _stylesheets, ...withoutStylesheets } = manifest
  return cssParts.length ? { ...withoutStylesheets, customCss: cssParts.join('\n') } : withoutStylesheets
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
  // CRAFT_THEME_PACKS_DIR lets a desktop/web shell explicitly choose the
  // writable pack location without changing the rest of the config root.
  return process.env.CRAFT_THEME_PACKS_DIR || join(process.env.CRAFT_CONFIG_DIR || CONFIG_DIR, 'theme-packs');
}

/** Read-only theme packs bundled by the Electron build. */
export function getBundledThemePacksDir(): string | undefined {
  const packaged = getBundledAssetsDir('theme-packs');
  if (packaged) return packaged;
  // Development source tree: the Harness packages are kept at repository
  // root/themes rather than under Electron's resources directory.
  const sourceCandidates = [
    join(process.cwd(), 'themes'),
    join(process.cwd(), '..', '..', 'themes'),
  ];
  return sourceCandidates.find((candidate) => existsSync(candidate));
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

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif', '.apng', '.bmp', '.ico', '.tif', '.tiff', '.heic', '.jxl']);

function isImageFile(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(name).toLowerCase());
}

/** List image files in a directory recursively, returning pack-relative paths. */
function listImages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    const result: string[] = [];
    const walk = (current: string) => {
      for (const entry of readdirSync(current)) {
        // Theme packages can contain source maps, tests and dependencies. They
        // are preserved on disk but never parsed or executed by this loader.
        if (entry === 'node_modules' || entry === '.git') continue;
        const path = join(current, entry);
        const stat = statSync(path);
        if (stat.isDirectory()) walk(path);
        else if (stat.isFile() && isImageFile(entry)) result.push(relative(dir, path).split(sep).join('/'));
      }
    };
    walk(dir);
    return result;
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
    const hit = files.find((f) => f.toLowerCase().includes(needle.toLowerCase()));
    if (hit) return hit;
  }
  return null;
}

/** Normalize Harness/DSH references such as `skins/foo/preview/light.png`. */
function normalizeDshAssetReference(packDir: string, reference: string | undefined, fallbackNeedles: string[]): string | undefined {
  if (reference) {
    const normalized = reference.replace(/\\/g, '/').replace(/^\.\//, '');
    const candidates = [
      normalized,
      normalized.replace(/^skins\/[^/]+\//, ''),
      normalized.replace(/^assets\/[^/]+\//, 'assets/'),
      basename(normalized),
    ];
    for (const candidate of candidates) {
      if (existsSync(join(packDir, candidate))) return candidate;
    }
    const byName = listImages(packDir).find((file) => file.endsWith(`/${basename(normalized)}`) || file === basename(normalized));
    if (byName) return byName;
  }
  return findImageByNeedle(packDir, fallbackNeedles) ?? undefined;
}

// ============================================================
// DSH skin.json → native manifest synthesis
// ============================================================

/**
 * Synthesize a native ThemePackManifest from a DSH skin.json and the
 * artwork conventions of dsh skin packages. Executable code is only recorded
 * as an opt-in script reference; it is not evaluated here.
 */
export function convertDshSkinToManifest(
  skin: DshSkinManifest,
  packDir: string,
): ThemePackManifest {
  const assetsDir = join(packDir, 'assets');

  const day = findImageByNeedle(assetsDir, ['palace-day', '-day', 'day-', 'light']);
  const night = findImageByNeedle(assetsDir, ['palace-night', '-night', 'night-', 'dark']);
  const sidebar = findImageByNeedle(assetsDir, ['sidebar']);
  const chat = findImageByNeedle(assetsDir, ['composer', 'frame', 'chat']);
  const charLeft = findImageByNeedle(assetsDir, ['maid-left', 'character-left', 'chibi-left']);
  const charRight = findImageByNeedle(assetsDir, ['maid-right', 'character-right', 'chibi-right']);
  const previewLight = normalizeDshAssetReference(packDir, skin.preview?.light, ['preview/light', 'light'])
  const previewDark = normalizeDshAssetReference(packDir, skin.preview?.dark, ['preview/dark', 'dark'])

  const manifest: ThemePackManifest = {
    name: skin.name || skin.nameEn || skin.id || 'DSH Skin',
    ...(skin.nameEn ? { nameEn: skin.nameEn } : {}),
    ...(skin.author ? { author: skin.author } : {}),
    ...(skin.tagline ? { tagline: skin.tagline } : {}),
    ...(skin.description ? { description: skin.description } : {}),
    ...(skin.tags?.length ? { tags: skin.tags } : {}),
    source: 'dsh',
    ...(skin.bodyAttr ? { bodyAttr: skin.bodyAttr } : {}),
  };

  const customCss = extractDshCss(packDir);
  if (customCss) manifest.customCss = inlineCssAssetUrlsFromDir(packDir, customCss, 'lib');
  const scripts = detectDshScripts(packDir);
  if (scripts.length) manifest.scripts = scripts;

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

  const lightPreview = previewLight;
  const darkPreview = previewDark;
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
  const userDir = join(getThemePacksDir(), safeId);
  const bundledRoot = getBundledThemePacksDir();
  const candidates = [
    { dir: userDir, location: 'user' as const },
    ...(bundledRoot ? [{ dir: join(bundledRoot, safeId), location: 'builtin' as const }] : []),
  ];
  const candidate = candidates.find((entry) => existsSync(entry.dir) && statSync(entry.dir).isDirectory());
  if (!candidate) return null;
  const dir = candidate.dir;

  for (const filename of MANIFEST_FILENAMES) {
    const manifestPath = join(dir, filename);
    if (!existsSync(manifestPath)) continue;
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      if (filename === 'skin.json') {
        const manifest = convertDshSkinToManifest(raw as DshSkinManifest, dir);
        return { id: safeId, dir, manifest, source: 'dsh', location: candidate.location };
      }
      const nativeManifest = loadPackStylesheets(dir, raw as ThemePackManifest);
      return { id: safeId, dir, manifest: nativeManifest, source: 'native', location: candidate.location };
    } catch (error) {
      debug(`[theme-pack] Failed to parse ${manifestPath}:`, error);
      return null;
    }
  }
  return null;
}

/** List all installed theme packs. */
export function listThemePacks(): ThemePack[] {
  const ids = new Set<string>();
  for (const root of [getThemePacksDir(), getBundledThemePacksDir()]) {
    if (!root || !existsSync(root)) continue;
    try {
      for (const entry of readdirSync(root)) {
        if (statSync(join(root, entry)).isDirectory()) ids.add(sanitizePackId(entry));
      }
    } catch { /* ignore an unavailable optional theme root */ }
  }
  return [...ids].map((id) => loadThemePack(id)).filter((pack): pack is ThemePack => pack !== null)
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
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
  '.apng': 'image/apng',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.heic': 'image/heic',
  '.jxl': 'image/jxl',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
};

/** Maximum asset size served as a data URL (8 MB). */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

/**
 * Resolve an asset reference (relative to the pack dir) to an absolute path.
 * Rejects references escaping the pack directory.
 */
export function resolveThemePackAssetPath(packId: string, asset: string): string | null {
  const safeId = sanitizePackId(packId);
  const userDir = join(getThemePacksDir(), safeId);
  const bundledRoot = getBundledThemePacksDir();
  const packDir = existsSync(userDir)
    ? userDir
    : bundledRoot ? join(bundledRoot, safeId) : userDir;
  if (!packDir || !asset) return null;

  const normalizedAsset = asset.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!normalizedAsset) return null;

  const absolute = join(packDir, normalizedAsset);
  const relativeAsset = relative(packDir, absolute);
  if (!relativeAsset || relativeAsset.startsWith('..') || relativeAsset.includes(`..${sep}`) || relativeAsset.includes(':')) return null;

  return existsSync(absolute) ? absolute : null;
}

/**
 * Read a theme pack asset as a data URL for CSS injection. Images, fonts,
 * stylesheets, scripts and media are supported; executable code is never run
 * by this function.
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

function resourceKind(mimeType: string): ThemePackResource['kind'] {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('font/')) return 'font';
  if (mimeType === 'text/css') return 'stylesheet';
  if (mimeType.includes('javascript')) return 'script';
  if (mimeType === 'application/json') return 'data';
  return 'other';
}

function inlineCssAssetUrlsFromDir(packDir: string, css: string, basePath: string): string {
  return css.replace(/url\((['"]?)([^'"\)]+)\1\)/gi, (full, quote: string, rawUrl: string) => {
    const url = rawUrl.trim();
    if (!url || /^(?:data:|https?:|blob:|#|var\()/i.test(url)) return full;
    const hashIndex = url.indexOf('#');
    const fragment = hashIndex >= 0 ? url.slice(hashIndex) : '';
    const localUrl = (hashIndex >= 0 ? url.slice(0, hashIndex) : url).split('?', 1)[0] ?? url;
    const candidates = [
      localUrl.replace(/^\.\//, ''),
      join(basePath, '..', localUrl).replace(/\\/g, '/'),
      join(basePath, localUrl).replace(/\\/g, '/'),
    ];
    for (const candidate of candidates) {
      const path = resolvePackRelativePath(packDir, candidate);
      if (!path) continue;
      const mimeType = MIME_BY_EXT[extname(path).toLowerCase()];
      if (!mimeType || !existsSync(path)) continue;
      try {
        const stats = statSync(path);
        if (stats.size > MAX_ASSET_BYTES) return full;
        const dataUrl = `data:${mimeType};base64,${readFileSync(path).toString('base64')}`;
        return `url(${dataUrl}${fragment})`;
      } catch { return full; }
    }
    return full;
  });
}

/** Inline local texture/font references used by generated Harness CSS. */
export function inlineThemePackCss(packId: string, css: string, basePath = 'lib/client.js'): string {
  const safeId = sanitizePackId(packId);
  const userDir = join(getThemePacksDir(), safeId);
  const bundledRoot = getBundledThemePacksDir();
  const packDir = existsSync(userDir) ? userDir : bundledRoot ? join(bundledRoot, safeId) : userDir;
  return existsSync(packDir) ? inlineCssAssetUrlsFromDir(packDir, css, basePath) : css;
}

/** Enumerate resources that a pack can reference from CSS or its manifest. */
export function listThemePackResources(packId: string): ThemePackResource[] {
  const safeId = sanitizePackId(packId);
  const userDir = join(getThemePacksDir(), safeId);
  const bundledRoot = getBundledThemePacksDir();
  const packDir = existsSync(userDir) ? userDir : bundledRoot ? join(bundledRoot, safeId) : userDir;
  if (!existsSync(packDir)) return [];
  const resources: ThemePackResource[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === '.git') continue;
      const path = join(current, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) { walk(path); continue; }
      if (!stat.isFile()) continue;
      const mimeType = MIME_BY_EXT[extname(path).toLowerCase()];
      if (!mimeType) continue;
      resources.push({
        path: relative(packDir, path).split(sep).join('/'),
        mimeType,
        size: stat.size,
        kind: resourceKind(mimeType),
      });
    }
  };
  try { walk(packDir); } catch { return []; }
  return resources.sort((a, b) => a.path.localeCompare(b.path));
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
