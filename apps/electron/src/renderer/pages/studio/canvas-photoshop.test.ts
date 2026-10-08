import { describe, expect, it } from 'bun:test'
import { filterPixelData, selectionMorphology, snapPoint, validateDocument, defaultDocument, photoshopActions } from './canvas-photoshop'
import { canvasToolGroups } from './canvas-tools'
import { CanvasToolSchema } from '../../../../../../packages/session-tools-core/src/tool-defs'

describe('core raster editing math', () => {
  const image = (values: number[]) => ({ width: values.length/4, height: 1, data: new Uint8ClampedArray(values) }) as ImageData
  it('levels clamp input range and retain transparent alpha', () => {
    const pixels=image([10,100,240,128,50,70,80,0]);filterPixelData(pixels,{filter:'levels',black:20,white:220,gamma:1})
    expect([...pixels.data]).toEqual([0,102,255,128,50,70,80,0])
  })
  it('curves interpolate ordered input points and reject duplicate inputs', () => {
    const pixels=image([64,128,192,255]);filterPixelData(pixels,{filter:'curves',curve:[{x:0,y:0},{x:128,y:64},{x:255,y:255}]})
    expect([...pixels.data]).toEqual([32,64,160,255])
    expect(()=>filterPixelData(pixels,{filter:'curves',curve:[{x:0,y:0},{x:0,y:255}]})).toThrow()
  })
  it('threshold, posterize, inversion and color balance have distinct effects', () => {
    const outputs=new Set<string>()
    for(const filter of ['threshold','posterize','invert','color-balance'] as const){const p=image([80,140,210,100]);filterPixelData(p,{filter,amount:filter==='threshold'?150:4,red:20,green:-20});outputs.add([...p.data].join());expect(p.data[3]).toBe(100)}
    expect(outputs.size).toBe(4)
  })
  it('noise is deterministic for a given seed and retains alpha', () => {
    const a=image([120,120,120,90]),b=image([120,120,120,90]);filterPixelData(a,{filter:'noise',seed:20});filterPixelData(b,{filter:'noise',seed:20});expect(a.data).toEqual(b.data);expect(a.data[3]).toBe(90)
  })
  it('morphology expands a point and contracts a solid selection without wrapping rows', () => {
    const point=new Uint8ClampedArray(25);point[12]=255
    const expanded=selectionMorphology(point,5,5,1,true)
    expect([...expanded].filter(v=>v===255).length).toBe(9);expect(expanded[0]).toBe(0)
    expect(selectionMorphology(new Uint8ClampedArray(25).fill(255),5,5,1,false)).toEqual(expanded)
  })
  it('snaps only near guides or frame edges and validates document bounds', () => {
    const doc=validateDocument({...defaultDocument(),bounds:{x:-10,y:0,width:40,height:30},snap:true,guides:[{axis:'x',value:5}]})
    expect(snapPoint({x:6,y:28},doc,3)).toEqual({x:5,y:30});expect(snapPoint({x:18,y:12},doc,3)).toEqual({x:18,y:12})
    expect(()=>validateDocument({...doc,background:'url(secret)'})).toThrow();expect(()=>validateDocument({...doc,bounds:{x:0,y:0,width:5000,height:1}})).toThrow()
  })
  it('registers unique tools and unique shortcuts with explicit AI operations', () => {
    const tools=canvasToolGroups.flatMap(g=>g.tools),ids=tools.map(t=>t.id),shortcuts=tools.flatMap(t=>t.shortcut?[t.shortcut]:[])
    expect(new Set(ids).size).toBe(ids.length);expect(new Set(shortcuts).size).toBe(shortcuts.length)
    expect(tools.every(t=>t.actions.length>0)).toBe(true)
    expect(tools.find(t=>t.id==='move')?.actions).toEqual(['set_layer'])
    for(const action of photoshopActions){expect(CanvasToolSchema.safeParse({action}).success).toBe(true);expect(tools.some(t=>t.actions.includes(action))).toBe(true)}
  })
})
