import type { CanvasTool } from './canvas-engine'

export const canvasToolGroups: Array<{ label: string; tools: Array<{ id: CanvasTool; label: string; shortcut?: string; actions: string[] }> }> = [
  { label: '布局与导航', tools: [
    { id: 'workspace', label: '编辑工作台', actions: ['set_document', 'resize_document', 'crop_document', 'set_guides', 'group_layers', 'set_group', 'align_layers', 'flatten_layers', 'set_layer_mask', 'apply_layer_mask', 'copy_pixels', 'cut_pixels', 'paste_pixels', 'filter', 'export_image', 'get_history', 'select_all', 'modify_selection', 'fill_selection', 'stroke_selection'] },
    { id: 'move', label: '移动图层', shortcut: 'V', actions: ['set_layer'] },
    { id: 'crop', label: '裁剪图层', shortcut: 'R', actions: ['crop_layer'] },
    { id: 'transform', label: '自由变换', actions: ['transform_layer'] },
    { id: 'hand', label: '平移画布', shortcut: 'H', actions: ['set_view', 'zoom', 'fit_view'] },
  ] },
  { label: '选区', tools: [
    { id: 'select', label: '矩形选区', shortcut: 'M', actions: ['set_selection'] },
    { id: 'ellipse', label: '椭圆选区', actions: ['select_ellipse'] },
    { id: 'polygon-lasso', label: '多边形套索', actions: ['select_polygon'] },
    { id: 'lasso', label: '套索', shortcut: 'L', actions: ['select_lasso'] },
    { id: 'select-brush', label: '涂抹选中', shortcut: 'Q', actions: ['select_brush'] },
    { id: 'wand', label: '魔棒', shortcut: 'W', actions: ['select_wand'] },
  ] },
  { label: '绘制', tools: [
    { id: 'brush', label: '画笔', shortcut: 'B', actions: ['paint'] },
    { id: 'text', label: '文字', shortcut: 'T', actions: ['add_text_layer', 'edit_text_layer', 'rasterize_layer', 'draw_text'] },
    { id: 'shape', label: '基础形状', shortcut: 'U', actions: ['draw_shape'] },
    { id: 'fill', label: '油漆桶', shortcut: 'F', actions: ['fill_region'] },
    { id: 'gradient', label: '渐变', actions: ['draw_gradient'] },
    { id: 'eyedropper', label: '取色', shortcut: 'I', actions: ['sample_color'] },
  ] },
  { label: '修复', tools: [
    { id: 'erase', label: '橡皮', shortcut: 'E', actions: ['erase', 'delete_pixels', 'clear_selection_pixels'] },
    { id: 'mosaic', label: '马赛克', shortcut: 'P', actions: ['pixelate'] },
    { id: 'exposure', label: '局部明暗', shortcut: 'O', actions: ['exposure_brush'] },
    { id: 'detail', label: '局部润色', actions: ['retouch_brush'] },
    { id: 'mask', label: '蒙版画笔', actions: ['paint_layer_mask'] },
    { id: 'heal', label: '修复画笔', actions: ['heal_stamp'] },
    { id: 'clone', label: '仿制图章', shortcut: 'S', actions: ['clone_stamp'] },
    { id: 'cutout', label: '智能抠图', shortcut: 'C', actions: ['cutout', 'generate'] },
  ] },
  { label: '调色', tools: [{ id: 'adjust', label: '画面调整', actions: ['adjust'] }] },
  { label: 'AI', tools: [
    { id: 'ai', label: 'AI 绘图', shortcut: 'G', actions: ['generate'] },
    { id: 'assist', label: '绘画助手', actions: ['ask_gpt'] },
  ] },
]
