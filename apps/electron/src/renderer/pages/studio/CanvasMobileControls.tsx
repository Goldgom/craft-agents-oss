import { useTranslation } from 'react-i18next'
import { Brush, Eraser, Hand, Scan, MousePointer2, Sparkles, Grid2X2, Settings2 } from 'lucide-react'
import type { CanvasTool } from './canvas-engine'

const quickTools = [
  ['brush', Brush], ['erase', Eraser], ['select', Scan], ['move', MousePointer2], ['hand', Hand], ['ai', Sparkles],
] as const

export function CanvasMobileControls({ tool, chooseTool, disabled, brush, setBrush, color, setColor, onTools, onProperties }: {
  tool: CanvasTool; chooseTool: (tool: CanvasTool) => void; disabled: boolean
  brush: number; setBrush: (value: number) => void; color: string; setColor: (value: string) => void
  onTools: () => void; onProperties: () => void
}) {
  const { t } = useTranslation()
  const brushTool = ['brush', 'erase', 'select-brush', 'clone', 'heal', 'detail', 'mask', 'mosaic', 'exposure', 'shape'].includes(tool)
  return <div data-studio-mobile-controls>
    <div className="studio-mobile-quick">
      <button onClick={onProperties} aria-label={t('studio.layersProperties')}><Settings2 className="size-4" /><span>{t(`studio.retouch.${tool}`)}</span></button>
      {brushTool && <>
        {tool !== 'erase' && <input type="color" value={color} onChange={event => setColor(event.target.value)} aria-label={t('studio.brushColor')} />}
        <label><span>{brush}px</span><input type="range" min="1" max="160" value={brush} aria-label={t('studio.brushSize')} onChange={event => setBrush(Number(event.target.value))} /></label>
      </>}
    </div>
    <nav aria-label={t('studio.retouch.toolbar')} className="studio-mobile-dock">
      {quickTools.map(([id, Icon]) => <button key={id} disabled={disabled} aria-pressed={tool === id}
        aria-label={t(`studio.retouch.${id}`)} onClick={() => chooseTool(id)}>
        <Icon className="size-5" /><span>{t(`studio.retouch.${id}`)}</span>
      </button>)}
      <button onClick={onTools} aria-label={t('studio.mobile.allTools')}><Grid2X2 className="size-5" /><span>{t('studio.mobile.allTools')}</span></button>
    </nav>
  </div>
}
