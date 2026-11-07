# Fork branches and offline Win7 builds

## Branch layout

- `main` is preserved unchanged.
- `TokenBird` combines Linux sharp native packaging and messaging localization. The multilingual interface (including Korean) is already included in upstream `TokenBird`.
- `codex/win7-compat-installers` is based on the fork's `TokenBird`, with the Win7 compatibility layer and offline installers on top.
- Original feature branches remain available; they are not deleted by consolidation.

Upstream: `https://github.com/Goldgom/craft-agents-oss.git` (`origin`).
Fork: `https://github.com/Ganyu-1202/craft-agents-oss.git` (`fork`).

To synchronize again, first save the old fork TokenBird tip, fetch upstream, rebase TokenBird onto `origin/TokenBird`, then rebase the Win7-only commits using `git rebase --onto TokenBird <old-fork-TokenBird-tip> codex/win7-compat-installers`. Review conflicts rather than replacing whole upstream files. Push rewritten Win7 history only with an explicit `--force-with-lease` expected old remote tip. Do not push changes to upstream or `main`.

## Offline dependencies

The six original files in `win7_dependencies/` total about 407 MiB. Public GitHub forks reject new LFS objects, so files over 50 MiB are stored as 40 MiB ordinary Git parts. `files.json` records original sizes and SHA-256 hashes. The installer build automatically restores the original files, or run `bun scripts/restore-win7-dependencies.ts`. Reconstructed originals are ignored by Git. Dependency hashes and archive layouts are validated by `scripts/prepare-win7-dependencies.ts` before they are embedded in NSIS.

Use `bun install --frozen-lockfile`, then `bun run win7:local:dist` on Windows. Electron 22.3.27 is the Win7 runtime. Both EXE and MSI are emitted under `apps/win7-local/release/`.

The MSI wraps the exact interactive NSIS EXE, not an independent application-only MSI. Thus both formats contain all six offline dependencies, keep the same optional selection and archive destination/PATH controls, and run external installers as the current user. MSI is not intended as a silent enterprise deployment package. The MSI validation hook rejects silent arguments or elevated impersonation changes. Building installers does not install these external tools on the build host.

Bundling the original JDK 21, Node 18, Git, or UCRT MinGW payloads does **not** establish their Windows 7 compatibility. Existing installer warnings remain in place; optional tools are not selected by default. Validate on a real Win7 x64 machine before deployment.

## Checks

- `bun test scripts/win7-client.test.ts scripts/win7-local.test.ts scripts/win7-dependencies.test.ts`
- `bun run webui:typecheck`
- `node scripts/run-win7-local-smoke.cjs`
- `node scripts/run-win7-local-smoke.cjs --packaged-app`
- `bun scripts/verify-win7-installer.ts` checks the final EXE for byte-identical offline payloads and x64 architecture.

Linux AppImage: build `TokenBird` using `bun run build:linux:wsl` on Windows with an x64 Linux WSL distribution, or `bun run build:all linux` on Linux. Use an isolated worktree when building both branches concurrently. Proxy variables for WSL downloads must be forwarded with `WSLENV` when required by the host network.
