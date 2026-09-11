import { describe, expect, test } from 'bun:test'
import { getResizeObserverInlineSize } from '../useContainerWidth'

function entryWith(
  contentBoxSize: ResizeObserverSize[] | ResizeObserverSize | undefined,
  contentRectWidth: number,
): ResizeObserverEntry {
  return {
    contentBoxSize,
    contentRect: { width: contentRectWidth },
  } as unknown as ResizeObserverEntry
}

describe('getResizeObserverInlineSize', () => {
  test('reads the modern array form', () => {
    expect(getResizeObserverInlineSize(entryWith([{ inlineSize: 640 } as ResizeObserverSize], 1))).toBe(640)
  })

  test('reads the legacy Safari object form', () => {
    expect(getResizeObserverInlineSize(entryWith({ inlineSize: 480 } as ResizeObserverSize, 1))).toBe(480)
  })

  test('falls back to contentRect for older WebViews', () => {
    expect(getResizeObserverInlineSize(entryWith(undefined, 360))).toBe(360)
  })
})
