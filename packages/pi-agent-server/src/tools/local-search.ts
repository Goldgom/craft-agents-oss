import { spawn } from 'node:child_process';
import { basename, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Type, type Static } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

const SEARCH_TIMEOUT_SECONDS = 15;
const MAX_OUTPUT_BYTES = 50_000;
const EXCLUDED_DIRECTORIES = ['.git', '.deploy', 'node_modules', 'vendor', 'dist', 'build', '.build', '.build-all', '.toolchains', 'artifacts', '.tmp', '.cache', '.gocache', '.gomodcache', '.bun-cache', '.next', 'coverage'];

const common = {
  path: Type.Optional(Type.String({ description: 'Search directory or file; default current directory. Prefer a narrow source directory.' })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: 'Maximum output lines (default 100)' })),
  timeout: Type.Optional(Type.Number({ minimum: 0.001, maximum: 120, description: 'Timeout in seconds (default 15, maximum 120). Partial results are retained.' })),
  includeIgnored: Type.Optional(Type.Boolean({ description: 'Explicitly include ignored, dependency and build directories (default false). Binary contents are still skipped.' })),
};
const grepSchema = Type.Object({
  ...common,
  pattern: Type.String({ description: 'Regular expression or literal text to search for' }),
  glob: Type.Optional(Type.String({ description: 'File glob, e.g. *.go or src/**/*.tsx. Prefer path to narrow directories before scanning.' })),
  ignoreCase: Type.Optional(Type.Boolean()),
  literal: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
});
const findSchema = Type.Object({ ...common, pattern: Type.String({ description: 'File glob, e.g. *codex* or src/**/*.test.ts. Prefer path to narrow directories before scanning.' }) });

/** Direct rg child: cancellation never leaves a shell/pipeline running. */
export function runSearchProcess(
  executable: string,
  args: string[],
  cwd: string,
  options: { timeoutMs: number; limit: number; signal?: AbortSignal; acceptLine?: (line: string) => boolean },
): Promise<{ text: string; timedOut: boolean; limited: boolean; exitCode: number | null }> {
  return new Promise((resolveResult, reject) => {
    if (options.signal?.aborted) return reject(new Error('Search cancelled'));
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stderr = '';
    let timedOut = false;
    let limited = false;
    let aborted = false;
    let lines = 0;
    let pending = '';
    const stop = () => child.kill();
    const onAbort = () => { aborted = true; stop(); };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    // Cover cancellation between the initial check and listener installation.
    if (options.signal?.aborted) onAbort();
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const appendLine = (line: string) => {
      if (limited || (options.acceptLine && !options.acceptLine(line))) return;
      const text = (lines ? '\n' : '') + line;
      const remaining = MAX_OUTPUT_BYTES - Buffer.byteLength(output);
      let bounded = Buffer.from(text).subarray(0, remaining).toString('utf8');
      // A UTF-8 character cut at the byte boundary can become a replacement
      // character. Keep even that final fragment inside the byte budget.
      while (Buffer.byteLength(bounded) > remaining) bounded = bounded.slice(0, -1);
      output += bounded;
      lines++;
      if (lines >= options.limit || Buffer.byteLength(text) >= remaining) {
        limited = true;
        stop();
      }
    };
    child.stdout.on('data', (chunk: string) => {
      if (limited) return;
      const rows = (pending + chunk).split('\n');
      pending = rows.pop() || '';
      for (const row of rows) appendLine(row.replace(/\r$/, ''));
      if (!limited && Buffer.byteLength(pending) >= MAX_OUTPUT_BYTES) {
        appendLine(pending);
        pending = '';
        limited = true;
        stop();
      }
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, 4000); });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      if (aborted) return reject(new Error('Search cancelled'));
      if (pending && !limited) appendLine(pending);
      if (!timedOut && !limited && code !== 0 && code !== 1) {
        return reject(new Error(`Search failed (${code}): ${stderr.trim()}`));
      }
      resolveResult({ text: output.trimEnd(), timedOut, limited, exitCode: code });
    });
  });
}

export function createLocalSearchTools(cwd: string, ripgrepPath?: string): ToolDefinition<any, any>[] {
  return [grepSchema, findSchema].map((parameters, index) => {
    const find = index === 1;
    return {
      name: find ? 'find' : 'grep',
      label: find ? 'Find' : 'Grep',
      description: `${find ? 'Find files by glob' : 'Search file contents with ripgrep'}. Respects .gitignore and skips dependency, deployment and build directories by default. Use includeIgnored or an explicit file/directory path when those are needed. Default timeout 15 seconds; partial results survive timeout.`,
      promptSnippet: find ? 'Find source filenames before searching contents; bounded to 15 seconds by default.' : 'Search a narrow source directory with ripgrep; bounded to 15 seconds by default.',
      parameters,
      async execute(_id, input, signal, _onUpdate, ctx) {
        const params = input as Static<typeof grepSchema>;
        if (!ripgrepPath) throw new Error('Bundled ripgrep is unavailable. Use Bash with rg and an explicit timeout.');
        const base = ctx?.cwd || cwd;
        const inputPath = params.path?.replace(/^~(?=$|[\\/])/, homedir()) || '.';
        const searchPath = resolve(base, inputPath);
        const args = ['--no-config', '--hidden', '--color=never'];
        const glob = (find ? params.pattern : params.glob)?.replace(/\\/g, '/');
        // Positive --glob rules override .gitignore. Type filters narrow the
        // filenames without accidentally re-including ignored files.
        if (glob) args.push('--type-add', `tokenbird:${glob.split('/').pop() || '*'}`, '--type', 'tokenbird');
        if (find) args.push('--files');
        const explicitlyIgnoredPath = inputPath.split(/[\\/]/).some((part: string) => EXCLUDED_DIRECTORIES.includes(part));
        if (params.includeIgnored || explicitlyIgnoredPath) args.push('--no-ignore');
        else for (const dir of EXCLUDED_DIRECTORIES) args.push('--glob', `!**/${dir}/**`);
        if (!find) {
          args.push('--line-number', '--with-filename', '--max-columns=500', '--max-columns-preview');
          if (params.ignoreCase) args.push('--ignore-case');
          if (params.literal) args.push('--fixed-strings');
          if (params.context) args.push('--context', String(params.context));
          args.push('--regexp', params.pattern);
        }
        args.push('--', searchPath);
        const timeout = params.timeout ?? SEARCH_TIMEOUT_SECONDS;
        const matcher = glob ? new Bun.Glob(glob) : undefined;
        const result = await runSearchProcess(ripgrepPath, args, base, {
          timeoutMs: timeout * 1000, limit: params.limit ?? 100, signal,
          acceptLine: matcher ? line => {
            const filePath = find ? line : line.match(/^(.*?)(?::\d+:|-\d+-)/)?.[1];
            if (!filePath) return false;
            const candidate = glob!.includes('/') ? relative(searchPath, filePath).replace(/\\/g, '/') : basename(filePath);
            return matcher.match(candidate);
          } : undefined,
        });
        const notices = [
          result.timedOut ? `Search timed out after ${timeout} seconds. Results are partial; narrow the path or glob before retrying.` : '',
          result.limited ? 'Output limit reached. Results are partial; narrow the path or glob.' : '',
        ].filter(Boolean);
        const text = [result.text || (notices.length ? 'No results collected before search stopped.' : 'No matches found.'), ...notices].join('\n\n');
        // Pi marks thrown failures as errors. Throw the partial results too so
        // both the model and UI receive the deadline notice and collected data.
        if (result.timedOut) throw new Error(text);
        return {
          content: [{ type: 'text' as const, text }],
          details: { partial: result.limited },
        };
      },
    };
  });
}
