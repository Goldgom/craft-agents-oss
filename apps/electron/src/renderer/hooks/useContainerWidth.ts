import { useState, useEffect, type RefObject } from 'react'

/**
 * Read the inline size across ResizeObserver implementations.
 *
 * Chromium exposes contentBoxSize as an array, while older Safari versions
 * expose a single object (and some older WebViews only expose contentRect).
 */
export function getResizeObserverInlineSize(entry: ResizeObserverEntry): number {
  const boxSize = entry.contentBoxSize as ResizeObserverSize[] | ResizeObserverSize | undefined
  const firstBox = Array.isArray(boxSize) ? boxSize[0] : boxSize
  return firstBox?.inlineSize ?? entry.contentRect.width
}

/**
 * Tracks the inline-size (width) of a DOM element using ResizeObserver.
 *
 * Used by AppShell to derive `isAutoCompact` — when the shell container
 * is narrower than the mobile threshold, sidebar/navigator auto-collapse
 * and panels switch to single-panel mode.
 *
 * Returns 0 until the element is first measured.
 */
export function useContainerWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const updateFromElement = () => setWidth(el.getBoundingClientRect().width)
    updateFromElement()

    // ResizeObserver is absent in older embedded WebViews. Window resize is a
    // sufficient fallback for AppShell because the observed element fills the
    // application viewport.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateFromElement)
      return () => window.removeEventListener('resize', updateFromElement)
    }

    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(getResizeObserverInlineSize(entry))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])

  return width
}
