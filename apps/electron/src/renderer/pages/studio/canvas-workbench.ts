import { assertPixelEditable, contentPixelBounds, createLayer, drawImageOnLayer, layerPixelBounds, rasterizeRegion, type CanvasLayer, type Point, type Rect } from './canvas-engine'
import { checkedSelectionBounds, clearMaskedSelection, combineSelections, drawMaskedImage, rectangularSelection, selectionMask, shapeSelection, trimSelection, type PixelSelection, type SelectionMode } from './canvas-retouch'
import { cropLayer, transformLayerContent } from './canvas-editing'
import { applyMask, canvasImage, copyLayer, createMask, exportedImage, filterLayer, healSegment, modifySelection, paintMask, retouchBrush, textLayer, validateDocument, type DocumentSettings, type FilterOptions } from './canvas-photoshop'

export type PixelClipboard = { image: HTMLCanvasElement; bounds: Rect }
export type WorkbenchState = { layers: CanvasLayer[]; activeId: string; document: DocumentSettings; selection: PixelSelection | null; clipboard: PixelClipboard | null }
export type WorkbenchResult = { layers?: CanvasLayer[]; activeId?: string; document?: DocumentSettings; selection?: PixelSelection | null; clipboard?: PixelClipboard; result: Record<string, unknown> }

/** Pure command boundary: validate and prepare replacements before the editor commits history. */
export function executeWorkbench(state: WorkbenchState, input: Record<string, unknown>): WorkbenchResult {
  const action = String(input.action), layer = state.layers.find(l => l.id === (input.layerId ?? state.activeId))
  if (!layer) throw new Error('图层不存在')
  const number = (key: string, fallback?: number) => {
    const value = input[key] ?? fallback
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} 必须为有限数字`)
    return value
  }
  const rect = () => checkedSelectionBounds({ x: number('x', 0), y: number('y', 0), width: number('width'), height: number('height') })
  const path = () => {
    const points = input.points ?? [{ x: number('x'), y: number('y') }]
    if (!Array.isArray(points) || !points.length || points.length > 2000 || !points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))) throw new Error('笔画坐标无效')
    return points as Point[]
  }
  const replace = (next: CanvasLayer): WorkbenchResult => ({ layers: state.layers.map(l => l.id === layer.id ? next : l), result: { applied: true, layerId: layer.id } })
  const unlocked = () => { if (layer.locked) throw new Error('当前图层已锁定') }
  const scope = () => state.document.bounds ?? contentPixelBounds(state.layers) ?? (() => { throw new Error('请设置文档尺寸或添加图像') })()
  if (action === 'set_document' || action === 'set_guides') {
    const doc = validateDocument({ ...state.document, ...(action === 'set_document' && input.width !== undefined ? { bounds: rect() } : {}),
      ...(input.infinite === true ? { bounds: null } : {}),
      ...Object.fromEntries(['background', 'guides', 'grid', 'snap'].filter(k => input[k] !== undefined).map(k => [k, input[k]])) })
    return { document: doc, result: { document: doc } }
  }
  if (action === 'crop_document') {
    const bounds = input.width !== undefined ? rect() : checkedSelectionBounds(state.selection?.bounds ?? scope())
    const layers = state.layers.map(l => {
      if (l.locked) throw new Error('裁剪前请解锁图层')
      if (!layerPixelBounds(l)) return l
      // Document crop is a rectangle. Preserve hidden layers and editable source when changing only the frame.
      if (input.trim === false) return l
      return cropLayer({ ...l, visible: true }, null, { ...bounds, action: 'crop_layer' })
    }).map((l, i) => ({ ...l, visible: state.layers[i].visible }))
    const selection=state.selection?combineSelections(state.selection,rectangularSelection(bounds),'intersect'):null
    return { layers, document: { ...state.document, bounds }, selection, result: { bounds } }
  }
  if (action === 'resize_document') {
    const old = checkedSelectionBounds(scope()), width = number('width'), height = number('height')
    const bounds = checkedSelectionBounds({ ...old, width, height }), sx = width / old.width, sy = height / old.height
    const layers = state.layers.map(l => {
      if (l.locked) throw new Error('调整图像大小前请解锁图层')
      const b = layerPixelBounds(l)
      if (!b) return l
      const result = transformLayerContent({ ...l, visible: true }, { targetWidth: Math.max(1, b.width * sx), targetHeight: Math.max(1, b.height * sy), smoothing: input.smoothing })
      const desired = { x: old.x + (b.x - old.x) * sx, y: old.y + (b.y - old.y) * sy }
      return { ...result.layer, visible: l.visible, offset: { x: result.layer.offset.x + desired.x - result.bounds.x, y: result.layer.offset.y + desired.y - result.bounds.y } }
    })
    const guides = state.document.guides.map(g => ({ ...g, value: g.axis === 'x' ? old.x + (g.value-old.x)*sx : old.y + (g.value-old.y)*sy }))
    let selection:PixelSelection|null=null
    if(state.selection){const b=state.selection.bounds,next=checkedSelectionBounds({x:old.x+(b.x-old.x)*sx,y:old.y+(b.y-old.y)*sy,width:Math.max(1,b.width*sx),height:Math.max(1,b.height*sy)});const mask=canvasImage(next.width,next.height);mask.getContext('2d')!.drawImage(state.selection.mask,0,0,next.width,next.height);selection={bounds:next,mask,kind:state.selection.kind}}
    return { layers, document: { ...state.document, bounds, guides }, selection, result: { bounds } }
  }
  if (action === 'select_all') return { selection: rectangularSelection(scope()), result: { selected: true } }
  if (action === 'modify_selection') {
    if (!state.selection) throw new Error('需要选区')
    const selection = modifySelection(state.selection, input.operation as 'feather', number('radius', 0), scope())
    return { selection: trimSelection(selection), result: { bounds: selection.bounds } }
  }
  if (action === 'select_polygon') {
    const mode = (input.selectionMode ?? 'replace') as SelectionMode
    if (!['replace','add','subtract','intersect'].includes(mode)) throw new Error('选区模式无效')
    const selection = combineSelections(state.selection, shapeSelection(path(), 'lasso'), mode)
    return { selection, result: { bounds: selection?.bounds ?? null } }
  }
  if (action === 'fill_selection' || action === 'stroke_selection') {
    if(!state.selection) throw new Error('需要选区')
    if(typeof input.color!=='string'||!/^#[0-9a-f]{6}$/i.test(input.color)) throw new Error('颜色需要 #RRGGBB')
    assertPixelEditable(layer)
    const next=copyLayer(layer),bounds=checkedSelectionBounds(state.selection.bounds),image=canvasImage(bounds.width,bounds.height)
    const ctx=image.getContext('2d')!;ctx.fillStyle=input.color;ctx.fillRect(0,0,image.width,image.height)
    const mask=action==='stroke_selection'?combineSelections(state.selection,modifySelection(state.selection,'contract',number('brush',2)),'subtract'):state.selection
    if(mask)drawMaskedImage(next,image,bounds,mask,new Map());return replace(next)
  }
  if (action === 'set_layer_mask') {
    unlocked()
    const mode = input.maskMode ?? 'reveal'
    if (!['reveal','hide','selection','remove','enable','disable'].includes(String(mode))) throw new Error('蒙版模式无效')
    const mask = mode === 'remove' ? undefined : mode === 'enable' || mode === 'disable'
      ? layer.mask ? { ...layer.mask, enabled: mode === 'enable' } : (() => { throw new Error('当前图层没有蒙版') })()
      : createMask(layer, state.selection, mode as 'reveal')
    return replace({ ...layer, mask })
  }
  if (action === 'paint_layer_mask') return replace({ ...layer, mask: paintMask(layer, path(), number('brush', 24), input.reveal === true, state.selection) })
  if (action === 'apply_layer_mask') return replace(applyMask(layer))
  if (action === 'group_layers' || action === 'align_layers') {
    const ids = input.layerIds
    if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length || ids.some(id => !state.layers.some(l => l.id === id))) throw new Error('请选择有效且不重复的图层')
    const chosen = state.layers.filter(l => ids.includes(l.id))
    if (chosen.some(l => l.locked)) throw new Error('请解锁所选图层')
    if (action === 'group_layers') {
      if (typeof input.group !== 'string' || input.group.length > 80) throw new Error('分组名称无效')
      return { layers: state.layers.map(l => ids.includes(l.id) ? { ...l, group: input.group as string || undefined, groupHidden: false } : l), result: { grouped: ids } }
    }
    const alignment = input.alignment
    if (!['left','center','right','top','middle','bottom'].includes(String(alignment))) throw new Error('对齐方式无效')
    const target = state.selection?.bounds ?? scope()
    return { layers: state.layers.map(l => {
      if (!ids.includes(l.id)) return l
      const b = layerPixelBounds(l); if (!b) return l
      const x = alignment === 'left' ? target.x-b.x : alignment === 'center' ? target.x+(target.width-b.width)/2-b.x : alignment === 'right' ? target.x+target.width-b.width-b.x : 0
      const y = alignment === 'top' ? target.y-b.y : alignment === 'middle' ? target.y+(target.height-b.height)/2-b.y : alignment === 'bottom' ? target.y+target.height-b.height-b.y : 0
      return { ...l, offset: { x: l.offset.x+x, y: l.offset.y+y } }
    }), result: { aligned: ids } }
  }
  if (action === 'set_group') {
    if (typeof input.group !== 'string' || !state.layers.some(l => l.group === input.group)) throw new Error('分组不存在')
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80)) throw new Error('分组名称无效')
    return { layers: state.layers.map(l => l.group === input.group ? { ...l, ...(input.name !== undefined ? { group: input.name as string } : {}), ...(typeof input.visible === 'boolean' ? { groupHidden: !input.visible } : {}) } : l), result: { updated: true } }
  }
  if (action === 'flatten_layers') {
    if (state.layers.some(l => l.locked)) throw new Error('合并前请解锁图层')
    const bounds = checkedSelectionBounds(scope()), merged = createLayer('合并图像')
    drawImageOnLayer(merged, rasterizeRegion(state.layers, bounds, bounds.width, bounds.height), bounds)
    // Hidden layers remain available; visible layers are replaced by the merged result.
    return { layers: [...state.layers.filter(l => !l.visible || l.groupHidden), merged], activeId: merged.id, result: { layerId: merged.id } }
  }
  if (action === 'copy_pixels' || action === 'cut_pixels') {
    if (action === 'cut_pixels') { assertPixelEditable(layer); if (layer.alphaLocked) throw new Error('当前图层已锁定透明度') }
    const bounds = checkedSelectionBounds(state.selection?.bounds ?? layerPixelBounds(layer) ?? scope())
    const image = rasterizeRegion([{ ...layer, opacity: 1, visible: true, groupHidden: false, blendMode: 'source-over', clipping: false }], bounds, bounds.width, bounds.height)
    if (state.selection) { const ctx = image.getContext('2d')!; ctx.setTransform(1,0,0,1,0,0); ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(selectionMask(state.selection, bounds),0,0) }
    const copied: WorkbenchResult = { clipboard: { image, bounds }, result: { copied: true, width: bounds.width, height: bounds.height } }
    if (action === 'cut_pixels') { const next = copyLayer(layer); clearMaskedSelection(next, state.selection ?? rectangularSelection(bounds), new Map()); copied.layers = state.layers.map(l => l.id === layer.id ? next : l) }
    return copied
  }
  if (action === 'paste_pixels') {
    if (!state.clipboard) throw new Error('剪贴板为空')
    const next = createLayer('粘贴图层'), bounds = { ...state.clipboard.bounds, x: number('x', state.clipboard.bounds.x), y: number('y', state.clipboard.bounds.y) }
    checkedSelectionBounds(bounds); drawImageOnLayer(next, state.clipboard.image, bounds)
    return { layers: [...state.layers, next], activeId: next.id, result: { layerId: next.id } }
  }
  if (action === 'add_text_layer' || action === 'edit_text_layer') {
    if (action === 'edit_text_layer' && !layer.textSource) throw new Error('当前图层不是可编辑文字')
    const source = action === 'edit_text_layer' ? layer.textSource! : { text: '', x: number('x',0), y: number('y',0), fontSize: 32, fontFamily: 'sans-serif', bold: false, color: '#000000' }
    const next = textLayer({ ...source, ...Object.fromEntries(['text','fontSize','fontFamily','bold','color'].filter(k => input[k] !== undefined).map(k => [k,input[k]])) }, action === 'edit_text_layer' ? layer : undefined)
    return action === 'edit_text_layer' ? replace(next) : { layers: [...state.layers,next], activeId: next.id, result: { layerId: next.id } }
  }
  if (action === 'rasterize_layer') { unlocked(); return replace({ ...layer, textSource: undefined }) }
  if (action === 'filter') {
    const next = copyLayer(layer)
    const brushSelection = input.points ? shapeSelection(path(), 'brush', number('brush',24)) : null
    const selection = brushSelection ? state.selection ? combineSelections(brushSelection,state.selection,'intersect') : brushSelection : state.selection
    if (brushSelection && !selection) return { result: { applied: false } }
    filterLayer(next, input as FilterOptions, selection, new Map()); return replace(next)
  }
  if (action === 'heal_stamp') {
    const next = copyLayer(layer), points = path(), delta = { x: number('sourceX')-points[0].x, y: number('sourceY')-points[0].y }, before = new Map()
    for (let i=0;i<points.length;i++) healSegment(next,layer,points[Math.max(0,i-1)],points[i],delta,number('brush',24),before,state.selection)
    return replace(next)
  }
  if (action === 'retouch_brush') {
    const next=copyLayer(layer);retouchBrush(next,path(),number('brush',24),(input.retouchMode??'blur') as 'blur',number('strength',30),state.selection,new Map());return replace(next)
  }
  if (action === 'export_image' && input.selectionOnly===true && !state.selection) throw new Error('需要选区')
  if (action === 'export_image') return { result: exportedImage(state.layers,state.document,input.selectionOnly === true ? state.selection : null,(input.format ?? 'png') as 'png',number('quality',.92)) }
  throw new Error(`未知编辑命令: ${action}`)
}
