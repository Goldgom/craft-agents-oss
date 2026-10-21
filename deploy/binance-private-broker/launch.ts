import { getCredentialManager } from '../../packages/shared/src/credentials/index.ts';

// This trusted service reads the named vault entry directly. Secrets exist only
// in the Python child's environment; neither arguments nor files contain them.
try {
  const workspaceId = process.env.TOKENBIRD_BROKER_WORKSPACE_ID;
  const name = process.env.TOKENBIRD_BROKER_CREDENTIAL_NAME;
  const python = process.env.TOKENBIRD_BROKER_PYTHON;
  const script = process.env.TOKENBIRD_BROKER_SCRIPT;
  if (!workspaceId || !name || !python || !script) throw new Error();
  const credential = await getCredentialManager().get({ type: 'saved_credential', workspaceId, name });
  if (!credential?.username || !credential.value) throw new Error();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    PYTHONUNBUFFERED: '1',
    TB_CRED_BINANCE_KEY: credential.username,
    TB_CRED_BINANCE_SECRET: credential.value,
  };
  for (const key of ['NOTIFY_SOCKET', 'WATCHDOG_USEC']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  const child = Bun.spawn([python, script], { env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
  const code = await child.exited;
  console.error(`[credential-broker] Process exited (${code}); supervisor will recover it.`);
  process.exit(code || 1);
} catch {
  console.error('[credential-broker] Startup failed; check service paths and the named workspace credential.');
  process.exit(1);
}
