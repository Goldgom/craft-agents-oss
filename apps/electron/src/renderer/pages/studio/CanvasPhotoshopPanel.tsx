import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { WorkbenchSelect } from '@/components/ui/workbench-select'
import { BLEND_MODES, type CanvasLayer, type Rect } from './canvas-engine'
import { FILTERS, type DocumentSettings, type FilterName } from './canvas-photoshop'

type Props = {
  documentSettings: DocumentSettings; layers: CanvasLayer[]; activeId: string; selection: Rect | null
  clipboardAvailable: boolean; history: Array<{ index: number; kind: string }>
  onCommand: (input: Record<string, unknown>) => Promise<unknown>
  onSave: (data: string | Blob, name: string) => void
}
const field = 'w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs'
const button = 'rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent disabled:opacity-40'

export function CanvasPhotoshopPanel({ documentSettings: doc, layers, activeId, selection, clipboardAvailable, history, onCommand, onSave }: Props) {
  const { t } = useTranslation()
  const label = (key: string) => t(`studio.ps.${key}`)
  const layer = layers.find(l => l.id === activeId)!
  const [width, setWidth] = useState(doc.bounds?.width ?? 1024), [height,setHeight] = useState(doc.bounds?.height ?? 1024)
  const [group,setGroup] = useState(''), [ids,setIds] = useState<string[]>([activeId])
  const [filter,setFilter] = useState<FilterName>('levels'), [amount,setAmount] = useState(50)
  const [black,setBlack] = useState(0), [white,setWhite] = useState(255), [gamma,setGamma] = useState(1)
  const [red,setRed] = useState(0), [green,setGreen] = useState(0), [blue,setBlue] = useState(0)
  const [curve,setCurve] = useState('0,0;128,128;255,255'), [radius,setRadius] = useState(8)
  const [guide,setGuide] = useState(0), [guideAxis,setGuideAxis] = useState('x')
  const [format,setFormat] = useState('png'), [quality,setQuality] = useState(92), [selectionOnly,setSelectionOnly] = useState(false)
  const [text,setText] = useState(''), [font,setFont] = useState('sans-serif'), [fontSize,setFontSize] = useState(32), [bold,setBold] = useState(false), [color,setColor] = useState('#000000')
  const [selectionColor,setSelectionColor]=useState('#000000'),[strokeWidth,setStrokeWidth]=useState(2)
  const [running,setRunning] = useState(false)
  useEffect(()=>{if(doc.bounds){setWidth(doc.bounds.width);setHeight(doc.bounds.height)}},[doc.bounds])
  useEffect(()=>{setIds([activeId]);setGroup(layer.group??'');const s=layer.textSource;setText(s?.text??'');setFont(s?.fontFamily??'sans-serif');setFontSize(s?.fontSize??32);setBold(s?.bold??false);setColor(s?.color??'#000000')},[activeId,layer.textSource,layer.group])
  const run = async (input: Record<string, unknown>) => {setRunning(true);try{return await onCommand(input)}finally{setRunning(false)}}
  const command = (action: string, input: Record<string,unknown> = {}) => {void run({action,...input}).catch(()=>{})}
  const num = (name: string,value: number,change:(n:number)=>void,min?:number,max?:number,step=1) => <label className="block space-y-1 text-xs text-muted-foreground">{label(name)}<input className={field} type="number" value={value} min={min} max={max} step={step} onChange={e=>change(Number(e.target.value))}/></label>
  const select = (value:string,options:Array<{value:string;label:string}>,change:(v:string)=>void) => <WorkbenchSelect value={value} onValueChange={change} options={options}/>
  const heading = (key:string) => <summary className="cursor-pointer text-xs font-semibold">{label(key)}</summary>
  return <div className="space-y-4 px-4 py-4">
    <p className="text-xs text-muted-foreground">{label('intro')}</p>
    <fieldset disabled={running} className="space-y-4">
      <details open className="space-y-3 border-b border-border pb-4">{heading('document')}
        <div className="grid grid-cols-2 gap-2">{num('width',width,setWidth,1,4096)}{num('height',height,setHeight,1,4096)}</div>
        <div className="flex flex-wrap gap-2"><button className={button} onClick={()=>command('set_document',{x:doc.bounds?.x??0,y:doc.bounds?.y??0,width,height})}>{label('canvasSize')}</button><button className={button} onClick={()=>command('resize_document',{width,height})}>{label('imageSize')}</button><button disabled={!selection} className={button} onClick={()=>command('crop_document')}>{label('crop')}</button><button className={button} onClick={()=>command('set_document',{infinite:true})}>{label('infinite')}</button></div>
        <label className="flex items-center justify-between text-xs">{label('background')}<input type="color" value={doc.background==='transparent'?'#ffffff':doc.background} onChange={e=>command('set_document',{background:e.target.value})}/></label>
        <button className={button} onClick={()=>command('set_document',{background:'transparent'})}>{label('transparent')}</button>
        <div className="flex gap-3">{(['grid','snap'] as const).map(k=><label key={k} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={doc[k]} onChange={e=>command('set_guides',{[k]:e.target.checked})}/>{label(k)}</label>)}</div>
        <div className="flex items-end gap-2"><div className="w-16">{select(guideAxis,[{value:'x',label:label('vertical')},{value:'y',label:label('horizontal')}],setGuideAxis)}</div>{num('guidePosition',guide,setGuide)}<button className={button} onClick={()=>command('set_guides',{guides:[...doc.guides,{axis:guideAxis,value:guide}]})}>+</button></div>
        {doc.guides.map((g,i)=><button key={i} className={`${button} mr-1`} title={label('removeGuide')} onClick={()=>command('set_guides',{guides:doc.guides.filter((_,j)=>i!==j)})}>{g.axis.toUpperCase()} {g.value} ×</button>)}
      </details>
      <details open className="space-y-3 border-b border-border pb-4">{heading('layers')}
        {select(activeId,layers.map(l=>({value:l.id,label:l.name})),id=>command('set_layer',{layerId:id}))}
        <label className="block space-y-1 text-xs">{label('blend')}{select(layer.blendMode??'source-over',BLEND_MODES.map(value=>({value,label:label(`blendModes.${value}`)})),v=>command('set_layer',{blendMode:v}))}</label>
        <div className="flex flex-wrap gap-2">{(['locked','alphaLocked','clipping'] as const).map(k=><label key={k} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={!!layer[k]} onChange={e=>command('set_layer',{[k]:e.target.checked})}/>{label(k)}</label>)}</div>
        <div className="flex flex-wrap gap-2">{(['reveal','hide','selection'] as const).map(maskMode=><button key={maskMode} className={button} disabled={maskMode==='selection'&&!selection} onClick={()=>command('set_layer_mask',{maskMode})}>{label(`mask.${maskMode}`)}</button>)}</div>
        {layer.mask&&<div className="flex flex-wrap gap-2"><button className={button} onClick={()=>command('set_layer_mask',{maskMode:layer.mask!.enabled?'disable':'enable'})}>{label(layer.mask.enabled?'disableMask':'enableMask')}</button><button className={button} onClick={()=>command('apply_layer_mask')}>{label('applyMask')}</button><button className={button} onClick={()=>command('set_layer_mask',{maskMode:'remove'})}>{label('removeMask')}</button></div>}
        <p className="text-xs text-muted-foreground">{label('chooseLayers')}</p>
        <div className="max-h-32 space-y-1 overflow-y-auto">{layers.map(l=><label key={l.id} className="flex items-center gap-2 truncate text-xs"><input type="checkbox" checked={ids.includes(l.id)} onChange={e=>setIds(e.target.checked?[...ids,l.id]:ids.filter(id=>id!==l.id))}/>{l.name}{l.group&&` · ${l.group}`}</label>)}</div>
        <input className={field} value={group} placeholder={label('groupName')} onChange={e=>setGroup(e.target.value)}/>
        <div className="flex flex-wrap gap-2"><button disabled={!ids.length} className={button} onClick={()=>command('group_layers',{layerIds:ids,group})}>{label('group')}</button><button disabled={!ids.length} className={button} onClick={()=>command('group_layers',{layerIds:ids,group:''})}>{label('ungroup')}</button>{layer.group&&<button className={button} onClick={()=>command('set_group',{group:layer.group,visible:!!layer.groupHidden})}>{label(layer.groupHidden?'showGroup':'hideGroup')}</button>}</div>
        <div className="grid grid-cols-3 gap-1">{['left','center','right','top','middle','bottom'].map(alignment=><button key={alignment} disabled={!ids.length} className={button} onClick={()=>command('align_layers',{layerIds:ids,alignment})}>{label(`align.${alignment}`)}</button>)}</div>
        <button className={button} onClick={()=>command('flatten_layers')}>{label('flatten')}</button>
      </details>
      <details className="space-y-3 border-b border-border pb-4">{heading('text')}
        <textarea className={field} value={text} rows={3} placeholder={label('textContent')} onChange={e=>setText(e.target.value)}/>
        <input className={field} value={font} aria-label={label('font')} onChange={e=>setFont(e.target.value)}/>
        {num('fontSize',fontSize,setFontSize,8,512)}
        <div className="flex items-center justify-between"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={bold} onChange={e=>setBold(e.target.checked)}/>{label('bold')}</label><input type="color" value={color} onChange={e=>setColor(e.target.value)}/></div>
        <div className="flex flex-wrap gap-2"><button disabled={!text.trim()} className={button} onClick={()=>command(layer.textSource?'edit_text_layer':'add_text_layer',{text,fontFamily:font,fontSize,bold,color,x:selection?.x??doc.bounds?.x??0,y:selection?.y??doc.bounds?.y??0})}>{label(layer.textSource?'editText':'addText')}</button><button disabled={!layer.textSource} className={button} onClick={()=>command('rasterize_layer')}>{label('rasterize')}</button></div>
      </details>
      <details className="space-y-3 border-b border-border pb-4">{heading('selection')}
        {num('radius',radius,setRadius,0,128)}
        <div className="flex flex-wrap gap-2"><button className={button} onClick={()=>command('select_all')}>{label('selectAll')}</button>{['feather','expand','contract','invert'].map(operation=><button key={operation} disabled={!selection} className={button} onClick={()=>command('modify_selection',{operation,radius})}>{label(operation)}</button>)}</div>
        <div className="flex items-center gap-2"><input type="color" value={selectionColor} onChange={e=>setSelectionColor(e.target.value)}/>{num('strokeWidth',strokeWidth,setStrokeWidth,1,128)}</div>
        <div className="flex flex-wrap gap-2">{['fill_selection','stroke_selection'].map(action=><button key={action} className={button} disabled={!selection} onClick={()=>command(action,{color:selectionColor,brush:strokeWidth})}>{label(action)}</button>)}</div>
        <div className="flex flex-wrap gap-2"><button className={button} onClick={()=>command('copy_pixels')}>{label('copy')}</button><button className={button} onClick={()=>command('cut_pixels')}>{label('cut')}</button><button disabled={!clipboardAvailable} className={button} onClick={()=>command('paste_pixels')}>{label('paste')}</button></div>
      </details>
      <details className="space-y-3 border-b border-border pb-4">{heading('filters')}
        {select(filter,FILTERS.map(value=>({value,label:label(`filter.${value}`)})),v=>{setFilter(v as FilterName);setAmount(v==='blur'?3:v==='threshold'?128:v==='posterize'?6:50)})}
        {filter==='levels'&&<><div className="grid grid-cols-2 gap-2">{num('black',black,setBlack,0,254)}{num('white',white,setWhite,1,255)}</div>{num('gamma',gamma,setGamma,.1,10,.1)}</>}
        {filter==='curves'&&<label className="block space-y-1 text-xs">{label('curvePoints')}<input className={field} value={curve} onChange={e=>setCurve(e.target.value)}/></label>}
        {filter==='color-balance'&&<div className="grid grid-cols-3 gap-2">{num('red',red,setRed,-100,100)}{num('green',green,setGreen,-100,100)}{num('blue',blue,setBlue,-100,100)}</div>}
        {['threshold','posterize','sharpen','noise','blur'].includes(filter)&&num('amount',amount,setAmount,filter==='posterize'?2:0,filter==='blur'?24:filter==='threshold'?255:100)}
        <p className="text-xs text-muted-foreground">{label('filterScope')}</p>
        <button className={button} onClick={()=>command('filter',{filter,...(filter==='levels'?{black,white,gamma}:filter==='curves'?{curve:curve.split(';').map(pair=>{const [x,y]=pair.split(',').map(Number);return{x,y}})}:filter==='color-balance'?{red,green,blue}:filter==='invert'?{}:{amount})})}>{label('applyFilter')}</button>
      </details>
      <details open className="space-y-3">{heading('export')}
        {select(format,['png','jpeg','webp'].map(value=>({value,label:value.toUpperCase()})),setFormat)}
        {format!=='png'&&num('quality',quality,setQuality,10,100)}
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={selectionOnly} disabled={!selection} onChange={e=>setSelectionOnly(e.target.checked)}/>{label('selectionOnly')}</label>
        <button className={button} onClick={()=>{void run({action:'export_image',format,quality:quality/100,selectionOnly:selectionOnly&&!!selection}).then(value=>{const result=value as {base64:string;mime:string};onSave(`data:${result.mime};base64,${result.base64}`,`tokenbird-canvas.${format==='jpeg'?'jpg':format}`)}).catch(()=>{})}}>{label('export')}</button>
        <p className="text-xs text-muted-foreground">{label('history')} · {history.length}/50</p>
        <div className="max-h-24 overflow-y-auto text-xs text-muted-foreground">{[...history].reverse().map(item=><div key={item.index}>{item.index+1}. {label(`historyKinds.${item.kind}`)}</div>)}</div>
      </details>
    </fieldset>
  </div>
}
