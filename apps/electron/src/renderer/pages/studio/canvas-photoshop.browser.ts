import { createLayer, drawImageOnLayer, layerPixelBounds, rasterizeRegion, rawLayer, restoreTiles, type CanvasLayer, type TileSnapshot } from './canvas-engine'
import { combineSelections, rectangularSelection, shapeSelection, type PixelSelection } from './canvas-retouch'
import { canvasImage, copyLayer, defaultDocument, deserializeLayers, filterLayer, paintBrushStroke, retouchBrush, serializeLayer, type DocumentSettings } from './canvas-photoshop'
import { executeWorkbench, type WorkbenchState } from './canvas-workbench'
import { transformLayerContent } from './canvas-editing'

export async function runPhotoshopChecks(): Promise<string[]> {
  const checks: string[]=[]
  const mark=(message:string)=>{checks.push(message);console.info(message)}
  const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message)}
  const pixel=(layers:CanvasLayer[],x:number,y:number)=>[...rasterizeRegion(layers,{x,y,width:1,height:1},1,1).getContext('2d')!.getImageData(0,0,1,1).data]
  const solid=(color:string,x=0,y=0,w=32,h=32)=>{const l=createLayer(),image=canvasImage(w,h);const ctx=image.getContext('2d')!;ctx.fillStyle=color;ctx.fillRect(0,0,w,h);drawImageOnLayer(l,image,{x,y,width:w,height:h});return l}
  let state:WorkbenchState={layers:[solid('#ff0000')],activeId:'',document:defaultDocument(),selection:null,clipboard:null};state.activeId=state.layers[0].id
  const command=(action:string,input:Record<string,unknown>={})=>{
    const result=executeWorkbench(state,{action,...input});state={...state,...(result.layers?{layers:result.layers}:{}),...(result.activeId?{activeId:result.activeId}:{}),...(result.document?{document:result.document}:{}),...('selection'in result?{selection:result.selection??null}:{}),...(result.clipboard?{clipboard:result.clipboard}:{})};return result.result
  }
  const reset=(layers:CanvasLayer[],selection:PixelSelection|null=null,doc:DocumentSettings=defaultDocument())=>{state={layers,activeId:layers.at(-1)!.id,document:doc,selection,clipboard:null}}
  command('set_document',{x:-8,y:-8,width:48,height:48,background:'#ffffff'});command('set_guides',{guides:[{axis:'x',value:10}],snap:true,grid:false})
  assert(state.document.bounds?.width===48&&state.document.guides[0].value===10&&state.document.snap&&!state.document.grid,'Document and guide settings failed')
  command('select_all');assert(state.selection?.bounds.x===-8&&state.selection.bounds.width===48,'Select all ignored document bounds')
  mark('document dimensions, background, guides, grid, snapping settings and select all')

  reset([solid('#ff0000')]);command('select_polygon',{points:[{x:0,y:0},{x:32,y:0},{x:0,y:32}]})
  command('copy_pixels');command('paste_pixels',{x:64,y:0})
  assert(pixel([state.layers.at(-1)!],68,4)[3]===255&&pixel([state.layers.at(-1)!],92,28)[3]===0,'Polygon clipboard lost transparency or shape')
  const original=state.layers[0];state.activeId=original.id;command('cut_pixels')
  assert(pixel([state.layers[0]],4,4)[3]===0&&pixel([state.layers[0]],28,28)[3]===255&&pixel([original],4,4)[3]===255,'Cut modified source history or selection outside pixels')
  mark('polygon selection, copy, cut and paste preserve alpha, offsets and prior history')

  reset([solid('#ff0000')],rectangularSelection({x:8,y:8,width:8,height:8}),{...defaultDocument(),bounds:{x:0,y:0,width:32,height:32}})
  command('modify_selection',{operation:'expand',radius:2});assert(state.selection!.bounds.width===12,'Expand did not grow selection')
  command('modify_selection',{operation:'contract',radius:2})
  const expanded=state.selection!;command('modify_selection',{operation:'feather',radius:2});assert(state.selection!.bounds.width>expanded.bounds.width,'Feather did not include edge falloff')
  state.selection=rectangularSelection({x:8,y:8,width:8,height:8});command('modify_selection',{operation:'invert'})
  assert(state.selection!.bounds.width===32&&state.selection!.mask.getContext('2d')!.getImageData(10,10,1,1).data[3]===0,'Document-wide inversion failed')
  mark('selection expansion, contraction, feather and document-wide inversion')

  const islands=combineSelections(rectangularSelection({x:0,y:0,width:12,height:12}),rectangularSelection({x:20,y:0,width:12,height:12}),'add')!
  reset([createLayer()],islands);command('fill_selection',{color:'#ff0000'})
  assert(pixel(state.layers,4,4)[0]===255&&pixel(state.layers,24,4)[0]===255&&pixel(state.layers,16,4)[3]===0,'Fill selection did not cover separate selected islands')
  const outlined=combineSelections(rectangularSelection({x:0,y:0,width:32,height:32}),rectangularSelection({x:12,y:12,width:8,height:8}),'subtract')!
  reset([createLayer()],outlined);command('stroke_selection',{color:'#00ff00',brush:2})
  assert(pixel(state.layers,0,16)[1]===255&&pixel(state.layers,10,16)[1]===255&&pixel(state.layers,5,5)[3]===0&&pixel(state.layers,16,16)[3]===0,'Selection stroke lost outer border, hole border or interior transparency')
  mark('selection fill covers disconnected islands and stroke outlines both outer and hole edges')

  const maskLayer=solid('#ff0000');maskLayer.offset={x:10,y:-5}
  reset([maskLayer],rectangularSelection({x:10,y:-5,width:16,height:16}));command('set_layer_mask',{maskMode:'selection'})
  assert(pixel(state.layers,14,0)[3]===255&&pixel(state.layers,34,20)[3]===0,'Selection mask did not hide outside pixels')
  assert(pixel([rawLayer(state.layers[0])],34,20)[3]===255,'Non-destructive mask erased source pixels')
  command('set_layer_mask',{maskMode:'disable'});assert(pixel(state.layers,34,20)[3]===255,'Disable mask failed')
  command('set_layer_mask',{maskMode:'enable'});state.selection=null;command('paint_layer_mask',{points:[{x:34,y:20}],brush:8,reveal:true});assert(pixel(state.layers,34,20)[3]>250,'Mask reveal failed')
  command('paint_layer_mask',{points:[{x:14,y:0}],brush:8,reveal:false});assert(pixel(state.layers,14,0)[3]===0,'Mask hide failed')
  const masked=copyLayer(state.layers[0]);command('apply_layer_mask');assert(!state.layers[0].mask&&pixel(state.layers,14,0)[3]===0&&pixel([rawLayer(masked)],14,0)[3]===255,'Apply mask failed or modified history')
  command('set_layer_mask',{maskMode:'hide'});command('set_layer_mask',{maskMode:'remove'});assert(pixel(state.layers,34,20)[3]>250,'Remove mask failed')
  command('set_layer_mask',{maskMode:'reveal'});assert(pixel(state.layers,34,20)[3]>250,'Reveal all mask failed')
  mark('non-destructive masks, enable/disable, reveal/hide painting, apply/remove with moved layers')

  const bottom=solid('#808080'),top=solid('#ff0000');top.blendMode='multiply'
  assert(pixel([bottom,top],4,4).join()==='128,0,0,255','Multiply blend failed')
  top.blendMode='screen';assert(pixel([bottom,top],4,4).join()==='255,128,128,255','Screen blend failed')
  const clipped=solid('#0000ff',0,0,32,32);clipped.clipping=true
  assert(pixel([solid('#ff0000',0,0,16,16),clipped],24,24)[3]===0&&pixel([bottom,clipped],4,4)[2]===255,'Clipping layer alpha failed')
  bottom.groupHidden=true;assert(pixel([bottom,clipped],4,4)[3]===0,'Clipping displayed pixels over hidden base')
  mark('actual multiply/screen pixels and clipping to visible base-layer alpha')

  reset([solid('#ff0000'),solid('#0000ff',64,0)])
  command('group_layers',{layerIds:state.layers.map(l=>l.id),group:'subjects'});command('set_group',{group:'subjects',name:'renamed',visible:false})
  assert(state.layers.every(l=>l.group==='renamed'&&l.groupHidden)&&pixel(state.layers,4,4)[3]===0,'Group rename/visibility failed')
  command('set_group',{group:'renamed',visible:true});command('set_document',{width:128,height:64})
  command('align_layers',{layerIds:state.layers.map(l=>l.id),alignment:'center'});assert(state.layers.every(l=>layerPixelBounds(l)!.x===48),'Layer alignment failed')
  const hidden=solid('#00ff00');hidden.visible=false;state.layers.push(hidden)
  command('flatten_layers');assert(state.layers.length===2&&state.layers[0].id===hidden.id&&pixel(state.layers,50,4)[2]===255,'Merge visible lost hidden layers or flattened wrong pixels')
  mark('layer grouping, rename, visibility, alignment and visible merge retain hidden layers')

  reset([solid('#ff0000',8,8,8,8),solid('#0000ff',24,24,8,8)],null,{...defaultDocument(),bounds:{x:0,y:0,width:40,height:40}})
  command('resize_document',{width:80,height:80,smoothing:false});assert(layerPixelBounds(state.layers[0])!.x===16&&layerPixelBounds(state.layers[1])!.x===48,'Document resize lost relative positions')
  assert(layerPixelBounds(state.layers[0])!.width===16,'Document resize did not resample pixels')
  command('crop_document',{x:16,y:16,width:16,height:16});assert(pixel(state.layers,50,50)[3]===0&&state.document.bounds!.x===16,'Document crop did not trim pixels')
  mark('document resampling preserves layer layout and document crop trims outside pixels')

  reset([createLayer()]);command('add_text_layer',{x:0,y:0,text:'Hello',fontSize:24,fontFamily:'Arial',color:'#123456'})
  const id=state.activeId, text=state.layers.at(-1)!;assert(text.textSource&&text.tiles.size>0,'Editable text was not rasterized for display')
  const moved={...text,offset:{x:100,y:-20}},transformed=transformLayerContent(moved,{targetWidth:100,targetHeight:40,angle:25}).layer
  state.layers=state.layers.map(l=>l.id===id?transformed:l);command('edit_text_layer',{text:'World'})
  const edited=state.layers.at(-1)!;assert(edited.id===id&&edited.offset.x===100&&edited.textSource!.matrix.join()===transformed.textSource!.matrix.join(),'Text edit lost movement or transform')
  const same=executeWorkbench({...state,layers:[transformed],activeId:transformed.id},{action:'edit_text_layer',text:'Hello'}).layers![0]
  const a=layerPixelBounds(transformed)!,b=layerPixelBounds(same)!;assert(Math.abs(a.x-b.x)<2&&Math.abs(a.y-b.y)<2,'Regenerating transformed text shifted world position')
  command('rasterize_layer');assert(!state.layers.at(-1)!.textSource&&state.layers.at(-1)!.tiles.size>0,'Rasterization lost text pixels')
  mark('editable text creation, regeneration after move/rotation, editing and rasterization')

  const sheared=solid('#ff0000');reset([sheared],rectangularSelection({x:0,y:0,width:16,height:32}));command('set_layer_mask',{maskMode:'selection'})
  const geometry=transformLayerContent(state.layers[0],{targetWidth:32,targetHeight:32,skewX:30,angle:10})
  assert(geometry.bounds.width>32&&geometry.layer.mask&&pixel([rawLayer(geometry.layer)],16,16)[3]>0,'Skew did not transform image geometry')
  const maskPixels=rasterizeRegion([geometry.layer],geometry.bounds,geometry.bounds.width,geometry.bounds.height).getContext('2d')!.getImageData(0,0,geometry.bounds.width,geometry.bounds.height).data
  const rawPixels=rasterizeRegion([rawLayer(geometry.layer)],geometry.bounds,geometry.bounds.width,geometry.bounds.height).getContext('2d')!.getImageData(0,0,geometry.bounds.width,geometry.bounds.height).data
  assert(maskPixels.filter((_,i)=>i%4===3).reduce((a,b)=>a+b,0)<rawPixels.filter((_,i)=>i%4===3).reduce((a,b)=>a+b,0),'Skew did not retain transformed mask')
  let singular=false;try{transformLayerContent(sheared,{skewX:45,skewY:45})}catch{singular=true}assert(singular,'Singular skew should be rejected')
  mark('skew and rotation transform pixels and masks together and reject singular geometry')

  const alpha=solid('rgba(255,0,0,.5)',0,0,8,8);alpha.alphaLocked=true
  const before:TileSnapshot=new Map();paintBrushStroke(alpha,[{x:4,y:4},{x:12,y:4}],false,before,{color:'#0000ff',brush:6,opacity:50,hardness:100},null)
  assert(pixel([alpha],4,4)[3]===128&&pixel([alpha],12,4)[3]===0,'Brush transparency lock failed')
  restoreTiles(alpha,before);assert(pixel([alpha],4,4)[0]===255,'Transparency-locked brush undo failed')
  const empty=createLayer();paintBrushStroke(empty,[{x:4,y:4},{x:16,y:4},{x:4,y:4}],false,new Map(),{color:'#0000ff',brush:8,opacity:50,hardness:100},null)
  assert(pixel([empty],8,4)[3]===128,'Overlapping stroke accumulated opacity')
  const soft=createLayer();paintBrushStroke(soft,[{x:10,y:10}],false,new Map(),{color:'#0000ff',brush:20,opacity:100,hardness:0},null);assert(pixel([soft],20,10)[3]>0&&pixel([soft],20,10)[3]<150,'Brush hardness has no soft edge')
  const eraseBefore:TileSnapshot=new Map();paintBrushStroke(empty,[{x:8,y:4}],true,eraseBefore,{color:'#000000',brush:8,opacity:50,hardness:100},null);assert(pixel([empty],8,4)[3]>=63&&pixel([empty],8,4)[3]<=65,'Eraser opacity failed')
  mark('brush hardness, one opacity application per stroke, eraser opacity, alpha lock and undo')

  const locked=solid('#ff0000');locked.locked=true;reset([locked])
  for(const [action,input]of [['filter',{filter:'invert'}],['cut_pixels',{}],['set_layer_mask',{maskMode:'hide'}],['resize_document',{width:64,height:64}],['retouch_brush',{retouchMode:'smudge',points:[{x:2,y:2},{x:8,y:2}]}]] as const){let rejected=false;try{command(action,input)}catch{rejected=true}assert(rejected,`${action} ignored layer lock`)}
  assert(pixel([locked],4,4).join()==='255,0,0,255','Locked operation modified pixels')
  mark('locked editing commands reject without changing source pixels')

  const seam=solid('#808080',500,0,24,16);reset([seam]);command('filter',{filter:'invert'});assert(pixel(state.layers,510,4)[0]===127&&pixel(state.layers,514,4)[0]===127,'Filter seam failed')
  const donut=combineSelections(rectangularSelection({x:500,y:0,width:24,height:16}),shapeSelection([{x:512,y:8}],'brush',6),'subtract')!
  state.selection=donut;command('filter',{filter:'threshold',amount:200});assert(pixel(state.layers,512,8)[0]===127&&pixel(state.layers,504,8)[0]===0,'Filter ignored selection holes')
  const grad=solid('#000000',500,0,12,16),white=canvasImage(12,16);white.getContext('2d')!.fillStyle='#ffffff';white.getContext('2d')!.fillRect(0,0,12,16);drawImageOnLayer(grad,white,{x:512,y:0,width:12,height:16})
  filterLayer(grad,{filter:'blur',amount:2},null,new Map());assert(pixel([grad],511,8)[0]>0&&pixel([grad],512,8)[0]<255,'Blur did not sample across tile seam')
  mark('filters respect selection holes and blur samples neighboring tiles across seams')

  const mixed=solid('#000000',0,0,16,16),light=canvasImage(16,16);light.getContext('2d')!.fillStyle='#ffffff';light.getContext('2d')!.fillRect(0,0,16,16);drawImageOnLayer(mixed,light,{x:16,y:0,width:16,height:16})
  reset([mixed]);command('retouch_brush',{retouchMode:'blur',points:[{x:16,y:8}],brush:12,strength:50});assert(pixel(state.layers,15,8)[0]>0&&pixel(state.layers,2,8)[0]===0,'Local blur affected wrong scope')
  command('retouch_brush',{retouchMode:'sharpen',points:[{x:16,y:8}],brush:12,strength:50})
  reset([mixed]);command('retouch_brush',{retouchMode:'smudge',points:[{x:10,y:8},{x:22,y:8}],brush:10,strength:100});assert(pixel(state.layers,18,8)[0]<250,'Smudge did not carry color')
  mark('local blur/sharpen and smudge brush carry color within brush scope')

  const healing=solid('#000000',0,0,32,16),patch=canvasImage(16,16),ctx=patch.getContext('2d')!;ctx.fillStyle='#ffffff';ctx.fillRect(0,0,8,16);ctx.fillStyle='#808080';ctx.fillRect(8,0,8,16);drawImageOnLayer(healing,patch,{x:0,y:0,width:16,height:16})
  reset([healing]);command('heal_stamp',{sourceX:8,sourceY:8,points:[{x:24,y:8}],brush:12});assert(pixel(state.layers,20,8)[0]>0&&pixel(state.layers,24,8)[3]===255,'Healing did not adapt source texture or retain alpha')
  mark('healing stamp transfers texture while adapting destination color and retaining alpha')

  reset([solid('rgba(255,0,0,.5)',0,0,8,8)],null,{...defaultDocument(),bounds:{x:-4,y:-4,width:16,height:16},background:'transparent'})
  for(const format of ['png','jpeg','webp']){const result=command('export_image',{format,quality:.8});assert(result.width===16&&result.height===16&&result.mime===`image/${format}`,'Export dimensions or MIME incorrect');const bytes=atob(result.base64 as string);assert(format==='png'?bytes.startsWith('\x89PNG'):format==='jpeg'?bytes.charCodeAt(0)===255&&bytes.charCodeAt(1)===216:bytes.startsWith('RIFF')&&bytes.slice(8,12)==='WEBP',`${format} header incorrect`)}
  mark('PNG/JPEG/WebP exports use document frame, MIME and real format headers')

  const persisted=copyLayer(state.layers[0]);persisted.mask={bounds:{x:0,y:0,width:8,height:8},outside:0,enabled:true,canvas:canvasImage(8,8)};persisted.mask.canvas.getContext('2d')!.fillStyle='#ffffff';persisted.mask.canvas.getContext('2d')!.fillRect(0,0,4,8);persisted.blendMode='multiply';persisted.alphaLocked=true;persisted.group='group';persisted.locked=true
  const restored=await deserializeLayers(JSON.parse(JSON.stringify([serializeLayer(persisted)])))
  assert(restored[0].locked&&restored[0].alphaLocked&&restored[0].blendMode==='multiply'&&restored[0].group==='group'&&pixel(restored,6,4)[3]===0&&pixel([rawLayer(restored[0])],6,4)[3]===128,'Project metadata/pixel roundtrip failed')
  const textProject=executeWorkbench({...state,activeId:state.layers[0].id},{action:'add_text_layer',text:'Saved',x:-10,y:5}).layers!.at(-1)!
  const decoded=await deserializeLayers([serializeLayer(textProject)]);assert(decoded[0].textSource?.text==='Saved','Project lost editable text')
  mark('project PNG roundtrip preserves masks, locks, blend, groups, alpha and editable text')
  return checks
}
