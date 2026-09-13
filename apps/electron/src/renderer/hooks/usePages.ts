/**
 * usePages
 *
 * Loads workspace-scoped pages into `pagesAtom` and keeps them in sync via the
 * `pages:changed` broadcast (pushed whenever any page.json changes — create,
 * update, delete, content save, or a refresh-script run completing).
 *
 * Unlike `useProjects`, the atom is the ONLY state: consumers read
 * `pagesAtom` (or this hook's passthrough) and there is no duplicate local
 * list to drift.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { pagesAtom } from '@/atoms/pages'
import type { LoadedPage } from '@craft-agent/shared/pages/types'

export interface UsePagesResult {
  pages: LoadedPage[]
  refresh: () => Promise<void>
}

export function usePages(activeWorkspaceId: string | null | undefined): UsePagesResult {
  const pages = useAtomValue(pagesAtom)
  const setPages = useSetAtom(pagesAtom)
  // A push can arrive while an older remote GET is still in flight. Only the
  // newest request/event may commit, otherwise the stale GET can erase a page
  // until the next full application load.
  const revisionRef = useRef(0)
  const invalidatePending = useCallback(() => {
    ++revisionRef.current
  }, [])

  const refresh = useCallback(async () => {
    const revision = ++revisionRef.current
    if (!activeWorkspaceId) {
      if (revision === revisionRef.current) setPages([])
      return
    }
    try {
      const result = await window.electronAPI.getPages(activeWorkspaceId)
      if (revision === revisionRef.current) {
        setPages(Array.isArray(result) ? result : [])
      }
    } catch (err) {
      if (revision === revisionRef.current) {
        console.error('[usePages] Failed to load pages:', err)
        setPages([])
      }
    }
  }, [activeWorkspaceId, setPages])

  useEffect(() => {
    // Subscribe before the initial read so a page created during startup cannot
    // fall into the gap between GET and listener registration.
    if (!activeWorkspaceId) {
      void refresh()
      return
    }
    const off = window.electronAPI.onPagesChanged((wsId, list) => {
      if (wsId === activeWorkspaceId) {
        ++revisionRef.current
        setPages(Array.isArray(list) ? list : [])
      } else {
        // Backward compatibility with older servers/clients that do not yet
        // canonicalize and reverse-map remote workspace identities.
        void refresh()
      }
    })
    void refresh()
    return () => {
      invalidatePending()
      if (typeof off === 'function') off()
    }
  }, [activeWorkspaceId, setPages, refresh, invalidatePending])

  return { pages, refresh }
}
