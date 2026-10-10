export const BIRD_WIDTH = 236
export const BIRD_HEIGHT = 200
export const BUBBLE_WIDTH = 320
export const BUBBLE_HEIGHT = 144
const EDGE_GAP = 16
const BUBBLE_GAP = 8

interface Bounds { x: number; y: number; width: number; height: number }

export function defaultBirdBounds(area: Bounds): Bounds {
  return {
    x: Math.max(area.x, area.x + area.width - BIRD_WIDTH - EDGE_GAP),
    y: Math.max(area.y, area.y + area.height - BIRD_HEIGHT - EDGE_GAP),
    width: BIRD_WIDTH, height: BIRD_HEIGHT,
  }
}

/** Keep the bubble above the bird, or beside it when the bird is near the top. */
export function bubbleBounds(bird: Bounds, area: Bounds, height: number): Bounds {
  let x = bird.x + bird.width - BUBBLE_WIDTH
  let y = bird.y - height - BUBBLE_GAP
  if (y < area.y) {
    x = bird.x - BUBBLE_WIDTH - BUBBLE_GAP
    if (x < area.x) x = bird.x + bird.width + BUBBLE_GAP
    y = bird.y
  }
  return {
    x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - BUBBLE_WIDTH))),
    y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))),
    width: BUBBLE_WIDTH, height,
  }
}
