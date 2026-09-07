import { describe, expect, it } from 'bun:test';
import { getReleaseNotesList, isReleaseNoteFilename } from './index.ts';

describe('release notes loader', () => {
  it('treats only X.Y.Z.md files as release notes', () => {
    expect(isReleaseNoteFilename('0.13.1.md')).toBe(true);
    expect(isReleaseNoteFilename('10.0.12.md')).toBe(true);
    // next.md is the pending-notes template that ships alongside the versioned files.
    expect(isReleaseNoteFilename('next.md')).toBe(false);
    expect(isReleaseNoteFilename('README.md')).toBe(false);
    expect(isReleaseNoteFilename('0.13.md')).toBe(false);
    expect(isReleaseNoteFilename('0.13.1.md.bak')).toBe(false);
    expect(isReleaseNoteFilename('v0.13.1.md')).toBe(false);
  });

  it('never surfaces a non-semver version in the What\'s New list', () => {
    // Resolves against whichever notes directory exists on this machine (bundled
    // resources or ~/.craft-agent/release-notes); an empty list is fine.
    for (const note of getReleaseNotesList()) {
      expect(note.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
