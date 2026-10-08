import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import i18next from 'i18next'
import { initReactI18next, I18nextProvider } from 'react-i18next'
import en from '../../../../../../packages/shared/src/i18n/locales/en.json'
import { CanvasPhotoshopPanel } from './CanvasPhotoshopPanel'
import { executeWorkbench, type WorkbenchState } from './canvas-workbench'
import { createLayer } from './canvas-engine'
import { defaultDocument } from './canvas-photoshop'

/** Verify actual controls dispatch the same commands exercised by pixel and AI tests. */
export async function runWorkbenchUiChecks(): Promise<string[]> {
  const i18n=i18next.createInstance();await i18n.use(initReactI18next).init({lng:'en',keySeparator:false,resources:{en:{translation:en}},interpolation:{escapeValue:false}})
  const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node)
  const environment=globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean },previousEnvironment=environment.IS_REACT_ACT_ENVIRONMENT
  environment.IS_REACT_ACT_ENVIRONMENT=true
  const layer=createLayer('Pixel layer');let state:WorkbenchState={layers:[layer],activeId:layer.id,document:defaultDocument(),selection:null,clipboard:null}
  const sent:Array<Record<string,unknown>>=[],saved:string[]=[]
  function Harness(){const [current,setCurrent]=useState(state);return <I18nextProvider i18n={i18n}><CanvasPhotoshopPanel documentSettings={current.document} layers={current.layers} activeId={current.activeId} selection={current.selection?.bounds??null} clipboardAvailable={!!current.clipboard} history={[]} onSave={(_,name)=>saved.push(name)} onCommand={async input=>{
    sent.push(input)
    const result=executeWorkbench(state,input)
    state={...state,...(result.layers?{layers:result.layers}:{}),...(result.document?{document:result.document}:{}),...('selection'in result?{selection:result.selection??null}:{}),...(result.activeId?{activeId:result.activeId}:{}),...(result.clipboard?{clipboard:result.clipboard}:{})};setCurrent(state);return result.result
  }}/></I18nextProvider>}
  const assert=(value:unknown,message:string)=>{if(!value)throw new Error(message)}
  const click=async(label:string)=>{const button=Array.from(node.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent===label);assert(button&&!button.matches(':disabled'),`Workbench control missing or disabled: ${label}`);await act(async()=>button!.click())}
  try{
    await act(async()=>root.render(<Harness/>))
    assert(!node.textContent?.includes('studio.ps.'),'Workbench displays untranslated keys')
    await click('Canvas size');assert(state.document.bounds?.width===1024&&sent.at(-1)?.action==='set_document','Canvas size control did not dispatch command')
    node.querySelectorAll('details').forEach(details=>details.open=true)
    await click('Select all');assert(state.selection?.bounds.height===1024,'Select all control failed')
    await click('Fill selection');assert(state.layers[0].tiles.size>0&&sent.at(-1)?.action==='fill_selection','Fill selection control failed')
    await click('Copy pixels');await click('Paste as layer');assert(state.layers.length===2,'Clipboard controls failed')
    await click('Mask from selection');assert(state.layers.at(-1)?.mask,'Mask control failed')
    await click('Export image');assert(saved[0]==='tokenbird-canvas.png','Export control did not save image')
    return ['workbench controls render translated labels and dispatch document, selection, fill, clipboard, mask and export actions']
  }finally{await act(async()=>root.unmount());node.remove();environment.IS_REACT_ACT_ENVIRONMENT=previousEnvironment}
}
