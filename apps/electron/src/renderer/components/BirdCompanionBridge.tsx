import { useEffect } from 'react'
import { toBirdProgressEvent } from '../../shared/bird-companion'

/** Forward remote progress to the client-local companion. Local duplicates are idempotent. */
export function BirdCompanionBridge() {
  useEffect(() => {
    if (!window.electronAPI.observeBirdCompanionProgress) return
    return window.electronAPI.onSessionEvent(event => {
      const progress = toBirdProgressEvent(event)
      if (progress) void window.electronAPI.observeBirdCompanionProgress?.(progress).catch(error => {
        console.warn('[bird-companion] Progress unavailable:', error)
      })
    })
  }, [])
  return null
}
