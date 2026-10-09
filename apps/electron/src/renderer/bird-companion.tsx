import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initReactI18next, useTranslation } from 'react-i18next'
import { setupI18n, i18n } from '@craft-agent/shared/i18n'
import { getLocalizedProductName } from '@craft-agent/shared/branding'
import type { BirdCompanionState } from '../shared/bird-companion'
import { BirdAvatar } from './components/bird/BirdAvatar'
import './components/bird/bird-companion.css'

declare global {
  interface Window {
    birdCompanion: {
      onState(callback: (state: BirdCompanionState) => void): () => void
      ready(): Promise<void>
      getState(): Promise<BirdCompanionState>
      dismiss(): Promise<void>
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
  const [greeting, setGreeting] = useState(false)
  const greetingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const off = window.birdCompanion.onState(next => {
      if (next.language && i18n.language !== next.language) void i18n.changeLanguage(next.language)
      setState(next)
      document.documentElement.lang = next.language || 'en'
    })
    void window.birdCompanion.ready()
    return () => { off(); if (greetingTimer.current) clearTimeout(greetingTimer.current) }
  }, [])
  const product = getLocalizedProductName(i18n.resolvedLanguage || i18n.language)
  return (
    <main className={`bird-companion bird-companion--${state.mood}`}>
      <section className="bird-bubble" role="status" aria-live="polite"
        onPointerEnter={() => { void window.birdCompanion.interactive(true) }}
        onPointerLeave={() => { if (!drag.current) void window.birdCompanion.interactive(false) }}>
        <header className="bird-bubble-header">
          <span className="bird-status-dot" />
          <span>{product}</span>
          <button type="button" className="bird-dismiss" aria-label={t('birdCompanion.dismiss')} title={t('birdCompanion.dismiss')}
            onClick={() => { void window.birdCompanion.dismiss() }}>×</button>
        </header>
        <p className="bird-message">{t(`birdCompanion.activity.${greeting && state.mood === 'idle' ? 'greeting' : state.activity}`, { product })}</p>
        <footer className="bird-bubble-footer">
          <span>{state.mood === 'idle' ? t('birdCompanion.dragHint') : t('birdCompanion.steps', { count: state.completedSteps })}</span>
          {state.activeSessions > 1 && <span>{t('birdCompanion.sessions', { count: state.activeSessions })}</span>}
        </footer>
      </section>
      <button type="button" className="bird-character" aria-label={t('birdCompanion.characterLabel')}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return }
          if (state.mood !== 'idle') return
          setGreeting(true)
          if (greetingTimer.current) clearTimeout(greetingTimer.current)
          greetingTimer.current = setTimeout(() => setGreeting(false), 3500)
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
        <BirdAvatar mood={greeting && state.mood === 'idle' ? 'success' : state.mood} />
      </button>
      <div className="bird-ground-shadow" />
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
