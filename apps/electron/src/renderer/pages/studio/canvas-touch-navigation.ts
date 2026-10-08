import type { Point } from './canvas-engine'

export type CanvasView = Point & { zoom: number }
type Pinch = { center: Point; distance: number; view: CanvasView }

function geometry(points: Map<number, Point>) {
  const [a, b] = [...points.values()]
  return {
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
  }
}

/** Two fingers navigate regardless of the editing tool. Keep ownership until
 * every finger lifts so the remaining finger cannot start an accidental edit. */
export class CanvasTouchNavigation {
  private points = new Map<number, Point>()
  private pinch: Pinch | null = null
  navigating = false

  has(id: number) { return this.points.has(id) }

  down(id: number, point: Point, view: CanvasView): boolean {
    this.points.set(id, point)
    const started = this.points.size >= 2 && !this.navigating
    if (this.points.size >= 2) {
      this.navigating = true
      this.rebase(view)
    }
    return started
  }

  move(id: number, point: Point): CanvasView | null {
    if (!this.points.has(id)) return null
    this.points.set(id, point)
    if (!this.pinch || this.points.size < 2) return null
    const { center, distance } = geometry(this.points)
    const { view, center: origin, distance: initialDistance } = this.pinch
    const zoom = Math.max(0.1, Math.min(4, view.zoom * distance / initialDistance))
    return {
      x: center.x - (origin.x - view.x) / view.zoom * zoom,
      y: center.y - (origin.y - view.y) / view.zoom * zoom,
      zoom,
    }
  }

  up(id: number, view: CanvasView) {
    if (!this.points.delete(id)) return
    this.rebase(view)
    if (!this.points.size) this.navigating = false
  }

  private rebase(view: CanvasView) {
    this.pinch = this.points.size >= 2 ? { ...geometry(this.points), view: { ...view } } : null
  }
}
