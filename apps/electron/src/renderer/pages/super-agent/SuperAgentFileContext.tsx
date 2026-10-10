import { useMemo, type ReactNode } from 'react'
import { PlatformProvider, usePlatform, type PlatformActions } from '@craft-agent/ui/context'
import { resolveSessionFileLink } from '../../lib/session-data-link'

/** Every team surface shares the environment's file context, independently of
 * the ordinary chat session currently selected in the application. */
export function SuperAgentFileContext({ workingDirectory, children }: {
  workingDirectory?: string
  children: ReactNode
}) {
  const parent = usePlatform()
  const actions = useMemo<PlatformActions>(() => {
    const resolve = (path: string) => resolveSessionFileLink(path, workingDirectory, undefined, '')
    return {
      ...parent,
      resolveFilePath: resolve,
      onOpenFile: parent.onOpenFile && (path => parent.onOpenFile!(resolve(path))),
      onOpenFileExternal: parent.onOpenFileExternal && (path => parent.onOpenFileExternal!(resolve(path))),
      onRevealInFinder: parent.onRevealInFinder && (path => parent.onRevealInFinder!(resolve(path))),
      onReadFile: parent.onReadFile && (path => parent.onReadFile!(resolve(path))),
      onReadFileDataUrl: parent.onReadFileDataUrl && (path => parent.onReadFileDataUrl!(resolve(path))),
      onReadFileBinary: parent.onReadFileBinary && (path => parent.onReadFileBinary!(resolve(path))),
    }
  }, [parent, workingDirectory])
  return <PlatformProvider actions={actions}>{children}</PlatformProvider>
}
