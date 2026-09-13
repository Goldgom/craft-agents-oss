/**
 * Centralized branding assets for TokenBird
 * Used by OAuth callback pages
 */

export const CRAFT_LOGO = [
  'TokenBird',
  '词元鸟',
] as const;

/** Logo as a single string for HTML templates */
export const CRAFT_LOGO_HTML = CRAFT_LOGO.map((line) => line.trimEnd()).join('\n');

/** Session viewer base URL */
export const VIEWER_URL = 'https://thecraftagents.com';
