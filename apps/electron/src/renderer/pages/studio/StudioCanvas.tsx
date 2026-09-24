import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Brush, Copy, Download, Eraser, Eye, EyeOff, Hand, History, ImagePlus, Layers3, LoaderCircle, Maximize2, MousePointer2, Plus, Redo2, Scan, Scissors, Settings2, SlidersHorizontal, Sparkles, Trash2, Undo2, WandSparkles, X, ZoomIn, ZoomOut } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { StudioConnectionPicker, useStudioConnections } from './useStudioConnections'
import { StudioImageConnectionDialog } from './StudioImageConnectionDialog'
import { GenerationImage, StudioGenerationHistory } from './StudioGenerationHistory'
import { listStudioGenerations, saveStudioGeneration, type StudioGeneration } from './studio-generation-history'
import { assessEditOutput, composeInpaint, composeOutpaint, fillTransparentForEdit, referenceCoverage, type EditOutputIssue } from './studio-image-composite'
import { classifyStudioConnectionError, type StudioConnectionIssue } from './studio-connection-error'
import { StudioSessionWorkspace, type StudioSessionEditorProps } from './StudioSessionWorkspace'
import { MAX_RASTER_SIDE, TILE_SIZE, captureTile, clearLayerRect, contentBounds, contentPixelBounds, createLayer, drawImageOnLayer, drawLayers, layerPixelBounds, normalizeRect, paintSegment, rasterizeRegion, removeEdgeBackground, restoreTiles, tileRange, unionRects, type CanvasLayer, type CanvasTool, type Point, type Rect, type TileSnapshot } from './canvas-engine'

const SIZE = 1024
const MAX_AI_CANVAS_PIXELS = 32_000_000
type AiMode = 'generate' | 'inpaint' | 'outpaint' | 'cutout'
type CandidateBatch = { records: StudioGeneration[]; target: Rect; context: Rect | null; reference: HTMLCanvasElement | null; layerId: string; mode: AiMode; prompt: string; savedCount: number; issues: Map<string, EditOutputIssue> }
const actionClass = 'inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:bg-accent disabled:opacity-40'
const iconClass = 'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40'
const sectionClass = 'space-y-3 border-b border-border/70 px-4 py-4'
type TileAction = { kind: 'tiles'; layerId: string; before: TileSnapshot; after: TileSnapshot }
type LayerAction = { kind: 'layers'; before: CanvasLayer[]; after: CanvasLayer[] }
type Action = TileAction | LayerAction | { kind: 'batch'; actions: Array<TileAction | LayerAction> }
type Gesture =
  | { kind: 'paint'; layerId: string; before: TileSnapshot; last: Point }
  | { kind: 'pan'; start: Point; origin: Point }
  | { kind: 'layer'; start: Point; layerId: string; origin: Point }
  | { kind: 'select'; start: Point }
  | { kind: 'selection-move' | 'selection-resize'; start: Point; original: Rect }

function cloneLayers(layers: CanvasLayer[]): CanvasLayer[] {
  return layers.map(layer => ({ ...layer, offset: { ...layer.offset }, tiles: new Map(layer.tiles) }))
}
function base64(canvas: HTMLCanvasElement) { return canvas.toDataURL('image/png').split(',')[1] }
function editIssueMessage(issue: EditOutputIssue) {
  return issue === 'black-fill'
    ? '模型把待补全区域生成成大片纯黑，结果未写入画布。请缩小选区或更换支持遮罩编辑的模型。'
    : '模型明显改动了遮罩要求保留的原图，无法可靠拼接，结果未写入画布。请更换支持遮罩编辑的模型。'
}
function saveFile(data: string | Blob, name: string) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data)
  const link = document.createElement('a'); link.href = url; link.download = name; link.click()
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
async function decode(url: string): Promise<HTMLImageElement> {
  const image = new Image(); image.src = url; await image.decode(); return image
}
function checkRect(rect: Rect, max = MAX_RASTER_SIDE) {
  if (rect.width < 2 || rect.height < 2 || rect.width > max || rect.height > max) throw new Error(`请框选 2–${max} 像素的区域；画布坐标不受限制`)
}
function square(rect: Rect, padding = 0): Rect {
  const size = Math.max(rect.width, rect.height) * (1 + padding * 2)
  return { x: rect.x + rect.width / 2 - size / 2, y: rect.y + rect.height / 2 - size / 2, width: size, height: size }
}
function pixelAligned(rect: Rect): Rect {
  const x = Math.floor(rect.x); const y = Math.floor(rect.y)
  return { x, y, width: Math.ceil(rect.x + rect.width) - x, height: Math.ceil(rect.y + rect.height) - y }
}
function rasterizeLayer(layer: CanvasLayer, rect: Rect, width: number, height: number): HTMLCanvasElement {
  return rasterizeRegion([{ ...layer, visible: true, opacity: 1 }], rect, width, height)
}

type CanvasProject = { version: number; activeId?: string; view?: { x: number; y: number; zoom: number }; prompt?: string; layers: Array<{ id: string; name: string; visible: boolean; opacity: number; offset: Point; tiles: Array<[string, string]> }> }

function serializeProject(layers: CanvasLayer[], activeId: string, view: { x: number; y: number; zoom: number }, prompt: string): string {
  const project: CanvasProject = { version: 1, activeId, view, prompt, layers: layers.map(layer => ({
    id: layer.id, name: layer.name, visible: layer.visible, opacity: layer.opacity, offset: layer.offset,
    tiles: [...layer.tiles].map(([key, canvas]) => [key, canvas.toDataURL('image/png')]),
  })) }
  return JSON.stringify(project)
}

async function parseProject(raw: string): Promise<{ project: CanvasProject; layers: CanvasLayer[] }> {
  const project = JSON.parse(raw) as CanvasProject
  if (project.version !== 1 || !Array.isArray(project.layers) || !project.layers.length || project.layers.length > 100) throw new Error('无效的画布工程')
  const next: CanvasLayer[] = []; let count = 0
  for (const entry of project.layers) {
    if (!entry || typeof entry.name !== 'string' || !Array.isArray(entry.tiles) || entry.tiles.length > 1024 || !Number.isFinite(entry.offset?.x) || !Number.isFinite(entry.offset?.y)) throw new Error('工程图层无效')
    const layer = createLayer(entry.name.slice(0, 80)); layer.id = entry.id || layer.id
    if (!Number.isFinite(entry.opacity)) throw new Error('工程图层不透明度无效')
    layer.visible = entry.visible !== false; layer.opacity = Math.max(0, Math.min(1, entry.opacity))
    layer.offset = entry.offset
    for (const [key, data] of entry.tiles) {
      if (typeof key !== 'string' || !/^-?\d+,-?\d+$/.test(key) || typeof data !== 'string' || !data.startsWith('data:image/png;base64,') || ++count > 4096) throw new Error('工程图块无效')
      const image = await decode(data)
      if (image.naturalWidth !== TILE_SIZE || image.naturalHeight !== TILE_SIZE) throw new Error('工程图块尺寸无效')
      const tile = document.createElement('canvas'); tile.width = TILE_SIZE; tile.height = TILE_SIZE
      tile.getContext('2d')!.drawImage(image, 0, 0); layer.tiles.set(key, tile)
    }
    next.push(layer)
  }
  return { project, layers: next }
}

export default function StudioCanvas({ active = true, onOpenAiSettings }: { active?: boolean; onOpenAiSettings: () => void }) {
  return <StudioSessionWorkspace mode="canvas">{sessionProps => <CanvasEditor key={sessionProps.session.id} {...sessionProps} active={active} onOpenAiSettings={onOpenAiSettings} />}</StudioSessionWorkspace>
}

function CanvasEditor({ active, onOpenAiSettings, session, onSave, createSession, flushRef, setLocked, suggestTitle }: StudioSessionEditorProps & { active: boolean; onOpenAiSettings: () => void }) {
  const [layers, setLayers] = useState<CanvasLayer[]>(() => [createLayer()])
  const layersRef = useRef(layers); layersRef.current = layers
  const [activeId, setActiveId] = useState(() => layers[0].id)
  const [tool, setTool] = useState<CanvasTool>('ai')
  const [selection, setSelection] = useState<Rect | null>(null)
  const selectionRef = useRef(selection); selectionRef.current = selection
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const viewRef = useRef(view); viewRef.current = view
  const [size, setSize] = useState({ width: 1, height: 1 })
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 })
  const [color, setColor] = useState('#f5f5f4')
  const [brush, setBrush] = useState(18)
  const [tolerance, setTolerance] = useState(32)
  const [brightness, setBrightness] = useState(100)
  const [contrast, setContrast] = useState(100)
  const [prompt, setPrompt] = useState('')
  const [aiMode, setAiMode] = useState<AiMode>('generate')
  const [generationCount, setGenerationCount] = useState(1)
  const [generationWidth, setGenerationWidth] = useState(1024)
  const [generationHeight, setGenerationHeight] = useState(1024)
  const [candidates, setCandidates] = useState<CandidateBatch | null>(null)
  const [candidateIndex, setCandidateIndex] = useState(0)
  const [recentRecords, setRecentRecords] = useState<StudioGeneration[]>([])
  const [recentVisible, setRecentVisible] = useState(() => sessionStorage.getItem('tokenbird.studio.recentPreviewHidden') !== '1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [historyRevision, setHistoryRevision] = useState(0)
  const [setupDone, setSetupDone] = useState(() => localStorage.getItem('tokenbird.studio.imageSetupDone') === '1')
  const [setupDismissed, setSetupDismissed] = useState(() => sessionStorage.getItem('tokenbird.studio.imageSetupDismissed') === '1')
  const [connectionSettingsOpen, setConnectionSettingsOpen] = useState(false)
  const [connectionIssue, setConnectionIssue] = useState<StudioConnectionIssue | null>(null)
  const viewElement = useRef<HTMLDivElement>(null)
  const canvasElement = useRef<HTMLCanvasElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const projectInput = useRef<HTMLInputElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const spaceHeld = useRef(false)
  const initialized = useRef(false)
  const undoStack = useRef<Action[]>([])
  const redoStack = useRef<Action[]>([])
  const hydrated = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, refreshHistory] = useState(0)
  const { connections, connection, connectionSlug, setConnectionSlug, model, setModel, channelGroup, setChannelGroup, groups, loaded, loginTokenNest, refresh } = useStudioConnections({ image: true })
  const imageReady = !!connection?.isAuthenticated && !!model.trim()
    && (connection.oauthProvider !== 'tokennest' || !!channelGroup)
  const setupOpen = active && loaded && (connectionSettingsOpen || !!connectionIssue || (!setupDismissed && (!setupDone || !imageReady)))
  const activeLayer = layers.find(layer => layer.id === activeId) ?? layers[layers.length - 1]
  const selected = !!selection && selection.width >= 2 && selection.height >= 2
  const activeIdRef = useRef(activeId); activeIdRef.current = activeId
  const promptRef = useRef(prompt); promptRef.current = prompt

  async function persist() {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (!hydrated.current) return
    await onSave(serializeProject(layersRef.current, activeIdRef.current, viewRef.current, promptRef.current))
  }
  useLayoutEffect(() => {
    flushRef.current = persist
    return () => { if (flushRef.current === persist) flushRef.current = null }
  })

  useEffect(() => {
    let alive = true
    void (async () => {
      if (session.data) {
        const restored = await parseProject(session.data)
        if (!alive) return
        replace(restored.layers)
        setActiveId(restored.layers.some(layer => layer.id === restored.project.activeId) ? restored.project.activeId! : restored.layers[restored.layers.length - 1].id)
        if (restored.project.view && Number.isFinite(restored.project.view.x) && Number.isFinite(restored.project.view.y) && Number.isFinite(restored.project.view.zoom)) {
          initialized.current = true
          setView({ ...restored.project.view, zoom: Math.max(0.1, Math.min(4, restored.project.view.zoom)) })
        }
        setPrompt(typeof restored.project.prompt === 'string' ? restored.project.prompt : '')
      }
      hydrated.current = true
    })().catch(cause => { if (alive) setError(`画布会话恢复失败：${String(cause)}`) })
    return () => { alive = false; hydrated.current = false; if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [session.id])

  useEffect(() => {
    if (!hydrated.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void persist().catch(cause => setError(`自动保存失败：${String(cause)}`)) }, 900)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [layers, activeId, view, prompt, onSave])

  useEffect(() => { setLocked(busy); return () => setLocked(false) }, [busy, setLocked])
  useEffect(() => {
    let alive = true
    void listStudioGenerations(5).then(page => { if (alive) setRecentRecords(page.items) }).catch(() => {})
    return () => { alive = false }
  }, [historyRevision])

  function replace(next: CanvasLayer[]) { layersRef.current = next; setLayers(next) }
  function record(action: Action) {
    undoStack.current = [...undoStack.current.slice(-19), action]
    redoStack.current = []; refreshHistory(value => value + 1)
  }
  function changeLayers(next: CanvasLayer[]) {
    record({ kind: 'layers', before: cloneLayers(layersRef.current), after: cloneLayers(next) })
    replace(next)
  }
  function finishTiles(layer: CanvasLayer, before: TileSnapshot) {
    if (!before.size) return
    const after: TileSnapshot = new Map()
    for (const key of before.keys()) after.set(key, captureTile(layer, key))
    record({ kind: 'tiles', layerId: layer.id, before, after }); replace([...layersRef.current])
  }
  function restore(action: Action, side: 'before' | 'after') {
    if (action.kind === 'batch') {
      for (const item of side === 'before' ? [...action.actions].reverse() : action.actions) restore(item, side)
    } else if (action.kind === 'layers') {
      const next = cloneLayers(action[side]); replace(next)
      setActiveId(id => next.some(layer => layer.id === id) ? id : next[next.length - 1].id)
    } else {
      const layer = layersRef.current.find(item => item.id === action.layerId)
      if (layer) { restoreTiles(layer, action[side]); replace([...layersRef.current]) }
    }
    refreshHistory(value => value + 1)
  }
  function undo() { const action = undoStack.current.pop(); if (action) { restore(action, 'before'); redoStack.current.push(action) } }
  function redo() { const action = redoStack.current.pop(); if (action) { restore(action, 'after'); undoStack.current.push(action) } }

  function screen(event: { clientX: number; clientY: number }): Point {
    const rect = viewElement.current?.getBoundingClientRect()
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
  }
  function world(point: Point): Point {
    const v = viewRef.current; return { x: (point.x - v.x) / v.zoom, y: (point.y - v.y) / v.zoom }
  }
  function visible(): Rect {
    const v = viewRef.current
    return { x: -v.x / v.zoom, y: -v.y / v.zoom, width: size.width / v.zoom, height: size.height / v.zoom }
  }
  function zoomAt(point: Point, next: number) {
    const target = world(point), zoom = Math.max(0.1, Math.min(4, next))
    setView({ x: point.x - target.x * zoom, y: point.y - target.y * zoom, zoom })
  }
  function fit() {
    const bounds = contentPixelBounds(layersRef.current)
    if (!bounds) { setView({ x: size.width / 2, y: size.height / 2, zoom: 1 }); return }
    const zoom = Math.max(0.1, Math.min(1.5, (size.width - 96) / bounds.width, (size.height - 96) / bounds.height))
    setView({ x: size.width / 2 - (bounds.x + bounds.width / 2) * zoom, y: size.height / 2 - (bounds.y + bounds.height / 2) * zoom, zoom })
  }
  useEffect(() => {
    const element = viewElement.current; if (!element) return
    const observer = new ResizeObserver(() => {
      const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight)
      setSize({ width, height })
      if (!initialized.current) { initialized.current = true; setView({ x: width / 2, y: height / 2, zoom: 1 }) }
    })
    observer.observe(element); return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const canvas = canvasElement.current; if (!canvas || !active) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const width = Math.max(1, Math.round(size.width * dpr)), height = Math.max(1, Math.round(size.height * dpr))
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height }
    const ctx = canvas.getContext('2d')!
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.x, dpr * view.y)
    drawLayers(ctx, layers, visible())
    if (selection?.width && selection.height) {
      ctx.setLineDash([7 / view.zoom, 5 / view.zoom]); ctx.lineWidth = 1.5 / view.zoom
      ctx.strokeStyle = '#60a5fa'; ctx.fillStyle = 'rgba(96,165,250,.1)'
      ctx.fillRect(selection.x, selection.y, selection.width, selection.height)
      ctx.strokeRect(selection.x, selection.y, selection.width, selection.height)
    }
  }, [active, layers, selection, view, size])

  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 && event.button !== 1) return
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
    const p = screen(event), w = world(p); setCursor(w)
    if (tool === 'hand' || event.button === 1 || spaceHeld.current) gesture.current = { kind: 'pan', start: p, origin: { x: viewRef.current.x, y: viewRef.current.y } }
    else if (tool === 'move') gesture.current = { kind: 'layer', start: w, layerId: activeLayer.id, origin: { ...activeLayer.offset } }
    else if (tool === 'select' || tool === 'ai') {
      const rect = selectionRef.current
      const hit = !!rect && w.x >= rect.x && w.x <= rect.x + rect.width && w.y >= rect.y && w.y <= rect.y + rect.height
      const corner = hit && Math.abs((w.x - rect.x - rect.width) * viewRef.current.zoom) < 16 && Math.abs((w.y - rect.y - rect.height) * viewRef.current.zoom) < 16
      if (rect && corner) gesture.current = { kind: 'selection-resize', start: w, original: rect }
      else if (rect && hit) gesture.current = { kind: 'selection-move', start: w, original: rect }
      else { gesture.current = { kind: 'select', start: w }; setSelection({ x: w.x, y: w.y, width: 0, height: 0 }) }
    } else if (tool === 'brush' || tool === 'erase') {
      if (!activeLayer.visible) { setError('请先显示当前图层'); return }
      const before: TileSnapshot = new Map()
      paintSegment(activeLayer, w, w, brush, color, tool === 'erase', before)
      gesture.current = { kind: 'paint', layerId: activeLayer.id, before, last: w }; replace([...layersRef.current])
    }
  }
  function pointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    const p = screen(event), w = world(p); setCursor(w)
    const g = gesture.current; if (!g) return
    if (g.kind === 'pan') setView({ ...viewRef.current, x: g.origin.x + p.x - g.start.x, y: g.origin.y + p.y - g.start.y })
    else if (g.kind === 'layer') {
      const layer = layersRef.current.find(item => item.id === g.layerId)
      if (layer) { layer.offset = { x: g.origin.x + w.x - g.start.x, y: g.origin.y + w.y - g.start.y }; replace([...layersRef.current]) }
    } else if (g.kind === 'select') setSelection(normalizeRect(g.start, w))
    else if (g.kind === 'selection-move') setSelection({ ...g.original, x: g.original.x + w.x - g.start.x, y: g.original.y + w.y - g.start.y })
    else if (g.kind === 'selection-resize') setSelection({ ...g.original, width: Math.max(2, g.original.width + w.x - g.start.x), height: Math.max(2, g.original.height + w.y - g.start.y) })
    else if (g.kind === 'paint') {
      const layer = layersRef.current.find(item => item.id === g.layerId)
      if (layer) { paintSegment(layer, g.last, w, brush, color, tool === 'erase', g.before); g.last = w; replace([...layersRef.current]) }
    }
  }
  function pointerUp() {
    const g = gesture.current; gesture.current = null
    if (g?.kind === 'paint') { const layer = layersRef.current.find(item => item.id === g.layerId); if (layer) finishTiles(layer, g.before) }
    if (g?.kind === 'layer') {
      const layer = layersRef.current.find(item => item.id === g.layerId)
      if (layer && (layer.offset.x !== g.origin.x || layer.offset.y !== g.origin.y)) {
        const before = cloneLayers(layersRef.current); before.find(item => item.id === g.layerId)!.offset = g.origin
        record({ kind: 'layers', before, after: cloneLayers(layersRef.current) })
      }
    }
  }

  function addLayer(name = `图层 ${layersRef.current.length + 1}`) {
    const layer = createLayer(name); changeLayers([...layersRef.current, layer]); setActiveId(layer.id); return layer
  }
  function duplicate() {
    const layer = createLayer(`${activeLayer.name} 副本`)
    layer.offset = { ...activeLayer.offset }; layer.opacity = activeLayer.opacity
    for (const [key, tile] of activeLayer.tiles) {
      const copy = document.createElement('canvas'); copy.width = TILE_SIZE; copy.height = TILE_SIZE
      copy.getContext('2d')!.drawImage(tile, 0, 0); layer.tiles.set(key, copy)
    }
    const index = layersRef.current.indexOf(activeLayer)
    changeLayers([...layersRef.current.slice(0, index + 1), layer, ...layersRef.current.slice(index + 1)]); setActiveId(layer.id)
  }
  function reorder(direction: number) {
    const index = layersRef.current.findIndex(layer => layer.id === activeId), target = index + direction
    if (target < 0 || target >= layersRef.current.length) return
    const next = [...layersRef.current]; [next[index], next[target]] = [next[target], next[index]]; changeLayers(next)
  }
  function removeLayer() {
    if (layersRef.current.length === 1) { setError('至少保留一个图层'); return }
    const index = layersRef.current.findIndex(layer => layer.id === activeId)
    const next = layersRef.current.filter(layer => layer.id !== activeId); changeLayers(next)
    setActiveId(next[Math.max(0, index - 1)].id)
  }
  function transformLayer(kind: 'flip-x' | 'flip-y' | 'rotate') {
    try {
      const bounds = layerPixelBounds(activeLayer)
      if (!bounds) throw new Error('当前图层没有内容')
      checkRect(bounds)
      const input = rasterizeLayer(activeLayer, bounds, Math.ceil(bounds.width), Math.ceil(bounds.height))
      const output = document.createElement('canvas')
      output.width = kind === 'rotate' ? input.height : input.width
      output.height = kind === 'rotate' ? input.width : input.height
      const ctx = output.getContext('2d')!
      if (kind === 'flip-x') { ctx.translate(output.width, 0); ctx.scale(-1, 1) }
      if (kind === 'flip-y') { ctx.translate(0, output.height); ctx.scale(1, -1) }
      if (kind === 'rotate') { ctx.translate(output.width, 0); ctx.rotate(Math.PI / 2) }
      ctx.drawImage(input, 0, 0)
      const before = cloneLayers(layersRef.current)
      activeLayer.tiles = new Map()
      drawImageOnLayer(activeLayer, output, {
        x: bounds.x + (bounds.width - output.width) / 2, y: bounds.y + (bounds.height - output.height) / 2,
        width: output.width, height: output.height,
      })
      record({ kind: 'layers', before, after: cloneLayers(layersRef.current) })
      replace([...layersRef.current])
    } catch (cause) { setError(String(cause)) }
  }
  function mergeDown() {
    try {
      const index = layersRef.current.findIndex(layer => layer.id === activeId)
      if (index < 1) throw new Error('当前图层下方没有图层')
      const below = layersRef.current[index - 1]
      if (!activeLayer.visible || !below.visible) throw new Error('请先显示两个待合并图层')
      const bounds = unionRects(layerPixelBounds(below), layerPixelBounds(activeLayer))
      if (!bounds) throw new Error('待合并图层没有内容')
      checkRect(bounds)
      const merged = rasterizeRegion([below, activeLayer], bounds, Math.ceil(bounds.width), Math.ceil(bounds.height))
      const replacement = createLayer(`${below.name} + ${activeLayer.name}`)
      drawImageOnLayer(replacement, merged, bounds)
      changeLayers([...layersRef.current.slice(0, index - 1), replacement, ...layersRef.current.slice(index + 1)])
      setActiveId(replacement.id)
    } catch (cause) { setError(String(cause)) }
  }
  function clearSelected() {
    if (!selected || !selection) return
    const before: TileSnapshot = new Map(); clearLayerRect(activeLayer, selection, before)
    finishTiles(activeLayer, before); setSelection(null)
  }
  function extract(cut: boolean) {
    if (!selected || !selection) return
    try {
      checkRect(selection)
      const crop = rasterizeLayer(activeLayer, selection, Math.ceil(selection.width), Math.ceil(selection.height))
      const layer = createLayer(`${activeLayer.name} · 选区`); drawImageOnLayer(layer, crop, selection)
      if (cut) {
        const before: TileSnapshot = new Map()
        clearLayerRect(activeLayer, selection, before)
        const after: TileSnapshot = new Map()
        for (const key of before.keys()) after.set(key, captureTile(activeLayer, key))
        const next = [...layersRef.current, layer]
        record({ kind: 'batch', actions: [
          { kind: 'tiles', layerId: activeLayer.id, before, after },
          { kind: 'layers', before: cloneLayers(layersRef.current), after: cloneLayers(next) },
        ] })
        replace(next)
      } else changeLayers([...layersRef.current, layer])
      setActiveId(layer.id); setSelection(null)
    } catch (cause) { setError(String(cause)) }
  }
  async function importImage(file: File) {
    if (!file.type.startsWith('image/')) throw new Error('请选择图片文件')
    const url = URL.createObjectURL(file)
    try {
      let image: HTMLImageElement
      try { image = await decode(url) }
      catch { throw new Error('图片无法解码，请确认文件未损坏且格式受支持') }
      const factor = Math.min(1, MAX_RASTER_SIDE / Math.max(image.naturalWidth, image.naturalHeight))
      const width = Math.round(image.naturalWidth * factor), height = Math.round(image.naturalHeight * factor)
      const center = world({ x: size.width / 2, y: size.height / 2 }), layer = createLayer(file.name.replace(/\.[^.]+$/, ''))
      drawImageOnLayer(layer, image, { x: center.x - width / 2, y: center.y - height / 2, width, height })
      changeLayers([...layersRef.current, layer]); setActiveId(layer.id)
      suggestTitle(layer.name)
      setNotice(factor < 1 ? '图片已缩放至 4096 像素内导入' : '图片已作为新图层导入')
    } finally { URL.revokeObjectURL(url) }
  }
  async function addGenerationToCanvas(record: StudioGeneration) {
    await importImage(new File([record.image], `AI · ${record.prompt.slice(0, 24)}.png`, { type: 'image/png' }))
  }
  function exportPng() {
    try {
      const bounds = selected ? selection : contentPixelBounds(layersRef.current)
      if (!bounds) throw new Error('画布上还没有内容')
      checkRect(bounds)
      saveFile(rasterizeRegion(layersRef.current, bounds, Math.ceil(bounds.width), Math.ceil(bounds.height)).toDataURL('image/png'), 'tokenbird-canvas.png')
      setNotice(selected ? '选区已导出' : '画布内容已导出')
    } catch (cause) { setError(String(cause)) }
  }
  function saveProject() {
    saveFile(new Blob([serializeProject(layersRef.current, activeIdRef.current, viewRef.current, promptRef.current)], { type: 'application/json' }), 'tokenbird-canvas.tbcanvas')
    setNotice('工程已保存')
  }
  async function openProject(file: File) {
    if (file.size > 150_000_000) throw new Error('工程文件超过 150 MB')
    const { project, layers: next } = await parseProject(await file.text())
    changeLayers(next); setActiveId(project.activeId && next.some(layer => layer.id === project.activeId) ? project.activeId : next[next.length - 1].id)
    if (project.view && Number.isFinite(project.view.x) && Number.isFinite(project.view.y) && Number.isFinite(project.view.zoom)) setView(project.view)
    setPrompt(typeof project.prompt === 'string' ? project.prompt : '')
    setSelection(null); setNotice('工程已打开')
  }
  function localCutout() {
    try {
      if (!activeLayer.visible) throw new Error('请先显示图层')
      const bounds = selected ? selection : layerPixelBounds(activeLayer)
      if (!bounds) throw new Error('当前图层没有内容')
      checkRect(bounds, 2048)
      const canvas = rasterizeLayer(activeLayer, bounds, Math.ceil(bounds.width), Math.ceil(bounds.height))
      const ctx = canvas.getContext('2d')!, pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const removed = removeEdgeBackground(pixels, tolerance)
      if (!removed) throw new Error('未找到边缘相近背景；可提高容差或尝试 AI 抠图')
      ctx.putImageData(pixels, 0, 0)
      const before: TileSnapshot = new Map(); clearLayerRect(activeLayer, bounds, before)
      drawImageOnLayer(activeLayer, canvas, bounds, before); finishTiles(activeLayer, before)
      setNotice(`已将 ${removed.toLocaleString()} 个像素变为透明`); setError('')
    } catch (cause) { setError(String(cause)) }
  }
  function adjust() {
    try {
      const bounds = selected ? selection : layerPixelBounds(activeLayer)
      if (!bounds) throw new Error('当前图层没有内容')
      checkRect(bounds)
      const image = rasterizeLayer(activeLayer, bounds, Math.ceil(bounds.width), Math.ceil(bounds.height))
      const adjusted = document.createElement('canvas'); adjusted.width = image.width; adjusted.height = image.height
      const ctx = adjusted.getContext('2d')!; ctx.filter = `brightness(${brightness}%) contrast(${contrast}%)`; ctx.drawImage(image, 0, 0)
      const before: TileSnapshot = new Map(); clearLayerRect(activeLayer, bounds, before)
      drawImageOnLayer(activeLayer, adjusted, bounds, before); finishTiles(activeLayer, before)
      setBrightness(100); setContrast(100); setNotice('已应用调节')
    } catch (cause) { setError(String(cause)) }
  }
  async function applyCandidate(batch: CandidateBatch, record: StudioGeneration) {
    const url = URL.createObjectURL(record.image)
    let image: HTMLImageElement
    try { image = await decode(url) } finally { URL.revokeObjectURL(url) }
    if (batch.mode === 'inpaint' || batch.mode === 'outpaint') {
      const layer = layersRef.current.find(item => item.id === batch.layerId)
      if (!layer || !layer.visible) throw new Error('原图层已被删除或隐藏，请先恢复该图层')
      if (!batch.reference) throw new Error('缺少生成时的原图快照')
      const overlay = document.createElement('canvas')
      overlay.width = image.naturalWidth; overlay.height = image.naturalHeight
      const ctx = overlay.getContext('2d')!
      ctx.drawImage(image, 0, 0, overlay.width, overlay.height)
      const reference = document.createElement('canvas')
      reference.width = overlay.width; reference.height = overlay.height
      reference.getContext('2d')!.drawImage(batch.reference, 0, 0, reference.width, reference.height)
      const generatedPixels = ctx.getImageData(0, 0, overlay.width, overlay.height)
      const referencePixels = reference.getContext('2d')!.getImageData(0, 0, reference.width, reference.height)
      const feather = Math.max(8, Math.min(32, Math.round(Math.min(overlay.width, overlay.height) * 0.02)))
      if (batch.mode === 'inpaint') composeInpaint(generatedPixels, referencePixels, feather)
      else composeOutpaint(generatedPixels, referencePixels, feather)
      ctx.putImageData(generatedPixels, 0, 0)
      const before: TileSnapshot = new Map()
      clearLayerRect(layer, batch.target, before)
      drawImageOnLayer(layer, overlay, batch.target, before)
      finishTiles(layer, before)
      setSelection(null); setCandidates(null)
      suggestTitle(batch.prompt.slice(0, 40))
      setNotice(batch.mode === 'inpaint'
        ? '已在原图层重绘选区，并保留边缘像素与周围画面衔接'
        : '已在原图层补全透明区域，并保留原有画面')
      return
    }
    const layer = createLayer(batch.mode === 'cutout' ? 'AI 透明素材' : `AI · ${batch.prompt.slice(0, 24)}`)
    let transparent = true
    if (batch.context) {
      const { target, context } = batch
      const sx = (target.x - context.x) / context.width * image.naturalWidth
      const sy = (target.y - context.y) / context.height * image.naturalHeight
      const sw = target.width / context.width * image.naturalWidth
      const sh = target.height / context.height * image.naturalHeight
      const crop = document.createElement('canvas')
      crop.width = Math.max(1, Math.round(sw)); crop.height = Math.max(1, Math.round(sh))
      const ctx = crop.getContext('2d')!
      ctx.drawImage(image, sx, sy, sw, sh, 0, 0, crop.width, crop.height)
      if (batch.mode === 'cutout') {
        transparent = false
        const pixels = ctx.getImageData(0, 0, crop.width, crop.height).data
        for (let index = 3; index < pixels.length; index += 4) if (pixels[index] < 250) { transparent = true; break }
      }
      drawImageOnLayer(layer, crop, target)
    } else drawImageOnLayer(layer, image, batch.target)
    changeLayers([...layersRef.current, layer]); setActiveId(layer.id); setSelection(null); setCandidates(null)
    suggestTitle(batch.prompt.slice(0, 40))
    setNotice(batch.mode === 'cutout'
      ? transparent ? '透明素材已加入新图层；原图保留' : '模型返回了不透明图片，请尝试本地去背景或更换模型'
      : 'AI 图片已加入新图层')
  }

  async function generate(mode: AiMode = aiMode) {
    if (!imageReady) { setError('请先选择可用的绘画连接、图片分组和模型'); return }
    if (mode !== 'cutout' && !prompt.trim()) { setError('请填写提示词'); return }
    setBusy(true); setError(''); setNotice('')
    try {
      const generationPrompt = mode === 'cutout'
        ? 'Remove the background completely. Keep only the original subject with fine edges. Return a PNG with a fully transparent background, without adding objects.'
        : prompt.trim()
      let target: Rect, source: HTMLCanvasElement | null = null, mask: HTMLCanvasElement | null = null
      let reference: HTMLCanvasElement | null = null
      let context: Rect | null = null
      if (mode === 'cutout') {
        if (!activeLayer.visible) throw new Error('请先显示当前图层')
        const bounds = selected ? selection : layerPixelBounds(activeLayer)
        if (!bounds) throw new Error('请先导入图片或框选素材')
        checkRect(bounds); target = bounds; context = square(target, 0.05)
        source = rasterizeLayer(activeLayer, context, SIZE, SIZE)
      } else {
        const center = world({ x: size.width / 2, y: size.height / 2 })
        target = selected && selection ? selection : {
          x: center.x - generationWidth / 2, y: center.y - generationHeight / 2,
          width: generationWidth, height: generationHeight,
        }
        target = pixelAligned(target)
        if (![target.x, target.y, target.width, target.height].every(Number.isFinite)
          || target.width < 2 || target.height < 2 || target.width * target.height > MAX_AI_CANVAS_PIXELS) {
          throw new Error('目标区域需要至少 2 × 2 像素，单次最多处理 3200 万画布像素；可分次扩展更大的画面')
        }
        const range = tileRange(target)
        if ((range.right - range.left + 1) * (range.bottom - range.top + 1) > 128) {
          throw new Error('选区跨越过多画布分块；请缩小单次生成区域，或分次扩展画面')
        }
        if (mode === 'inpaint' || mode === 'outpaint') {
          if (!selected || !selection) throw new Error(mode === 'inpaint' ? '请先框选要重绘的区域' : '请先框选要扩展的区域')
          if (!activeLayer.visible) throw new Error('请先显示要修改的图层')
          if (activeLayer.opacity !== 1) throw new Error('请先将要修改的图层不透明度设为 100%，再进行重绘或补全')
          reference = rasterizeLayer(activeLayer, target, SIZE, SIZE)
          const activePixels = reference.getContext('2d')!.getImageData(0, 0, SIZE, SIZE).data
          let activeHasContent = false
          for (let index = 3; index < activePixels.length; index += 4) if (activePixels[index]) { activeHasContent = true; break }
          if (!activeHasContent) throw new Error('请先在图层面板选择包含原图的图层，并让选区覆盖部分原图')
          const activeIndex = layersRef.current.findIndex(layer => layer.id === activeLayer.id)
          const upperLayers = layersRef.current.slice(activeIndex + 1).filter(layer => layer.visible && layer.opacity > 0)
          if (upperLayers.length) {
            const upperPixels = rasterizeRegion(upperLayers, target, SIZE, SIZE).getContext('2d')!.getImageData(0, 0, SIZE, SIZE).data
            for (let index = 3; index < upperPixels.length; index += 4) if (upperPixels[index]) {
              throw new Error('选区被上方图层遮挡；请先选择上方图层或合并相关图层，再进行重绘')
            }
          }
          // The API output uses the same frame as the selected canvas region.
          // Padding this input and then cropping the response changed its scale.
          context = target
          source = rasterizeRegion(layersRef.current, target, SIZE, SIZE)
          const sourcePixels = source.getContext('2d')!.getImageData(0, 0, SIZE, SIZE)
          const alpha = sourcePixels.data
          let populated = false, blank = false
          for (let index = 3; index < alpha.length; index += 4) if (alpha[index]) { populated = true; break }
          if (!populated) throw new Error('选区附近没有可供 AI 参考的图像；请改用直接生成')
          if (mode === 'outpaint') {
            const coverage = referenceCoverage(sourcePixels)
            if (coverage < 0.2) throw new Error(`选区内原图参考只有 ${Math.round(coverage * 100)}%；请让选区至少约五分之一覆盖原图，再分次向空白扩展`)
          }
          mask = document.createElement('canvas'); mask.width = SIZE; mask.height = SIZE
          const ctx = mask.getContext('2d')!; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, SIZE, SIZE)
          if (mode === 'inpaint') {
            const pixels = ctx.getImageData(0, 0, SIZE, SIZE)
            const border = 24
            for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
              const index = (y * SIZE + x) * 4 + 3
              if ((x >= border && x < SIZE - border && y >= border && y < SIZE - border) || alpha[index] === 0) {
                pixels.data[index] = 0
              }
            }
            ctx.putImageData(pixels, 0, 0)
          } else {
            const pixels = ctx.getImageData(0, 0, SIZE, SIZE)
            const left = Math.max(0, Math.floor((target.x - context.x) / context.width * SIZE))
            const top = Math.max(0, Math.floor((target.y - context.y) / context.height * SIZE))
            const right = Math.min(SIZE, Math.ceil((target.x + target.width - context.x) / context.width * SIZE))
            const bottom = Math.min(SIZE, Math.ceil((target.y + target.height - context.y) / context.height * SIZE))
            for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
              const index = (y * SIZE + x) * 4
              pixels.data[index + 3] = alpha[index + 3] > 0 ? 255 : 0
              if (x >= left && x < right && y >= top && y < bottom && alpha[index + 3] === 0) blank = true
            }
            if (!blank) throw new Error('选区内没有空白区域；请改用局部重绘')
            ctx.putImageData(pixels, 0, 0)
          }
          fillTransparentForEdit(sourcePixels)
          source.getContext('2d')!.putImageData(sourcePixels, 0, 0)
        }
      }
      const requestedSize = source ? '1024x1024'
        : target.width / target.height > 1.3 ? '1536x1024'
          : target.height / target.width > 1.3 ? '1024x1536' : '1024x1024'
      const result = await window.electronAPI.generateStudioImage({
        connectionSlug, model: model.trim(), size: requestedSize, count: generationCount,
        ...(connection?.oauthProvider === 'tokennest' ? { channelGroup } : {}),
        prompt: (mode === 'inpaint'
          ? `Keep the framing, scale, positions, and visible border pixels exactly fixed. Edit only the transparent mask area. ${generationPrompt}`
          : mode === 'outpaint'
            ? `Keep all existing opaque pixels exactly fixed. Fill only the transparent area and continue the surrounding artwork seamlessly. ${generationPrompt}`
            : generationPrompt).slice(0, 4000),
        ...(source ? { imageBase64: base64(source) } : {}),
        ...(mask ? { maskBase64: base64(mask) } : {}),
        ...(mode === 'cutout' ? { transparentBackground: true } : {}),
      })
      const outputs = result.images?.length ? result.images : [result]
      const records: StudioGeneration[] = []
      const issues = new Map<string, EditOutputIssue>()
      let historyError = ''
      let savedCount = 0
      for (const output of outputs) {
        const image = await decode(`data:${output.mimeType};base64,${output.imageBase64}`)
        const bytes = Uint8Array.from(atob(output.imageBase64), char => char.charCodeAt(0))
        const record: StudioGeneration = {
          id: crypto.randomUUID(), createdAt: Date.now() + records.length, sessionId: session.id,
          sessionTitle: session.title === '未命名画布' ? generationPrompt.slice(0, 40) : session.title,
          kind: mode === 'inpaint' ? 'edit' : mode,
          prompt: generationPrompt, model: model.trim(), connectionName: connection?.name ?? connectionSlug,
          ...(connection?.oauthProvider === 'tokennest' ? { channelGroup } : {}),
          width: image.naturalWidth, height: image.naturalHeight,
          image: new Blob([bytes], { type: 'image/png' }),
        }
        if (source && mask) {
          const returned = document.createElement('canvas'); returned.width = SIZE; returned.height = SIZE
          const returnedContext = returned.getContext('2d')!
          returnedContext.drawImage(image, 0, 0, SIZE, SIZE)
          const issue = assessEditOutput(
            returnedContext.getImageData(0, 0, SIZE, SIZE),
            source.getContext('2d')!.getImageData(0, 0, SIZE, SIZE),
            mask.getContext('2d')!.getImageData(0, 0, SIZE, SIZE),
          )
          if (issue) issues.set(record.id, issue)
        }
        records.push(record)
        try { await saveStudioGeneration(record); savedCount++ }
        catch (cause) { historyError = String(cause) }
      }
      if (!records.length) throw new Error('模型没有返回图片')
      setRecentRecords(current => [...records, ...current].slice(0, 5))
      if (savedCount) setHistoryRevision(value => value + 1)
      const batch: CandidateBatch = { records, target, context, reference, layerId: activeLayer.id, mode, prompt: generationPrompt, savedCount, issues }
      if (records.length === 1 && !issues.size) await applyCandidate(batch, records[0])
      else {
        setCandidateIndex(Math.max(0, records.findIndex(record => !issues.has(record.id))))
        setCandidates(batch)
        setNotice(issues.size === records.length
          ? editIssueMessage(issues.get(records[0].id)!)
          : `已生成 ${records.length} 张图片，请选择一张${mode === 'inpaint' || mode === 'outpaint' ? '替换选区' : '加入画布'}`)
      }
      if (outputs.length < generationCount) setNotice(`模型返回 ${outputs.length} 张图片，少于请求的 ${generationCount} 张`)
      if (historyError) setError(`图片已生成，但部分本地历史保存失败：${historyError}`)
    } catch (cause) {
      const issue = classifyStudioConnectionError(cause, connection?.oauthProvider === 'tokennest')
      if (issue) { setConnectionIssue(issue); setConnectionSettingsOpen(true); setError('') }
      else setError(String(cause))
    }
    finally { setBusy(false) }
  }
  async function chooseCandidate(record: StudioGeneration) {
    if (!candidates || busy) return
    const issue = candidates.issues.get(record.id)
    if (issue) { setError(editIssueMessage(issue)); return }
    setBusy(true)
    try { await applyCandidate(candidates, record) }
    catch (cause) { setError(`图片加入画布失败：${String(cause)}`) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    if (!active) return
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, textarea, select, [contenteditable="true"]')) return
      if (event.code === 'Space') { event.preventDefault(); spaceHeld.current = true; return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return }
      const shortcuts: Record<string, CanvasTool> = { v: 'move', h: 'hand', m: 'select', b: 'brush', e: 'erase', g: 'ai' }
      if (shortcuts[event.key.toLowerCase()]) { event.preventDefault(); setTool(shortcuts[event.key.toLowerCase()]); return }
      if (event.key === 'Escape') setSelection(null)
      if (event.key === 'Delete' || event.key === 'Backspace') clearSelected()
    }
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') spaceHeld.current = false }
    const blur = () => { spaceHeld.current = false }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur) }
  })

  const grid = Math.max(8, 32 * view.zoom)
  const frame = selected && selection ? { left: view.x + selection.x * view.zoom, top: view.y + selection.y * view.zoom,
    width: selection.width * view.zoom, height: selection.height * view.zoom } : null
  const tools: Array<{ id: CanvasTool; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'move', label: '移动图层 V', icon: MousePointer2 }, { id: 'hand', label: '平移画布 H', icon: Hand },
    { id: 'select', label: '框选 M', icon: Scan }, { id: 'brush', label: '画笔 B', icon: Brush }, { id: 'erase', label: '橡皮 E', icon: Eraser },
    { id: 'adjust', label: '调节', icon: SlidersHorizontal }, { id: 'ai', label: 'AI 绘图 G', icon: Sparkles },
  ]
  return <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
    <header className="flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-border/70 px-3">
      <div className="mr-2 flex items-center gap-2 border-r border-border pr-4"><Layers3 className="h-4 w-4 text-primary" /><strong className="text-sm">画布</strong><span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">无限</span></div>
      <button className={actionClass} onClick={() => void createSession()}><Plus className="h-3.5 w-3.5" />新建会话</button>
      <button className={actionClass} onClick={() => imageInput.current?.click()}><ImagePlus className="h-3.5 w-3.5" />导入图片</button>
      <button className={actionClass} onClick={() => projectInput.current?.click()}>打开工程</button>
      <span className="mx-1 h-5 w-px bg-border" />
      <button className={iconClass} title="撤销 Ctrl+Z" disabled={!undoStack.current.length} onClick={undo}><Undo2 className="h-4 w-4" /></button>
      <button className={iconClass} title="重做 Ctrl+Y" disabled={!redoStack.current.length} onClick={redo}><Redo2 className="h-4 w-4" /></button>
      <div className="ml-auto flex gap-2"><button className={actionClass} onClick={saveProject}><Download className="h-3.5 w-3.5" />保存工程</button><button className={actionClass} onClick={exportPng}>导出 PNG</button></div>
      <input ref={imageInput} hidden type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; if (file) void importImage(file).catch(cause => setError(String(cause))); event.target.value = '' }} />
      <input ref={projectInput} hidden type="file" accept=".tbcanvas,application/json" onChange={event => { const file = event.target.files?.[0]; if (file) void openProject(file).catch(cause => setError(String(cause))); event.target.value = '' }} />
    </header>
    <div className="flex min-h-0 flex-1">
      <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border/70 px-1.5 py-3">
        {tools.map(({ id, label, icon: Icon }) => <button key={id} title={label} aria-label={label} onClick={() => setTool(id)}
          className={`flex h-9 w-9 items-center justify-center rounded-lg ${tool === id ? 'bg-primary/15 text-primary ring-1 ring-primary/30' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}><Icon className="h-[18px] w-[18px]" /></button>)}
      </nav>
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div ref={viewElement} className="relative min-h-0 flex-1 overflow-hidden"
          style={{ backgroundColor: 'var(--background)', backgroundImage: 'linear-gradient(to right, color-mix(in oklch, var(--foreground) 11%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklch, var(--foreground) 11%, transparent) 1px, transparent 1px)', backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${view.x}px ${view.y}px` }}>
          <canvas ref={canvasElement} className={`absolute inset-0 h-full w-full touch-none ${tool === 'hand' ? 'cursor-grab' : tool === 'move' ? 'cursor-move' : 'cursor-crosshair'}`}
            onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}
            onWheel={event => { event.preventDefault(); zoomAt(screen(event), viewRef.current.zoom * Math.exp(-event.deltaY * .001)) }}
            onContextMenu={event => event.preventDefault()} aria-label="无限画布" />
          {busy && <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/35 backdrop-blur-[2px]" role="status" aria-live="polite">
            <div className="flex min-w-56 flex-col items-center rounded-2xl border border-primary/25 bg-background/95 px-8 py-7 shadow-strong">
              <div className="relative mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><span className="absolute inset-0 animate-ping rounded-2xl border border-primary/25" /><Sparkles className="size-6 animate-pulse" /></div>
              <strong className="text-sm">AI 正在生成图片</strong><span className="mt-1 text-xs text-muted-foreground">{aiMode === 'inpaint' || aiMode === 'outpaint' ? '生成完成后将替换当前图层中的选区' : '生成完成后将添加到新图层'}</span>
              <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-primary/10"><div className="h-full w-1/2 animate-pulse rounded-full bg-primary/70" /></div>
            </div>
          </div>}
          {frame && <div className="pointer-events-none absolute border border-sky-400 bg-sky-400/10" style={frame}><i className="absolute -right-1 -bottom-1 h-2 w-2 rounded-sm border border-sky-600 bg-white" /></div>}
          {frame && tool === 'ai' && <button className="absolute z-10 flex items-center gap-1.5 rounded-full border border-primary/40 bg-background px-3 py-1.5 text-xs text-primary shadow-middle hover:bg-accent disabled:opacity-50"
            style={{ left: Math.min(Math.max(12, frame.left + frame.width - 120), size.width - 140), top: Math.min(Math.max(12, frame.top + frame.height + 10), size.height - 42) }}
            disabled={busy} onClick={() => void generate()}><Sparkles className="h-3.5 w-3.5" />{aiMode === 'inpaint' ? '重绘选区' : aiMode === 'outpaint' ? '扩图补全' : aiMode === 'cutout' ? '智能抠图' : '生成到选区'}</button>}
          {recentRecords.length > 0 && (recentVisible ? <div className="absolute left-1/2 top-3 z-10 flex max-w-[min(90%,600px)] -translate-x-1/2 items-center gap-2 rounded-xl border border-border/80 bg-background/95 px-2 py-1.5 shadow-middle backdrop-blur">
            <span className="shrink-0 text-[10px] text-muted-foreground">模型原图</span>
            <div className="flex min-w-0 gap-1.5 overflow-x-auto">{recentRecords.map(record => <div key={record.id} className="shrink-0 rounded-md border border-border/70 p-0.5" title={record.prompt}><GenerationImage record={record} className="size-10 rounded object-cover" /></div>)}</div>
            <button className={iconClass} title="关闭生成预览" aria-label="关闭生成预览" onClick={() => { sessionStorage.setItem('tokenbird.studio.recentPreviewHidden', '1'); setRecentVisible(false) }}><X className="size-3.5" /></button>
          </div> : <button className="absolute right-3 top-3 z-10 rounded-lg border border-border bg-background/95 p-2 text-muted-foreground shadow-middle hover:text-foreground" title="显示生成预览" aria-label="显示生成预览" onClick={() => { sessionStorage.removeItem('tokenbird.studio.recentPreviewHidden'); setRecentVisible(true) }}><History className="size-4" /></button>)}
          {!contentBounds(layers) && !selected && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><div className="rounded-2xl border border-border bg-background/90 px-8 py-6 text-center shadow-middle"><ImagePlus className="mx-auto mb-3 h-6 w-6 text-primary" /><strong className="text-sm">从空白画布开始</strong><p className="mt-1 text-xs text-muted-foreground">导入图片、绘画或框选区域让 AI 创作</p></div></div>}
        </div>
        <footer className="flex h-9 shrink-0 items-center gap-3 border-t border-border/70 px-3 text-[11px] text-muted-foreground">
          <span>{Math.round(cursor.x)}, {Math.round(cursor.y)} px</span>{selection && <span>选区 {Math.round(selection.width)} × {Math.round(selection.height)}</span>}
          <span className="hidden sm:inline">空格拖动画布 · 滚轮缩放</span>
          <div className="ml-auto flex items-center gap-1"><button className={iconClass} aria-label="缩小" onClick={() => zoomAt({ x: size.width / 2, y: size.height / 2 }, view.zoom / 1.25)}><ZoomOut className="h-3.5 w-3.5" /></button><span className="min-w-10 text-center tabular-nums">{Math.round(view.zoom * 100)}%</span><button className={iconClass} aria-label="放大" onClick={() => zoomAt({ x: size.width / 2, y: size.height / 2 }, view.zoom * 1.25)}><ZoomIn className="h-3.5 w-3.5" /></button><button className={iconClass} aria-label="适合内容" onClick={fit}><Maximize2 className="h-3.5 w-3.5" /></button></div>
        </footer>
      </main>
      <aside className="w-[320px] shrink-0 overflow-y-auto border-l border-border/70 bg-background">
        {tool === 'ai' && <section className={sectionClass}>
          <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /><h2 className="text-sm font-semibold">AI 绘图</h2><span className="ml-auto text-[11px] text-muted-foreground">{aiMode === 'inpaint' || aiMode === 'outpaint' ? '直接修改当前图层' : '结果作为新图层'}</span></div>
          <StudioConnectionPicker image connections={connections} connectionSlug={connectionSlug} setConnectionSlug={setConnectionSlug} model={model} setModel={setModel} channelGroup={channelGroup} setChannelGroup={setChannelGroup} />
          <button className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline" onClick={() => setConnectionSettingsOpen(true)}><Settings2 className="size-3.5" />连接设置</button>
          {connection?.oauthProvider === 'tokennest' && !connection.isAuthenticated && <p className="text-xs text-muted-foreground">TokenNest 登录已失效，请重新登录。</p>}
          {connection?.oauthProvider === 'tokennest' && connection.isAuthenticated && groups.length === 0 && <p className="text-xs text-muted-foreground">当前账户没有可用的图片分组。请检查 TokenNest 图片分组权限、图片渠道及模型，再刷新连接。</p>}
          <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="AI 绘图方式">
            {([['generate', '直接生成'], ['inpaint', '局部重绘'], ['outpaint', '扩图补全'], ['cutout', '智能抠图']] as const).map(([id, label]) =>
              <button key={id} className={`${actionClass} ${aiMode === id ? 'border-primary/50 bg-primary/10 text-primary' : ''}`} aria-pressed={aiMode === id} onClick={() => setAiMode(id)}>{label}</button>)}
          </div>
          <textarea className="min-h-24 w-full resize-y rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs leading-5 outline-none focus:border-primary/60" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="描述希望生成或修改的画面…" disabled={aiMode === 'cutout'} />
          <div className="flex items-center gap-3 text-xs"><label htmlFor="studio-generation-count" className="shrink-0">生成数量</label><select id="studio-generation-count" className="h-8 flex-1 rounded-md border border-border bg-background px-2" value={generationCount} onChange={event => setGenerationCount(Number(event.target.value))}>{[1, 2, 3, 4].map(count => <option key={count} value={count}>{count} 张</option>)}</select></div>
          {selected && selection ? <p className="text-[11px] text-muted-foreground">目标选区：{Math.round(selection.width)} × {Math.round(selection.height)} px</p>
            : aiMode === 'generate' ? <div className="grid grid-cols-2 gap-2 text-xs"><label>画布宽度<input className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2" type="number" min="2" max="16000" value={generationWidth} onChange={event => setGenerationWidth(Number(event.target.value))} /></label><label>画布高度<input className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2" type="number" min="2" max="16000" value={generationHeight} onChange={event => setGenerationHeight(Number(event.target.value))} /></label></div> : null}
          <button className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50" disabled={busy || !imageReady || (aiMode !== 'generate' && aiMode !== 'cutout' && !selected)} onClick={() => void generate()}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}{busy ? '正在生成…' : aiMode === 'inpaint' ? '重绘选区' : aiMode === 'outpaint' ? '补全空白区域' : aiMode === 'cutout' ? '生成透明素材' : '生成图片'}</button>
          <p className="text-[11px] leading-4 text-muted-foreground">直接生成可放入任意画布选区；重绘直接修改当前原图层。扩图时让选区至少约五分之一覆盖原图，其余覆盖空白，并分次向外扩展。所选模型和渠道需支持带遮罩的图片编辑。单次最多处理 3200 万画布像素。</p>
        </section>}
        {tool === 'ai' && <StudioGenerationHistory revision={historyRevision} sessionId={session.id} disabled={busy}
          onAddToCanvas={addGenerationToCanvas}
          onReusePrompt={value => { setTool('ai'); setPrompt(value); setNotice('已将历史提示词填入输入框') }} />}
        {(tool === 'brush' || tool === 'erase') && <section className={sectionClass}>
          <h2 className="text-sm font-semibold">{tool === 'brush' ? '画笔' : '橡皮'}配置</h2>
          <div className="flex items-center gap-3">{tool === 'brush' && <input type="color" className="h-8 w-8" value={color} onChange={event => setColor(event.target.value)} aria-label="画笔颜色" />}<label className="flex-1 text-[11px]">笔刷 {brush}px<input className="w-full accent-primary" type="range" min="1" max="160" value={brush} onChange={event => setBrush(Number(event.target.value))} /></label></div>
        </section>}
        <section className={sectionClass}>
          <div className="flex items-center gap-2"><Layers3 className="h-4 w-4" /><h2 className="text-sm font-semibold">图层</h2><span className="ml-auto text-[11px] text-muted-foreground">{layers.length} 层</span></div>
          <div className="space-y-1">{[...layers].reverse().map(layer => <div key={layer.id} onClick={() => setActiveId(layer.id)} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 ${layer.id === activeId ? 'border-primary/40 bg-primary/10' : 'border-transparent hover:bg-muted/40'}`}>
            <button className={iconClass} title={layer.visible ? '隐藏图层' : '显示图层'} onClick={event => { event.stopPropagation(); layer.visible = !layer.visible; replace([...layersRef.current]) }}>{layer.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}</button>
            <span className="flex h-7 w-7 items-center justify-center rounded border border-border bg-muted/30"><Layers3 className="h-3.5 w-3.5" /></span><input className="min-w-0 flex-1 bg-transparent text-xs outline-none" aria-label="图层名称" value={layer.name} onClick={event => event.stopPropagation()} onChange={event => { layer.name = event.target.value.slice(0, 80); replace([...layersRef.current]) }} />
          </div>)}</div>
          {tool === 'move' && <><div className="flex items-center gap-1 border-t border-border/70 pt-2"><button className={iconClass} title="新建图层" onClick={() => addLayer()}><Plus className="h-4 w-4" /></button><button className={iconClass} title="复制图层" onClick={duplicate}><Copy className="h-4 w-4" /></button><button className={iconClass} title="上移" onClick={() => reorder(1)}><ArrowUp className="h-4 w-4" /></button><button className={iconClass} title="下移" onClick={() => reorder(-1)}><ArrowDown className="h-4 w-4" /></button><button className={`${iconClass} ml-auto`} title="删除图层" onClick={removeLayer}><Trash2 className="h-4 w-4" /></button></div>
            <div className="grid grid-cols-3 gap-1.5"><button className={actionClass} onClick={() => transformLayer('flip-x')}>水平翻转</button><button className={actionClass} onClick={() => transformLayer('flip-y')}>垂直翻转</button><button className={actionClass} onClick={() => transformLayer('rotate')}>旋转 90°</button></div>
            <button className={`${actionClass} w-full`} onClick={mergeDown}>合并到下方图层</button>
            <label className="block text-[11px] text-muted-foreground">不透明度 {Math.round(activeLayer.opacity * 100)}%<input className="mt-1 w-full accent-primary" type="range" min="0" max="100" value={Math.round(activeLayer.opacity * 100)} onChange={event => { activeLayer.opacity = Number(event.target.value) / 100; replace([...layersRef.current]) }} /></label></>}
        </section>
        {tool === 'select' && <section className={sectionClass}>
          <div className="flex items-center gap-2"><Scissors className="h-4 w-4" /><h2 className="text-sm font-semibold">选区与抠图</h2></div>
          <div className="grid grid-cols-2 gap-2"><button className={actionClass} disabled={!selected} onClick={() => extract(false)}>复制为图层</button><button className={actionClass} disabled={!selected} onClick={() => extract(true)}>剪切为图层</button><button className={actionClass} disabled={!selected} onClick={clearSelected}>挖空选区</button><button className={actionClass} onClick={() => setSelection(null)}>取消选区</button></div>
          <label className="block text-[11px] text-muted-foreground">边缘颜色容差 {tolerance}<input className="mt-1 w-full accent-primary" type="range" min="0" max="100" value={tolerance} onChange={event => setTolerance(Number(event.target.value))} /></label>
          <button className={`${actionClass} w-full`} onClick={localCutout}>本地去背景</button>
          <p className="text-[11px] text-muted-foreground">AI 智能抠图可在 AI 绘图工具中选择。</p>
        </section>}
        {tool === 'adjust' && <section className={`${sectionClass} border-b-0`}>
          <h2 className="text-sm font-semibold">手动调节</h2>
          <label className="block text-[11px]">亮度 {brightness}%<input className="w-full accent-primary" type="range" min="0" max="200" value={brightness} onChange={event => setBrightness(Number(event.target.value))} /></label>
          <label className="block text-[11px]">对比度 {contrast}%<input className="w-full accent-primary" type="range" min="0" max="200" value={contrast} onChange={event => setContrast(Number(event.target.value))} /></label>
          <button className={actionClass} onClick={adjust}>应用到当前图层</button>
        </section>}
        {(error || notice) && <div className={`sticky bottom-0 border-t px-4 py-3 text-xs ${error ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-border bg-background text-muted-foreground'}`} role={error ? 'alert' : 'status'}>{error || notice}</div>}
      </aside>
    </div>
    <Dialog open={!!candidates} onOpenChange={open => { if (!open && !busy) setCandidates(null) }}>
      <DialogContent className="flex max-h-[88vh] max-w-5xl flex-col overflow-hidden">
        <DialogHeader><DialogTitle>选择生成结果</DialogTitle></DialogHeader>
        {candidates && <><p className="text-xs text-muted-foreground">本次生成 {candidates.records.length} 张，选择一张{candidates.mode === 'inpaint' || candidates.mode === 'outpaint' ? '替换当前图层中的选区' : '加入当前画布'}。{candidates.savedCount < candidates.records.length ? `有 ${candidates.records.length - candidates.savedCount} 张未能保存到本地历史，关闭后会丢失未保存结果。` : '所有款式已保存到本地历史。'}</p>
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto md:grid-cols-[minmax(0,1fr)_180px] md:overflow-hidden">
            <div className="flex min-h-52 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/20 p-3"><GenerationImage record={candidates.records[candidateIndex]} className="max-h-[55vh] max-w-full object-contain" /></div>
            <div className="grid content-start grid-cols-2 gap-2 overflow-y-auto md:grid-cols-1">{candidates.records.map((record, index) => <button key={record.id} className={`flex items-center gap-2 rounded-lg border p-1.5 text-left text-xs ${candidateIndex === index ? 'border-primary bg-primary/10' : 'border-border/70 hover:bg-accent'}`} onClick={() => setCandidateIndex(index)}><GenerationImage record={record} className="size-14 shrink-0 rounded object-cover" /><span>款式 {index + 1}{candidates.issues.has(record.id) && <small className="block text-destructive">无法无缝拼接</small>}</span></button>)}</div>
          </div>
          {candidates.issues.has(candidates.records[candidateIndex].id) && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{editIssueMessage(candidates.issues.get(candidates.records[candidateIndex].id)!)}</p>}
          <div className="flex items-center justify-end gap-2 border-t border-border pt-3"><button className={actionClass} onClick={() => saveFile(candidates.records[candidateIndex].image, `tokenbird-ai-${candidateIndex + 1}.png`)}><Download className="size-3.5" />下载所选</button><button className={actionClass} disabled={busy} onClick={() => setCandidates(null)}>{candidates.savedCount === candidates.records.length ? '稍后从历史查看' : '关闭候选'}</button><button className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground disabled:opacity-50" disabled={busy || candidates.issues.has(candidates.records[candidateIndex].id)} onClick={() => void chooseCandidate(candidates.records[candidateIndex])}><ImagePlus className="size-4" />{candidates.mode === 'inpaint' || candidates.mode === 'outpaint' ? '替换选区' : '加入画布'}</button></div>
        </>}
      </DialogContent>
    </Dialog>
    <StudioImageConnectionDialog open={setupOpen} issue={connectionIssue}
      onClose={() => { sessionStorage.setItem('tokenbird.studio.imageSetupDismissed', '1'); setSetupDismissed(true); setConnectionSettingsOpen(false); setConnectionIssue(null) }}
      onFinish={() => { localStorage.setItem('tokenbird.studio.imageSetupDone', '1'); setSetupDone(true); setConnectionSettingsOpen(false); setConnectionIssue(null); setError('') }}
      onReauthorized={() => setConnectionIssue(null)}
      onOpenAiSettings={onOpenAiSettings} connections={connections} connection={connection} connectionSlug={connectionSlug} setConnectionSlug={setConnectionSlug}
      model={model} setModel={setModel} channelGroup={channelGroup} setChannelGroup={setChannelGroup} imageReady={imageReady} imageGroupCount={groups.length}
      loginTokenNest={loginTokenNest} refresh={refresh} />
  </div>
}
