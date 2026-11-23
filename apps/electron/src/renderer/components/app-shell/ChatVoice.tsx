import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { LoaderCircle, Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@tokenbird/ui'
import type { Message } from '../../../shared/types'
import { findVoiceReply, latestVoiceRequest, playVoice, transcribeRecording } from './voice-audio'

type Props = {
  controlsRef: Ref<{ read: (text: string) => void; stop: () => void }>
  slug?: string
  messages: Message[]
  canSend: boolean
  focused: boolean
  canDictate: boolean
  append: (text: string) => void
  send: (text: string) => void
  children: (controls: { microphone?: ReactNode; conversation?: ReactNode }) => ReactNode
}

export function ChatVoice(props: Props) {
  const { t } = useTranslation()
  const latest = useRef(props)
  useLayoutEffect(() => { latest.current = props })
  const [phase, setPhase] = useState<'idle' | 'opening' | 'recording' | 'transcribing'>('idle')
  const [conversation, setConversation] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const enabled = useRef(false)
  const baseline = useRef<string | undefined>(undefined)
  const spoken = useRef<string | undefined>(undefined)
  const recording = useRef<AbortController | null>(null)
  const playback = useRef<AbortController | null>(null)
  const player = useRef<AudioContext | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const userId = latestVoiceRequest(props.messages)
  const observedUser = useRef(userId)

  function stopReading() {
    playback.current?.abort()
    playback.current = null
    setReading(false)
  }

  useLayoutEffect(() => () => {
    recording.current?.abort()
    playback.current?.abort()
    const context = player.current
    player.current = null
    if (context) void context.close().catch(() => undefined)
  }, [])

  async function read(text: string) {
    playback.current?.abort()
    const controller = new AbortController()
    const { signal } = controller
    playback.current = controller
    setError('')
    setReading(true)
    try {
      const context = player.current ??= new AudioContext()
      await context.resume()
      await playVoice(text, context, latest.current.slug, signal)
    } catch (cause) {
      if (!signal.aborted) {
        controller.abort()
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (playback.current === controller) {
        playback.current = null
        setReading(false)
      }
    }
  }

  useImperativeHandle(props.controlsRef, () => ({
    read,
    stop() {
      baseline.current = userId
      stopReading()
    },
  }))

  function toggleConversation(on: boolean) {
    enabled.current = on
    baseline.current = userId
    spoken.current = undefined
    setConversation(on)
    setError('')
    if (!on) {
      stopReading()
      return
    }
    // Unlock audio on the user's gesture, before the asynchronous reply arrives.
    try {
      const context = player.current ??= new AudioContext()
      void context.resume().catch(() => undefined)
    } catch { /* Playback reports an unavailable audio device when it is used. */ }
  }

  const reply = conversation && userId !== baseline.current ? findVoiceReply(props.messages, userId) : undefined
  useEffect(() => {
    if (!props.focused) {
      baseline.current = userId
      stopReading()
      return
    }
    if (observedUser.current !== userId) {
      observedUser.current = userId
      stopReading()
    }
    if (!enabled.current || !reply || spoken.current === reply.id || recording.current) return
    spoken.current = reply.id
    void read(reply.content)
    // Playback only follows a new confirmed reply, not unrelated composer renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, reply, props.focused])

  function cancelRecording() {
    recording.current?.abort()
    recording.current = null
    recorder.current = null
    setPhase('idle')
  }

  async function record() {
    if (recording.current) return
    stopReading()
    baseline.current = userId
    setError('')
    const controller = new AbortController()
    const { signal } = controller
    recording.current = controller
    setPhase('opening')
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error(t('voice.unavailable'))
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } })
      const release = () => stream.getTracks().forEach(track => track.stop())
      if (signal.aborted) { release(); return }
      signal.addEventListener('abort', release, { once: true })
      const mic = new MediaRecorder(stream)
      recorder.current = mic
      const parts: Blob[] = []
      let limit: number | undefined
      mic.ondataavailable = event => parts.push(event.data)
      mic.onerror = () => {
        setError(t('voice.unavailable'))
        cancelRecording()
      }
      mic.onstop = async () => {
        clearTimeout(limit)
        release()
        if (signal.aborted) return
        setPhase('transcribing')
        try {
          const text = (await transcribeRecording(new Blob(parts, { type: mic.mimeType }), latest.current.slug, signal)).trim()
          signal.throwIfAborted()
          if (!text) throw new Error(t('voice.empty'))
          if (enabled.current && latest.current.focused && latest.current.canSend) latest.current.send(text)
          else latest.current.append(text)
        } catch (cause) {
          if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (!signal.aborted) cancelRecording()
        }
      }
      mic.start()
      limit = window.setTimeout(() => { if (mic.state === 'recording') mic.stop() }, 115_000)
      signal.addEventListener('abort', () => {
        clearTimeout(limit)
        if (mic.state === 'recording') mic.stop()
      }, { once: true })
      setPhase('recording')
    } catch (cause) {
      if (!signal.aborted) {
        setError(cause instanceof Error ? cause.message : String(cause))
        cancelRecording()
      }
    }
  }

  const available = typeof window.electronAPI?.tokenNestVoice === 'function'
  const microphoneLabel = t(phase === 'recording' ? 'voice.finish' : phase === 'idle' ? 'voice.dictate' : `voice.${phase}`)
  const microphone = available && (props.canDictate || phase !== 'idle') ? <div className="ml-1 inline-flex shrink-0 items-center gap-0.5">
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-7"
          aria-label={microphoneLabel} disabled={phase === 'opening' || phase === 'transcribing'}
          onClick={() => phase === 'recording' ? recorder.current?.stop() : void record()}>
          {phase === 'recording' ? <Square className="size-3 fill-current text-destructive" />
            : phase === 'idle' ? <Mic className="size-4" /> : <LoaderCircle className="size-4 animate-spin" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{microphoneLabel}</TooltipContent>
    </Tooltip>
    {phase !== 'idle' && <Button type="button" variant="ghost" size="sm" className="h-7 px-1.5"
      onClick={cancelRecording}>{t('common.cancel')}</Button>}
  </div> : undefined
  return <>
    {props.children({
      microphone,
      conversation: available ? <label className="flex h-9 shrink-0 items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <span className="whitespace-nowrap">{t('voice.talk')}</span>
        <Switch checked={conversation} onCheckedChange={toggleConversation} />
      </label> : undefined,
    })}
    {reading && <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground" aria-live="polite">
      {t('voice.reading')}
      <Button type="button" variant="ghost" size="sm" className="h-6 px-1.5" onClick={stopReading}>{t('common.cancel')}</Button>
    </div>}
    {error && <p role="alert" className="text-center text-xs text-destructive">{error}</p>}
  </>
}
