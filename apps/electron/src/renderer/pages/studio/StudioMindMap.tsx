import { i18n } from '@craft-agent/shared/i18n'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUp, Clipboard, Download, FileUp, LoaderCircle, MessageCircle, PanelRightClose, PanelRightOpen, RotateCcw, Sparkles } from 'lucide-react'
import { StudioConnectionPicker, useStudioConnections } from './useStudioConnections'
import { rechargeOnInsufficientBalance } from '@/lib/tokennest-recharge'
import { jpegToPdf } from './studio-pdf'
import { isWebUI } from '@/lib/platform'
import { useTheme } from '@/context/ThemeContext'
import { StudioSessionWorkspace, type StudioSessionEditorProps } from './StudioSessionWorkspace'
import { Markdown } from '@/components/markdown'
import { StudioThinkingPicker, studioThinkingLevel, type StudioThinkingLevel } from './StudioThinkingPicker'
import { StudioExecutionModePicker, studioExecutionMode, type StudioExecutionMode } from './StudioExecutionModePicker'

const EMPTY_DRAWIO = '<mxfile host="TokenBird"><diagram name="Mind Map"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>'

function download(data: Blob | string, name: string) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = url; link.download = name; document.body.appendChild(link); link.click(); link.remove()
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 1000)
}

type DrawioMessage = { event?: string; xml?: string; data?: string; format?: string; message?: { requestId?: string } }

type MindMapMessage = { id: string; role: 'user' | 'assistant'; content: string; createdAt: number; beforeXml?: string; failed?: boolean }
type MindMapSessionData = { xml: string; prompt: string; thinkingLevel?: StudioThinkingLevel; mode?: StudioExecutionMode; messages: MindMapMessage[] }

function readSessionData(raw: string): MindMapSessionData {
  if (raw) {
    try {
      const value = JSON.parse(raw) as MindMapSessionData
      if (typeof value.xml === 'string' && /<(?:mxfile|mxGraphModel)\b/.test(value.xml)) return {
        xml: value.xml,
        prompt: typeof value.prompt === 'string' ? value.prompt : '',
        thinkingLevel: studioThinkingLevel(value.thinkingLevel),
        mode: studioExecutionMode(value.mode),
        messages: Array.isArray(value.messages) ? value.messages.filter((item): item is MindMapMessage =>
          !!item && typeof item.id === 'string' && (item.role === 'user' || item.role === 'assistant')
          && typeof item.content === 'string' && Number.isFinite(item.createdAt)).slice(-100) : [],
      }
    } catch { /* A new session starts with an empty diagram. */ }
  }
  return { xml: EMPTY_DRAWIO, prompt: '', thinkingLevel: 'auto', mode: 'execute', messages: [] }
}

function validateDrawioDocument(xml: string, allowCompressed = false): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(i18n.t('studio.unsafeDeclaration'))
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  if (doc.querySelector('parsererror') || doc.documentElement.tagName !== 'mxfile'
    || !doc.querySelector('diagram')
    || (!allowCompressed && (!doc.querySelector('mxGraphModel > root > mxCell[id="0"]')
      || !doc.querySelector('mxGraphModel > root > mxCell[id="1"]')))) throw new Error(i18n.t('studio.invalidDrawio'))
  if (allowCompressed && !doc.querySelector('mxGraphModel > root > mxCell[id="0"]')
    && !Array.from(doc.querySelectorAll('diagram')).every(diagram => /^[A-Za-z0-9+/=\s]+$/.test(diagram.textContent ?? ''))) {
    throw new Error(i18n.t('studio.invalidCompressedDrawio'))
  }
  for (const element of Array.from(doc.getElementsByTagName('*'))) {
    if (/^(script|iframe|object|embed|foreignObject)$/i.test(element.tagName)) throw new Error(i18n.t('studio.unsafeElement'))
    for (const attribute of Array.from(element.attributes)) {
      if (/^on/i.test(attribute.name) || /javascript:/i.test(attribute.value)) throw new Error(i18n.t('studio.unsafeAttribute'))
    }
  }
}

export default function StudioMindMap() {
  return <StudioSessionWorkspace mode="mindmap">{sessionProps => <MindMapEditor key={sessionProps.session.id} {...sessionProps} />}</StudioSessionWorkspace>
}

function MindMapEditor({ session, onSave, createSession, bindWorkDirectory, flushRef, setLocked, suggestTitle }: StudioSessionEditorProps) {
  const { t, i18n } = useTranslation()
  const { isDark } = useTheme()
  const initial = useRef(readSessionData(session.data))
  const frameRef = useRef<HTMLIFrameElement>(null)
  const readyRef = useRef(false)
  const xmlRef = useRef(initial.current.xml)
  const pendingRef = useRef(new Map<string, { resolve: (message: DrawioMessage) => void; reject: (error: Error) => void }>())
  const [ready, setReady] = useState(false)
  const [frameDark, setFrameDark] = useState(isDark)
  const [chatOpen, setChatOpen] = useState(() => new URLSearchParams(window.location.search).get('embedded') !== 'android')
  const [prompt, setPrompt] = useState(initial.current.prompt)
  const [thinkingLevel, setThinkingLevel] = useState<StudioThinkingLevel>(studioThinkingLevel(initial.current.thinkingLevel))
  const [mode, setMode] = useState<StudioExecutionMode>(studioExecutionMode(initial.current.mode))
  const promptRef = useRef(prompt); promptRef.current = prompt
  const thinkingLevelRef = useRef(thinkingLevel); thinkingLevelRef.current = thinkingLevel
  const modeRef = useRef(mode); modeRef.current = mode
  const [messages, setMessages] = useState<MindMapMessage[]>(initial.current.messages)
  const messagesRef = useRef(messages); messagesRef.current = messages
  const transcriptRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const { connections, connection, connectionSlug, setConnectionSlug, model, setModel, modelChannelGroup, loginTokenNest } = useStudioConnections()

  const persist = useCallback(async () => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    await onSave(JSON.stringify({ xml: xmlRef.current, prompt: promptRef.current, thinkingLevel: thinkingLevelRef.current, mode: modeRef.current, messages: messagesRef.current }))
  }, [onSave])
  const schedulePersist = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void persist().catch(cause => setError(i18n.t('studio.autosaveFailed', { value1: String(cause) }))) }, 750)
  }, [persist, i18n])
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
  useEffect(() => { schedulePersist(); return () => { if (saveTimer.current) clearTimeout(saveTimer.current) } }, [prompt, thinkingLevel, mode, messages, schedulePersist])
  useEffect(() => { if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight }, [messages.length, chatOpen, busy])
  useEffect(() => { setLocked(busy); return () => setLocked(false) }, [busy, setLocked])

  const language = i18n.resolvedLanguage ?? 'en'
  const drawioLanguage = language === 'zh-Hans' ? 'zh' : language === 'zh-Hant' ? 'zh-tw' : language.split('-')[0]
  const [frameLanguage, setFrameLanguage] = useState(drawioLanguage)
  const query = `?embed=1&proto=json&offline=1&ui=atlas&dark=${frameDark ? '1' : '0'}&lang=${encodeURIComponent(frameLanguage)}&spin=1&libraries=0`
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
    const timer = setTimeout(() => { if (!readyRef.current) setError(i18n.t('studio.editorLoadFailed')) }, 20_000)
    return () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      for (const request of pending.values()) request.reject(new Error('Editor closed'))
      pending.clear()
    }
  }, [schedulePersist, i18n])

  const requestExport = useCallback((format: 'xml' | 'png', timeoutMs = 30_000): Promise<DrawioMessage> => {
    if (!readyRef.current) return Promise.reject(new Error(i18n.t('studio.editorNotReady')))
    const requestId = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      pendingRef.current.set(requestId, { resolve, reject })
      send({ action: 'export', format, requestId, scale: 2, background: '#ffffff', border: 16 })
      setTimeout(() => {
        if (pendingRef.current.delete(requestId)) reject(new Error(i18n.t('studio.exportTimeout')))
      }, timeoutMs)
    })
  }, [send, i18n])

  useEffect(() => {
    if (isDark === frameDark && drawioLanguage === frameLanguage) return
    let cancelled = false
    void (async () => {
      if (readyRef.current) {
        try {
          const result = await requestExport('xml', 5000)
          if (result.xml) { xmlRef.current = result.xml; schedulePersist() }
        } catch (cause) { if (!cancelled) { setError(i18n.t('studio.themeSaveFailed', { value1: String(cause) })); return } }
      }
      if (cancelled) return
      readyRef.current = false
      setReady(false)
      setFrameDark(isDark)
      setFrameLanguage(drawioLanguage)
    })()
    return () => { cancelled = true }
  }, [isDark, frameDark, drawioLanguage, frameLanguage, requestExport, schedulePersist, i18n])

  async function exportFile(format: 'xml' | 'png') {
    try {
      const result = await requestExport(format)
      if (format === 'xml' && result.xml) download(new Blob([result.xml], { type: 'application/xml' }), 'tokenbird-mindmap.drawio')
      else if (format === 'png' && result.data?.startsWith('data:image/png')) download(result.data, 'tokenbird-mindmap.png')
      else throw new Error(t('studio.noExportFile'))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function exportPdf() {
    try {
      const result = await requestExport('png')
      if (!result.data?.startsWith('data:image/png')) throw new Error(t('studio.noExportImage'))
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
      if (!result.xml) throw new Error(t('studio.noExportDiagram'))
      const file = await window.electronAPI.exportStudioVisio(result.xml)
      download(`data:application/vnd.ms-visio.drawing.main+xml;base64,${file.base64}`, 'tokenbird-mindmap.vsdx')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  async function generate(retryInstruction?: string) {
    const instruction = (retryInstruction ?? prompt).trim()
    if (!ready || !connectionSlug || !model.trim() || !instruction) { setError(t('studio.diagramRequestRequired')); return }
    if (busy) return
    const previous = messagesRef.current
    const retry = !!retryInstruction && previous.at(-1)?.failed && previous.at(-2)?.role === 'user' && previous.at(-2)?.content === instruction
    const conversation = retry ? previous.slice(0, -2) : previous
    const history = conversation.filter(message => !message.failed).slice(-16).map(message => ({ role: message.role, text: message.content }))
    const userMessage: MindMapMessage = { id: crypto.randomUUID(), role: 'user', content: instruction, createdAt: Date.now() }
    setMessages([...conversation, userMessage].slice(-100))
    setPrompt('')
    setBusy(true); setError('')
    try {
      const latest = await requestExport('xml')
      const beforeXml = latest.xml || xmlRef.current
      if (!beforeXml) throw new Error(t('studio.diagramReadFailed'))
      xmlRef.current = beforeXml
      const workspaceContext = session.workspaceDir
        ? await window.electronAPI.getStudioMindMapWorkspaceContext(session.workspaceDir) : undefined
      const result = await window.electronAPI.generateStudioMindMap({
        connectionSlug, model: model.trim(), channelGroup: modelChannelGroup || undefined,
        prompt: instruction, currentXml: beforeXml, workspaceContext, history, thinkingLevel, mode,
      })
      if (result.mode === 'ask') {
        setMessages(current => [...current, { id: crypto.randomUUID(), role: 'assistant' as const, content: result.summary, createdAt: Date.now() }].slice(-100))
        return
      }
      validateDrawioDocument(result.xml)
      load(result.xml)
      setMessages(current => [...current, { id: crypto.randomUUID(), role: 'assistant' as const, content: result.summary, createdAt: Date.now(), beforeXml }].slice(-100))
      suggestTitle(instruction.slice(0, 40))
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      rechargeOnInsufficientBalance(cause, connection)
      setError(message)
      setPrompt(instruction)
      setMessages(current => [...current, { id: crypto.randomUUID(), role: 'assistant' as const, content: t('studio.diagramEditFailed', { value1: message }), createdAt: Date.now(), failed: true }].slice(-100))
    }
    finally { setBusy(false) }
  }

  return (
    <div data-studio-editor="mindmap" className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-12 flex-wrap items-center gap-1.5 border-b border-border/70 bg-background px-3 py-2 text-xs">
        <strong className="mr-2 flex items-center gap-2 text-sm"><Sparkles className="size-4 text-primary" />{t('studio.mindMap')}</strong>
        <span className="max-w-[38vw] truncate text-xs text-muted-foreground" title={session.workspaceDir || t('studio.legacyNoDirectory')}>{t('studio.currentDirectoryLabel', { directory: session.workspaceDir || t('studio.notSet') })}</span>
        {!session.workspaceDir && <button className="rounded-md px-2 py-1 text-xs text-primary hover:bg-accent" title={t('studio.bindDirectoryHint')} onClick={() => void bindWorkDirectory()}>{t('studio.setWorkingDirectory')}</button>}
        <button className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => void createSession()}>{t('studio.new')}</button>
        <button className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => fileRef.current?.click()}><FileUp className="size-3.5" />{t('studio.import')}</button>
        <input ref={fileRef} hidden type="file" accept=".drawio,.xml,text/xml" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; try { const xml = await file.text(); validateDrawioDocument(xml, true); load(xml); setError('') } catch (cause) { setError(String(cause)) } event.target.value = '' }} />
        <span className="mx-1 h-4 w-px bg-border" />
        <button disabled={!ready} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={() => void exportFile('xml')}><Download className="size-3.5" />draw.io</button>
        <button disabled={!ready} className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={() => void exportFile('png')}>PNG</button>
        <button disabled={!ready} className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={() => void exportPdf()}>PDF</button>
        <button disabled={!ready} className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40" onClick={() => void exportVisio()}>Visio</button>
        <button className="ml-auto flex items-center gap-1.5 rounded-md border border-border/70 px-2.5 py-1.5 text-foreground hover:bg-accent" title={chatOpen ? t('studio.hideEditHistory') : t('studio.showEditHistory')} aria-label={chatOpen ? t('studio.hideEditHistory') : t('studio.showEditHistory')} onClick={() => setChatOpen(open => !open)}>{chatOpen ? <PanelRightClose className="size-3.5" /> : <PanelRightOpen className="size-3.5" />}{chatOpen ? t('studio.hideAi') : t('studio.aiEdit')}</button>
      </div>
      <div className="relative flex min-h-0 flex-1">
        <iframe key={`${frameDark ? 'dark' : 'light'}-${frameLanguage}`} aria-busy={!ready} ref={frameRef} title={t('studio.mindMapEditor')} src={frameUrl} className="min-h-0 min-w-0 flex-1 border-0 bg-background" />
        {chatOpen && <aside className="flex w-[min(420px,40vw)] min-w-[300px] shrink-0 flex-col border-l border-border/70 bg-background max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-20 max-md:w-[min(420px,100vw)] max-md:shadow-strong">
          <header className="shrink-0 border-b border-border/70 px-4 py-3">
            <div className="flex items-center gap-2"><MessageCircle className="size-4 text-primary" /><h2 className="text-sm font-semibold">{t('studio.mindMapAssistant')}</h2><span className="ml-auto text-[11px] text-muted-foreground">{messages.length ? t('studio.messageCount', { count: messages.length }) : t('studio.newConversation')}</span><button type="button" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title={t('studio.hideConversation')} aria-label={t('studio.hideConversation')} onClick={() => setChatOpen(false)}><PanelRightClose className="size-4" /></button></div>
            <p className="mt-1 truncate text-[11px] text-muted-foreground" title={session.title}>{t('studio.currentDiagramLabel', { title: session.title })}</p>
            <div className="mt-3"><StudioConnectionPicker connections={connections} connectionSlug={connectionSlug} setConnectionSlug={setConnectionSlug} model={model} setModel={setModel} /></div>
            {connection?.oauthProvider === 'tokennest' && !connection.isAuthenticated && <button className="mt-2 text-xs text-primary underline" onClick={() => void loginTokenNest().catch(cause => setError(String(cause)))}>{t('studio.signInTokenNest')}</button>}
          </header>
          <div ref={transcriptRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5" role="log" aria-label={t('studio.mindMapConversation')} aria-live="polite">
            {messages.length === 0 && <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Sparkles className="size-6" /></div>
              <h3 className="text-sm font-medium">{t('studio.organizeWithAi')}</h3>
              <p className="mt-2 max-w-[280px] text-xs leading-5 text-muted-foreground">{t('studio.mindMapChatHint')}</p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">{[t('studio.productMapExample'), t('studio.timelineMapExample')].map(example => <button key={example} type="button" className="rounded-lg border border-border px-3 py-2 text-left text-xs hover:bg-accent" onClick={() => { setPrompt(example); inputRef.current?.focus() }}>{example}</button>)}</div>
            </div>}
            {messages.map((message, index) => <article key={message.id} className={message.role === 'user' ? 'ml-5 rounded-2xl rounded-tr-md bg-muted/60 px-3.5 py-3' : ''}>
              <div className="mb-2 flex items-center gap-2 text-muted-foreground">
                {message.role === 'assistant' && <span className="flex size-5 items-center justify-center rounded-md bg-primary/10 text-primary" aria-label={t('studio.assistantReply')}><Sparkles className="size-3" /></span>}
                <button type="button" className="ml-auto rounded p-1 hover:bg-accent hover:text-foreground" title={t('studio.copyMessage')} aria-label={t('studio.copyMessage')} onClick={() => void navigator.clipboard.writeText(message.content)}><Clipboard className="size-3" /></button>
              </div>
              {message.role === 'assistant' ? <Markdown className={`break-words text-xs leading-5 ${message.failed ? 'text-destructive' : ''}`}>{message.content}</Markdown> : <div className="whitespace-pre-wrap break-words text-xs leading-5">{message.content}</div>}
              {message.role === 'assistant' && message.beforeXml && <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3">
                <div className="flex items-center gap-2 text-xs font-medium"><Sparkles className="size-3.5 text-primary" />{t('studio.diagramApplied')}</div>
                <button type="button" disabled={busy || !ready} className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs hover:bg-accent disabled:opacity-40" onClick={() => { load(message.beforeXml!); setError('') }}><RotateCcw className="size-3.5" />{t('studio.restoreBeforeEdit')}</button>
              </div>}
              {message.failed && index === messages.length - 1 && messages[index - 1]?.role === 'user' && <button type="button" disabled={busy || !ready} className="mt-2 flex items-center gap-1 text-xs text-primary underline disabled:opacity-40" onClick={() => void generate(messages[index - 1].content)}><RotateCcw className="size-3" />{t('studio.retry')}</button>}
            </article>)}
            {busy && <div className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin" />{t('studio.editingDiagram')}</div>}
            {error && !messages.at(-1)?.failed && <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">{error}</div>}
          </div>
          <div className="shrink-0 border-t border-border/70 bg-background p-3">
            <div className="rounded-xl border border-border bg-muted/20 focus-within:border-primary/50">
              <textarea ref={inputRef} className="min-h-24 max-h-56 w-full resize-y bg-transparent px-3 pt-3 text-xs leading-5 outline-none placeholder:text-muted-foreground" aria-label={t('studio.diagramInstructions')} placeholder={t('studio.diagramPrompt')} maxLength={4000} value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void generate() } }} />
              <div className="flex items-center gap-2 px-2 pb-2"><StudioExecutionModePicker value={mode} onChange={setMode} /><StudioThinkingPicker value={thinkingLevel} onChange={setThinkingLevel} /><span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground">{ready ? t('studio.attachedDiagram') : t('studio.loadingEditor')}</span><button type="button" disabled={busy || !ready || !prompt.trim()} className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40" aria-label={t('studio.sendMessage')} onClick={() => void generate()}>{busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</button></div>
            </div>
          </div>
        </aside>}
      </div>
    </div>
  )
}
