import { expect, it } from 'bun:test'
import { canvasExportInfo } from './canvas-export'

it('routes real canvas export bytes to matching extensions and browser MIME types',()=>{
  expect(canvasExportInfo({action:'export_image',format:'jpeg'})).toEqual({mime:'image/jpeg',extension:'jpg',extensions:['.jpg','.jpeg']})
  expect(canvasExportInfo({action:'export_image',format:'webp'})).toEqual({mime:'image/webp',extension:'webp',extensions:['.webp']})
  expect(canvasExportInfo({action:'export_image'}).extensions).toEqual(['.png'])
  expect(canvasExportInfo({action:'save_project'}).mime).toBe('application/json')
  expect(()=>canvasExportInfo({action:'export_image',format:'psd'})).toThrow()
})
