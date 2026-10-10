import { describe, expect, it } from 'bun:test'
import { CanvasTouchNavigation } from './canvas-touch-navigation'

describe('canvas touch navigation', () => {
  it('zooms around the fingers and pans their shared canvas anchor', () => {
    const touch = new CanvasTouchNavigation()
    const view = { x: 30, y: 40, zoom: 2 }
    expect(touch.down(1, { x: 100, y: 150 }, view)).toBe(false)
    expect(touch.move(1, { x: 100, y: 150 })).toBeNull()
    expect(touch.down(2, { x: 200, y: 150 }, view)).toBe(true)
    touch.move(1, { x: 70, y: 180 })
    const next = touch.move(2, { x: 270, y: 180 })!
    expect(next).toEqual({ x: -70, y: -40, zoom: 4 })
    expect((170 - next.x) / next.zoom).toBe((150 - view.x) / view.zoom)
    expect((180 - next.y) / next.zoom).toBe((150 - view.y) / view.zoom)
  })

  it('limits zoom while preserving the anchor', () => {
    const touch = new CanvasTouchNavigation()
    const view = { x: 0, y: 0, zoom: 1 }
    touch.down(1, { x: 0, y: 0 }, view)
    touch.down(2, { x: 100, y: 0 }, view)
    const small = touch.move(2, { x: 1, y: 0 })!
    expect(small.zoom).toBe(0.1)
    expect((0.5 - small.x) / small.zoom).toBeCloseTo(50)
    const large = touch.move(2, { x: 1000, y: 0 })!
    expect(large.zoom).toBe(4)
    expect((500 - large.x) / large.zoom).toBeCloseTo(50)
  })

  it('does not resume editing when one finger lifts or is cancelled', () => {
    const touch = new CanvasTouchNavigation()
    const view = { x: 0, y: 0, zoom: 1 }
    touch.down(1, { x: 0, y: 0 }, view)
    touch.down(2, { x: 100, y: 0 }, view)
    touch.up(2, view)
    expect(touch.navigating).toBe(true)
    expect(touch.move(1, { x: 20, y: 0 })).toBeNull()
    expect(touch.down(3, { x: 120, y: 0 }, view)).toBe(false)
    expect(touch.move(3, { x: 120, y: 0 })).toEqual(view)
    touch.up(1, view)
    touch.up(3, view)
    expect(touch.navigating).toBe(false)
    expect(touch.down(4, { x: 10, y: 10 }, view)).toBe(false)
  })

  it('rebases when a third finger replaces a captured finger without jumping', () => {
    const touch = new CanvasTouchNavigation()
    const view = { x: 10, y: 20, zoom: 1 }
    touch.down(1, { x: 0, y: 0 }, view)
    touch.down(2, { x: 100, y: 0 }, view)
    const next = touch.move(2, { x: 200, y: 0 })!
    touch.down(3, { x: 50, y: 100 }, next)
    expect(touch.move(3, { x: 50, y: 100 })).toEqual(next)
    touch.up(1, next)
    expect(touch.move(2, { x: 200, y: 0 })).toEqual(next)
    touch.up(999, next)
    expect(touch.move(999, { x: 0, y: 0 })).toBeNull()
  })

  it('keeps coincident contacts finite', () => {
    const touch = new CanvasTouchNavigation()
    const view = { x: 0, y: 0, zoom: 1 }
    touch.down(1, { x: 50, y: 50 }, view)
    touch.down(2, { x: 50, y: 50 }, view)
    expect(touch.move(2, { x: 50, y: 50 })).toEqual(view)
  })
})
