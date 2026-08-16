/**
 * Theme Pack Style — browser-safe types + defaults.
 *
 * Kept free of any Node imports so the Electron renderer (and any web
 * build) can import `DEFAULT_THEME_PACK_STYLE` without pulling `node:fs` /
 * `node:os` into the client bundle (which Vite externalizes and turns into
 * a runtime crash). Node-side pack I/O lives in `theme-pack.ts`.
 */

/** Basic style settings for a theme pack (all optional, sane defaults). */
export interface ThemePackStyle {
  /** CSS background-size for the background image ('cover' default). */
  backgroundSize?: string;
  /** CSS background-position for the background image ('center' default). */
  backgroundPosition?: string;
  /** Backdrop blur radius (px) applied to glass panels when mode='scenic'. */
  backgroundBlur?: number;
  /** Opacity (0-1) of the chat panel texture. */
  chatOpacity?: number;
  /** CSS blend mode for the chat texture overlay. */
  chatBlend?: string;
  /** Opacity (0-1) of the sidebar texture. */
  sidebarOpacity?: number;
  /** CSS blend mode for the sidebar texture overlay. */
  sidebarBlend?: string;
  /**
   * CSS background-size for chat/sidebar textures.
   * Default 'auto' — textures render at their natural size (constrained),
   * not stretched or cropped to fill the panel.
   */
  textureSize?: string;
  /**
   * CSS background-position for chat/sidebar textures ('center' default).
   */
  texturePosition?: string;
  /** CSS background-repeat for chat/sidebar textures ('no-repeat' default). */
  textureRepeat?: string;
  /** Per-area size override for the chat texture. */
  chatTextureSize?: string;
  /** Per-area position override for the chat texture. */
  chatTexturePosition?: string;
  /** Per-area size override for the sidebar texture. */
  sidebarTextureSize?: string;
  /** Per-area position override for the sidebar texture. */
  sidebarTexturePosition?: string;
  /**
   * Height of character standees (立绘) anchored to the window bottom.
   * Default matches DSH skins: 'clamp(560px, 96vh, 1180px)'.
   */
  characterHeight?: string;
  /** Bottom offset of character standees (can tuck slightly below the edge). */
  characterBottom?: string;
  /** Opacity (0-1) of character standees. */
  characterOpacity?: number;
  /** Border radius applied to chat cards (e.g. '12px'). */
  borderRadius?: string;
}

export const DEFAULT_THEME_PACK_STYLE: Required<ThemePackStyle> = {
  backgroundSize: 'cover',
  backgroundPosition: 'center',
  backgroundBlur: 0,
  chatOpacity: 0.9,
  chatBlend: 'normal',
  sidebarOpacity: 0.85,
  sidebarBlend: 'normal',
  textureSize: 'auto',
  texturePosition: 'center',
  textureRepeat: 'no-repeat',
  chatTextureSize: 'auto',
  chatTexturePosition: 'center',
  sidebarTextureSize: 'auto',
  sidebarTexturePosition: 'center',
  characterHeight: 'clamp(560px, 96vh, 1180px)',
  characterBottom: 'clamp(-34px, -2.4vh, -12px)',
  characterOpacity: 0.92,
  borderRadius: '0px',
};
