import { createRoot } from 'react-dom/client'
import { ServerDirectoryBrowser } from '../../../electron/src/renderer/components/ServerDirectoryBrowser'
import { ModalProvider } from '../../../electron/src/renderer/context/ModalContext'

/** Browse the active server's filesystem, including the on-device Bun runtime. */
export function pickServerDirectory(initialPath?: string): Promise<string | null> {
  return new Promise(resolve => {
    const container = document.createElement('div'); document.body.appendChild(container)
    const root = createRoot(container)
    const finish = (path: string | null) => {
      root.unmount(); container.remove(); resolve(path)
    }
    root.render(<ModalProvider><ServerDirectoryBrowser open mode="browse" initialPath={initialPath}
      onSelect={finish} onCancel={() => finish(null)} /></ModalProvider>)
  })
}
