import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initReactI18next, useTranslation } from 'react-i18next'
import { setupI18n, i18n } from '@craft-agent/shared/i18n'
import { getLocalizedProductName } from '@craft-agent/shared/branding'
import type { BirdCompanionState, BirdWindowRole } from '../shared/bird-companion'
import { BirdAvatar } from './components/bird/BirdAvatar'
import './components/bird/bird-companion.css'

declare global {
  interface Window {
    birdCompanion: {
      role: BirdWindowRole
      onState(callback: (state: BirdCompanionState) => void): () => void
      ready(): Promise<void>
      getState(): Promise<BirdCompanionState>
      dismissBubble(): Promise<void>
      showBubble(): Promise<void>
      resizeBubble(height: number): Promise<void>
      interactive(value: boolean): Promise<void>
      move(x: number, y: number): Promise<void>
    }
  }
}

setupI18n([initReactI18next])

function BirdCompanion({ initialState }: { initialState: BirdCompanionState }) {
  const { t } = useTranslation()
  const [state, setState] = useState(initialState)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const bubbleRef = useRef<HTMLElement>(null)
  const role = window.birdCompanion.role
  useEffect(() => {
    const off = window.birdCompanion.onState(next => {
      if (next.language && i18n.language !== next.language) void i18n.changeLanguage(next.language)
      setState(next)
      document.documentElement.lang = next.language || 'en'
    })
    void window.birdCompanion.ready()
    return off
  }, [])
  useEffect(() => {
    const element = bubbleRef.current
    if (role !== 'bubble' || !element) return
    const resize = () => { void window.birdCompanion.resizeBubble(element.offsetHeight + 36) }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [role])
  const product = getLocalizedProductName(i18n.resolvedLanguage || i18n.language)
  return (
    <main className={`bird-companion bird-companion--${state.mood} bird-companion--${role}`}>
      {role === 'bubble' && <section ref={bubbleRef} className="bird-bubble" role="status" aria-live="polite"
        onPointerEnter={() => { void window.birdCompanion.interactive(true) }}
        onPointerLeave={() => { if (!drag.current) void window.birdCompanion.interactive(false) }}>
        <header className="bird-bubble-header">
          <span className="bird-status-dot" />
          <span>{product}</span>
          <button type="button" className="bird-dismiss" aria-label={t('birdCompanion.dismiss')} title={t('birdCompanion.dismiss')}
            onClick={() => { void window.birdCompanion.dismissBubble() }}>×</button>
        </header>
        <p className="bird-message">{t(`birdCompanion.activity.${state.activity}`, { product })}</p>
        <footer className="bird-bubble-footer">
          <span>{state.mood === 'idle' ? t('birdCompanion.dragHint') : t('birdCompanion.steps', { count: state.completedSteps })}</span>
          {state.activeSessions > 1 && <span>{t('birdCompanion.sessions', { count: state.activeSessions })}</span>}
        </footer>
      </section>}
      {role === 'bird' && <><button type="button" className="bird-character" aria-label={t('birdCompanion.characterLabel')}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return }
          void window.birdCompanion.showBubble()
        }}
        onPointerEnter={() => { void window.birdCompanion.interactive(true) }}
        onPointerLeave={() => { if (!drag.current) void window.birdCompanion.interactive(false) }}
        onPointerDown={event => {
          if (event.button !== 0) return
          suppressClick.current = false
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = { x: event.screenX, y: event.screenY, moved: false }
        }}
        onPointerMove={event => {
          const current = drag.current
          if (!current) return
          const dx = event.screenX - current.x
          const dy = event.screenY - current.y
          if (!current.moved && Math.abs(dx) + Math.abs(dy) < 4) return
          current.moved = true
          current.x = event.screenX
          current.y = event.screenY
          void window.birdCompanion.move(dx, dy)
        }}
        onPointerUp={event => {
          const moved = drag.current?.moved
          suppressClick.current = !!moved
          drag.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
          void window.birdCompanion.interactive(event.currentTarget.matches(':hover'))
        }}
        onPointerCancel={() => { drag.current = null; void window.birdCompanion.interactive(false) }}>
        <BirdAvatar mood={state.mood === 'idle' && state.activity === 'greeting' ? 'success' : state.mood} />
      </button>
      <div className="bird-ground-shadow" /></>}
    </main>
  )
}

async function startCompanion() {
  const initialState = await window.birdCompanion.getState()
  if (initialState.language) await i18n.changeLanguage(initialState.language)
  document.documentElement.lang = initialState.language || 'en'
  createRoot(document.getElementById('root')!).render(<BirdCompanion initialState={initialState} />)
}
void startCompanion().catch(error => console.error('[bird-companion] Startup failed:', error))
