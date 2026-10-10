export {}

declare global {
  interface Window {
    TokenBirdDesktop?: {
      versions: { node: string; chrome: string; electron: string }
      invoke(method: string, ...args: any[]): Promise<any>
      on(event: string, callback: (...args: any[]) => void): () => void
      getFilePath(file: File): string | null
    }
    TokenBirdRemote?: {
      getConnection(): Promise<{ serverUrl: string; token?: string; workspaceId?: string; mode?: 'local' | 'remote' }>
      configureServer(): Promise<void>
      openExternal(url: string): Promise<void>
    }
  }
}
