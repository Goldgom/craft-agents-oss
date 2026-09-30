/** Native authority is derived only from Electron objects, never WS claims. */
export interface NativeFrameIdentity {
  url: string
  processId: number
  routingId: number
}

export interface NativeWebContentsIdentity {
  id: number
  mainFrame: NativeFrameIdentity
  getURL(): string
  isDestroyed(): boolean
}

export interface NativeAuthorityEvent {
  sender: NativeWebContentsIdentity
  senderFrame: NativeFrameIdentity | null
}

interface NativeWindowRegistry {
  getWindowByWebContentsId(id: number): unknown
  getWorkspaceForWindow(id: number): string | null | undefined
}

const bindingEpochs = new WeakMap<object, number>()

export function advanceNativeWindowBinding(sender: object): void {
  bindingEpochs.set(sender, (bindingEpochs.get(sender) ?? 0) + 1)
}

function documentIdentity(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['file:', 'http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    url.search = ''
    url.hash = ''
    return url.href
  } catch { return null }
}

export function createNativeWindowAuthority(registry: NativeWindowRegistry, trustedAppUrls: readonly string[], options: { allowUnboundWorkspace?: boolean } = {}) {
  const documents = new Set(trustedAppUrls.map(documentIdentity).filter((url): url is string => !!url))
  return (event: NativeAuthorityEvent) => {
    const sender = event.sender
    const window = registry.getWindowByWebContentsId(sender?.id) as {
      webContents?: NativeWebContentsIdentity
      isDestroyed?: () => boolean
    } | null
    if (!sender || sender.isDestroyed() || !window || window.isDestroyed?.()
      || window.webContents !== sender || !event.senderFrame || event.senderFrame !== sender.mainFrame
      || !documents.has(documentIdentity(event.senderFrame.url) ?? '')
      || (sender.getURL() !== '' && documentIdentity(event.senderFrame.url) !== documentIdentity(sender.getURL()))) {
      throw new Error('This action requires a trusted application window')
    }
    const workspaceId = registry.getWorkspaceForWindow(sender.id)
    if (workspaceId == null || (!workspaceId && !options.allowUnboundWorkspace)) throw new Error('This action requires a registered workspace window')
    return {
      webContentsId: sender.id,
      workspaceId,
      bindingId: `${sender.id}:${sender.mainFrame.processId}:${sender.mainFrame.routingId}:${bindingEpochs.get(sender) ?? 0}:${workspaceId}`,
    }
  }
}
