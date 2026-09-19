const unsupported = () => {
  throw new Error(
    'Claude Code cannot run locally on Android. Use a remote TokenBird server for Claude sessions.',
  )
}

export const query = unsupported
export const createSdkMcpServer = unsupported
export const tool = unsupported

export class AbortError extends Error {
  constructor(message = 'Operation aborted') {
    super(message)
    this.name = 'AbortError'
  }
}
