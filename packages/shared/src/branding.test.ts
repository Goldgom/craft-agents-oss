import { describe, expect, it } from 'bun:test';
import { getLocalizedProductName } from './branding.ts';

describe('getLocalizedProductName', () => {
  it('uses the Chinese product name for Simplified and Traditional Chinese locales', () => {
    expect(getLocalizedProductName('zh-Hans')).toBe('词元鸟');
    expect(getLocalizedProductName('zh-CN')).toBe('词元鸟');
    expect(getLocalizedProductName('zh-Hant')).toBe('词元鸟');
    expect(getLocalizedProductName('zh-TW')).toBe('词元鸟');
  });

  it('keeps TokenBird for non-Chinese or unknown locales', () => {
    expect(getLocalizedProductName('en-US')).toBe('TokenBird');
    expect(getLocalizedProductName('ja')).toBe('TokenBird');
    expect(getLocalizedProductName(undefined)).toBe('TokenBird');
  });
});
