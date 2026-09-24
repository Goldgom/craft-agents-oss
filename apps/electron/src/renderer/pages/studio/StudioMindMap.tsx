import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Download, FileUp, LoaderCircle, PanelRightClose, PanelRightOpen, RotateCcw, Send, Sparkles } from 'lucide-react'
import { StudioConnectionPicker, useStudioConnections } from './useStudioConnections'
import { jpegToPdf } from './studio-pdf'
import { isWebUI } from '@/lib/platform'
import { useTheme } from '@/context/ThemeContext'
import { StudioSessionWorkspace, type StudioSessionEditorProps } from './StudioSessionWorkspace'

const EMPTY_DRAWIO = '<mxfile host="TokenBird"><diagram name="Mind Map"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'

function download(data: Blob | string, name: string) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 1000)
}

type DrawioMessage = { event?: string; xml?: string; data?: string; format?: string; message?: { requestId?: string } }

type MindMapMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt: number; beforeXml?: string; failed?: boolean }
type MindMapSessionData = { xml: string; prompt: string; messages: MindMapMessage[] }

function readSessionData(raw: string): MindMapSessionData {
  if (raw) {
    try {
      const value = JSON.parse(raw) as MindMapSessionData
      if (typeof value.xml === 'string' && /<(?:mxfile|mxGraphModel)\b/.test(value.xml)) return {
        xml: value.xml,
        prompt: typeof value.prompt === 'string' ? value.prompt : '',
        messages: Array.isArray(value.messages) ? value.messages.filter((item): item is MindMapMessage =>
          !!item && typeof item.id === 'string' && (item.role === 'user' || item.role === 'assistant')
          && typeof item.content === 'string' && Number.isFinite(item.createdAt)).slice(-100) : [],
      }
    } catch { /* A new session starts with an empty diagram. */ }
  }
  return { xml: EMPTY_DRAWIO, prompt: '', messages: [] }
}

function validateDrawioDocument(xml: string, allowCompressed = false): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('导图包含不安全的声明')
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror') || doc.documentElement.tagName !== 'mxfile'
    || !doc.querySelector('diagram')
    || (!allowCompressed && (!doc.querySelector('mxGraphModel > root > mxCell[id="0"]')
      || !doc.querySelector('mxGraphModel > root > mxCell[id="1"]')))) throw new Error('无效的 draw.io 文档')
  if (allowCompressed && !doc.querySelector('mxGraphModel > root > mxCell[id="0"]')
    && !Array.from(doc.querySelectorAll('diagram')).every(diagram => /^[A-Za-z0-9+/=\s]+$/.test(diagram.textContent ?? ''))) {
    throw new Error('无效的 draw.io 压缩数据')
  }
  for (const element of Array.from(doc.getElementsByTagName('*'))) {
    if (/^(script|iframe|object|embed|foreignObject)$/i.test(element.tagName)) throw new Error('导图包含不安全的元素')
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name) || /javascript:/i.test(attribute.value)) throw new Error('导图包含不安全的属性')
    }
  }
}

export default function StudioMindMap() {
  return <StudioSessionWorkspace mode="mindmap">{sessionProps => <MindMapEditor key={sessionProps.session.id} {...sessionProps} />}</StudioSessionWorkspace>
}

function MindMapEditor({ session, onSave, createSession, flushRef, setLocked, suggestTitle }: StudioSessionEditorProps) {
  const { isDark } = useTheme()
  const initial = useRef(readSessionData(session.data))
  const frameRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)
  const xmlRef = useRef(initial.current.xml)
  const pendingRef = useRef(new Map<string, { resolve: (message: DrawioMessage) => void; reject: (error: Error) => void }>())
  const [ready, setReady] = useState(false)
  const [frameDark, setFrameDark] = useState(isDark)
  const [chatOpen, setChatOpen] = useState(true)
  const [prompt, setPrompt] = useState(initial.current.prompt)
  const promptRef = useRef(prompt); promptRef.current = prompt
  const [messages, setMessages] = useState<MindMapMessage[]>(initial.current.messages)
  const messagesRef = useRef(messages); messagesRef.current = messages
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const { connections, connection, connectionSlug, setConnectionSlug, model, setModel, modelChannelGroup, loginTokenNest } = useStudioConnections()

  const persist = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    await onSave(JSON.stringify({ xml: xmlRef.current, prompt: promptRef.current, messages: messagesRef.current }))
  }, [onSave])
  const schedulePersist = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void persist().catch(cause => setError(`自动保存失败：${String(cause)}`)) }, 750)
  }, [persist])
  useLayoutEffect(() => {
    const flush = async () => {
      if (readyRef.current) {
        try {
          const result = await requestExport('xml', 2500)
          if (result.xml) xmlRef.current = result.xml
        } catch { /* Keep the latest autosave if draw.io cannot export promptly. */ }
      }
      await persist()
    }
    flushRef.current = flush
    return () => { if (flushRef.current === flush) flushRef.current = null }
  })
  useEffect(() => { schedulePersist(); return () => { if (saveTimer.current) clearTimeout(saveTimer.current) } }, [prompt, messages, schedulePersist])
  useEffect(() => { transcriptEndRef.current?.scrollIntoView({ block: 'end' }) }, [messages.length, chatOpen])
  useEffect(() => { setLocked(busy); return () => setLocked(false) }, [busy, setLocked])

  const query = `?embed=1&proto=json&offline=1&ui=atlas&dark=${frameDark ? '1' : '0'}&spin=1&libraries=0`
  const frameUrl = !isWebUI && window.location.protocol === 'file:'
    ? `tokenbird-studio://drawio/index.html${query}`
    : new URL(`drawio/index.html${query}`, window.location.href).toString()

  const send = useCallback((message: Record<string, unknown>) => {
    frameRef.current?.contentWindow?.postMessage(JSON.stringify(message), '*')
  }, [])

  function load(xml: string) {
    xmlRef.current = xml
    schedulePersist()
    if (readyRef.current) send({ action: 'load', xml, autosave: 1, fit: '1' })
  }

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== frameRef.current?.contentWindow || typeof event.data !== 'string') return
      let message: DrawioMessage
      try { message = JSON.parse(event.data) as DrawioMessage } catch { return }
      if (message.event === 'init') {
        readyRef.current = true
        setReady(true)
        frameRef.current?.contentWindow?.postMessage(JSON.stringify({ action: 'load', xml: xmlRef.current, autosave: 1, fit: '1' }), '*')
      } else if (message.event === 'autosave' && readyRef.current && typeof message.xml === 'string') {
        xmlRef.current = message.xml
        schedulePersist()
      } else if (message.event === 'export') {
        const id = message.message?.requestId
        const pending = id ? pendingRef.current.get(id) : undefined
        if (id && pending) { pendingRef.current.delete(id); pending.resolve(message) }
      }
    }
    const pending = pendingRef.current
    window.addEventListener('message', onMessage)
    const timer = setTimeout(() => { if (!readyRef.current) setError('draw.io 编辑器未能加载，请检查本地资源是否已打包') }, 20_000)
    return () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      for (const request of pending.values()) request.reject(new Error('Editor closed'))
      pending.clear()
    }
  }, [schedulePersist])

  const requestExport = useCallback((format: 'xml' | 'png', timeoutMs = 30_000): Promise<DrawioMessage> => {
    if (!readyRef.current) return Promise.reject(new Error('draw.io 编辑器尚未就绪'))
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      pendingRef.current.set(requestId, { resolve, reject })
      send({ action: 'export', format, requestId, scale: 2, background: '#ffffff', border: 16 })
      setTimeout(() => {
        if (pendingRef.current.delete(requestId)) reject(new Error('draw.io 导出超时'))
      }, timeoutMs)
    })
  }, [send])

  useEffect(() => {
    if (isDark === frameDark) return
    let cancelled = false
    void (async () => {
      if (readyRef.current) {
        try {
          const result = await requestExport('xml', 5000)
          if (result.xml) { xmlRef.current = result.xml; schedulePersist() }
        } catch (cause) { if (!cancelled) { setError(`切换主题前保存导图失败：${String(cause)}`); return } }
      }
      if (cancelled) return
      readyRef.current = false
      setReady(false)
      setFrameDark(isDark)
    })()
    return () => { cancelled = true }
  }, [isDark, frameDark, requestExport, schedulePersist])

  async function exportFile(format: 'xml' | 'png') {
    try {
      const result = await requestExport(format)
      if (format === 'xml' && result.xml) download(new Blob([result.xml], { type: 'application/xml' }), 'tokenbird-mindmap.drawio')
      else if (format === 'png' && result.data?.startsWith('data:image/png')) download(result.data, 'tokenbird-mindmap.png')
      else throw new Error('draw.io 未返回导出文件')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function exportPdf() {
    try {
      const result = await requestExport('png')
      if (!result.data?.startsWith('data:image/png')) throw new Error('draw.io 未返回图像')
      const image = new Image()
      image.src = result.data
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, 0, 0)
      const jpeg = Uint8Array.from(atob(canvas.toDataURL('image/jpeg', 0.95).split(',')[1]), char => char.charCodeAt(0))
      download(jpegToPdf(jpeg, canvas.width, canvas.height), 'tokenbird-mindmap.pdf')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function exportVisio() {
    try {
      const result = await requestExport('xml')
      if (!result.xml) throw new Error('draw.io 未返回导图数据')
      const file = await window.electronAPI.exportStudioVisio(result.xml)
      download(`data:application/vnd.ms-visio.drawing.main+xml;base64,${file.base64}`, 'tokenbird-mindmap.vsdx')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function generate() {
    const instruction = prompt.trim()
    if (!ready || !connectionSlug || !model.trim() || !instruction) { setError('请等待编辑器就绪，并选择连接、模型和填写修改要求'); return }
    const priorRequests = messagesRef.current.filter(message => message.role === 'user').map(message => message.content).slice(-8)
    const userMessage: MindMapMessage = { id: crypto.randomUUID(), role: 'user', content: instruction, createdAt: Date.now() }
    setMessages(current => [...current, userMessage].slice(-100))
    setPrompt('')
    setBusy(true); setError('')
    try {
      const latest = await requestExport('xml')
      const beforeXml = latest.xml || xmlRef.current
      if (!beforeXml) throw new Error('无法读取当前导图')
      xmlRef.current = beforeXml
      const result = await window.electronAPI.generateStudioMindMap({
        connectionSlug, model: model.trim(), channelGroup: modelChannelGroup || undefined,
        prompt: instruction, currentXml: beforeXml, priorRequests,
      })
      validateDrawioDocument(result.xml)
      load(result.xml)
      setMessages(current => [...current, { id: crypto.randomUUID(), role: 'assistant' as const, content: result.summary, createdAt: Date.now(), beforeXml }].slice(-100))
      suggestTitle(instruction.slice(0, 40))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      setPrompt(instruction)
      setMessages(current => [...current, { id: crypto.randomUUID(), role: 'assistant' as const, content: `修改失败：${message}`, createdAt: Date.now(), failed: true }].slice(-100))
    }
    finally { setBusy(false) }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-12 flex-wrap items-center gap-1.5 border-b border-border/70 bg-background px-3 py-2 text-xs">
        <strong className="mr-2 flex items-center gap-2 text-sm"><Sparkles className="size-4 text-primary" />思维导图</strong>
        <button className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => void createSession()}>新建</button>
        <button className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => fileRef.current?.click()}><FileUp className="size-3.5" />导入</button>
        <input ref={fileRef} hidden type="file" accept=".drawio,.xml,text/xml" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { const xml = await file.text(); validateDrawioDocument(xml, true); load(xml); setError('') } catch (cause) { setError(String(cause)) } event.target.value = '' }} />
        <span className="mx-1 h-4 w-px bg-border" />
        <button disabled={!ready} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={() => void exportFile('xml')}><Download className="size-3.5" />draw.io</button>
        <button disabled={!ready} className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={() => void exportFile('png')}>PNG</button>
        <button disabled={!ready} className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={() => void exportPdf()}>PDF</button>
        <button disabled={!ready} className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={() => void exportVisio()}>Visio</button>
        <button className="ml-auto flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1.5 text-foreground hover:bg-accent" title={chatOpen ? '收起修改记录' : '展开修改记录'} aria-label={chatOpen ? '收起修改记录' : '展开修改记录'} onClick={() => setChatOpen(open => !open)}>{chatOpen ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}{chatOpen ? '收起 AI' : 'AI 修改'}</button>
      </div>
      <div className="relative flex min-h-0 flex-1">
        <iframe key={frameDark ? 'dark' : 'light'} ref={frameRef} title="draw.io mind map editor" src={frameUrl} className="min-h-0 min-w-0 flex-1 border-0 bg-background" />
        {chatOpen && <aside className="flex w-80 min-w-0 shrink-0 flex-col border-l border-border/70 bg-background max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-20 max-md:shadow-strong">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/70 px-4"><div><h2 className="text-sm font-semibold">AI 修改记录</h2><p className="text-[11px] text-muted-foreground">描述新导图，或继续修改当前内容</p></div><button className="rounded p-1 text-muted-foreground hover:bg-accent" title="收起修改记录" aria-label="收起修改记录" onClick={() => setChatOpen(false)}><PanelRightClose className="size-4" /></button></div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-label="导图修改记录">
            {messages.length === 0 && <div className="rounded-xl border border-dashed border-border/80 bg-muted/30 p-4 text-xs leading-5 text-muted-foreground">先描述想要的思维导图，例如“生成一个产品规划图，分为目标、功能和时间线”。之后可以继续要求添加节点、调整层级或改变样式。</div>}
            {messages.map(message => <div key={message.id} className={`flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div className={`max-w-full whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-xs leading-5 ${message.role === 'user' ? 'bg-primary text-primary-foreground' : message.failed ? 'bg-destructive/10 text-destructive' : 'bg-muted text-foreground'}`}>{message.content}</div>
              {message.role === 'assistant' && message.beforeXml && <button disabled={busy || !ready} className="mt-1 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={() => { load(message.beforeXml!); setError('') }}><RotateCcw className="size-3" />恢复到这次修改前</button>}
            </div>)}
            {busy && <div className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />正在修改导图…</div>}
            <div ref={transcriptEndRef} />
          </div>
          <div className="shrink-0 space-y-2 border-t border-border/70 p-3">
            <StudioConnectionPicker connections={connections} connectionSlug={connectionSlug} setConnectionSlug={setConnectionSlug} model={model} setModel={setModel} />
            {connection?.oauthProvider === 'tokennest' && !connection.isAuthenticated && <button className="text-xs text-primary underline" onClick={() => void loginTokenNest().catch(cause => setError(String(cause)))}>登录 TokenNest</button>}
            <div className="rounded-xl border border-border bg-muted/20 p-2 focus-within:border-primary/60">
              <textarea className="max-h-40 min-h-20 w-full resize-y bg-transparent p-1 text-xs leading-5 outline-none" aria-label="导图修改要求" placeholder="描述新导图或输入修改要求…" value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void generate() } }} />
              <div className="flex items-center justify-between"><span className="text-[10px] text-muted-foreground">Ctrl + Enter 发送</span><button disabled={busy || !ready || !prompt.trim()} className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40" onClick={() => void generate()}><Send className="size-3.5" />发送</button></div>
            </div>
            {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
          </div>
        </aside>}
      </div>
    </div>
  )
}
