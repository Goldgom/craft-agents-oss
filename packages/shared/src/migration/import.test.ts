import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { moveFileIntoPlace } from './import.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('moveFileIntoPlace', () => {
  it('publishes through a destination-local temporary file and removes the source', () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'craft-import-source-'));
    const destDir = mkdtempSync(join(tmpdir(), 'craft-import-dest-'));
    tempDirs.push(sourceDir, destDir);

    const source = join(sourceDir, 'preferences.json');
    const destination = join(destDir, 'preferences.json');
    writeFileSync(source, '{"theme":"dark"}', 'utf8');

    moveFileIntoPlace(source, destination);

    expect(existsSync(source)).toBe(false);
    expect(readFileSync(destination, 'utf8')).toBe('{"theme":"dark"}');
    expect(readdirSync(destDir).filter((name) => name.includes('.craft-import-'))).toEqual([]);
  });
});
