import { useStudioCompactLayout } from './useStudioCompactLayout'
import { StudioMobileSheet } from './StudioMobileSheet'
import { CanvasMobileControls } from './CanvasMobileControls'
import { i18n } from '@craft-agent/shared/i18n'
import { useTranslation } from 'react-i18next'
import { WorkbenchSelect } from '@/components/ui/workbench-select'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Brush, Crop, Scaling, Grid2X2, SunMoon, Type, Shapes, PaintBucket, Blend, CircleDashed, Copy, Download, Eraser, Eye, EyeOff, Hand, History, ImagePlus, Lasso, Layers3, LoaderCircle, Maximize2, MessageCircle, MousePointer2, Paintbrush, Pipette, Plus, Redo2, Scan, Scissors, Settings2, SlidersHorizontal, Sparkles, Stamp, Trash2, Undo2, WandSparkles, X, ZoomIn, ZoomOut } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { StudioConnectionPicker, useStudioConnections } from './useStudioConnections'
import { StudioImageConnectionDialog } from './StudioImageConnectionDialog'
import { GenerationImage, StudioGenerationHistory } from './StudioGenerationHistory'
import { deleteStudioGeneration, getStudioGeneration, listStudioGenerations, saveStudioGeneration, type StudioGeneration } from './studio-generation-history'
import { assessEditOutput, composeInpaint, composeOutpaint, fillTransparentForEdit, referenceCoverage, type EditOutputIssue } from './studio-image-composite'
import { classifyStudioConnectionError, type StudioConnectionIssue } from './studio-connection-error'
import { rechargeOnInsufficientBalance } from '@/lib/tokennest-recharge'
import { StudioSessionWorkspace, type StudioSessionEditorProps } from './StudioSessionWorkspace'
import { StudioCanvasChat, type CanvasChatMessage, type CanvasSuggestion } from './StudioCanvasChat'
import { studioThinkingLevel, type StudioThinkingLevel } from './StudioThinkingPicker'
import { studioExecutionMode, type StudioExecutionMode } from './StudioExecutionModePicker'
import { CanvasTouchNavigation, type CanvasView } from './canvas-touch-navigation'
import { activeStudioSessionId, listStudioSessions } from './studio-sessions'
import { applyAdjustments, defaultAdjustments, adjustmentsAreNeutral, type AdjustmentSettings, type AdjustmentStyle } from './studio-adjustments'
import { BLEND_MODES, rawLayer, assertPixelEditable, MAX_RASTER_SIDE, TILE_SIZE, captureTile, clearLayerRect, contentBounds, contentPixelBounds, createLayer, drawImageOnLayer, drawLayers, layerPixelBounds, normalizeRect, paintSegment, rasterizeRegion, removeEdgeBackground, restoreTiles, tileRange, unionRects, type CanvasLayer, type CanvasTool, type Point, type Rect, type TileSnapshot } from './canvas-engine'
import { checkedSelectionBounds, clearMaskedSelection, cloneSegment, combineSelections, drawMaskedImage, paintMaskedSegment, rectangularSelection, sampleColor, selectionMask, shapeSelection, snapshotLayer, wandSelection, type PixelSelection, type SelectionMode } from './canvas-retouch'
import { canvasToolGroups } from './canvas-tools'
import { applyDrawingCommand, drawingActions, type DrawingShape } from './canvas-drawing'
import { executeWorkbench } from './canvas-workbench'
import { CanvasPhotoshopPanel } from './CanvasPhotoshopPanel'
import { retouchBrush, paintBrushStroke, photoshopActions, defaultDocument, validateDocument, serializeLayer, deserializeLayers, copyLayer, paintMask, snapPoint, healSegment, type DocumentSettings } from './canvas-photoshop'
import { applyEditingPixels, cropLayer, resizeDimensions, transformLayerContent, type ExposureMode } from './canvas-editing'

const SIZE = 1024
const MAX_AI_CANVAS_PIXELS = 32_000_000
type AiMode = 'generate' | 'inpaint' | 'outpaint' | 'cutout'
type CandidateBatch = { records: StudioGeneration[]; target: Rect; context: Rect | null; reference: HTMLCanvasElement | null; pixelSelection: PixelSelection | null; layerId: string; mode: AiMode; prompt: string; savedCount: number; issues: Map<string, EditOutputIssue> }
const actionClass = 'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 text-xs font-medium transition-colors hover:border-primary/30 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40'
const iconClass = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-40'
const sectionClass = 'space-y-3 border-b border-border/70 px-4 py-4'
type TileAction = { kind: 'tiles'; layerId: string; before: TileSnapshot; after: TileSnapshot }
type LayerAction = { kind: 'layers'; before: CanvasLayer[]; after: CanvasLayer[] }
type SelectionAction = { kind: 'selection'; before: { rect: Rect | null; mask: PixelSelection | null }; after: { rect: Rect | null; mask: PixelSelection | null } }
type DocumentAction = { kind: 'document'; before: CanvasLayer[]; after: CanvasLayer[]; beforeDocument: DocumentSettings; afterDocument: DocumentSettings }
type Action = TileAction | LayerAction | SelectionAction | DocumentAction | { kind: 'batch'; actions: Array<TileAction | LayerAction | SelectionAction | DocumentAction> }
type Gesture =
  | { kind: 'paint'; layerId: string; before: TileSnapshot; last: Point; erase: boolean; points: Point[] }
  | { kind: 'polygon'; previous: Point[] }
  | { kind: 'detail'; layerId: string; before: TileSnapshot; points: Point[] }
  | { kind: 'effect'; layerId: string; before: TileSnapshot; last: Point; source: CanvasLayer; action: 'pixelate' | 'exposure_brush'; selection: PixelSelection | null }
  | { kind: 'mask-paint'; layerId: string; before: CanvasLayer[]; original: CanvasLayer; points: Point[] }
  | { kind: 'clone'; heal?: boolean; layerId: string; before: TileSnapshot; last: Point; source: CanvasLayer; delta: Point }
  | { kind: 'drawing'; layerId: string; start: Point; end: Point; tool: 'shape' | 'gradient' | 'text' | 'fill'; selection: PixelSelection | null }
  | { kind: 'mask'; points: Point[]; shape: 'lasso' | 'brush' | 'ellipse'; previous: PixelSelection | null; mode: SelectionMode }
  | { kind: 'pan'; start: Point; origin: Point }
  | { kind: 'layer'; start: Point; layerId: string; origin: Point }
  | { kind: 'select'; start: Point }
  | { kind: 'selection-move' | 'selection-resize'; start: Point; original: Rect; mask: PixelSelection | null }

function cloneLayers(layers: CanvasLayer[]): CanvasLayer[] {
  return layers.map(layer => copyLayer(layer))
}
function base64(canvas: HTMLCanvasElement) { return canvas.toDataURL('image/png').split(',')[1] }
function bytesBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768))
  return btoa(binary)
}
function editIssueMessage(issue: EditOutputIssue) {
  return issue === 'black-fill'
    ? i18n.t('studio.blackFill')
    : i18n.t('studio.referenceChanged')
}
function saveFile(data: string | Blob, name: string) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data)
  const link = document.createElement('a'); link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove()
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
async function decode(url: string): Promise<HTMLImageElement> {
  const image = new Image(); image.src = url; await image.decode(); return image
}
function checkRect(rect: Rect, max = MAX_RASTER_SIDE) {
  if (rect.width < 2 || rect.height < 2 || rect.width > max || rect.height > max) throw new Error(i18n.t('studio.selectionSize', { value1: max }))
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
  return rasterizeRegion([rawLayer(layer)], rect, width, height)
}

function comparisonPreview(layers: CanvasLayer[], rect: Rect): string {
  const scale = Math.min(1, 768 / rect.width, 768 / rect.height)
  const width = Math.max(1, Math.round(rect.width * scale))
  const height = Math.max(1, Math.round(rect.height * scale))
  return rasterizeRegion(layers, rect, width, height).toDataURL('image/webp', 0.82)
}

type CanvasProject = { version: number; document?: DocumentSettings; activeId?: string; view?: { x: number; y: number; zoom: number }; prompt?: string; assistantDraft?: string; assistantThinking?: StudioThinkingLevel; assistantMode?: StudioExecutionMode; assistant?: CanvasChatMessage[]; layers: Array<ReturnType<typeof serializeLayer>> }
function serializeProject(layers: CanvasLayer[], activeId: string, view: { x: number; y: number; zoom: number }, prompt: string, assistant: CanvasChatMessage[], assistantDraft: string, assistantThinking: StudioThinkingLevel, assistantMode: StudioExecutionMode, documentSettings: DocumentSettings): string {
  return JSON.stringify({ version: 1, activeId, view, prompt, assistantDraft, assistantThinking, assistantMode, assistant: assistant.slice(-100), document: documentSettings, layers: layers.map(serializeLayer) })
}
async function parseProject(raw: string): Promise<{ project: CanvasProject; layers: CanvasLayer[] }> {
  const project = JSON.parse(raw) as CanvasProject
  if (project.version !== 1) throw new Error(i18n.t('studio.invalidProject'))
  project.document = validateDocument(project.document)
  return { project, layers: await deserializeLayers(project.layers) }
}

export default function StudioCanvas({ active = true, onOpenAiSettings }: { active?: boolean; onOpenAiSettings: () => void }) {
  return <StudioSessionWorkspace mode="canvas">{sessionProps => <CanvasEditor key={sessionProps.session.id} {...sessionProps} active={active} onOpenAiSettings={onOpenAiSettings} />}</StudioSessionWorkspace>
}

function CanvasEditor({ compactLayout, active, onOpenAiSettings, session, onSave, createSession, selectSession, renameSession, deleteSession, flushRef, setLocked, suggestTitle }: StudioSessionEditorProps & { active: boolean; onOpenAiSettings: () => void }) {
  const { t } = useTranslation()
  const { ref: layoutRef, compact: measuredCompact } = useStudioCompactLayout()
  const compact = compactLayout ?? measuredCompact
  const [mobilePanel, setMobilePanel] = useState<'tools' | 'properties' | 'files' | null>(null)
  useEffect(() => { if (!compact) setMobilePanel(null) }, [compact])
  const [fingerNavigation, setFingerNavigation] = useState(() => localStorage.getItem('tokenbird.studio.fingerNavigation') === '1')
  const [layers, setLayers] = useState<CanvasLayer[]>(() => [createLayer(t('studio.layerNumber', { value1: 1 }))])
  const layersRef = useRef(layers); layersRef.current = layers
  const [activeId, setActiveId] = useState(() => layers[0].id)
  const [documentSettings, setDocumentSettings] = useState<DocumentSettings>(defaultDocument)
  const documentRef = useRef(documentSettings); documentRef.current = documentSettings
  const clipboard = useRef<{ image: HTMLCanvasElement; bounds: Rect } | null>(null)
  const [brushOpacity, setBrushOpacity] = useState(100)
  const [hardness, setHardness] = useState(100)
  const [retouchMode,setRetouchMode] = useState<'blur'|'sharpen'|'smudge'>('blur')
  const [backgroundColor, setBackgroundColor] = useState('#ffffff')
  const [maskReveal, setMaskReveal] = useState(false)
  const [polygonPoints, setPolygonPoints] = useState<Point[]>([])
  const [tool, setTool] = useState<CanvasTool>('ai')
  const [selection, setSelectionRect] = useState<Rect | null>(null)
  const [pixelSelection, setPixelSelection] = useState<PixelSelection | null>(null)
  const pixelSelectionRef = useRef<PixelSelection | null>(null)
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('replace')
  const [cloneSource, setCloneSource] = useState<Point | null>(null)
  function setSelection(rect: Rect | null) {
    selectionRef.current = rect; setSelectionRect(rect)
    pixelSelectionRef.current = null; setPixelSelection(null)
  }
  function setMaskedSelection(next: PixelSelection | null) {
    pixelSelectionRef.current = next; setPixelSelection(next)
    selectionRef.current = next?.bounds ?? null; setSelectionRect(next?.bounds ?? null)
  }
  function currentSelectionMask(): PixelSelection | null {
    return pixelSelectionRef.current ?? (selectionRef.current ? rectangularSelection(selectionRef.current) : null)
  }
  const selectionRef = useRef(selection); selectionRef.current = selection
  const [view, setViewState] = useState({ x: 0, y: 0, zoom: 1 })
  const viewRef = useRef(view); viewRef.current = view
  const [size, setSize] = useState({ width: 1, height: 1 })
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 })
  const [color, setColor] = useState('#f5f5f4')
  const [brush, setBrush] = useState(18)
  const [text, setText] = useState('')
  const [fontSize, setFontSize] = useState(32)
  const [fontFamily, setFontFamily] = useState('sans-serif')
  const [bold, setBold] = useState(false)
  const [shape, setShape] = useState<DrawingShape>('rectangle')
  const [filled, setFilled] = useState(false)
  const [secondaryColor, setSecondaryColor] = useState('#ffffff')
  const [gradientKind, setGradientKind] = useState('linear')
  const [blockSize, setBlockSize] = useState(12)
  const [strength, setStrength] = useState(20)
  const [exposureMode, setExposureMode] = useState<ExposureMode>('dodge')
  const [targetWidth, setTargetWidth] = useState(512)
  const [targetHeight, setTargetHeight] = useState(512)
  const [skewX,setSkewX]=useState(0),[skewY,setSkewY]=useState(0)
  const [transformAngle, setTransformAngle] = useState(0)
  const [lockAspect, setLockAspect] = useState(true)
  const [smoothing, setSmoothing] = useState(true)
  const [drawingPreview, setDrawingPreview] = useState<Rect | null>(null)
  const [tolerance, setTolerance] = useState(32)
  const [adjustments, setAdjustments] = useState<AdjustmentSettings>({ ...defaultAdjustments })
  const [prompt, setPrompt] = useState('')
  const [assistantQuestion, setAssistantQuestion] = useState('')
  const [assistantThinking, setAssistantThinking] = useState<StudioThinkingLevel>('auto')
  const [assistantMode, setAssistantMode] = useState<StudioExecutionMode>('execute')
  const [assistantHistory, setAssistantHistory] = useState<CanvasChatMessage[]>([])
  const [assistantError, setAssistantError] = useState('')
  const [assistantBusy, setAssistantBusy] = useState(false)
  const [aiMode, setAiMode] = useState<AiMode>('generate')
  const [generationCount, setGenerationCount] = useState(1)
  const [generationWidth, setGenerationWidth] = useState(1024)
  const [generationHeight, setGenerationHeight] = useState(1024)
  const [candidates, setCandidates] = useState<CandidateBatch | null>(null)
  const [candidateIndex, setCandidateIndex] = useState(0)
  const [recentRecords, setRecentRecords] = useState<StudioGeneration[]>([])
  const [recentVisible, setRecentVisible] = useState(() => sessionStorage.getItem('tokenbird.studio.recentPreviewHidden') !== '1')
  const [mobilePreviewVisible, setMobilePreviewVisible] = useState(false)
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
  const touchNavigation = useRef(new CanvasTouchNavigation())
  const editPointer = useRef<{ id: number; type: string; selection: Rect | null; mask: PixelSelection | null } | null>(null)
  const canvasCommandRef = useRef<(input: Record<string, unknown>) => Promise<unknown>>(async () => { throw new Error('Canvas is loading') })
  const spaceHeld = useRef(false)
  const initialized = useRef(false)
  const undoStack = useRef<Action[]>([])
  const redoStack = useRef<Action[]>([])
  const hydrated = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [, refreshHistory] = useState(0)
  const { connections, connection, connectionSlug, setConnectionSlug, model, setModel, channelGroup, setChannelGroup, groups, loaded, loginTokenNest, refresh } = useStudioConnections({ image: true })
  const assistantConnection = useStudioConnections({ assistant: true })
  const imageReady = !!connection?.isAuthenticated && !!model.trim()
    && (connection.oauthProvider !== 'tokennest' || !!channelGroup)
  const setupOpen = active && loaded && (connectionSettingsOpen || !!connectionIssue || (!setupDismissed && (!setupDone || !imageReady)))
  const activeLayer = layers.find(layer => layer.id === activeId) ?? layers[layers.length - 1]
  useEffect(() => {
    if (tool !== 'transform') return
    const layer = layersRef.current.find(item => item.id === activeId)
    const bounds = layer ? layerPixelBounds(layer) : null
    if (bounds) { setTargetWidth(Math.ceil(bounds.width)); setTargetHeight(Math.ceil(bounds.height)) }
    setTransformAngle(0)
  }, [activeId, tool])
  const selected = !!selection && (pixelSelection ? selection.width > 0 && selection.height > 0 : selection.width >= 2 && selection.height >= 2)
  const activeIdRef = useRef(activeId); activeIdRef.current = activeId
  const promptRef = useRef(prompt); promptRef.current = prompt
  const assistantQuestionRef = useRef(assistantQuestion); assistantQuestionRef.current = assistantQuestion
  const assistantThinkingRef = useRef(assistantThinking); assistantThinkingRef.current = assistantThinking
  const assistantModeRef = useRef(assistantMode); assistantModeRef.current = assistantMode
  const assistantHistoryRef = useRef(assistantHistory); assistantHistoryRef.current = assistantHistory
  const applyingSuggestions = useRef(new Set<number>())

  async function persist() {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (!hydrated.current) return
    await onSave(serializeProject(layersRef.current, activeIdRef.current, viewRef.current, promptRef.current, assistantHistoryRef.current, assistantQuestionRef.current, assistantThinkingRef.current, assistantModeRef.current, documentRef.current))
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
        replace(restored.layers); documentRef.current=restored.project.document??defaultDocument();setDocumentSettings(documentRef.current)
        setActiveId(restored.layers.some(layer => layer.id === restored.project.activeId) ? restored.project.activeId! : restored.layers[restored.layers.length - 1].id)
        if (restored.project.view && Number.isFinite(restored.project.view.x) && Number.isFinite(restored.project.view.y) && Number.isFinite(restored.project.view.zoom)) {
          initialized.current = true
          setView({ ...restored.project.view, zoom: Math.max(0.1, Math.min(4, restored.project.view.zoom)) })
        }
        setPrompt(typeof restored.project.prompt === 'string' ? restored.project.prompt : '')
        setAssistantQuestion(typeof restored.project.assistantDraft === 'string' ? restored.project.assistantDraft.slice(0, 4000) : '')
        setAssistantThinking(studioThinkingLevel(restored.project.assistantThinking))
        setAssistantMode(studioExecutionMode(restored.project.assistantMode))
        setAssistantHistory(Array.isArray(restored.project.assistant) ? restored.project.assistant.slice(-100).filter(message => (message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string').map(message => ({ ...message, text: message.text.slice(0, 4000) })) : [])
      }
      hydrated.current = true
    })().catch(cause => { if (alive) setError(i18n.t('studio.restoreFailed', { value1: String(cause) })) })
    return () => { alive = false; hydrated.current = false; if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [session.id])

  useEffect(() => {
    if (!hydrated.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void persist().catch(cause => setError(i18n.t('studio.autosaveFailed', { value1: String(cause) }))) }, 900)
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current) }
  }, [layers, activeId, view, prompt, assistantHistory, assistantQuestion, assistantThinking, assistantMode, documentSettings, onSave])

  useEffect(() => { setLocked(busy || assistantBusy); return () => setLocked(false) }, [busy, assistantBusy, setLocked])
  useEffect(() => {
    let alive = true
    void listStudioGenerations(5).then(page => { if (alive) setRecentRecords(page.items) }).catch(() => {})
    return () => { alive = false }
  }, [historyRevision])

  function replace(next: CanvasLayer[]) { layersRef.current = next; setLayers(next) }
  function record(action: Action) {
    undoStack.current = [...undoStack.current.slice(-49), action]
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
    if (action.kind === 'selection') {
      const state=action[side]; if(state.mask) setMaskedSelection(state.mask); else setSelection(state.rect)
    } else if (action.kind === 'document') {
      const next=cloneLayers(action[side]);replace(next);setActiveId(id=>next.some(l=>l.id===id)?id:next[next.length-1].id)
      documentRef.current=side==='before'?action.beforeDocument:action.afterDocument;setDocumentSettings(documentRef.current)
    } else if (action.kind === 'batch') {
      for (const item of side === 'before' ? [...action.actions].reverse() : action.actions) restore(item, side)
    } else if (action.kind === 'layers') {
      const next = cloneLayers(action[side]); replace(next)
      setActiveId(id => next.some(layer => layer.id === id) ? id : next[next.length - 1].id)
      if (tool === 'transform') {
        const layer = next.find(item => item.id === activeId) ?? next[next.length - 1]
        const bounds = layerPixelBounds(layer)
        if (bounds) { setTargetWidth(Math.ceil(bounds.width)); setTargetHeight(Math.ceil(bounds.height)) }
        setTransformAngle(0)
      }
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
    const v = viewRef.current; return snapPoint({ x: (point.x - v.x) / v.zoom, y: (point.y - v.y) / v.zoom }, documentRef.current, 6/v.zoom)
  }
  function visible(): Rect {
    const v = viewRef.current
    return { x: -v.x / v.zoom, y: -v.y / v.zoom, width: size.width / v.zoom, height: size.height / v.zoom }
  }
  function setView(next: CanvasView) {
    // Pointer events can arrive before React renders the previous update.
    viewRef.current = next
    setViewState(next)
  }
  function zoomAt(point: Point, next: number) {
    const target = world(point), zoom = Math.max(0.1, Math.min(4, next))
    setView({ x: point.x - target.x * zoom, y: point.y - target.y * zoom, zoom })
  }
  function fit() {
    const bounds = documentRef.current.bounds ?? contentPixelBounds(layersRef.current)
    if (!bounds) { setView({ x: size.width / 2, y: size.height / 2, zoom: 1 }); return }
    const zoom = Math.max(0.1, Math.min(1.5, (size.width - 96) / bounds.width, (size.height - 96) / bounds.height))
    setView({ x: size.width / 2 - (bounds.x + bounds.width / 2) * zoom, y: size.height / 2 - (bounds.y + bounds.height / 2) * zoom, zoom })
  }
  useEffect(() => {
    const element = viewElement.current; if (!element) return
    let previous: { width: number; height: number } | null = null
    const update = () => {
      const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight)
      setSize({ width, height })
      if (!initialized.current && element.clientWidth > 1 && element.clientHeight > 1) {
        initialized.current = true; setView({ x: width / 2, y: height / 2, zoom: 1 })
      } else if (previous && width > 1 && height > 1) {
        setView({ ...viewRef.current, x: viewRef.current.x + (width - previous.width) / 2, y: viewRef.current.y + (height - previous.height) / 2 })
      }
      if (width > 1 && height > 1) previous = { width, height }
    }
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const observer = new ResizeObserver(update)
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
    if(documentSettings.bounds && documentSettings.background!=='transparent') { const b=documentSettings.bounds; ctx.fillStyle=documentSettings.background; ctx.fillRect(b.x,b.y,b.width,b.height) }
    drawLayers(ctx, layers, visible())
    if(documentSettings.bounds) { const b=documentSettings.bounds;ctx.save();ctx.strokeStyle='#888';ctx.lineWidth=1/view.zoom;ctx.strokeRect(b.x,b.y,b.width,b.height);ctx.restore() }
    ctx.save();ctx.strokeStyle='#22d3ee';ctx.lineWidth=1/view.zoom;ctx.setLineDash([4/view.zoom,4/view.zoom]);const viewport=visible()
    for(const guide of documentSettings.guides) {ctx.beginPath();if(guide.axis==='x'){ctx.moveTo(guide.value,viewport.y);ctx.lineTo(guide.value,viewport.y+viewport.height)}else{ctx.moveTo(viewport.x,guide.value);ctx.lineTo(viewport.x+viewport.width,guide.value)}ctx.stroke()}
    if(polygonPoints.length){ctx.beginPath();ctx.moveTo(polygonPoints[0].x,polygonPoints[0].y);polygonPoints.slice(1).forEach(p=>ctx.lineTo(p.x,p.y));ctx.stroke()}
    ctx.restore()
    if(tool==='workspace') {ctx.save();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.fillStyle='rgba(100,100,100,.85)';ctx.font='10px sans-serif';const step=Math.pow(10,Math.floor(Math.log10(80/view.zoom)));for(let x=Math.floor(viewport.x/step)*step;x<viewport.x+viewport.width;x+=step){const sx=view.x+x*view.zoom;ctx.fillText(String(Math.round(x)),sx+2,11);ctx.fillRect(sx,0,1,5)}for(let y=Math.floor(viewport.y/step)*step;y<viewport.y+viewport.height;y+=step){const sy=view.y+y*view.zoom;ctx.fillText(String(Math.round(y)),2,sy+10);ctx.fillRect(0,sy,5,1)}ctx.restore()}

    if (pixelSelection) {
      const preview = selectionMask(pixelSelection, visible(), Math.max(1, Math.round(size.width)), Math.max(1, Math.round(size.height)))
      const previewContext = preview.getContext('2d')!
      previewContext.globalCompositeOperation = 'source-in'; previewContext.fillStyle = 'rgba(96,165,250,.35)'; previewContext.fillRect(0, 0, preview.width, preview.height)
      ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.drawImage(preview, 0, 0, size.width, size.height); ctx.restore()
    } else if (selection?.width && selection.height) {
      ctx.setLineDash([7 / view.zoom, 5 / view.zoom]); ctx.lineWidth = 1.5 / view.zoom
      ctx.strokeStyle = '#60a5fa'; ctx.fillStyle = 'rgba(96,165,250,.1)'
      ctx.fillRect(selection.x, selection.y, selection.width, selection.height)
      ctx.strokeRect(selection.x, selection.y, selection.width, selection.height)
    }
    if ((tool === 'clone'||tool==='heal') && cloneSource) {
      ctx.save(); ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.5 / view.zoom; ctx.beginPath()
      ctx.moveTo(cloneSource.x - 8 / view.zoom, cloneSource.y); ctx.lineTo(cloneSource.x + 8 / view.zoom, cloneSource.y)
      ctx.moveTo(cloneSource.x, cloneSource.y - 8 / view.zoom); ctx.lineTo(cloneSource.x, cloneSource.y + 8 / view.zoom); ctx.stroke(); ctx.restore()
    }
  }, [active, layers, selection, pixelSelection, view, size, tool, cloneSource, documentSettings, polygonPoints])

  function updateMaskGesture(g: Extract<Gesture, { kind: 'mask' }>) {
    try {
      if (g.shape === 'lasso' && g.points.length < 3 || g.shape === 'ellipse' && (g.points.length < 2 || g.points[0].x === g.points[1].x || g.points[0].y === g.points[1].y)) return
      const next = shapeSelection(g.points, g.shape, brush)
      setMaskedSelection(combineSelections(g.previous, next, g.mode)); setError('')
    } catch (cause) { setError(String(cause)) }
  }

  function pointerDown(event: React.PointerEvent<HTMLCanvasElement>) {
    if (busy || assistantBusy) return
    if (event.button !== 0 && event.button !== 1) return
    if (event.pointerType === 'touch' && editPointer.current && editPointer.current.type !== 'touch') return
    if (event.pointerType === 'pen' && editPointer.current?.type === 'touch' && !touchNavigation.current.navigating) {
      const fingerId = editPointer.current.id
      finishEdit(true)
      touchNavigation.current.up(fingerId, viewRef.current)
      if (event.currentTarget.hasPointerCapture(fingerId)) event.currentTarget.releasePointerCapture(fingerId)
    }
    if (event.pointerType !== 'touch' && (editPointer.current || touchNavigation.current.navigating)) return
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
    const p = screen(event), w = world(p); setCursor(w)
    if (event.pointerType === 'touch') {
      if (touchNavigation.current.down(event.pointerId, p, viewRef.current)) finishEdit(true)
      if (touchNavigation.current.navigating) return
    }
    editPointer.current = { id: event.pointerId, type: event.pointerType, selection: selectionRef.current, mask: pixelSelectionRef.current }
    if (tool === 'hand' || (event.pointerType === 'touch' && fingerNavigation) || event.button === 1 || spaceHeld.current) gesture.current = { kind: 'pan', start: p, origin: { x: viewRef.current.x, y: viewRef.current.y } }
    else if (tool === 'move' && !activeLayer.locked) gesture.current = { kind: 'layer', start: w, layerId: activeLayer.id, origin: { ...activeLayer.offset } }
    else if (tool === 'eyedropper') {
      const sample = sampleColor(layersRef.current, w); setColor(sample.color); setNotice(t('studio.sampledColor', { value1: sample.color, value2: Math.round(sample.alpha * 100) }))
    } else if (tool === 'wand') {
      try {
        const bounds = layerPixelBounds(activeLayer)
        if (!bounds) throw new Error(t('studio.emptyLayer'))
        const next = wandSelection(activeLayer, w, tolerance, bounds)
        setMaskedSelection(combineSelections(currentSelectionMask(), next, event.altKey ? 'subtract' : event.shiftKey ? 'add' : selectionMode))
        setError('')
      } catch (cause) { setError(String(cause)) }
    } else if (tool === 'lasso' || tool === 'select-brush' || tool === 'ellipse') {
      const g: Extract<Gesture, { kind: 'mask' }> = { kind: 'mask', points: [w], shape: tool === 'select-brush' ? 'brush' : tool, previous: currentSelectionMask(), mode: event.altKey ? 'subtract' : event.shiftKey ? 'add' : selectionMode }
      gesture.current = g; updateMaskGesture(g)
    } else if(tool==='detail') {
      const before:TileSnapshot=new Map();try{retouchBrush(activeLayer,[w],brush,retouchMode,strength,currentSelectionMask(),before);gesture.current={kind:'detail',layerId:activeLayer.id,before,points:[w]};replace([...layersRef.current])}catch(cause){restoreTiles(activeLayer,before);setError(String(cause))}
    } else if (tool === 'mosaic' || tool === 'exposure') {
      const before: TileSnapshot = new Map(), source = snapshotLayer(activeLayer), action = tool === 'mosaic' ? 'pixelate' : 'exposure_brush'
      const mask = currentSelectionMask()
      try {
        applyEditingPixels(activeLayer, source, { action, points: [w], brush, blockSize, strength, exposureMode }, mask, before)
        gesture.current = { kind: 'effect', layerId: activeLayer.id, before, last: w, source, action, selection: mask }
        replace([...layersRef.current]); setError('')
      } catch (cause) { restoreTiles(activeLayer, before); setError(String(cause)) }
    } else if (tool === 'polygon-lasso') {
      gesture.current={kind:'polygon',previous:polygonPoints};setPolygonPoints(points=>points.length<2000?[...points,w]:points)
    } else if (tool === 'mask') {
      if(activeLayer.locked || !activeLayer.mask) {setError(t('studio.ps.maskRequired'));return}
      const original=copyLayer(activeLayer), before=cloneLayers(layersRef.current)
      try{ const mask=paintMask(original,[w],brush,maskReveal,currentSelectionMask());activeLayer.mask=mask;gesture.current={kind:'mask-paint',layerId:activeLayer.id,original,before,points:[w]};replace([...layersRef.current]) }catch(cause){setError(String(cause))}
    } else if (tool === 'clone' || tool === 'heal') {
      if (event.altKey) { setCloneSource(w); setNotice(t('studio.cloneSourceSet')); return }
      if (!cloneSource) { setError(t('studio.cloneSourceNeeded')); return }
      if (!activeLayer.visible) { setError(t('studio.showCurrentLayer')); return }
      const before: TileSnapshot = new Map(), source = snapshotLayer(activeLayer), delta = { x: cloneSource.x - w.x, y: cloneSource.y - w.y }
      try {
        if(tool==='heal') healSegment(activeLayer,source,w,w,delta,brush,before,currentSelectionMask()); else cloneSegment(activeLayer, source, w, w, delta, brush, before, currentSelectionMask())
        gesture.current = { kind: 'clone', heal:tool==='heal', layerId: activeLayer.id, before, last: w, source, delta }; replace([...layersRef.current]); setError('')
      } catch (cause) { setError(String(cause)) }
    } else if (tool === 'text' || tool === 'fill' || tool === 'shape' || tool === 'gradient') {
      if (!activeLayer.visible) { setError(t('studio.showCurrentLayer')); return }
      gesture.current = { kind: 'drawing', layerId: activeLayer.id, start: w, end: w, tool, selection: currentSelectionMask() }
      setDrawingPreview(null)
    }
    else if (tool === 'select' || tool === 'crop' || tool === 'ai' || tool === 'cutout') {
      const rect = selectionRef.current
      const hit = !!rect && w.x >= rect.x && w.x <= rect.x + rect.width && w.y >= rect.y && w.y <= rect.y + rect.height
      const corner = hit && Math.abs((w.x - rect.x - rect.width) * viewRef.current.zoom) < 16 && Math.abs((w.y - rect.y - rect.height) * viewRef.current.zoom) < 16
      if (rect && corner) gesture.current = { kind: 'selection-resize', start: w, original: rect, mask: pixelSelectionRef.current }
      else if (rect && hit) gesture.current = { kind: 'selection-move', start: w, original: rect, mask: pixelSelectionRef.current }
      else { gesture.current = { kind: 'select', start: w }; setSelection({ x: w.x, y: w.y, width: 0, height: 0 }) }
    } else if (tool === 'brush' || tool === 'erase') {
      if (!activeLayer.visible) { setError(t('studio.showCurrentLayer')); return }
      const before: TileSnapshot = new Map()
      const erase = tool !== 'brush'
      try { paintBrushPath(activeLayer,[w],erase,before) } catch(cause) {setError(String(cause));return}
      gesture.current = { kind: 'paint', layerId: activeLayer.id, before, last: w, erase, points: [w] }; replace([...layersRef.current])
    }
  }
  function pointerMove(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.pointerType === 'touch' && touchNavigation.current.has(event.pointerId)) {
      const next = touchNavigation.current.move(event.pointerId, screen(event))
      if (touchNavigation.current.navigating) {
        event.preventDefault()
        if (next) setView(next)
        return
      }
    }
    const p = screen(event), w = world(p); setCursor(w)
    if (editPointer.current?.id !== event.pointerId) return
    const g = gesture.current; if (!g) return
    if (g.kind === 'drawing') { g.end = w; if (g.tool === 'shape' || g.tool === 'gradient') setDrawingPreview(normalizeRect(g.start, w)) }
    else if (g.kind === 'pan') setView({ ...viewRef.current, x: g.origin.x + p.x - g.start.x, y: g.origin.y + p.y - g.start.y })
    else if (g.kind === 'layer') {
      const layer = layersRef.current.find(item => item.id === g.layerId)
      if (layer) { layer.offset = { x: g.origin.x + w.x - g.start.x, y: g.origin.y + w.y - g.start.y }; replace([...layersRef.current]) }
    } else if (g.kind === 'mask') {
      if (g.shape === 'ellipse') g.points = [g.points[0], w]
      else if (g.points.length < 2000 && Math.hypot(w.x - g.points[g.points.length - 1].x, w.y - g.points[g.points.length - 1].y) >= 1 / viewRef.current.zoom) g.points.push(w)
      updateMaskGesture(g)
    } else if (g.kind === 'effect') {
      const layer = layersRef.current.find(item => item.id === g.layerId)
      if (layer) {
        try { applyEditingPixels(layer, g.source, { action: g.action, points: [g.last, w], brush, blockSize, strength, exposureMode }, g.selection, g.before); g.last = w; replace([...layersRef.current]); setError('') }
        catch (cause) { setError(String(cause)) }
      }
    } else if(g.kind==='mask-paint') {
      const layer=layersRef.current.find(item=>item.id===g.layerId)
      if(layer && g.points.length<2000) {g.points.push(w);try{layer.mask=paintMask(g.original,g.points,brush,maskReveal,currentSelectionMask());replace([...layersRef.current])}catch(cause){setError(String(cause))}}
    } else if (g.kind === 'clone') {
      const layer = layersRef.current.find(item => item.id === g.layerId)
      if (layer) { try { if(g.heal)healSegment(layer,g.source,g.last,w,g.delta,brush,g.before,currentSelectionMask());else cloneSegment(layer, g.source, g.last, w, g.delta, brush, g.before, currentSelectionMask()); g.last = w; replace([...layersRef.current]) } catch (cause) { setError(String(cause)) } }
    } else if (g.kind === 'select') setSelection(normalizeRect(g.start, w))
    else if (g.kind === 'selection-move' || g.kind === 'selection-resize') {
      const bounds = g.kind === 'selection-move'
        ? { ...g.original, x: g.original.x + w.x - g.start.x, y: g.original.y + w.y - g.start.y }
        : { ...g.original, width: Math.max(2, g.original.width + w.x - g.start.x), height: Math.max(2, g.original.height + w.y - g.start.y) }
      if (g.mask) {
        try { checkedSelectionBounds(bounds); setMaskedSelection({ ...g.mask, bounds }) } catch (cause) { setError(String(cause)) }
      } else setSelection(bounds)
    }
    else if(g.kind==='detail') {
      const layer=layersRef.current.find(l=>l.id===g.layerId);if(layer&&g.points.length<2000){g.points.push(w);restoreTiles(layer,g.before);try{retouchBrush(layer,g.points,brush,retouchMode,strength,currentSelectionMask(),g.before);replace([...layersRef.current])}catch(cause){restoreTiles(layer,g.before);setError(String(cause))}}
    } else if (g.kind === 'paint') {
      const layer = layersRef.current.find(item => item.id === g.layerId)
      if (layer && g.points.length<2000) { g.points.push(w);try{restoreTiles(layer,g.before);paintBrushPath(layer,g.points,g.erase,g.before);g.last=w;replace([...layersRef.current])}catch(cause){setError(String(cause))} }
    }
  }
  function pointerUp(event: React.PointerEvent<HTMLCanvasElement>, cancelled = false) {
    if (editPointer.current?.id === event.pointerId) {
      if (!cancelled && gesture.current?.kind === 'drawing') gesture.current.end = world(screen(event))
      finishEdit(cancelled)
    }
    touchNavigation.current.up(event.pointerId, viewRef.current)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  function finishEdit(cancelled = false) {
    const previousSelection = editPointer.current?.selection ?? null
    const previousMask = editPointer.current?.mask ?? null
    editPointer.current = null
    const g = gesture.current; gesture.current = null
    setDrawingPreview(null)
    if (cancelled) {
      if (g?.kind === 'paint' || g?.kind === 'clone' || g?.kind === 'effect' || g?.kind === 'detail') {
        const layer = layersRef.current.find(item => item.id === g.layerId)
        if (layer) { restoreTiles(layer, g.before); replace([...layersRef.current]) }
      } else if(g?.kind==='polygon'){setPolygonPoints(g.previous)
      } else if(g?.kind==='mask-paint'){replace(cloneLayers(g.before))
      } else if (g?.kind === 'layer') {
        const layer = layersRef.current.find(item => item.id === g.layerId)
        if (layer) { layer.offset = { ...g.origin }; replace([...layersRef.current]) }
      } else if (g?.kind === 'mask' || g?.kind === 'select' || g?.kind === 'selection-move' || g?.kind === 'selection-resize') {
        if (previousMask) setMaskedSelection(previousMask)
        else setSelection(previousSelection)
      }
      return
    }
    if (g?.kind === 'paint' || g?.kind === 'clone' || g?.kind === 'effect' || g?.kind === 'detail') { const layer = layersRef.current.find(item => item.id === g.layerId); if (layer) finishTiles(layer, g.before) }
    if(g?.kind==='mask-paint') record({kind:'layers',before:g.before,after:cloneLayers(layersRef.current)})
    if(g?.kind==='mask' || g?.kind==='select' || g?.kind==='selection-move' || g?.kind==='selection-resize') record({kind:'selection',before:{rect:previousSelection,mask:previousMask},after:{rect:selectionRef.current,mask:pixelSelectionRef.current}})
    if (g?.kind === 'drawing' && (g.tool === 'text' || g.tool === 'fill' || g.start.x !== g.end.x || g.start.y !== g.end.y)) {
      const layer = layersRef.current.find(item => item.id === g.layerId)
      if (layer) {
        try {
          const scope = g.tool === 'fill' ? g.selection?.bounds ?? layerPixelBounds(layer) ?? checkedSelectionBounds(visible()) : null
          if(g.tool==='text') {executePhotoshop({action:'add_text_layer',x:g.start.x,y:g.start.y,text,fontSize,fontFamily,bold,color})} else executeDrawing({ action: { text: 'draw_text', fill: 'fill_region', shape: 'draw_shape', gradient: 'draw_gradient' }[g.tool],
            x: g.start.x, y: g.start.y, toX: g.end.x, toY: g.end.y,
            ...(scope ? { boundsX: scope.x, boundsY: scope.y, width: scope.width, height: scope.height } : {}) }, layer, g.selection)
          setError('')
        } catch (cause) { setError(String(cause)) }
      }
    }
    if (g?.kind === 'layer') {
      const layer = layersRef.current.find(item => item.id === g.layerId)
      if (layer && (layer.offset.x !== g.origin.x || layer.offset.y !== g.origin.y)) {
        const before = cloneLayers(layersRef.current); before.find(item => item.id === g.layerId)!.offset = g.origin
        record({ kind: 'layers', before, after: cloneLayers(layersRef.current) })
      }
    }
  }

  function executeDrawing(input: Record<string, unknown>, layer = activeLayer, mask = currentSelectionMask()) {
    const before: TileSnapshot = new Map()
    try {
      const bounds = applyDrawingCommand(layer, { color, brush, tolerance, text, fontSize, fontFamily, bold, shape, filled, secondaryColor, gradientKind, ...input }, mask, before)
      finishTiles(layer, before)
      return { applied: before.size > 0, layerId: layer.id, bounds }
    } catch (cause) { restoreTiles(layer, before); replace([...layersRef.current]); throw cause }
  }

  function paintBrushPath(layer: CanvasLayer, points: Point[], erase: boolean, before: TileSnapshot, options = { color, brush, opacity: brushOpacity, hardness }) {
    paintBrushStroke(layer, points, erase, before, options, currentSelectionMask())
  }
  function executePhotoshop(input: Record<string, unknown>) {
    if (input.action === 'get_history') return { undo: undoStack.current.map((item,index)=>({index,kind:item.kind})), redo: redoStack.current.map((item,index)=>({index,kind:item.kind})) }
    const beforeSelection = { rect: selectionRef.current, mask: pixelSelectionRef.current }
    const result = executeWorkbench({ layers: layersRef.current, activeId: activeIdRef.current, document: documentRef.current, selection: currentSelectionMask(), clipboard: clipboard.current }, input)
    const actions: Array<LayerAction | DocumentAction | SelectionAction> = []
    if (result.document) {
      actions.push({kind:'document',before:cloneLayers(layersRef.current),after:cloneLayers(result.layers??layersRef.current),beforeDocument:documentRef.current,afterDocument:result.document})
      documentRef.current=result.document;setDocumentSettings(result.document)
    } else if(result.layers) actions.push({kind:'layers',before:cloneLayers(layersRef.current),after:cloneLayers(result.layers)})
    if(result.layers) replace(result.layers)
    if(result.activeId) {activeIdRef.current=result.activeId;setActiveId(result.activeId)}
    if('selection' in result) {setMaskedSelection(result.selection??null);actions.push({kind:'selection',before:beforeSelection,after:{rect:selectionRef.current,mask:pixelSelectionRef.current}})}
    if(result.clipboard) {clipboard.current=result.clipboard;refreshHistory(v=>v+1)}
    if(actions.length===1) record(actions[0]);else if(actions.length) record({kind:'batch',actions})
    return result.result
  }

  function addLayer(name = t('studio.layerNumber', { value1: layersRef.current.length + 1 })) {
    const layer = createLayer(name); changeLayers([...layersRef.current, layer]); setActiveId(layer.id); return layer
  }
  function duplicate() {
    const layer = copyLayer(activeLayer,true); layer.name=t('studio.layerCopy',{value1:activeLayer.name})
    const index = layersRef.current.indexOf(activeLayer)
    changeLayers([...layersRef.current.slice(0, index + 1), layer, ...layersRef.current.slice(index + 1)]); setActiveId(layer.id)
  }
  function reorder(direction: number) {
    if(activeLayer.locked){setError('当前图层已锁定');return}
    const index = layersRef.current.findIndex(layer => layer.id === activeId), target = index + direction
    if (target < 0 || target >= layersRef.current.length) return
    const next = [...layersRef.current]; [next[index], next[target]] = [next[target], next[index]]; changeLayers(next)
  }
  function removeLayer() {
    if (activeLayer.locked) {setError('当前图层已锁定');return}
    if (layersRef.current.length === 1) { setError(t('studio.keepOneLayer')); return }
    const index = layersRef.current.findIndex(layer => layer.id === activeId)
    const next = layersRef.current.filter(layer => layer.id !== activeId); changeLayers(next)
    setActiveId(next[Math.max(0, index - 1)].id)
  }
  function executeLayerGeometry(input: Record<string, unknown>) {
    if (busy || assistantBusy) throw new Error('Canvas is busy; wait for the current AI request to finish')
    const result = input.action === 'crop_layer'
      ? { layer: cropLayer(activeLayer, currentSelectionMask(), input) }
      : transformLayerContent(activeLayer, input)
    changeLayers(layersRef.current.map(layer => layer.id === activeLayer.id ? result.layer : layer))
    const bounds = layerPixelBounds(result.layer)
    if (input.action === 'crop_layer') setSelection(null)
    else {
      if (bounds) { setTargetWidth(Math.ceil(bounds.width)); setTargetHeight(Math.ceil(bounds.height)) }
      setTransformAngle(0)
    }
    return { applied: true, layerId: result.layer.id, bounds,
      ...(input.action === 'crop_layer' ? { cropped: result.layer.id } : { transformed: result.layer.id }) }
  }
  function applyGeometry(input: Record<string, unknown>) {
    try { executeLayerGeometry(input); setError('') } catch (cause) { setError(String(cause)) }
  }
  function executePixelEdit(input: Record<string, unknown>) {
    const before: TileSnapshot = new Map()
    try {
      const bounds = applyEditingPixels(activeLayer, snapshotLayer(activeLayer), { brush, blockSize, strength, exposureMode, ...input }, currentSelectionMask(), before)
      finishTiles(activeLayer, before)
      return { applied: before.size > 0, layerId: activeLayer.id, bounds }
    } catch (cause) { restoreTiles(activeLayer, before); replace([...layersRef.current]); throw cause }
  }
  function chooseTool(next: CanvasTool) {
    if (next === 'transform') {
      const bounds = layerPixelBounds(activeLayer)
      if (bounds) { setTargetWidth(Math.ceil(bounds.width)); setTargetHeight(Math.ceil(bounds.height)) }
      setTransformAngle(0);setSkewX(0);setSkewY(0)
    }
    if(next==='text'&&activeLayer.textSource){const source=activeLayer.textSource;setText(source.text);setFontSize(source.fontSize);setFontFamily(source.fontFamily);setBold(source.bold);setColor(source.color)}
    setTool(next)
    if (next === 'cutout') setAiMode('cutout')
    if (compact) setMobilePanel(['ai', 'assist', 'text', 'shape', 'gradient', 'transform', 'workspace', 'adjust', 'cutout'].includes(next) ? 'properties' : null)
  }
  function setTransformDimension(axis: 'width' | 'height', value: number) {
    if (!Number.isFinite(value)) return
    const next = resizeDimensions(targetWidth, targetHeight, axis, value, lockAspect)
    setTargetWidth(next.width); setTargetHeight(next.height)
  }
  function mergeDown() {
    try {
      const index = layersRef.current.findIndex(layer => layer.id === activeId)
      if (index < 1) throw new Error(t('studio.noLayerBelow'))
      const below = layersRef.current[index - 1]
      if(activeLayer.locked||below.locked) throw new Error('合并前请解锁图层')
      if (!activeLayer.visible || !below.visible) throw new Error(t('studio.showMergeLayers'))
      const bounds = unionRects(layerPixelBounds(below), layerPixelBounds(activeLayer))
      if (!bounds) throw new Error(t('studio.emptyMergeLayers'))
      checkRect(bounds)
      const merged = rasterizeRegion([below, activeLayer], bounds, Math.ceil(bounds.width), Math.ceil(bounds.height))
      const replacement = createLayer(`${below.name} + ${activeLayer.name}`)
      drawImageOnLayer(replacement, merged, bounds)
      changeLayers([...layersRef.current.slice(0, index - 1), replacement, ...layersRef.current.slice(index + 1)])
      setActiveId(replacement.id)
      return true
    } catch (cause) { setError(String(cause)); return false }
  }
  function clearSelected() {
    const before:TileSnapshot=new Map()
    try {
      assertPixelEditable(activeLayer)
      if (!selected || !selection) return false
      if(pixelSelectionRef.current)clearMaskedSelection(activeLayer,pixelSelectionRef.current,before)
      else clearLayerRect(activeLayer,selection,before)
      finishTiles(activeLayer,before);setSelection(null);return true
    }catch(cause){restoreTiles(activeLayer,before);setError(String(cause));return false}
  }
  function extract(cut: boolean) {
    if (!selected || !selection) return
    try {
      checkRect(selection)
      const crop = rasterizeLayer(activeLayer, selection, Math.ceil(selection.width), Math.ceil(selection.height))
      if (pixelSelectionRef.current) {
        const ctx = crop.getContext('2d')!
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(selectionMask(pixelSelectionRef.current, selection, crop.width, crop.height), 0, 0)
      }
      const layer = createLayer(t('studio.selectionLayer', { value1: activeLayer.name })); drawImageOnLayer(layer, crop, selection)
      if (cut) {
        const before: TileSnapshot = new Map()
        if (pixelSelectionRef.current) clearMaskedSelection(activeLayer, pixelSelectionRef.current, before)
        else clearLayerRect(activeLayer, selection, before)
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
      return true
    } catch (cause) { setError(String(cause)); return false }
  }
  async function importImage(file: File) {
    if (!file.type.startsWith('image/')) throw new Error(t('studio.chooseImage'))
    const url = URL.createObjectURL(file)
    try {
      let image: HTMLImageElement
      try { image = await decode(url) }
      catch { throw new Error(t('studio.decodeFailed')) }
      const factor = Math.min(1, MAX_RASTER_SIDE / Math.max(image.naturalWidth, image.naturalHeight))
      const width = Math.round(image.naturalWidth * factor), height = Math.round(image.naturalHeight * factor)
      const center = world({ x: size.width / 2, y: size.height / 2 }), layer = createLayer(file.name.replace(/\.[^.]+$/, ''))
      drawImageOnLayer(layer, image, { x: center.x - width / 2, y: center.y - height / 2, width, height })
      changeLayers([...layersRef.current, layer]); setActiveId(layer.id)
      suggestTitle(layer.name)
      setNotice(factor < 1 ? t('studio.imageScaled') : t('studio.imageImported'))
    } finally { URL.revokeObjectURL(url) }
  }
  async function addGenerationToCanvas(record: StudioGeneration) {
    await importImage(new File([record.image], `AI · ${record.prompt.slice(0, 24)}.png`, { type: 'image/png' }))
  }
  function saveProject() {
    saveFile(new Blob([serializeProject(layersRef.current, activeIdRef.current, viewRef.current, promptRef.current, assistantHistoryRef.current, assistantQuestionRef.current, assistantThinkingRef.current, assistantModeRef.current, documentRef.current)], { type: 'application/json' }), 'tokenbird-canvas.tbcanvas')
    setNotice(t('studio.projectSaved'))
  }
  async function openProject(file: File) {
    if (file.size > 150_000_000) throw new Error(t('studio.projectTooLarge'))
    const { project, layers: next } = await parseProject(await file.text())
    const nextDocument=project.document??defaultDocument();record({kind:'document',before:cloneLayers(layersRef.current),after:cloneLayers(next),beforeDocument:documentRef.current,afterDocument:nextDocument});replace(next);documentRef.current=nextDocument;setDocumentSettings(nextDocument); setActiveId(project.activeId && next.some(layer => layer.id === project.activeId) ? project.activeId : next[next.length - 1].id)
    if (project.view && Number.isFinite(project.view.x) && Number.isFinite(project.view.y) && Number.isFinite(project.view.zoom)) setView(project.view)
    setPrompt(typeof project.prompt === 'string' ? project.prompt : '')
    setAssistantQuestion(typeof project.assistantDraft === 'string' ? project.assistantDraft.slice(0, 4000) : '')
    setAssistantThinking(studioThinkingLevel(project.assistantThinking))
    setAssistantMode(studioExecutionMode(project.assistantMode))
    setAssistantHistory(Array.isArray(project.assistant) ? project.assistant.slice(-100).filter(message => (message.role === 'user' || message.role === 'assistant') && typeof message.text === 'string') : [])
    setSelection(null); setNotice(t('studio.projectOpened'))
  }
  function localCutout() {
    try {
      assertPixelEditable(activeLayer);if(activeLayer.alphaLocked) throw new Error('请先关闭透明度锁定再抠图')
      if (!activeLayer.visible) throw new Error(t('studio.showLayer'))
      const bounds = selected ? selection : layerPixelBounds(activeLayer)
      if (!bounds) throw new Error(t('studio.emptyLayer'))
      checkRect(bounds, 2048)
      const canvas = rasterizeLayer(activeLayer, bounds, Math.ceil(bounds.width), Math.ceil(bounds.height))
      const ctx = canvas.getContext('2d')!, pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const removed = removeEdgeBackground(pixels, tolerance)
      if (!removed) throw new Error(t('studio.noBackground'))
      ctx.putImageData(pixels, 0, 0)
      const before: TileSnapshot = new Map()
      drawMaskedImage(activeLayer, canvas, bounds, pixelSelectionRef.current, before, true); finishTiles(activeLayer, before)
      setNotice(t('studio.pixelsCleared', { value1: removed.toLocaleString() })); setError('')
      return true
    } catch (cause) { setError(String(cause)); return false }
  }
  function adjust(settings = adjustments) {
    try {
      if (adjustmentsAreNeutral(settings)) return
      const changes = applyAdjustments(layersRef.current, selected ? selection : null, settings, pixelSelectionRef.current)
      if (!changes.length) throw new Error(selected ? t('studio.emptySelectionAdjust') : t('studio.emptyCanvasAdjust'))
      record({ kind: 'batch', actions: changes.map(({ layerId, before, after }) => ({ kind: 'tiles', layerId, before, after })) })
      replace([...layersRef.current])
      setAdjustments({ ...defaultAdjustments }); setNotice(selected ? t('studio.selectionAdjusted') : t('studio.canvasAdjusted')); setError('')
      return true
    } catch (cause) { setError(String(cause)); return false }
  }
  async function applyCandidate(batch: CandidateBatch, record: StudioGeneration) {
    const url = URL.createObjectURL(record.image)
    let image: HTMLImageElement
    try { image = await decode(url) } finally { URL.revokeObjectURL(url) }
    if (batch.mode === 'inpaint' || batch.mode === 'outpaint') {
      const layer = layersRef.current.find(item => item.id === batch.layerId)
      if (!layer || !layer.visible) throw new Error(t('studio.restoreOriginalLayer'))
      assertPixelEditable(layer)
      if (!batch.reference) throw new Error(t('studio.missingSnapshot'))
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
      drawMaskedImage(layer, overlay, batch.target, batch.pixelSelection, before, true)
      finishTiles(layer, before)
      setSelection(null); setCandidates(null)
      suggestTitle(batch.prompt.slice(0, 40))
      setNotice(batch.mode === 'inpaint'
        ? t('studio.inpaintApplied')
        : t('studio.outpaintApplied'))
      return
    }
    const layer = createLayer(batch.mode === 'cutout' ? t('studio.transparentAsset') : `AI · ${batch.prompt.slice(0, 24)}`)
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
      drawMaskedImage(layer, crop, target, batch.pixelSelection)
    } else drawMaskedImage(layer, image, batch.target, batch.pixelSelection)
    changeLayers([...layersRef.current, layer]); setActiveId(layer.id); setSelection(null); setCandidates(null)
    suggestTitle(batch.prompt.slice(0, 40))
    setNotice(batch.mode === 'cutout'
      ? transparent ? t('studio.transparentAssetAdded') : t('studio.opaqueOutput')
      : t('studio.aiImageAdded'))
  }

  async function generate(mode: AiMode = tool === 'cutout' ? 'cutout' : aiMode, promptOverride?: string) {
    if (!imageReady) { const message = t('studio.imageConnectionRequired'); setError(message); return { status: 'error' as const, message } }
    if (mode !== 'cutout' && !(promptOverride ?? prompt).trim()) { const message = t('studio.promptRequired'); setError(message); return { status: 'error' as const, message } }
    setBusy(true); setError(''); setNotice('')
    try {
      const generationPrompt = mode === 'cutout'
        ? 'Remove the background completely. Keep only the original subject with fine edges. Return a PNG with a fully transparent background, without adding objects.'
        : (promptOverride ?? prompt).trim()
      let target: Rect, source: HTMLCanvasElement | null = null, mask: HTMLCanvasElement | null = null
      let reference: HTMLCanvasElement | null = null
      const generationSelection = pixelSelectionRef.current
      let context: Rect | null = null
      if (mode === 'cutout') {
        if (!activeLayer.visible) throw new Error(t('studio.showCurrentLayer'))
        const bounds = selected ? selection : layerPixelBounds(activeLayer)
        if (!bounds) throw new Error(t('studio.imageRequired'))
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
          throw new Error(t('studio.targetSizeLimit'))
        }
        const range = tileRange(target)
        if ((range.right - range.left + 1) * (range.bottom - range.top + 1) > 128) {
          throw new Error(t('studio.tooManyTiles'))
        }
        if (mode === 'inpaint' || mode === 'outpaint') {
          assertPixelEditable(activeLayer)
          if (!selected || !selection) throw new Error(mode === 'inpaint' ? t('studio.inpaintSelectionRequired') : t('studio.outpaintSelectionRequired'))
          if (!activeLayer.visible) throw new Error(t('studio.showEditLayer'))
          if (activeLayer.opacity !== 1) throw new Error(t('studio.fullOpacityRequired'))
          reference = rasterizeLayer(activeLayer, target, SIZE, SIZE)
          const activePixels = reference.getContext('2d')!.getImageData(0, 0, SIZE, SIZE).data
          let activeHasContent = false
          for (let index = 3; index < activePixels.length; index += 4) if (activePixels[index]) { activeHasContent = true; break }
          if (!activeHasContent) throw new Error(t('studio.originalLayerRequired'))
          const activeIndex = layersRef.current.findIndex(layer => layer.id === activeLayer.id)
          const upperLayers = layersRef.current.slice(activeIndex + 1).filter(layer => layer.visible && layer.opacity > 0)
          if (upperLayers.length) {
            const upperPixels = rasterizeRegion(upperLayers, target, SIZE, SIZE).getContext('2d')!.getImageData(0, 0, SIZE, SIZE).data
            for (let index = 3; index < upperPixels.length; index += 4) if (upperPixels[index]) {
              throw new Error(t('studio.selectionObscured'))
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
          if (!populated) throw new Error(t('studio.noReference'))
          if (mode === 'outpaint') {
            const coverage = referenceCoverage(sourcePixels)
            if (coverage < 0.2) throw new Error(t('studio.insufficientReference', { value1: Math.round(coverage * 100) }))
          }
          mask = document.createElement('canvas'); mask.width = SIZE; mask.height = SIZE
          const ctx = mask.getContext('2d')!; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, SIZE, SIZE)
          if (mode === 'inpaint') {
            const pixels = ctx.getImageData(0, 0, SIZE, SIZE)
            const border = 24
            for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
              const index = (y * SIZE + x) * 4 + 3
              if ((x >= border && x < SIZE - border && y >= border && y < SIZE - border) || alpha[index] === 0 || generationSelection) {
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
            if (!blank) throw new Error(t('studio.noBlankArea'))
            ctx.putImageData(pixels, 0, 0)
          }
          if (generationSelection) {
            const selectedPixels = selectionMask(generationSelection, target, SIZE, SIZE).getContext('2d')!.getImageData(0, 0, SIZE, SIZE)
            const pixels = ctx.getImageData(0, 0, SIZE, SIZE)
            for (let index = 3; index < pixels.data.length; index += 4) pixels.data[index] = 255 - (255 - pixels.data[index]) * selectedPixels.data[index] / 255
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
          sessionTitle: session.title === t('studio.untitledCanvas') ? generationPrompt.slice(0, 40) : session.title,
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
      if (!records.length) throw new Error(t('studio.noImageReturned'))
      setRecentRecords(current => [...records, ...current].slice(0, 5))
      if (savedCount) setHistoryRevision(value => value + 1)
      const batch: CandidateBatch = { records, target, context, reference, pixelSelection: generationSelection, layerId: activeLayer.id, mode, prompt: generationPrompt, savedCount, issues }
      if (records.length === 1 && !issues.size) await applyCandidate(batch, records[0])
      else {
        setCandidateIndex(Math.max(0, records.findIndex(record => !issues.has(record.id))))
        setCandidates(batch)
        setNotice(issues.size === records.length
          ? editIssueMessage(issues.get(records[0].id)!)
          : t('studio.imagesGenerated', { value1: records.length, value2: t(mode === 'inpaint' || mode === 'outpaint' ? 'studio.replaceSelection' : 'studio.addToCanvas') }))
      }
      if (outputs.length < generationCount) setNotice(t('studio.fewerImages', { value1: outputs.length, value2: generationCount }))
      if (historyError) setError(t('studio.historySaveFailed', { value1: historyError }))
      return { status: records.length === 1 && !issues.size ? 'applied' : 'candidates', count: records.length,
        candidates: records.map((record, index) => ({ index, id: record.id, issue: issues.get(record.id) ?? null })) }
    } catch (cause) {
      const issue = classifyStudioConnectionError(cause, connection?.oauthProvider === 'tokennest')
      rechargeOnInsufficientBalance(cause, connection)
      if (issue) { setConnectionIssue(issue); setConnectionSettingsOpen(true); setError('') }
      else setError(String(cause))
      return { status: 'error', message: String(cause) }
    }
    finally { setBusy(false) }
  }
  async function chooseCandidate(record: StudioGeneration) {
    if (!candidates || busy) return false
    const issue = candidates.issues.get(record.id)
    if (issue) { setError(editIssueMessage(issue)); return false }
    setBusy(true)
    try { await applyCandidate(candidates, record); return true }
    catch (cause) { setError(t('studio.imageAddFailed', { value1: String(cause) })); return false }
    finally { setBusy(false) }
  }
  async function askCanvasAssistant(questionOverride?: string): Promise<CanvasSuggestion | null> {
    const question = (questionOverride ?? assistantQuestion).trim()
    if (!question || assistantBusy) return null
    if (!assistantConnection.connection?.isAuthenticated || !assistantConnection.model.trim()) {
      setAssistantError(t('studio.textConnectionRequired')); return null
    }
    setAssistantBusy(true); setAssistantError(''); setError('')
    const previous = assistantHistoryRef.current
    const retry = !!questionOverride && previous.at(-1)?.role === 'user' && previous.at(-1)?.text === question
    if (!retry) {
      const next = [...previous, { role: 'user' as const, text: question }].slice(-100)
      assistantHistoryRef.current = next
      setAssistantHistory(next)
    }
    if (!previous.length) suggestTitle(question.slice(0, 40))
    setAssistantQuestion('')
    try {
      const bounds = selected && selection ? selection : contentPixelBounds(layersRef.current)
      let imageBase64: string | undefined
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        const scale = Math.min(1, 1024 / bounds.width, 1024 / bounds.height)
        imageBase64 = base64(rasterizeRegion(layersRef.current, bounds,
          Math.max(1, Math.round(bounds.width * scale)), Math.max(1, Math.round(bounds.height * scale))))
      }
      const suggestion = await window.electronAPI.assistStudioCanvas({
        connectionSlug: assistantConnection.connectionSlug, model: assistantConnection.model.trim(),
        ...(assistantConnection.connection.oauthProvider === 'tokennest' ? { channelGroup: assistantConnection.modelChannelGroup } : {}),
        sessionId: session.id, sessionTitle: session.title, question, thinkingLevel: assistantThinking,
        history: previous.slice(-20).map(({ role, text }) => ({ role, text })),
        ...(imageBase64 ? { imageBase64 } : {}), ...(selected && selection ? { selection } : {}),
      })
      const next = [...assistantHistoryRef.current, { role: 'assistant' as const, text: suggestion.reply, suggestion }].slice(-100)
      assistantHistoryRef.current = next
      setAssistantHistory(next)
      if (assistantMode === 'execute' && suggestion.operation !== 'none') {
        try { await applyCanvasSuggestion(next.length - 1) }
        catch { setError(t('studio.suggestionFailed')) }
      }
      return suggestion
    } catch (cause) { rechargeOnInsufficientBalance(cause, assistantConnection.connection); setAssistantError(t('studio.assistantFailed', { value1: String(cause) })); return null }
    finally { setAssistantBusy(false) }
  }
  async function applyCanvasSuggestion(index: number) {
    const message = assistantHistoryRef.current[index]
    if (!message || message.applied || !message.suggestion || applyingSuggestions.current.has(index)) return
    const suggestion = message.suggestion
    if (suggestion.operation === 'adjust') {
      const settings = { ...defaultAdjustments, ...suggestion.adjustments }
      if (adjustmentsAreNeutral(settings)) { setError(t('studio.noAdjustmentParams')); return }
      const bounds = selected && selection ? selection : contentPixelBounds(layersRef.current)
      if (!bounds) { setError(t('studio.emptyCanvasAdjust')); return }
      let before: string
      try { before = comparisonPreview(layersRef.current, bounds) }
      catch (cause) { setError(t('studio.beforePreviewFailed', { value1: String(cause) })); return }
      if (!adjust(settings)) return
      let after: string | undefined
      try { after = comparisonPreview(layersRef.current, bounds) }
      catch (cause) { setError(t('studio.afterPreviewFailed', { value1: String(cause) })) }
      const next = [...assistantHistoryRef.current]
      next[index] = { ...message, applied: true, ...(after ? { comparison: { before, after } } : {}) }
      assistantHistoryRef.current = next
      setAssistantHistory(next)
      return
    }
    if (suggestion.operation === 'none' || !suggestion.prompt?.trim()) return
    if ((suggestion.operation === 'inpaint' || suggestion.operation === 'outpaint') && !selected) {
      setError(t('studio.editSelectionRequired')); setTool('select'); return
    }
    setTool('ai'); setAiMode(suggestion.operation); setPrompt(suggestion.prompt)
    applyingSuggestions.current.add(index)
    try {
      const result = await generate(suggestion.operation, suggestion.prompt)
      if (result?.status === 'error') {
        const issue = classifyStudioConnectionError(result.message, connection?.oauthProvider === 'tokennest')
        if (!issue) setError(t('studio.suggestionImageFailed'))
      }
      if (result?.status === 'applied' || (result?.status === 'candidates' && result.candidates?.some(candidate => !candidate.issue))) {
        const current = assistantHistoryRef.current
        if (current[index]?.suggestion !== suggestion) return
        const next = [...current]
        next[index] = { ...next[index], applied: true, candidateReady: result.status === 'candidates' }
        assistantHistoryRef.current = next
        setAssistantHistory(next)
      }
    } finally { applyingSuggestions.current.delete(index) }
  }
  async function canvasCommand(input: Record<string, unknown>): Promise<unknown> {
    const action = String(input.action ?? '')
    const targetId = typeof input.sessionId === 'string' ? input.sessionId : session.id
    if (action === 'list_sessions') return { sessions: await listStudioSessions('canvas'), activeId: session.id }
    if ((busy || assistantBusy) && !['get_state', 'get_history', 'list_history', 'list_tools'].includes(action)) throw new Error('Canvas is busy; wait for the current AI request to finish')
    if (action === 'create_session') {
      const previous = activeStudioSessionId('canvas')
      await createSession()
      const created = activeStudioSessionId('canvas')
      if (!created || created === previous) throw new Error('Canvas session was not created')
      return { sessionId: created }
    }
    if (action === 'select_session') {
      if (!(await listStudioSessions('canvas')).some(item => item.id === targetId)) throw new Error('Canvas session not found')
      await selectSession(targetId)
      if (activeStudioSessionId('canvas') !== targetId) throw new Error('Canvas session could not be selected')
      return { sessionId: targetId, selected: true }
    }
    if (action === 'rename_session') {
      if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('title is required')
      await renameSession(targetId, input.title)
      const renamed = (await listStudioSessions('canvas')).find(item => item.id === targetId)
      if (renamed?.title !== input.title.trim().slice(0, 80)) throw new Error('Canvas session was not renamed')
      return { sessionId: targetId, title: renamed.title }
    }
    if (action === 'delete_session') {
      if (input.confirm !== true) throw new Error('confirm=true is required to delete a canvas session permanently')
      await deleteSession(targetId, true)
      if ((await listStudioSessions('canvas')).some(item => item.id === targetId)) throw new Error('Canvas session was not deleted')
      return { deleted: targetId, activeId: activeStudioSessionId('canvas') }
    }
    if (targetId !== session.id) throw new Error(`Canvas session ${targetId} is not active. Call select_session first.`)
    if(photoshopActions.includes(action as typeof photoshopActions[number])) return executePhotoshop(input)
    if (action === 'get_state') return {
      session: { id: session.id, title: session.title }, activeLayerId: activeId, selection: selected ? selection : null,
      selectionKind: pixelSelectionRef.current?.kind ?? (selected ? 'rectangle' : null), selectionMode, cloneSource,
      layers: layersRef.current.map(layer => ({ id: layer.id, name: layer.name, visible: layer.visible, opacity: Math.round(layer.opacity * 100), offset: layer.offset, tiles: layer.tiles.size, blendMode:layer.blendMode??'source-over',locked:!!layer.locked,alphaLocked:!!layer.alphaLocked,group:layer.group,clipping:!!layer.clipping,mask:layer.mask?{enabled:layer.mask.enabled,bounds:layer.mask.bounds}:null,textSource:layer.textSource })),
      view: viewRef.current, image: { connectionSlug, model, channelGroup, mode: aiMode, count: generationCount, width: generationWidth, height: generationHeight, prompt },
      assistant: { connectionSlug: assistantConnection.connectionSlug, model: assistantConnection.model, messages: assistantHistory.length },
      document:documentSettings,
      editing: { blockSize, strength, exposureMode, retouchMode, brushOpacity, hardness, targetWidth, targetHeight, angle: transformAngle, skewX,skewY, smoothing },
      adjustments, undoAvailable: undoStack.current.length > 0, redoAvailable: redoStack.current.length > 0,
    }
    if (action === 'list_tools') return { groups: canvasToolGroups, selectionActions: ['invert_selection', 'clear_selection', 'extract_selection', 'export_selection_mask'], selectionModes: ['replace', 'add', 'subtract', 'intersect'] }
    const number = (key: string): number => {
      const value = input[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`)
      return value
    }
    const path = (): Point[] => {
      const points = Array.isArray(input.points) && input.points.length ? input.points as Point[] : [
        { x: number('x'), y: number('y') }, { x: input.toX === undefined ? number('x') : number('toX'), y: input.toY === undefined ? number('y') : number('toY') },
      ]
      if (points.length > 2000 || !points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))) throw new Error('Path must contain 1–2000 finite canvas points')
      checkedSelectionBounds({ x: Math.min(...points.map(p => p.x)) - 80, y: Math.min(...points.map(p => p.y)) - 80,
        width: Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)) + 160, height: Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)) + 160 })
      return points
    }
    const combine = (next: PixelSelection) => {
      const mode = (input.selectionMode ?? 'replace') as SelectionMode
      if (!['replace', 'add', 'subtract', 'intersect'].includes(mode)) throw new Error('Invalid selectionMode')
      setMaskedSelection(combineSelections(currentSelectionMask(), next, mode))
      return { selection: selectionRef.current, selectionKind: pixelSelectionRef.current?.kind ?? null }
    }
    if (action === 'import_image') {
      if (typeof input.imageBase64 !== 'string' || !input.imageBase64) throw new Error('imagePath or imageBase64 is required')
      const name = typeof input.imageName === 'string' ? input.imageName : typeof input.name === 'string' ? input.name : t('studio.importedImageFilename')
      const mime = /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp'
        : /\.gif$/i.test(name) ? 'image/gif' : /\.avif$/i.test(name) ? 'image/avif' : 'image/png'
      const bytes = Uint8Array.from(atob(input.imageBase64), character => character.charCodeAt(0))
      if (bytes.length > 30_000_000) throw new Error('Image exceeds 30 MB')
      await importImage(new File([bytes], name, { type: mime }))
      return { imported: true, layerId: layersRef.current[layersRef.current.length - 1].id }
    }
    if (action === 'open_project') {
      if (typeof input.projectText !== 'string') throw new Error('projectPath is required')
      await openProject(new File([input.projectText], 'canvas.tbcanvas', { type: 'application/json' }))
      return { opened: true, layers: layersRef.current.length }
    }
    if (action === 'export_png') {
      if (typeof input.outputPath !== 'string') throw new Error('outputPath is required')
      return executePhotoshop({...input,action:'export_image',format:'png',selectionOnly:selected})
    }
    if (action === 'save_project') {
      if (typeof input.outputPath !== 'string') throw new Error('outputPath is required')
      const raw = serializeProject(layersRef.current, activeIdRef.current, viewRef.current, promptRef.current, assistantHistoryRef.current, assistantQuestionRef.current, assistantThinkingRef.current, assistantModeRef.current, documentRef.current)
      return { base64: bytesBase64(new TextEncoder().encode(raw)) }
    }
    if (action === 'set_selection') {
      const rect = { x: number('x'), y: number('y'), width: number('width'), height: number('height') }
      if (input.selectionMode && input.selectionMode !== 'replace') return combine(rectangularSelection(rect))
      checkRect(rect, 16000); setSelection(rect); return { selection: rect }
    }
    if (action === 'select_lasso' || action === 'select_brush') return combine(shapeSelection(path(), action === 'select_lasso' ? 'lasso' : 'brush', typeof input.brush === 'number' ? input.brush : brush))
    if (action === 'select_ellipse') {
      const rect = { x: number('x'), y: number('y'), width: number('width'), height: number('height') }; checkRect(rect)
      return combine(shapeSelection([{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }], 'ellipse'))
    }
    if (action === 'select_wand') {
      const bounds = layerPixelBounds(activeLayer)
      if (!bounds) throw new Error('Active layer has no pixels')
      return combine(wandSelection(activeLayer, { x: number('x'), y: number('y') }, typeof input.tolerance === 'number' ? input.tolerance : tolerance, bounds))
    }
    if (action === 'invert_selection') return executePhotoshop({action:'modify_selection',operation:'invert'})
    if (action === 'export_selection_mask') {
      const mask = currentSelectionMask(); if (!mask) throw new Error('Selection required')
      if (typeof input.outputPath !== 'string') throw new Error('outputPath is required')
      return { base64: base64(selectionMask(mask, checkedSelectionBounds(mask.bounds))), ...mask.bounds, selectedAlpha: 'opaque' }
    }
    if (action === 'sample_color') {
      const result = sampleColor(layersRef.current, { x: number('x'), y: number('y') }); setColor(result.color); return result
    }
    if (action === 'clear_selection') { setSelection(null); return { selection: null } }
    if (action === 'add_layer') { const layer = addLayer(typeof input.name === 'string' ? input.name.slice(0, 80) : undefined); return { layerId: layer.id } }
    if (action === 'duplicate_layer') { duplicate(); return { duplicated: activeId } }
    if (action === 'remove_layer') { if(activeLayer.locked) throw new Error('当前图层已锁定'); if (layersRef.current.length === 1) throw new Error('At least one layer must remain'); removeLayer(); return { removed: activeId } }
    if (action === 'move_layer') {
      if(activeLayer.locked) throw new Error('当前图层已锁定')
      const index = layersRef.current.findIndex(layer => layer.id === activeId)
      const target = index + (input.direction === 'down' ? -1 : 1)
      if (target < 0 || target >= layersRef.current.length) throw new Error('Layer cannot move further')
      reorder(input.direction === 'down' ? -1 : 1); return { moved: activeId }
    }
    if (action === 'set_layer') {
      const id = typeof input.layerId === 'string' ? input.layerId : activeId
      const next = cloneLayers(layersRef.current), layer = next.find(item => item.id === id)
      if (!layer) throw new Error('Layer not found')
      if (typeof input.name === 'string') layer.name = input.name.slice(0, 80)
      if(layer.locked && (input.x!==undefined||input.y!==undefined)) throw new Error('当前图层已锁定')
      if(typeof input.locked==='boolean') layer.locked=input.locked
      if(typeof input.alphaLocked==='boolean') layer.alphaLocked=input.alphaLocked
      if(typeof input.clipping==='boolean') layer.clipping=input.clipping
      if(typeof input.blendMode==='string'){if(!BLEND_MODES.includes(input.blendMode as typeof BLEND_MODES[number]))throw new Error('混合模式无效');layer.blendMode=input.blendMode as typeof BLEND_MODES[number]}
      if (typeof input.visible === 'boolean') layer.visible = input.visible
      if (typeof input.opacity === 'number' && !Number.isFinite(input.opacity)) throw new Error('opacity must be finite')
      if (typeof input.x === 'number' && (!Number.isFinite(input.x)||Math.abs(input.x)>1e9) || typeof input.y === 'number' && (!Number.isFinite(input.y)||Math.abs(input.y)>1e9)) throw new Error('Layer position is invalid')
      if (typeof input.opacity === 'number') layer.opacity = Math.max(0, Math.min(1, input.opacity / 100))
      if (typeof input.x === 'number') layer.offset.x = input.x
      if (typeof input.y === 'number') layer.offset.y = input.y
      changeLayers(next); setActiveId(id); return { layerId: id, name: layer.name, visible: layer.visible, opacity: layer.opacity, offset: layer.offset }
    }
    if (action === 'transform_layer' || action === 'crop_layer') return executeLayerGeometry(input)
    if (action === 'pixelate' || action === 'exposure_brush') return executePixelEdit(input)
    if (action === 'merge_down') { if (!mergeDown()) throw new Error('Layer merge failed'); return { merged: activeId } }
    if (drawingActions.includes(action as typeof drawingActions[number])) return executeDrawing(input)
    if(action==='paint'||action==='erase') { const before:TileSnapshot=new Map();paintBrushPath(activeLayer,path(),action==='erase',before,{color:typeof input.color==='string'?input.color:color,brush:typeof input.brush==='number'?input.brush:brush,opacity:typeof input.brushOpacity==='number'?input.brushOpacity:brushOpacity,hardness:typeof input.hardness==='number'?input.hardness:hardness});finishTiles(activeLayer,before);return{painted:true,layerId:activeLayer.id} }
    if (action === 'delete_pixels' || action === 'clone_stamp') {
      if (!activeLayer.visible) throw new Error('Active layer is hidden')
      if (action === 'delete_pixels' && selected) { if(!clearSelected())throw new Error('Pixel deletion failed'); return { deleted: true, layerId: activeLayer.id } }
      const points = path()
      const width = typeof input.brush === 'number' ? input.brush : brush
      if (!Number.isFinite(width) || width < 1 || width > 160) throw new Error('brush must be 1–160')
      const before: TileSnapshot = new Map()
      const source = action === 'clone_stamp' ? snapshotLayer(activeLayer) : null
      const delta = source ? { x: number('sourceX') - points[0].x, y: number('sourceY') - points[0].y } : null
      for (let index = 0; index < points.length; index++) {
        const from = points[Math.max(0, index - 1)], to = points[index]
        if (source && delta) cloneSegment(activeLayer, source, from, to, delta, width, before, currentSelectionMask())
        else paintMaskedSegment(activeLayer, from, to, width, typeof input.color === 'string' ? input.color : color, true, before, currentSelectionMask())
      }
      finishTiles(activeLayer, before); return { painted: true, layerId: activeLayer.id }
    }
    if (action === 'extract_selection') { if (!selected) throw new Error('Selection required'); if (!extract(input.cut === true)) throw new Error('Selection extraction failed'); return { extracted: true } }
    if (action === 'clear_selection_pixels') { if (!selected) throw new Error('Selection required'); if(!clearSelected())throw new Error('Pixel deletion failed'); return { cleared: true } }
    if (action === 'cutout') { if (!localCutout()) throw new Error('Local cutout failed'); return { applied: true } }
    if (action === 'adjust') {
      const settings = { ...defaultAdjustments, ...(input.adjustments && typeof input.adjustments === 'object' ? input.adjustments : {}) } as AdjustmentSettings
      if (adjustmentsAreNeutral(settings)) throw new Error('No adjustment values supplied')
      if (!adjust(settings)) throw new Error('Canvas adjustment failed')
      return { adjusted: true, scope: selected ? 'selection' : 'visible_layers' }
    }
    if (action === 'set_parameters') {
      if (typeof input.connectionSlug === 'string') setConnectionSlug(input.connectionSlug)
      if (typeof input.model === 'string') setModel(input.model)
      if (typeof input.channelGroup === 'string') setChannelGroup(input.channelGroup)
      if (typeof input.assistantConnectionSlug === 'string') assistantConnection.setConnectionSlug(input.assistantConnectionSlug)
      if (typeof input.assistantModel === 'string') assistantConnection.setModel(input.assistantModel)
      if (typeof input.prompt === 'string') setPrompt(input.prompt)
      if (typeof input.mode === 'string') setAiMode(input.mode as AiMode)
      if (typeof input.count === 'number') setGenerationCount(input.count)
      if (typeof input.width === 'number') setGenerationWidth(input.width)
      if (typeof input.height === 'number') setGenerationHeight(input.height)
      if (typeof input.brush === 'number') setBrush(input.brush)
      if (typeof input.color === 'string') setColor(input.color)
      if (typeof input.tolerance === 'number') setTolerance(input.tolerance)
      if (input.adjustments && typeof input.adjustments === 'object') {
        const nextAdjustments = input.adjustments as Partial<AdjustmentSettings>
        setAdjustments(current => ({ ...current, ...nextAdjustments }))
      }
      return { updated: true }
    }
    if (action === 'generate') {
      const mode = typeof input.mode === 'string' ? input.mode as AiMode : aiMode
      const result = await generate(mode, typeof input.prompt === 'string' ? input.prompt : undefined)
      if (result?.status === 'error') throw new Error(result.message)
      return result
    }
    if (action === 'choose_candidate') {
      if (!candidates) throw new Error('No pending AI candidates')
      const index = number('candidateIndex')
      const record = candidates.records[index]
      if (!record) throw new Error('Candidate index out of range')
      if (candidates.issues.has(record.id)) throw new Error('This candidate cannot be applied safely')
      if (!await chooseCandidate(record)) throw new Error('AI candidate could not be applied')
      return { applied: record.id }
    }
    if (action === 'download_candidate') {
      if (!candidates) throw new Error('No pending AI candidates')
      if (typeof input.outputPath !== 'string') throw new Error('outputPath is required')
      const record = candidates.records[number('candidateIndex')]
      if (!record) throw new Error('Candidate index out of range')
      return { base64: bytesBase64(new Uint8Array(await record.image.arrayBuffer())) }
    }
    if (action === 'dismiss_candidates') { setCandidates(null); return { dismissed: true } }
    if (['list_history', 'add_history', 'delete_history', 'download_history', 'reuse_prompt'].includes(action)) {
      if (action === 'list_history') {
        const cursor = typeof input.beforeCreatedAt === 'number' && typeof input.beforeId === 'string'
          ? { createdAt: input.beforeCreatedAt, id: input.beforeId } : undefined
        const page = await listStudioGenerations(typeof input.limit === 'number' ? input.limit : 20, cursor)
        return { items: page.items.filter(item => item.sessionId === session.id).map(({ image, ...meta }) => ({ ...meta, bytes: image.size })), hasMore: page.hasMore,
          nextCursor: page.items.length ? { createdAt: page.items[page.items.length - 1].createdAt, id: page.items[page.items.length - 1].id } : null }
      }
      const record = typeof input.generationId === 'string' ? await getStudioGeneration(input.generationId) : undefined
      if (!record) throw new Error('Generation history item not found')
      if (action === 'add_history') { await addGenerationToCanvas(record); return { imported: record.id } }
      if (action === 'reuse_prompt') { setPrompt(record.prompt); return { prompt: record.prompt } }
      if (action === 'delete_history') {
        if (input.confirm !== true) throw new Error('confirm=true is required to delete generation history')
        await deleteStudioGeneration(record.id); setHistoryRevision(value => value + 1); return { deleted: record.id }
      }
      if (typeof input.outputPath !== 'string') throw new Error('outputPath is required')
      return { base64: bytesBase64(new Uint8Array(await record.image.arrayBuffer())) }
    }
    if (action === 'ask_gpt') {
      if (typeof input.question !== 'string' || !input.question.trim()) throw new Error('question is required')
      const result = await askCanvasAssistant(input.question)
      if (!result) throw new Error('GPT canvas assistant did not return a suggestion')
      return result
    }
    if (action === 'undo') { undo(); return { undone: true } }
    if (action === 'redo') { redo(); return { redone: true } }
    if (action === 'fit_view') {
      if (size.width <= 1 || size.height <= 1) throw new Error('Open the canvas tab before fitting the viewport')
      fit(); return { view: 'fit' }
    }
    if (action === 'zoom') { zoomAt({ x: size.width / 2, y: size.height / 2 }, number('zoom')); return { zoom: input.zoom } }
    if (action === 'set_view') {
      const next = { x: number('x'), y: number('y'), zoom: typeof input.zoom === 'number' ? Math.max(0.1, Math.min(4, input.zoom)) : viewRef.current.zoom }
      setView(next); return { view: next }
    }
    throw new Error(`Unknown canvas action: ${action}`)
  }
  canvasCommandRef.current = canvasCommand
  useEffect(() => window.electronAPI.onStudioCanvasRequest(input => canvasCommandRef.current(input)), [])
  useEffect(() => {
    if (!active) return
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, select, button, [role="combobox"], [role="listbox"], [role="option"], [contenteditable="true"]')) return
      if (event.code === 'Space') { event.preventDefault(); spaceHeld.current = true; return }
      if (busy || assistantBusy) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); return }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); return }
      if ((event.ctrlKey||event.metaKey) && ['a','c','x','v'].includes(event.key.toLowerCase())) {
        event.preventDefault(); try {executePhotoshop({action:({a:'select_all',c:'copy_pixels',x:'cut_pixels',v:'paste_pixels'} as Record<string,string>)[event.key.toLowerCase()]})}catch(cause){setError(String(cause))};return
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if(event.key==='Enter'&&polygonPoints.length>=3){try{executePhotoshop({action:'select_polygon',points:polygonPoints,selectionMode});setPolygonPoints([])}catch(cause){setError(String(cause))};return}
      if(event.key.toLowerCase()==='x'){setColor(backgroundColor);setBackgroundColor(color);return}
      if(event.key.toLowerCase()==='d'){setColor('#000000');setBackgroundColor('#ffffff');return}
      const shortcuts: Record<string, CanvasTool> = Object.fromEntries(canvasToolGroups.flatMap(group => group.tools.filter(item => item.shortcut).map(item => [item.shortcut!.toLowerCase(), item.id])))
      if (shortcuts[event.key.toLowerCase()]) { event.preventDefault(); chooseTool(shortcuts[event.key.toLowerCase()]); return }
      if (event.key === 'Escape') {setSelection(null);setPolygonPoints([])}
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); clearSelected() }
    }
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') spaceHeld.current = false }
    const blur = () => { spaceHeld.current = false }
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur) }
  })

  const grid = Math.max(8, 32 * view.zoom)
  const frame = selected && selection ? { left: view.x + selection.x * view.zoom, top: view.y + selection.y * view.zoom,
    width: selection.width * view.zoom, height: selection.height * view.zoom } : null
  const toolIcons: Record<CanvasTool, React.ComponentType<{ className?: string }>> = { workspace: Settings2, detail: SlidersHorizontal, 'polygon-lasso':Lasso, mask:Scan, heal:Stamp, move: MousePointer2, hand: Hand, crop: Crop, transform: Scaling, select: Scan, ellipse: CircleDashed,
    lasso: Lasso, 'select-brush': Paintbrush, wand: WandSparkles, brush: Brush, text: Type, shape: Shapes, fill: PaintBucket, gradient: Blend, erase: Eraser, mosaic: Grid2X2, exposure: SunMoon, clone: Stamp, eyedropper: Pipette,
    cutout: Scissors, adjust: SlidersHorizontal, ai: Sparkles, assist: MessageCircle }
  const selectionTools: CanvasTool[] = ['select', 'ellipse', 'lasso', 'select-brush', 'wand', 'polygon-lasso']
  const inspectorContent = (<aside data-studio-inspector className={`${tool === 'assist' ? 'w-[min(420px,40vw)] overflow-hidden' : 'w-[320px] overflow-y-auto'} min-h-0 shrink-0 border-l border-border/70 bg-background`}>
        {(tool === 'ai' || tool === 'cutout') && <section className={sectionClass}>
          <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /><h2 className="text-sm font-semibold">{tool === 'cutout' ? t('studio.smartCutout') : t('studio.aiDrawing')}</h2><span className="ml-auto text-[11px] text-muted-foreground">{tool !== 'cutout' && (aiMode === 'inpaint' || aiMode === 'outpaint') ? t('studio.editCurrentLayer') : t('studio.resultNewLayer')}</span></div>
          <StudioConnectionPicker image connections={connections} connectionSlug={connectionSlug} setConnectionSlug={setConnectionSlug} model={model} setModel={setModel} channelGroup={channelGroup} setChannelGroup={setChannelGroup} />
          <button className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline" onClick={() => setConnectionSettingsOpen(true)}><Settings2 className="size-3.5" />{t('studio.connectionSettings')}</button>
          {connection?.oauthProvider === 'tokennest' && !connection.isAuthenticated && <p className="text-xs text-muted-foreground">{t('studio.tokenNestExpired')}</p>}
          {connection?.oauthProvider === 'tokennest' && connection.isAuthenticated && groups.length === 0 && <p className="text-xs text-muted-foreground">{t('studio.noImageGroups')}</p>}
          {tool === 'ai' && <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={t('studio.drawingMode')}>
            {([['generate', t('studio.directGenerate')], ['inpaint', t('studio.localRepaint')], ['outpaint', t('studio.expandFill')], ['cutout', t('studio.smartCutout')]] as const).map(([id, label]) =>
              <button key={id} className={`${actionClass} ${aiMode === id ? 'border-primary/50 bg-primary/10 text-primary' : ''}`} aria-pressed={aiMode === id} onClick={() => setAiMode(id)}>{label}</button>)}
          </div>}
          {tool === 'ai' && <textarea className="min-h-24 w-full resize-y rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs leading-5 outline-none focus:border-primary/60" value={prompt} onChange={event => setPrompt(event.target.value)} placeholder={t('studio.imagePrompt')} disabled={aiMode === 'cutout'} />}
          <div className="flex items-center gap-3 text-xs"><label htmlFor="studio-generation-count" className="shrink-0">{t('studio.generationCount')}</label><WorkbenchSelect id="studio-generation-count" className="h-8 flex-1" value={generationCount} onValueChange={value => setGenerationCount(Number(value))} options={[...[1, 2, 3, 4].map(count => ({ value: count, label: t('studio.imageCount', { count }) }))]} /></div>
          {selected && selection ? <p className="text-[11px] text-muted-foreground">{t('studio.targetSelection')}{Math.round(selection.width)} × {Math.round(selection.height)} px</p>
            : aiMode === 'generate' ? <div className="grid grid-cols-2 gap-2 text-xs"><label>{t('studio.canvasWidth')}<input className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2" type="number" min="2" max="16000" value={generationWidth} onChange={event => setGenerationWidth(Number(event.target.value))} /></label><label>{t('studio.canvasHeight')}<input className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2" type="number" min="2" max="16000" value={generationHeight} onChange={event => setGenerationHeight(Number(event.target.value))} /></label></div> : null}
          <button className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50" disabled={busy || !imageReady || (tool !== 'cutout' && aiMode !== 'generate' && aiMode !== 'cutout' && !selected)} onClick={() => void generate()}>{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <WandSparkles className="h-4 w-4" />}{busy ? t('studio.generating') : tool === 'cutout' ? t('studio.generateTransparent') : aiMode === 'inpaint' ? t('studio.repaintSelection') : aiMode === 'outpaint' ? t('studio.fillBlank') : aiMode === 'cutout' ? t('studio.generateTransparent') : t('studio.generateImage')}</button>
          <p className="text-[11px] leading-4 text-muted-foreground">{t('studio.generationHint')}</p>
        </section>}
        {tool === 'ai' && <StudioGenerationHistory revision={historyRevision} sessionId={session.id} disabled={busy}
          onAddToCanvas={addGenerationToCanvas}
          onReusePrompt={value => { setTool('ai'); setPrompt(value); setNotice(t('studio.promptReused')) }} />}
        {tool === 'assist' && <StudioCanvasChat
          sessionTitle={session.title} selectionLabel={selected && selection ? t('studio.attachedSelection', { value1: Math.round(selection.width), value2: Math.round(selection.height) }) : contentBounds(layers) ? t('studio.attachedCanvas') : t('studio.blankCanvasAsk')}
          messages={assistantHistory} draft={assistantQuestion} onDraftChange={setAssistantQuestion}
          thinkingLevel={assistantThinking} onThinkingLevelChange={setAssistantThinking}
          mode={assistantMode} onModeChange={setAssistantMode}
          onSubmit={question => { void askCanvasAssistant(question) }} onApply={index => { void applyCanvasSuggestion(index) }}
          busy={assistantBusy} canvasBusy={busy} error={assistantError || error} notice={notice}
          connectionPicker={<StudioConnectionPicker connections={assistantConnection.connections} connectionSlug={assistantConnection.connectionSlug}
            setConnectionSlug={assistantConnection.setConnectionSlug} model={assistantConnection.model} setModel={assistantConnection.setModel} />} />}
        {tool==='workspace' && <CanvasPhotoshopPanel documentSettings={documentSettings} layers={layers} activeId={activeId} selection={selected?selection:null} clipboardAvailable={!!clipboard.current} history={undoStack.current.map((action,index)=>({index,kind:action.kind}))} onCommand={input=>canvasCommand(input).catch(cause=>{setError(String(cause));throw cause})} onSave={saveFile} />}
        {tool==='polygon-lasso' && <section className={sectionClass}><p className="text-xs text-muted-foreground">{t('studio.ps.polygonHint')}</p><button className={actionClass} disabled={polygonPoints.length<3} onClick={()=>{try{executePhotoshop({action:'select_polygon',points:polygonPoints,selectionMode});setPolygonPoints([])}catch(cause){setError(String(cause))}}}>{t('studio.ps.finishSelection')}</button></section>}
        {tool==='detail' && <section className={sectionClass}><h2 className="text-sm font-semibold">{t('studio.retouch.detail')}</h2><WorkbenchSelect value={retouchMode} options={['blur','sharpen','smudge'].map(value=>({value,label:t(`studio.ps.filter.${value}`)}))} onValueChange={value=>setRetouchMode(value as typeof retouchMode)}/><label className="block text-xs">{t('studio.brush')}: {brush}<input type="range" min="1" max="160" value={brush} onChange={e=>setBrush(Number(e.target.value))}/></label><label className="block text-xs">{t('studio.ps.amount')}: {strength}%<input type="range" min="1" max="100" value={strength} onChange={e=>setStrength(Number(e.target.value))}/></label></section>}
        {tool==='mask' && <section className={sectionClass}><h2 className="text-sm font-semibold">{t('studio.ps.mask')}</h2><div className="flex gap-2"><button className={actionClass} aria-pressed={maskReveal} onClick={()=>setMaskReveal(true)}>{t('studio.ps.reveal')}</button><button className={actionClass} aria-pressed={!maskReveal} onClick={()=>setMaskReveal(false)}>{t('studio.ps.hide')}</button></div><input type="range" min="1" max="160" value={brush} onChange={e=>setBrush(Number(e.target.value))}/></section>}
        {tool === 'crop' && <section className={sectionClass}>
          <h2 className="text-sm font-semibold">{t('studio.retouch.crop')}</h2>
          <p className="text-[11px] text-muted-foreground">{t('studio.editing.cropHint')}</p>
          {selected && selection && <div className="text-xs text-muted-foreground">{Math.ceil(selection.width)} × {Math.ceil(selection.height)} px</div>}
          <button className={`${actionClass} w-full`} disabled={!selected || busy || assistantBusy} onClick={() => applyGeometry({ action: 'crop_layer' })}>{t('studio.editing.applyCrop')}</button>
        </section>}
        {tool === 'transform' && <section className={sectionClass}>
          <h2 className="text-sm font-semibold">{t('studio.retouch.transform')}</h2>
          <p className="text-[11px] text-muted-foreground">{t('studio.editing.transformHint')}</p>
          <div className="grid grid-cols-2 gap-2">{(['width', 'height'] as const).map(axis => <label key={axis} className="text-xs">{t(`studio.editing.${axis}`)}<input type="number" min="1" max="4096" className="mt-1 w-full rounded border border-border bg-background p-1" value={axis === 'width' ? targetWidth : targetHeight} onChange={event => setTransformDimension(axis, Number(event.target.value))} /></label>)}</div>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={lockAspect} onChange={event => setLockAspect(event.target.checked)} />{t('studio.editing.lockAspect')}</label>
          <label className="flex items-center justify-between text-xs">{t('studio.editing.angle')}<input type="number" min="-360" max="360" className="w-20 rounded border border-border bg-background p-1" value={transformAngle} onChange={event => setTransformAngle(Number(event.target.value))} /></label>
          <div className="grid grid-cols-2 gap-2">{([['skewX',skewX,setSkewX],['skewY',skewY,setSkewY]] as const).map(([key,value,set])=><label key={key} className="text-xs">{t(`studio.ps.${key}`)}<input type="number" min="-75" max="75" value={value} className="mt-1 w-full rounded border border-border bg-background p-1" onChange={e=>set(Number(e.target.value))}/></label>)}</div>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={smoothing} onChange={event => setSmoothing(event.target.checked)} />{t('studio.editing.smoothing')}</label>
          <button className={`${actionClass} w-full`} disabled={busy || assistantBusy} onClick={() => applyGeometry({ action: 'transform_layer', transform: 'resize-rotate', targetWidth, targetHeight, angle: transformAngle, skewX,skewY, smoothing })}>{t('studio.editing.applyTransform')}</button>
          <div className="grid grid-cols-3 gap-1.5"><button className={actionClass} onClick={() => applyGeometry({ action: 'transform_layer', transform: 'flip-x' })}>{t('studio.flipHorizontal')}</button><button className={actionClass} onClick={() => applyGeometry({ action: 'transform_layer', transform: 'flip-y' })}>{t('studio.flipVertical')}</button><button className={actionClass} onClick={() => applyGeometry({ action: 'transform_layer', transform: 'rotate' })}>{t('studio.rotate90')}</button></div>
        </section>}
        {(tool === 'mosaic' || tool === 'exposure') && <section className={sectionClass}>
          <h2 className="text-sm font-semibold">{t(`studio.retouch.${tool}`)}</h2>
          <p className="text-[11px] text-muted-foreground">{t(`studio.editing.${tool}Hint`)}</p>
          <label className="block text-xs">{t('studio.brushSize')}{brush}px<input className="w-full accent-primary" type="range" min="1" max="160" value={brush} onChange={event => setBrush(Number(event.target.value))} /></label>
          {tool === 'mosaic' ? <>
            <label className="block text-xs">{t('studio.editing.blockSize')}: {blockSize}px<input className="w-full accent-primary" type="range" min="2" max="128" value={blockSize} onChange={event => setBlockSize(Number(event.target.value))} /></label>
            <button className={`${actionClass} w-full`} disabled={busy || assistantBusy} onClick={() => { try { executePixelEdit({ action: 'pixelate' }); setError('') } catch (cause) { setError(String(cause)) } }}>{t(selected ? 'studio.editing.applySelection' : 'studio.editing.applyLayer')}</button>
          </> : <>
            <div className="grid grid-cols-2 gap-1.5">{(['dodge', 'burn'] as const).map(value => <button key={value} className={`${actionClass} ${exposureMode === value ? 'border-primary/50 text-primary' : ''}`} aria-pressed={exposureMode === value} onClick={() => setExposureMode(value)}>{t(`studio.editing.${value}`)}</button>)}</div>
            <label className="block text-xs">{t('studio.editing.strength')}: {strength}%<input className="w-full accent-primary" type="range" min="1" max="100" value={strength} onChange={event => setStrength(Number(event.target.value))} /></label>
          </>}
        </section>}
        {(['text', 'shape', 'fill', 'gradient'] as CanvasTool[]).includes(tool) && <section className={sectionClass}>
          <h2 className="text-sm font-semibold">{t(`studio.retouch.${tool}`)}</h2>
          <p className="text-[11px] text-muted-foreground">{t(`studio.drawing.${tool}Hint`)}</p>
          <label className="flex items-center justify-between text-xs">{t('studio.brushColor')}<input type="color" value={color} onChange={event => setColor(event.target.value)} aria-label={t('studio.brushColor')} /></label>
          {tool === 'text' && <>
            <textarea className="min-h-20 w-full rounded border border-border bg-background p-2 text-xs" aria-label={t('studio.drawing.textContent')} placeholder={t('studio.drawing.textContent')} maxLength={2000} value={text} onChange={event => setText(event.target.value)} />
            <label className="flex items-center justify-between text-xs">{t('studio.drawing.fontSize')}<input className="w-20 rounded border border-border bg-background px-2" type="number" min="8" max="512" value={fontSize} onChange={event => setFontSize(Number(event.target.value))} /></label>
            <input className="w-full rounded border border-border bg-background p-1 text-xs" value={fontFamily} aria-label={t('studio.ps.font')} onChange={e=>setFontFamily(e.target.value)}/>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={bold} onChange={event => setBold(event.target.checked)} />{t('studio.drawing.bold')}</label>
            {activeLayer.textSource&&<div className="flex gap-2"><button className={actionClass} onClick={()=>{try{executePhotoshop({action:'edit_text_layer',text,fontSize,fontFamily,bold,color})}catch(cause){setError(String(cause))}}}>{t('studio.ps.editText')}</button><button className={actionClass} onClick={()=>{try{executePhotoshop({action:'rasterize_layer'})}catch(cause){setError(String(cause))}}}>{t('studio.ps.rasterize')}</button></div>}
          </>}
          {tool === 'shape' && <>
            <div className="grid grid-cols-2 gap-1.5">{(['rectangle', 'ellipse', 'line', 'arrow'] as const).map(value => <button key={value} className={`${actionClass} ${shape === value ? 'border-primary/50 text-primary' : ''}`} aria-pressed={shape === value} onClick={() => setShape(value)}>{t(`studio.drawing.${value}`)}</button>)}</div>
            <label className="block text-xs">{t('studio.drawing.strokeWidth')}: {brush}px<input className="w-full accent-primary" type="range" min="1" max="160" value={brush} onChange={event => setBrush(Number(event.target.value))} /></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" disabled={shape === 'line' || shape === 'arrow'} checked={filled} onChange={event => setFilled(event.target.checked)} />{t('studio.drawing.filled')}</label>
          </>}
          {tool === 'fill' && <label className="block text-xs">{t('studio.edgeTolerance')}{tolerance}<input className="w-full accent-primary" type="range" min="0" max="100" value={tolerance} onChange={event => setTolerance(Number(event.target.value))} /></label>}
          {tool === 'gradient' && <>
            <label className="flex items-center justify-between text-xs">{t('studio.drawing.secondaryColor')}<input type="color" value={secondaryColor} onChange={event => setSecondaryColor(event.target.value)} aria-label={t('studio.drawing.secondaryColor')} /></label>
            <div className="grid grid-cols-2 gap-1.5">{['linear', 'radial'].map(value => <button key={value} className={`${actionClass} ${gradientKind === value ? 'border-primary/50 text-primary' : ''}`} aria-pressed={gradientKind === value} onClick={() => setGradientKind(value)}>{t(`studio.drawing.${value}`)}</button>)}</div>
          </>}
        </section>}
        {(['brush', 'erase', 'select-brush', 'clone', 'heal'] as CanvasTool[]).includes(tool) && <section className={sectionClass}>
          <h2 className="text-sm font-semibold">{t(`studio.retouch.${tool}`)}{t('studio.configuration')}</h2>
          {(tool==='brush'||tool==='erase') && <>{[['brushOpacity',brushOpacity,setBrushOpacity],['hardness',hardness,setHardness]].map(([key,value,set])=><label key={String(key)} className="block text-xs">{t(`studio.ps.${key}`)}: {Number(value)}%<input type="range" min="0" max="100" value={Number(value)} onChange={e=>(set as (v:number)=>void)(Number(e.target.value))}/></label>)}<div className="flex gap-2"><input type="color" value={backgroundColor} onChange={e=>setBackgroundColor(e.target.value)} aria-label={t('studio.ps.background')}/><button className={actionClass} onClick={()=>{setColor(backgroundColor);setBackgroundColor(color)}}>{t('studio.ps.swapColors')}</button></div></>}
          <div className="flex items-center gap-3">{tool === 'brush' && <input type="color" className="h-8 w-8" value={color} onChange={event => setColor(event.target.value)} aria-label={t('studio.brushColor')} />}<label className="flex-1 text-[11px]">{t('studio.brushSize')}{brush}px<input className="w-full accent-primary" type="range" min="1" max="160" value={brush} onChange={event => setBrush(Number(event.target.value))} /></label></div>
        </section>}
        {(tool === 'clone'||tool==='heal') && <section className={sectionClass}>
          <p className="text-[11px] text-muted-foreground">{t('studio.retouch.cloneHint')}</p>
          <div className="grid grid-cols-2 gap-2">{(['x', 'y'] as const).map(axis => <label key={axis} className="text-[11px]">{t('studio.retouch.source')} {axis.toUpperCase()}<input aria-label={`${t('studio.retouch.source')} ${axis.toUpperCase()}`} type="number" className="mt-1 h-8 w-full rounded border border-border bg-background px-2" value={cloneSource?.[axis] ?? ''} onChange={event => { if (event.target.value === '') { setCloneSource(null); return } const value = Number(event.target.value); if (Number.isFinite(value)) setCloneSource(current => ({ ...(current ?? { x: 0, y: 0 }), [axis]: value })) }} /></label>)}</div>
          <button className={actionClass} disabled={!cloneSource} onClick={() => setCloneSource(null)}>{t('studio.retouch.clearSource')}</button>
        </section>}
        {tool === 'eyedropper' && <section className={sectionClass}><h2 className="text-sm font-semibold">{t('studio.retouch.eyedropper')}</h2><p className="text-[11px] text-muted-foreground">{t('studio.retouch.colorHint')}</p><div className="flex items-center gap-2"><span className="h-8 w-8 rounded border border-border" style={{ backgroundColor: color }} /><code className="text-xs">{color}</code><button className={actionClass} onClick={() => setTool('brush')}>{t('studio.retouch.brush')}</button></div></section>}
        {tool !== 'assist' && tool!=='workspace' && <section className={sectionClass}>
          <div className="flex items-center gap-2"><Layers3 className="h-4 w-4" /><h2 className="text-sm font-semibold">{t('studio.layers')}</h2><span className="ml-auto text-[11px] text-muted-foreground">{t('studio.layerCount', { count: layers.length })}</span></div>
          <div className="space-y-1">{[...layers].reverse().map(layer => <div key={layer.id} onClick={() => setActiveId(layer.id)} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2 py-1.5 ${layer.id === activeId ? 'border-primary/40 bg-primary/10' : 'border-transparent hover:bg-muted/40'}`}>
            <button className={iconClass} title={layer.visible ? t('studio.hideLayer') : t('studio.showLayerAction')} onClick={event => { event.stopPropagation(); void canvasCommand({action:'set_layer',layerId:layer.id,visible:!layer.visible}).catch(cause=>setError(String(cause))) }}>{layer.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}</button>
            <button aria-label={layer.name} aria-pressed={layer.id === activeId} className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-border bg-muted/30" onClick={event => { event.stopPropagation(); setActiveId(layer.id) }}><Layers3 className="h-3.5 w-3.5" /></button><input className="min-w-0 flex-1 bg-transparent text-xs outline-none" aria-label={t('studio.layerName')} value={layer.name} onClick={event => event.stopPropagation()} onChange={event => { canvasCommand({action:'set_layer',layerId:layer.id,name:event.target.value}).catch(cause=>setError(String(cause))) }} />
          </div>)}</div>
          {(tool === 'move' || compact) && <><div className="flex items-center gap-1 border-t border-border/70 pt-2"><button className={iconClass} title={t('studio.newLayer')} onClick={() => addLayer()}><Plus className="h-4 w-4" /></button><button className={iconClass} title={t('studio.duplicateLayer')} onClick={duplicate}><Copy className="h-4 w-4" /></button><button className={iconClass} title={t('studio.moveUp')} onClick={() => reorder(1)}><ArrowUp className="h-4 w-4" /></button><button className={iconClass} title={t('studio.moveDown')} onClick={() => reorder(-1)}><ArrowDown className="h-4 w-4" /></button><button className={`${iconClass} ml-auto`} title={t('studio.deleteLayer')} onClick={removeLayer}><Trash2 className="h-4 w-4" /></button></div>
            <button className={`${actionClass} w-full`} onClick={mergeDown}>{t('studio.mergeDown')}</button>
            <label className="block text-[11px] text-muted-foreground">{t('studio.opacity')}{Math.round(activeLayer.opacity * 100)}%<input className="mt-1 w-full accent-primary" type="range" min="0" max="100" value={Math.round(activeLayer.opacity * 100)} onChange={event => { canvasCommand({action:'set_layer',opacity:Number(event.target.value)}).catch(cause=>setError(String(cause))) }} /></label></>}
        </section>}
        {selectionTools.includes(tool) && <section className={sectionClass}>
          <div className="flex items-center gap-2"><Scissors className="h-4 w-4" /><h2 className="text-sm font-semibold">{t('studio.selectionCutout')}</h2></div>
          <div className="grid grid-cols-2 gap-2"><button className={actionClass} disabled={!selected} onClick={() => extract(false)}>{t('studio.copyToLayer')}</button><button className={actionClass} disabled={!selected} onClick={() => extract(true)}>{t('studio.cutToLayer')}</button><button className={actionClass} disabled={!selected} onClick={clearSelected}>{t('studio.clearSelection')}</button><button className={actionClass} onClick={() => setSelection(null)}>{t('studio.deselect')}</button></div>
          <div className="grid grid-cols-2 gap-1.5" role="group" aria-label={t('studio.retouch.selectionMode')}>{(['replace', 'add', 'subtract', 'intersect'] as const).map(mode => <button key={mode} className={`${actionClass} ${selectionMode === mode ? 'border-primary/50 text-primary' : ''}`} aria-pressed={selectionMode === mode} onClick={() => setSelectionMode(mode)}>{t(`studio.retouch.${mode}`)}</button>)}</div>
          <button className={`${actionClass} w-full`} disabled={!selected} onClick={() => { try {executePhotoshop({action:'modify_selection',operation:'invert'})} catch (cause) { setError(String(cause)) } }}>{t('studio.ps.invert')}</button>
          <p className="text-[11px] text-muted-foreground">{t('studio.retouch.selectionHint')}</p>
          <label className="block text-[11px] text-muted-foreground">{t('studio.edgeTolerance')}{tolerance}<input className="mt-1 w-full accent-primary" type="range" min="0" max="100" value={tolerance} onChange={event => setTolerance(Number(event.target.value))} /></label>
          <button className={`${actionClass} w-full`} onClick={localCutout}>{t('studio.removeBackground')}</button>
          <button className={`${actionClass} w-full`} disabled={!selected} onClick={() => { chooseTool('ai'); setAiMode('inpaint') }}><Sparkles className="h-3.5 w-3.5" />{t('studio.repaintSelection')}</button>
        </section>}
        {tool === 'cutout' && <section className={sectionClass}><h2 className="text-sm font-semibold">{t('studio.removeBackground')}</h2><p className="text-[11px] text-muted-foreground">{t('studio.retouch.cutoutHint')}</p><label className="block text-[11px]">{t('studio.edgeTolerance')}{tolerance}<input className="w-full accent-primary" type="range" min="0" max="100" value={tolerance} onChange={event => setTolerance(Number(event.target.value))} /></label><button className={`${actionClass} w-full`} disabled={busy} onClick={localCutout}>{t('studio.removeBackground')}</button></section>}
        {tool === 'adjust' && <section className={`${sectionClass} border-b-0`}>
          <h2 className="text-sm font-semibold">{t('studio.imageAdjustments')}</h2>
          <p className="text-[11px] text-muted-foreground">{selected ? t('studio.selectionScope') : t('studio.canvasScope')}{t('studio.adjustmentHint')}</p>
          <div className="space-y-2 border-t border-border/70 pt-3">
            <h3 className="text-xs font-medium">{t('studio.colorAdjustments')}</h3>
            {([
              ['brightness', t('studio.brightness'), 0, 200, '%'], ['contrast', t('studio.contrast'), 0, 200, '%'],
              ['saturation', t('studio.saturation'), 0, 200, '%'], ['hue', t('studio.hue'), -180, 180, '°'],
              ['temperature', t('studio.temperature'), -100, 100, ''],
            ] as const).map(([key, label, min, max, unit]) =>
              <label key={key} className="block text-[11px]">{label} {adjustments[key]}{unit}
                <input className="mt-1 w-full accent-primary" type="range" min={min} max={max} value={adjustments[key]}
                  onChange={event => setAdjustments(current => ({ ...current, [key]: Number(event.target.value) }))} />
              </label>)}
          </div>
          <div className="space-y-2 border-t border-border/70 pt-3">
            <h3 className="text-xs font-medium">{t('studio.style')}</h3>
            <div className="grid grid-cols-3 gap-1.5" role="group" aria-label={t('studio.stylePresets')}>
              {([['none', t('studio.originalStyle')], ['grayscale', t('studio.grayscale')], ['sepia', t('studio.sepia')], ['vintage', t('studio.vintage')], ['noir', t('studio.noir')]] as const satisfies ReadonlyArray<readonly [AdjustmentStyle, string]>).map(([style, label]) =>
                <button key={style} className={`${actionClass} ${adjustments.style === style ? 'border-primary/50 bg-primary/10 text-primary' : ''}`}
                  aria-pressed={adjustments.style === style} onClick={() => setAdjustments(current => ({ ...current, style }))}>{label}</button>)}
            </div>
          </div>
          <div className="space-y-2 border-t border-border/70 pt-3">
            <h3 className="text-xs font-medium">{t('studio.blur')}</h3>
            <label className="block text-[11px]">{t('studio.gaussianBlur')}{adjustments.blur}px
              <input className="mt-1 w-full accent-primary" type="range" min="0" max="24" value={adjustments.blur}
                onChange={event => setAdjustments(current => ({ ...current, blur: Number(event.target.value) }))} />
            </label>
          </div>
          <div className="flex gap-2 border-t border-border/70 pt-3"><button className={`${actionClass} flex-1`} disabled={adjustmentsAreNeutral(adjustments)} onClick={() => adjust()}>{t('studio.applyAdjustments')}</button><button className={actionClass} disabled={adjustmentsAreNeutral(adjustments)} onClick={() => setAdjustments({ ...defaultAdjustments })}>{t('studio.reset')}</button></div>
        </section>}
        {!compact && tool !== 'assist' && (error || notice) && <div className={`sticky bottom-0 border-t px-4 py-3 text-xs ${error ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-border bg-background text-muted-foreground'}`} role={error ? 'alert' : 'status'}>{error || notice}</div>}
      </aside>)
  return <div ref={layoutRef} data-compact={compact} data-studio-editor="canvas" className="flex h-full min-h-0 flex-col bg-background text-foreground">
    {compact ? <div data-studio-mobile-header>
      <button className={iconClass} aria-label={t('studio.undoShortcut')} disabled={!undoStack.current.length} onClick={undo}><Undo2 className="size-5" /></button>
      <button className={iconClass} aria-label={t('studio.redoShortcut')} disabled={!redoStack.current.length} onClick={redo}><Redo2 className="size-5" /></button>
      <strong>{t('studio.canvas')}</strong>
      <button className={iconClass} aria-label={t('studio.layersProperties')} onClick={() => setMobilePanel('properties')}><Layers3 className="size-5" /></button>
      <button className={iconClass} aria-label={t('studio.mobile.files')} onClick={() => setMobilePanel('files')}><Download className="size-5" /></button>
    </div> : <header className="flex h-12 shrink-0 items-center gap-2 overflow-x-auto border-b border-border/70 px-3">
      <div className="mr-2 flex items-center gap-2 border-r border-border pr-4"><Layers3 className="h-4 w-4 text-primary" /><strong className="text-sm">{t('studio.canvas')}</strong><span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{documentSettings.bounds?`${documentSettings.bounds.width} × ${documentSettings.bounds.height}`:t('studio.infinite')}</span></div>
      <button className={actionClass} onClick={() => void createSession()}><Plus className="h-3.5 w-3.5" />{t('studio.newSession')}</button>
      <button className={actionClass} onClick={() => imageInput.current?.click()}><ImagePlus className="h-3.5 w-3.5" />{t('studio.importImage')}</button>
      <button className={actionClass} onClick={() => projectInput.current?.click()}>{t('studio.openProject')}</button>
      <span className="mx-1 h-5 w-px bg-border" />
      <button className={iconClass} title={t('studio.undoShortcut')} disabled={!undoStack.current.length} onClick={undo}><Undo2 className="h-4 w-4" /></button>
      <button className={iconClass} title={t('studio.redoShortcut')} disabled={!redoStack.current.length} onClick={redo}><Redo2 className="h-4 w-4" /></button>
      <div className="ml-auto flex shrink-0 gap-2"><button className={actionClass} onClick={saveProject}><Download className="h-3.5 w-3.5" />{t('studio.saveProject')}</button><button className={actionClass} onClick={()=>chooseTool('workspace')}>{t('studio.ps.export')}</button></div>
    </header>}
      <input ref={imageInput} hidden type="file" accept="image/*" onChange={event => { const file = event.target.files?.[0]; if (file) void importImage(file).catch(cause => setError(String(cause))); event.target.value = '' }} />
      <input ref={projectInput} hidden type="file" accept=".tbcanvas,application/json" onChange={event => { const file = event.target.files?.[0]; if (file) void openProject(file).catch(cause => setError(String(cause))); event.target.value = '' }} />

    <div className="flex min-h-0 flex-1">
      {!compact && <nav aria-label={t('studio.retouch.toolbar')} className="flex w-[88px] shrink-0 flex-col gap-2 overflow-y-auto border-r border-border/70 px-1.5 py-3">
        {canvasToolGroups.map((group, index) => <div key={group.label} role="group" aria-label={t(`studio.retouch.group${index}`)} className="border-b border-border/60 pb-2 last:border-0">
          <div className="mb-1 text-center text-[10px] font-medium text-muted-foreground">{t(`studio.retouch.group${index}`)}</div>
          <div className="grid grid-cols-2 gap-1">{group.tools.map(({ id, shortcut }) => {
            const Icon = toolIcons[id], label = t(`studio.retouch.${id}`)
            return <button key={id} title={`${label}${shortcut ? ` ${shortcut}` : ''}`} aria-label={label} aria-pressed={tool === id} disabled={busy || assistantBusy}
              onClick={() => chooseTool(id)}
              className={`flex h-9 w-9 items-center justify-center rounded-lg disabled:opacity-40 ${tool === id ? 'bg-primary/15 text-primary ring-1 ring-primary/30' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}><Icon className="h-[18px] w-[18px]" /></button>
          })}</div>
        </div>)}
      </nav>}
      <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <div ref={viewElement} className="relative min-h-0 flex-1 overflow-hidden"
          style={{ backgroundColor: 'var(--background)', backgroundImage: 'linear-gradient(to right, color-mix(in oklch, var(--foreground) 11%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in oklch, var(--foreground) 11%, transparent) 1px, transparent 1px)', backgroundSize: documentSettings.grid ? `${grid}px ${grid}px` : '0 0', backgroundPosition: `${view.x}px ${view.y}px` }}>
          <canvas ref={canvasElement} className={`absolute inset-0 h-full w-full touch-none ${tool === 'hand' ? 'cursor-grab' : tool === 'move' ? 'cursor-move' : 'cursor-crosshair'}`}
            onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => pointerUp(event)}
            onPointerCancel={event => pointerUp(event, true)} onLostPointerCapture={event => pointerUp(event, true)}
            onWheel={event => { event.preventDefault(); zoomAt(screen(event), viewRef.current.zoom * Math.exp(-event.deltaY * .001)) }}
            onContextMenu={event => event.preventDefault()} aria-label={t('studio.infiniteCanvas')} />
          {busy && <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background/35 backdrop-blur-[2px]" role="status" aria-live="polite">
            <div className="flex min-w-56 flex-col items-center rounded-2xl border border-primary/25 bg-background/95 px-8 py-7 shadow-strong">
              <div className="relative mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><span className="absolute inset-0 animate-ping rounded-2xl border border-primary/25" /><Sparkles className="size-6 animate-pulse" /></div>
              <strong className="text-sm">{t('studio.generatingImage')}</strong><span className="mt-1 text-xs text-muted-foreground">{aiMode === 'inpaint' || aiMode === 'outpaint' ? t('studio.replaceAfterGeneration') : t('studio.newLayerAfterGeneration')}</span>
              <div className="mt-4 h-1 w-full overflow-hidden rounded-full bg-primary/10"><div className="h-full w-1/2 animate-pulse rounded-full bg-primary/70" /></div>
            </div>
          </div>}
          {drawingPreview && <div className="pointer-events-none absolute border border-primary bg-primary/10" style={{ left: view.x + drawingPreview.x * view.zoom, top: view.y + drawingPreview.y * view.zoom, width: Math.max(1, drawingPreview.width * view.zoom), height: Math.max(1, drawingPreview.height * view.zoom) }} />}
          {frame && !pixelSelection && <div className="pointer-events-none absolute border border-sky-400 bg-sky-400/10" style={frame}><i className="absolute -right-1 -bottom-1 h-2 w-2 rounded-sm border border-sky-600 bg-white" /></div>}
          {frame && tool === 'ai' && <button className="absolute z-10 flex items-center gap-1.5 rounded-full border border-primary/40 bg-background px-3 py-1.5 text-xs text-primary shadow-middle hover:bg-accent disabled:opacity-50"
            style={{ left: Math.min(Math.max(12, frame.left + frame.width - 120), size.width - 140), top: Math.min(Math.max(12, frame.top + frame.height + 10), size.height - 42) }}
            disabled={busy} onClick={() => void generate()}><Sparkles className="h-3.5 w-3.5" />{aiMode === 'inpaint' ? t('studio.repaintSelection') : aiMode === 'outpaint' ? t('studio.expandFill') : aiMode === 'cutout' ? t('studio.smartCutout') : t('studio.generateToSelection')}</button>}
          {recentRecords.length > 0 && ((compact ? mobilePreviewVisible : recentVisible) ? <div className={`absolute top-3 z-10 flex max-w-[min(90%,600px)] items-center gap-2 rounded-xl border border-border/80 bg-background/95 px-2 py-1.5 shadow-middle backdrop-blur ${compact ? 'left-3' : 'left-1/2 -translate-x-1/2'}`}>
            <span className="shrink-0 text-[10px] text-muted-foreground">{t('studio.originalOutput')}</span>
            <div className="flex min-w-0 gap-1.5 overflow-x-auto">{recentRecords.map(record => <div key={record.id} className="shrink-0 rounded-md border border-border/70 p-0.5" title={record.prompt}><GenerationImage record={record} className="size-10 rounded object-cover" /></div>)}</div>
            <button className={`${iconClass} ${compact ? 'min-h-11 min-w-11' : ''}`} title={t('studio.hidePreview')} aria-label={t('studio.hidePreview')} onClick={() => { if (compact) setMobilePreviewVisible(false); else { sessionStorage.setItem('tokenbird.studio.recentPreviewHidden', '1'); setRecentVisible(false) } }}><X className="size-3.5" /></button>
          </div> : <button className={`absolute top-3 z-10 flex items-center justify-center rounded-lg border border-border bg-background/95 p-2 text-muted-foreground shadow-middle hover:text-foreground ${compact ? 'left-3 min-h-11 min-w-11' : 'right-3'}`} title={t('studio.showPreview')} aria-label={t('studio.showPreview')} onClick={() => { if (compact) setMobilePreviewVisible(true); else { sessionStorage.removeItem('tokenbird.studio.recentPreviewHidden'); setRecentVisible(true) } }}><History className="size-4" /></button>)}
          {compact && (error || notice) && <div data-studio-mobile-status role={error ? 'alert' : 'status'}><span>{error || notice}</span><button aria-label={t('common.close')} onClick={() => { setError(''); setNotice('') }}><X className="size-4" /></button></div>}
          {!contentBounds(layers) && !selected && <div className="pointer-events-none absolute inset-0 flex items-center justify-center"><div className="rounded-2xl border border-border bg-background/90 px-8 py-6 text-center shadow-middle"><ImagePlus className="mx-auto mb-3 h-6 w-6 text-primary" /><strong className="text-sm">{t('studio.emptyCanvasTitle')}</strong><p className="mt-1 text-xs text-muted-foreground">{t('studio.emptyCanvasHint')}</p></div></div>}
        </div>
        <footer className="flex h-9 shrink-0 items-center gap-3 border-t border-border/70 px-3 text-[11px] text-muted-foreground">
          {!compact && <span>{Math.round(cursor.x)}, {Math.round(cursor.y)} px</span>}{!compact && selection && <span>{t('studio.selection')}{Math.round(selection.width)} × {Math.round(selection.height)}</span>}
          <span className={compact ? 'min-w-0 truncate' : 'hidden sm:inline'}>{compact ? t(fingerNavigation ? 'studio.mobile.fingerNavigationHint' : 'studio.touchHint') : t('studio.mouseHint')}</span>
          <div className="ml-auto flex items-center gap-1"><button className={iconClass} aria-label={t('studio.zoomOut')} onClick={() => zoomAt({ x: size.width / 2, y: size.height / 2 }, view.zoom / 1.25)}><ZoomOut className="h-3.5 w-3.5" /></button><span className="min-w-10 text-center tabular-nums">{Math.round(view.zoom * 100)}%</span><button className={iconClass} aria-label={t('studio.zoomIn')} onClick={() => zoomAt({ x: size.width / 2, y: size.height / 2 }, view.zoom * 1.25)}><ZoomIn className="h-3.5 w-3.5" /></button><button className={iconClass} aria-label={t('studio.fitContent')} onClick={fit}><Maximize2 className="h-3.5 w-3.5" /></button></div>
        </footer>
      </main>
      {!compact && inspectorContent}
    </div>
    {compact && <>
      <CanvasMobileControls tool={tool} chooseTool={chooseTool} disabled={busy || assistantBusy} brush={brush} setBrush={setBrush} color={color} setColor={setColor} onTools={() => setMobilePanel('tools')} onProperties={() => setMobilePanel('properties')} />
      <StudioMobileSheet open={mobilePanel !== null} onOpenChange={open => { if (!open) setMobilePanel(null) }} title={mobilePanel === 'tools' ? t('studio.mobile.allTools') : mobilePanel === 'files' ? t('studio.mobile.files') : t('studio.layersProperties')}>
        {mobilePanel === 'properties' && <>
          <label className="flex min-h-12 items-center gap-3 border-b border-border px-4 text-sm"><input type="checkbox" checked={fingerNavigation} onChange={event => { setFingerNavigation(event.target.checked); localStorage.setItem('tokenbird.studio.fingerNavigation', event.target.checked ? '1' : '0') }} />{t('studio.mobile.fingerNavigation')}</label>
          {inspectorContent}
        </>}
        {mobilePanel === 'tools' && <div className="studio-tool-picker">{canvasToolGroups.map((group, index) => <div key={group.label} role="group" aria-label={t(`studio.retouch.group${index}`)}>
          <h3>{t(`studio.retouch.group${index}`)}</h3><div data-tool-grid>{group.tools.map(({ id }) => { const Icon = toolIcons[id]; return <button key={id} aria-pressed={tool === id} disabled={busy || assistantBusy} onClick={() => chooseTool(id)}><Icon className="size-5 shrink-0" />{t(`studio.retouch.${id}`)}</button> })}</div>
        </div>)}</div>}
        {mobilePanel === 'files' && <div className="studio-mobile-files">
          <button onClick={() => { setMobilePanel(null); void createSession() }}>{t('studio.newSession')}</button>
          <button onClick={() => { setMobilePanel(null); imageInput.current?.click() }}>{t('studio.importImage')}</button>
          <button onClick={() => { setMobilePanel(null); projectInput.current?.click() }}>{t('studio.openProject')}</button>
          <button onClick={() => { saveProject(); setMobilePanel(null) }}>{t('studio.saveProject')}</button>
          <button onClick={() => chooseTool('workspace')}>{t('studio.ps.export')}</button>
        </div>}
      </StudioMobileSheet>
    </>}
    <Dialog open={!!candidates} onOpenChange={open => { if (!open && !busy) setCandidates(null) }}>
      <DialogContent className="flex max-h-[88vh] max-w-5xl flex-col overflow-hidden">
        <DialogHeader><DialogTitle>{t('studio.chooseResult')}</DialogTitle></DialogHeader>
        {candidates && <><p className="text-xs text-muted-foreground">{t(candidates.mode === 'inpaint' || candidates.mode === 'outpaint' ? 'studio.batchReplace' : 'studio.batchAdd', { count: candidates.records.length })} {candidates.savedCount < candidates.records.length ? t('studio.unsavedResults', { value1: candidates.records.length - candidates.savedCount }) : t('studio.allResultsSaved')}</p>
          <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto md:grid-cols-[minmax(0,1fr)_180px] md:overflow-hidden">
            <div className="flex min-h-52 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted/20 p-3"><GenerationImage record={candidates.records[candidateIndex]} className="max-h-[55vh] max-w-full object-contain" /></div>
            <div className="grid content-start grid-cols-2 gap-2 overflow-y-auto md:grid-cols-1">{candidates.records.map((record, index) => <button key={record.id} className={`flex items-center gap-2 rounded-lg border p-1.5 text-left text-xs ${candidateIndex === index ? 'border-primary bg-primary/10' : 'border-border/70 hover:bg-accent'}`} onClick={() => setCandidateIndex(index)}><GenerationImage record={record} className="size-14 shrink-0 rounded object-cover" /><span>{t('studio.variantLabel', { number: index + 1 })}{candidates.issues.has(record.id) && <small className="block text-destructive">{t('studio.cannotBlend')}</small>}</span></button>)}</div>
          </div>
          {candidates.issues.has(candidates.records[candidateIndex].id) && <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">{editIssueMessage(candidates.issues.get(candidates.records[candidateIndex].id)!)}</p>}
          <div className="flex items-center justify-end gap-2 border-t border-border pt-3"><button className={actionClass} onClick={() => saveFile(candidates.records[candidateIndex].image, `tokenbird-ai-${candidateIndex + 1}.png`)}><Download className="size-3.5" />{t('studio.downloadSelected')}</button><button className={actionClass} disabled={busy} onClick={() => setCandidates(null)}>{candidates.savedCount === candidates.records.length ? t('studio.viewLater') : t('studio.closeCandidates')}</button><button className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground disabled:opacity-50" disabled={busy || candidates.issues.has(candidates.records[candidateIndex].id)} onClick={() => void chooseCandidate(candidates.records[candidateIndex])}><ImagePlus className="size-4" />{candidates.mode === 'inpaint' || candidates.mode === 'outpaint' ? t('studio.replaceSelection') : t('studio.addToCanvas')}</button></div>
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
