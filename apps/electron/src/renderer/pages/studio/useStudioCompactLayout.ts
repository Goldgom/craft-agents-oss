import { useEffect, useRef, useState } from 'react'
import { useContainerWidth } from '@/hooks/useContainerWidth'

export function studioCompactLayout(width: number, height: number, android = false) {
  return android || width < 1000 || (width <= 1100 && height < 500)
}

/** Measure the workspace, including narrow desktop panes and rotated phones. */
export function useStudioCompactLayout() {
  const ref = useRef<HTMLDivElement>(null)
  const width = useContainerWidth(ref)
  const [height, setHeight] = useState(() => window.visualViewport?.height ?? window.innerHeight)
  useEffect(() => {
    const update = () => setHeight(window.visualViewport?.height ?? window.innerHeight)
    window.addEventListener('resize', update)
    window.visualViewport?.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('resize', update)
    }
  }, [])
  const android = new URLSearchParams(window.location.search).get('embedded') === 'android'
  return { ref, compact: studioCompactLayout(width || window.innerWidth, height, android) }
}
