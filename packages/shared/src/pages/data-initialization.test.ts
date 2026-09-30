import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPageDataWriterScript } from './data-write.ts';

type Writer = 'one-shot writer' | 'refresh data store';

/**
 * Hold a real rollback-journal RESERVED lock. A concurrent WAL switch needs a
 * lock upgrade and returns SQLITE_BUSY immediately, bypassing busy_timeout.
 * Release only after the child reports that actual error, not after a sleep.
 * The observation shim runs in the child and never substitutes a SQLite result.
 */
async function initializeUnderLock(writer: Writer, releaseOnBusy: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'page-data-initialization-'));
  const dbPath = join(dir, 'store.sqlite');
  const snapshotPath = join(dir, 'snapshot.json');
  const holder = new Database(dbPath);
  let locked = false;
  const release = () => {
    if (locked) {
      holder.exec('ROLLBACK;');
      locked = false;
    }
  };

  try {
    holder.exec('CREATE TABLE initialization_lock (id INTEGER); BEGIN IMMEDIATE;');
    locked = true;
    const writerPath = join(dir, 'writer.ts');
    writeFileSync(writerPath, writer === 'one-shot writer'
      ? buildPageDataWriterScript({
        dbPath,
        snapshotPath,
        patch: { set: { initialized: true }, appendSeries: { ticks: [{ t: 1, v: 7 }] } },
        maxPointsPerSeries: 100,
        maxKvKeys: 100,
        maxSeries: 100,
      })
      : `
        import { PageDataStore } from ${JSON.stringify(new URL('./data-store.ts', import.meta.url).href)};
        const store = new PageDataStore(${JSON.stringify(dbPath)}, ${JSON.stringify(snapshotPath)});
        store.kvSet('initialized', true);
        store.seriesAppend('ticks', { t: 1, v: 7 });
        store.exportSnapshot();
        store.close();
      `);

    const bootstrapPath = join(dir, 'observe-initialization.ts');
    writeFileSync(bootstrapPath, `
      import { Database } from 'bun:sqlite';
      const originalExec = Database.prototype.exec;
      const originalClose = Database.prototype.close;
      let busyCount = 0;
      let walAttempts = 0;
      let closeCount = 0;
      Database.prototype.exec = function(sql) {
        if (sql === 'PRAGMA journal_mode = WAL;') walAttempts++;
        try { return originalExec.call(this, sql); }
        catch (error) {
          if (error.code === 'SQLITE_BUSY') {
            busyCount++;
            process.stdout.write('INITIALIZATION_BUSY\\n');
          }
          throw error;
        }
      };
      Database.prototype.close = function(...args) {
        closeCount++;
        return originalClose.apply(this, args);
      };
      const started = performance.now();
      let errorCode;
      try { await import(${JSON.stringify(pathToFileURL(writerPath).href)}); }
      catch (error) {
        errorCode = error.code;
        process.exitCode = 1;
      }
      console.log('INITIALIZATION_RESULT ' + JSON.stringify({
        busyCount, walAttempts, closeCount, errorCode, elapsedMs: performance.now() - started,
      }));
    `);

    const child = Bun.spawn([process.execPath, bootstrapPath], { stdout: 'pipe', stderr: 'pipe' });
    // Safety net for a broken/unbounded implementation; not synchronization.
    const watchdog = setTimeout(() => child.kill(), 12_000);
    let stdout = '';
    try {
      const drainStdout = (async () => {
        for await (const chunk of child.stdout) {
          stdout += new TextDecoder().decode(chunk);
          if (releaseOnBusy && stdout.includes('INITIALIZATION_BUSY\n')) release();
        }
      })();
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        drainStdout,
      ]);
      release();
      const resultLine = stdout.split('\n').find((line) => line.startsWith('INITIALIZATION_RESULT '));
      if (!resultLine) throw new Error(`Writer did not finish initialization (${exitCode}): ${stderr}`);
      const metrics = JSON.parse(resultLine.slice('INITIALIZATION_RESULT '.length)) as {
        busyCount: number;
        walAttempts: number;
        closeCount: number;
        errorCode?: string;
        elapsedMs: number;
      };
      const snapshot = existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, 'utf-8')) : null;
      const tables = holder.query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).all().map((row) => row.name);
      const integrity = holder.query<{ integrity_check: string }, []>('PRAGMA integrity_check;').get();
      return { exitCode, stderr, metrics, snapshot, tables, integrity };
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
    }
  } finally {
    release();
    holder.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('page data initialization under real SQLite contention', () => {
  for (const writer of ['one-shot writer', 'refresh data store'] as const) {
    it(`${writer} retries the WAL lock upgrade and preserves the complete write`, async () => {
      const result = await initializeUnderLock(writer, true);
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
      expect(result.metrics.busyCount).toBeGreaterThanOrEqual(1);
      expect(result.metrics.walAttempts).toBeGreaterThanOrEqual(2);
      expect(result.metrics.closeCount).toBe(1);
      expect(result.snapshot.kv).toEqual({ initialized: true });
      expect(result.snapshot.series).toEqual({ ticks: [{ t: 1, v: 7 }] });
      expect(result.integrity).toEqual({ integrity_check: 'ok' });
    });

    it(`${writer} stops retrying a held lock and closes without applying user data`, async () => {
      const result = await initializeUnderLock(writer, false);
      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(1);
      expect(result.metrics.errorCode).toBe('SQLITE_BUSY');
      expect(result.metrics.walAttempts).toBeGreaterThanOrEqual(2);
      expect(result.metrics.closeCount).toBe(1);
      expect(result.metrics.elapsedMs).toBeGreaterThanOrEqual(4900);
      expect(result.metrics.elapsedMs).toBeLessThan(9000);
      expect(result.snapshot).toBeNull();
      expect(result.tables).toEqual(['initialization_lock']);
      expect(result.integrity).toEqual({ integrity_check: 'ok' });
    }, 15_000);
  }
});
