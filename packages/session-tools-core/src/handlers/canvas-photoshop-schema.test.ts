import { describe, expect, it } from 'bun:test'
import { CanvasToolSchema } from '../tool-defs'
import { handleCanvasTool } from './canvas-tool'
import type { SessionToolContext } from '../context'

describe('core editing AI interfaces',()=>{
  const examples: Record<string,Record<string,unknown>> = {
    set_document:{x:-10,y:0,width:1024,height:768,background:'#123456'},resize_document:{width:512,height:384,smoothing:false},crop_document:{trim:false},
    fill_selection:{color:'#123456'},stroke_selection:{color:'#123456',brush:4},
    select_all:{},modify_selection:{operation:'feather',radius:8},select_polygon:{points:[{x:0,y:0},{x:20,y:0},{x:0,y:20}],selectionMode:'add'},
    set_layer_mask:{maskMode:'selection'},paint_layer_mask:{points:[{x:2,y:4}],brush:20,reveal:true},apply_layer_mask:{},
    group_layers:{layerIds:['a','b'],group:'subjects'},set_group:{group:'subjects',name:'people',visible:false},align_layers:{layerIds:['a','b'],alignment:'center'},flatten_layers:{},
    copy_pixels:{},cut_pixels:{},paste_pixels:{x:-10,y:10},add_text_layer:{x:0,y:0,text:'Title',fontFamily:'Microsoft YaHei',fontSize:32,color:'#123456'},edit_text_layer:{text:'Updated',bold:true},rasterize_layer:{},
    filter:{filter:'curves',curve:[{x:0,y:0},{x:128,y:160},{x:255,y:255}]},export_image:{outputPath:'C:\\exports\\work.webp',format:'webp',quality:.85,selectionOnly:true},
    set_guides:{guides:[{axis:'x',value:25}],grid:true,snap:true},get_history:{},heal_stamp:{sourceX:2,sourceY:4,points:[{x:30,y:30}],brush:24},retouch_brush:{points:[{x:10,y:20},{x:20,y:20}],retouchMode:'smudge',strength:50,brush:16},
  }
  for (const action of Object.keys(examples)) it(`${action} validates and preserves fields through the desktop bridge`,async()=>{
    expect(examples[action]).toBeDefined()
    const input={action,...examples[action]},args=CanvasToolSchema.parse(input);expect(input).toEqual(args)
    let received:unknown
    const ctx={canvasToolFn:async(value:unknown)=>{received=value;return{applied:true}}} as SessionToolContext
    expect((await handleCanvasTool(ctx,args)).isError).not.toBe(true);expect(received).toEqual(input)
    expect((await handleCanvasTool({canvasToolFn:async()=>{throw new Error('Layer locked')}} as unknown as SessionToolContext,args)).isError).toBe(true)
  })
  it('preserves masks, blend, locks and full brush settings',()=>{
    const input={action:'set_layer',blendMode:'multiply',locked:true,alphaLocked:true,clipping:true,layerId:'layer'} as const
    expect(CanvasToolSchema.parse(input)).toEqual(input)
    expect(CanvasToolSchema.parse({action:'paint',brushOpacity:50,hardness:20})).toEqual({action:'paint',brushOpacity:50,hardness:20})
  })
  it('rejects invalid editing options',()=>{
    for(const input of [{action:'filter',filter:'unknown'},{action:'filter',gamma:0},{action:'set_layer',blendMode:'unknown'},{action:'paint',hardness:101},{action:'set_guides',guides:[{axis:'z',value:1}]},{action:'export_image',quality:0},{action:'set_layer_mask',maskMode:'invalid'},{action:'retouch_brush',retouchMode:'unknown'}])expect(CanvasToolSchema.safeParse(input).success).toBe(false)
  })
})
