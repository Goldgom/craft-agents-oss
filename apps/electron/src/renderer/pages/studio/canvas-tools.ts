import type { CanvasTool } from './canvas-engine'

export const canvasToolGroups: Array<{ label: string; tools: Array<{ id: CanvasTool; label: string; shortcut?: string; actions: string[] }> }> = [
  { label: '导航', tools: [
    { id: 'move', label: '移动图层', shortcut: 'V', actions: ['move_layer'] },
    { id: 'hand', label: '平移画布', shortcut: 'H', actions: ['set_view', 'zoom', 'fit_view'] },
  ] },
  { label: '选区', tools: [
    { id: 'select', label: '矩形选区', shortcut: 'M', actions: ['set_selection'] },
    { id: 'ellipse', label: '椭圆选区', actions: ['select_ellipse'] },
    { id: 'lasso', label: '套索', shortcut: 'L', actions: ['select_lasso'] },
    { id: 'select-brush', label: '涂抹选中', shortcut: 'Q', actions: ['select_brush'] },
    { id: 'wand', label: '魔棒', shortcut: 'W', actions: ['select_wand'] },
  ] },
  { label: '绘制', tools: [
    { id: 'brush', label: '画笔', shortcut: 'B', actions: ['paint'] },
    { id: 'eyedropper', label: '取色', shortcut: 'I', actions: ['sample_color'] },
  ] },
  { label: '修复', tools: [
    { id: 'erase', label: '橡皮', shortcut: 'E', actions: ['erase'] },
    { id: 'delete', label: '删除', shortcut: 'D', actions: ['delete_pixels', 'clear_selection_pixels'] },
    { id: 'clone', label: '仿制图章', shortcut: 'S', actions: ['clone_stamp'] },
    { id: 'cutout', label: '智能抠图', shortcut: 'C', actions: ['cutout', 'generate'] },
  ] },
  { label: '调色', tools: [{ id: 'adjust', label: '画面调整', actions: ['adjust'] }] },
  { label: 'AI', tools: [
    { id: 'ai', label: 'AI 绘图', shortcut: 'G', actions: ['generate'] },
    { id: 'assist', label: '绘画助手', actions: ['ask_gpt'] },
  ] },
]
