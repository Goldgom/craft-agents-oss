/** Provider/SDK errors can echo secrets. Only expose a fixed, useful category. */
export function sanitizeMcpConnectionError(error: unknown): { needsAuth: boolean; message: string } {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = Number(record.code ?? record.status ?? record.statusCode);
  const detail = error instanceof Error ? error.message : '';
  const needsAuth = status === 401 || status === 403 || /\b401\b|\b403\b|unauthorized|forbidden|authentication/i.test(detail);
  const notFound = status === 404 || /\b404\b/.test(detail);
  return {
    needsAuth,
    message: needsAuth
      ? 'Authentication failed. Please re-authenticate with this source.'
      : notFound
        ? 'MCP server endpoint not found. The server may be offline or the URL may be incorrect.'
        : 'Failed to connect to the MCP server. Check its endpoint and configuration, then retry.',
  };
}
