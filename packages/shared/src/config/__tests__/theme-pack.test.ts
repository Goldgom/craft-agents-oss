import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  convertDshSkinToManifest,
  importThemePackFromFolder,
  listThemePacks,
  loadThemePack,
  readThemePackAsset,
  resolveThemePackAssetPath,
  sanitizePackId,
  type DshSkinManifest,
} from '../theme-pack.ts';

/**
 * DSH skin compatibility (github.com/Small-tailqwq/dsh-deep-whale maid-atelier
 * layout): skin.json metadata + assets/*.webp artwork conventions map onto a
 * native theme pack manifest WITHOUT executing any plugin code.
 */

const skinFixture: DshSkinManifest = {
  id: 'maid-atelier',
  name: '深海女仆工坊',
  nameEn: 'Abyssal Maid Atelier',
  author: 'Small-tailqwq',
  tagline: '双女仆背景、深海蓝蕾丝界面与 Q 版侧栏',
  description: '…',
  tags: ['anime', 'maid', 'navy'],
  accent: '#c5a468',
  preview: { light: 'preview/light.webp', dark: 'preview/dark.webp' },
};

function makeDshSkinDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skin-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  mkdirSync(join(dir, 'preview'), { recursive: true });
  writeFileSync(join(dir, 'skin.json'), JSON.stringify(skinFixture, null, 2));
  // Artwork (placeholder bytes — the importer never decodes them here)
  writeFileSync(join(dir, 'assets', 'maid-atelier-palace-day-v4.webp'), 'day');
  writeFileSync(join(dir, 'assets', 'maid-atelier-palace-night-v4.webp'), 'night');
  writeFileSync(join(dir, 'assets', 'maid-sidebar-corner-v1.webp'), 'sidebar');
  writeFileSync(join(dir, 'assets', 'maid-composer-frame-v4.webp'), 'composer');
  writeFileSync(join(dir, 'assets', 'maid-atelier-maid-left-v5.webp'), 'char-left');
  writeFileSync(join(dir, 'assets', 'maid-atelier-maid-right-v6.webp'), 'char-right');
  writeFileSync(join(dir, 'preview', 'light.webp'), 'light');
  writeFileSync(join(dir, 'preview', 'dark.webp'), 'dark');
  // Plugin code that must NEVER be executed by Craft
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'client.js'), 'throw new Error("must not run")');
  return dir;
}

describe('sanitizePackId', () => {
  it('sanitizes unsafe folder names', () => {
    expect(sanitizePackId('My Pack!')).toBe('My-Pack');
    expect(sanitizePackId('  ')).toBe('theme-pack');
    expect(sanitizePackId('../evil')).toBe('..-evil');
  });
});

describe('convertDshSkinToManifest', () => {
  it('maps skin.json metadata and asset conventions to a native manifest', () => {
    const dir = makeDshSkinDir();
    try {
      const manifest = convertDshSkinToManifest(skinFixture, dir);

      expect(manifest.name).toBe('深海女仆工坊');
      expect(manifest.nameEn).toBe('Abyssal Maid Atelier');
      expect(manifest.author).toBe('Small-tailqwq');
      expect(manifest.source).toBe('dsh');

      // Background pair from *palace-day* / *palace-night*
      expect(manifest.background?.light).toContain('palace-day');
      expect(manifest.background?.dark).toContain('palace-night');
      // Sidebar / chat textures from conventions
      expect(manifest.sidebarTexture).toContain('sidebar');
      expect(manifest.chatTexture).toContain('composer');
      // Character standees (立绘) from *maid-left* / *maid-right*
      expect(manifest.characters?.left).toContain('maid-left');
      expect(manifest.characters?.right).toContain('maid-right');
      // Previews from skin.json
      expect(manifest.preview?.light).toBe('preview/light.webp');
      expect(manifest.preview?.dark).toBe('preview/dark.webp');
      // Accent color mapped into colors
      expect(manifest.colors?.accent).toBe('#c5a468');
      // DSH skins are full-window artwork → scenic
      expect(manifest.colors?.mode).toBe('scenic');
      // Texture constraints mirror the skin's own layout: fixed 130px corner
      // sprite, composer frame pasted width-fit on the input box (top-anchored
      // so the bow shows), backdrop anchored top-center.
      expect(manifest.style?.textureSize).toBe('auto');
      expect(manifest.style?.sidebarTextureSize).toBe('130px');
      expect(manifest.style?.sidebarTexturePosition).toBe('top left');
      expect(manifest.style?.chatTextureSize).toBe('100% auto');
      expect(manifest.style?.chatTexturePosition).toBe('center top');
      expect(manifest.style?.backgroundPosition).toBe('center top');
      expect(manifest.style?.backgroundSize).toBe('cover');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('importThemePackFromFolder + loadThemePack (DSH layout)', () => {
  it('imports a dsh skin folder into the theme packs dir and re-reads it', () => {
    const originalConfigDir = process.env.CRAFT_CONFIG_DIR;
    const tempConfig = mkdtempSync(join(tmpdir(), 'craft-config-'));
    process.env.CRAFT_CONFIG_DIR = tempConfig;
    const skinDir = makeDshSkinDir();
    try {
      const pack = importThemePackFromFolder(skinDir);
      expect(pack).not.toBeNull();
      expect(pack!.id).toBe('maid-atelier');
      expect(pack!.source).toBe('dsh');
      expect(pack!.manifest.background?.dark).toContain('palace-night');

      // Re-load via id
      const reloaded = loadThemePack('maid-atelier');
      expect(reloaded?.manifest.name).toBe('深海女仆工坊');

      // Listed
      expect(listThemePacks().map((p) => p.id)).toContain('maid-atelier');

      // Assets resolve + read as data URLs; plugin JS is never loaded
      expect(existsSync(join(pack!.dir, 'lib', 'client.js'))).toBe(true);
      const asset = readThemePackAsset('maid-atelier', reloaded!.manifest.background!.light!);
      expect(asset?.mimeType).toBe('image/webp');
      expect(asset?.dataUrl.startsWith('data:image/webp;base64,')).toBe(true);

      // Traversal attempts are rejected
      expect(resolveThemePackAssetPath('maid-atelier', '../outside.txt')).toBeNull();
      expect(resolveThemePackAssetPath('maid-atelier', 'assets/../../skin.json')).toBeNull();
    } finally {
      if (originalConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR;
      else process.env.CRAFT_CONFIG_DIR = originalConfigDir;
      rmSync(tempConfig, { recursive: true, force: true });
      rmSync(skinDir, { recursive: true, force: true });
    }
  });
});
