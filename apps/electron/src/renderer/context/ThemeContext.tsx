import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import * as storage from '@/lib/local-storage'
import {
  resolveTheme,
  themeToCSS,
  DEFAULT_THEME,
  DEFAULT_SHIKI_THEME,
  getShikiTheme,
  type ThemeOverrides,
  type ThemeFile,
  type ShikiThemeConfig,
} from '@config/theme'
import {
  DEFAULT_THEME_PACK_STYLE,
} from '@config/theme-pack-style'
import type {
  ThemePack,
  ThemePackAsset,
} from '@config/theme-pack'

export type ThemeMode = 'light' | 'dark' | 'system'
export type FontFamily = 'inter' | 'system'

interface ThemeContextType {
  // Preferences (persisted at app level)
  mode: ThemeMode
  /** App-level default color theme (used when workspace has no override) */
  colorTheme: string
  font: FontFamily
  setMode: (mode: ThemeMode) => void
  /** Set app-level default color theme */
  setColorTheme: (theme: string) => void
  setFont: (font: FontFamily) => void
  /** Opacity of the chat panel background (0 = transparent, 1 = opaque). */
  chatOpacity: number
  setChatOpacity: (opacity: number) => void

  // Workspace-level theme override
  /** Active workspace ID (null if no workspace context) */
  activeWorkspaceId: string | null
  /** Workspace-specific color theme override (null = inherit from app default) */
  workspaceColorTheme: string | null
  /** Set workspace-specific color theme override (null = inherit) */
  setWorkspaceColorTheme: (theme: string | null) => void

  // Derived/computed
  resolvedMode: 'light' | 'dark'
  systemPreference: 'light' | 'dark'
  /** Effective color theme for rendering (previewColorTheme ?? workspaceColorTheme ?? colorTheme) */
  effectiveColorTheme: string
  /** Temporary preview theme (hover state) - not persisted */
  previewColorTheme: string | null
  /** Set temporary preview theme for hover preview. Pass null to clear. */
  setPreviewColorTheme: (theme: string | null) => void
  /** Where effectiveColorTheme came from for current render cycle */
  effectiveColorThemeSource: 'preview' | 'workspace' | 'app'
  /** How the preset theme was resolved */
  themeResolvedFrom: 'none' | 'ipc' | 'fallback'
  /** Non-fatal theme loading error. Null when theme loaded normally. */
  themeLoadError: string | null

  // Theme resolution (singleton - loaded once)
  /** Loaded preset theme file, null if default or loading */
  presetTheme: ThemeFile | null
  /** Fully resolved theme (preset merged with any overrides) */
  resolvedTheme: ThemeOverrides
  /** Whether dark mode is active (scenic themes force dark) */
  isDark: boolean
  /** Whether theme is scenic mode (background image with glass panels) */
  isScenic: boolean
  /** Shiki syntax highlighting theme name for current mode */
  shikiTheme: string
  /** Shiki theme configuration (light/dark variants) */
  shikiConfig: ShikiThemeConfig

  // Theme packs (background + chat/sidebar textures + style JSON; dsh skin.json compatible)
  /** All installed theme packs */
  themePacks: ThemePack[]
  /** Currently selected theme pack id (null = no pack) */
  themePackId: string | null
  /** The active pack's manifest */
  activeThemePack: ThemePack | null
  /** Display name of the active pack */
  themePackName: string | null
  /** Reload installed pack list */
  refreshThemePacks: () => void
  /** Select a theme pack (null disables) */
  setThemePack: (packId: string | null) => void
  /** Import a pack/skin folder via native dialog */
  importThemePack: () => Promise<ThemePack | null>
  /** Delete an installed pack */
  deleteThemePack: (packId: string) => Promise<boolean>
  /** Explicit opt-in for compatibility scripts from imported theme packs. */
  themePackScriptsEnabled: boolean
  setThemePackScriptsEnabled: (enabled: boolean) => void
}

interface StoredTheme {
  mode: ThemeMode
  colorTheme: string
  font?: FontFamily
  /** True when user explicitly changed theme in UI (not auto-saved on startup) */
  isUserOverride?: boolean
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

const bundledThemeModules = import.meta.glob('../../../resources/themes/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, ThemeFile>

const BUNDLED_THEMES = new Map<string, ThemeFile>(
  Object.entries(bundledThemeModules).map(([path, theme]) => {
    const fileName = path.split('/').pop() ?? ''
    const id = fileName.replace('.json', '')
    return [id, theme]
  })
)

function decodeAssetDataUrl(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) return null

  const meta = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  try {
    if (meta.includes(';base64')) {
      const binary = atob(payload)
      const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    }
    return decodeURIComponent(payload)
  } catch {
    return null
  }
}

/**
 * Execute a Harness client bundle against a deliberately tiny DOM facade.
 * Scripts can add/remove style and link elements, set body data attributes and
 * update the title, but receive no Electron bridge, network, storage, or real
 * window/document object. This is opt-in because third-party JS is still code.
 */
function runThemeCompatibilityScript(source: string): () => void {
  const cleanups: Array<() => void> = []
  const unwrap = (value: any) => value?.__craftThemeElement ?? value
  const wrapElement = (real: HTMLElement) => {
    const dataset = real.dataset
    return {
      __craftThemeElement: real,
      dataset,
      get textContent() { return real.textContent ?? '' },
      set textContent(value: string) { real.textContent = value },
      get rel() { return real.getAttribute('rel') ?? '' },
      set rel(value: string) { real.setAttribute('rel', value) },
      get href() { return real.getAttribute('href') ?? '' },
      set href(value: string) { real.setAttribute('href', value) },
      setAttribute: (name: string, value: string) => real.setAttribute(name, value),
      remove: () => real.remove(),
    }
  }
  const append = (parent: HTMLElement) => (...children: any[]) => children.forEach(child => parent.appendChild(unwrap(child)))
  const body = wrapElement(document.body)
  const head = { append: append(document.head), appendChild: (child: any) => document.head.appendChild(unwrap(child)) }
  const fakeDocument: any = {
    body,
    head,
    get title() { return document.title },
    set title(value: string) { document.title = String(value) },
    createElement: (tag: string) => wrapElement(document.createElement(tag)),
    querySelector: (selector: string) => {
      const result = document.querySelector(selector)
      return result instanceof HTMLElement ? wrapElement(result) : null
    },
  }
  const fakeWindow: any = { __ModuleLoader__: null, document: fakeDocument }
  fakeWindow.__ModuleLoader__ = {
    load: (definition: any) => {
      if (!definition || typeof definition.factory !== 'function') return
      const exports = definition.factory(() => { throw new Error('Theme script imports are disabled') }) ?? {}
      if (typeof exports.apply !== 'function') return
      const ctx = {
        effect: (effect: unknown) => {
          if (typeof effect !== 'function') return
          try {
            // Harness/Cordis uses effect(() => cleanup, description), while a
            // few packs provide the cleanup directly. Support both forms.
            const result = (effect as () => unknown)()
            if (typeof result === 'function') cleanups.push(result as () => void)
          } catch { /* ignore an unsupported effect */ }
        },
      }
      try { exports.apply(ctx) } catch { /* a decorative script must never break the app */ }
    },
  }
  const blocked = undefined
  try {
    const execute = new Function('window', 'document', 'fetch', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'indexedDB', 'require', 'process', 'globalThis', `'use strict';\n${source}`)
    execute(fakeWindow, fakeDocument, blocked, blocked, blocked, blocked, blocked, blocked, blocked, blocked)
  } catch {
    // Keep CSS/asset compatibility even when a package uses unsupported JS.
  }
  return () => { for (const cleanup of cleanups.reverse()) { try { cleanup() } catch { /* ignore cleanup */ } } }
}

interface ThemeProviderProps {
  children: ReactNode
  defaultMode?: ThemeMode
  defaultColorTheme?: string
  defaultFont?: FontFamily
  /** Active workspace ID for workspace-level theme overrides */
  activeWorkspaceId?: string | null
}

function getSystemPreference(): 'light' | 'dark' {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  return 'light'
}

function loadStoredTheme(): StoredTheme | null {
  if (typeof window === 'undefined') return null
  return storage.get<StoredTheme | null>(storage.KEYS.theme, null)
}

function saveTheme(theme: StoredTheme): void {
  storage.set(storage.KEYS.theme, theme)
}

export function ThemeProvider({
  children,
  defaultMode = 'system',
  defaultColorTheme = 'default',
  defaultFont = 'system',
  activeWorkspaceId = null
}: ThemeProviderProps) {
  const stored = loadStoredTheme()

  // === Preference state (persisted at app level) ===
  const [mode, setModeState] = useState<ThemeMode>(stored?.mode ?? defaultMode)
  // Only use localStorage colorTheme if user explicitly set it via UI
  const [colorTheme, setColorThemeState] = useState<string>(() => {
    if (stored?.isUserOverride && stored.colorTheme) {
      return stored.colorTheme
    }
    return defaultColorTheme // Will be updated by config.json effect
  })
  const [font, setFontState] = useState<FontFamily>(stored?.font ?? defaultFont)
  const [chatOpacity, setChatOpacityState] = useState(() => {
    const value = storage.get<number>(storage.KEYS.chatOpacity, 1)
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1
  })
  const [systemPreference, setSystemPreference] = useState<'light' | 'dark'>(getSystemPreference)
  const [previewColorTheme, setPreviewColorTheme] = useState<string | null>(null)

  // === Workspace-level theme override ===
  const [workspaceColorTheme, setWorkspaceColorThemeState] = useState<string | null>(null)

  // Track if we're receiving an external update to prevent echo broadcasts
  const isExternalUpdate = useRef(false)

  // Load app-level colorTheme from config.json on mount (only if user hasn't overridden)
  useEffect(() => {
    // Skip if user has explicitly set a theme via UI
    if (stored?.isUserOverride) return

    window.electronAPI?.getColorTheme?.().then((configTheme) => {
      if (configTheme && configTheme !== 'default') {
        setColorThemeState(configTheme)
      }
    }).catch(() => {
      // Keep default on error
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only run on mount

  // === Preset theme state (singleton) ===
  const [presetTheme, setPresetTheme] = useState<ThemeFile | null>(null)
  const [themeResolvedFrom, setThemeResolvedFrom] = useState<'none' | 'ipc' | 'fallback'>('none')
  const [themeLoadError, setThemeLoadError] = useState<string | null>(null)

  // === Theme pack state ===
  const [themePacks, setThemePacks] = useState<ThemePack[]>([])
  const [themePackId, setThemePackId] = useState<string | null>(null)
  const [activeThemePack, setActiveThemePack] = useState<ThemePack | null>(null)
  const [themePackScriptsEnabled, setThemePackScriptsEnabledState] = useState(() =>
    storage.get(storage.KEYS.themePackScripts, false)
  )
  const [packAssets, setPackAssets] = useState<{
    background: ThemePackAsset | null
    chat: ThemePackAsset | null
    sidebar: ThemePackAsset | null
    characters: { left: ThemePackAsset | null; right: ThemePackAsset | null }
  }>({ background: null, chat: null, sidebar: null, characters: { left: null, right: null } })

  // === Derived values ===
  const resolvedMode = mode === 'system' ? systemPreference : mode
  // Effective theme: preview > workspace override > app default
  const effectiveColorTheme = previewColorTheme ?? workspaceColorTheme ?? colorTheme
  const effectiveColorThemeSource: 'preview' | 'workspace' | 'app' =
    previewColorTheme !== null ? 'preview' : workspaceColorTheme !== null ? 'workspace' : 'app'
  const isDarkFromMode = resolvedMode === 'dark'

  // Load workspace theme override when workspace changes
  useEffect(() => {
    if (!activeWorkspaceId) {
      setWorkspaceColorThemeState(null)
      return
    }

    window.electronAPI?.getWorkspaceColorTheme?.(activeWorkspaceId).then((theme) => {
      setWorkspaceColorThemeState(theme)
    }).catch(() => {
      setWorkspaceColorThemeState(null)
    })
  }, [activeWorkspaceId])

  // Load preset theme when effectiveColorTheme changes (SINGLETON - only here, not in useTheme)
  useEffect(() => {
    let cancelled = false

    const applyFallback = (reason: string) => {
      const fallbackTheme = BUNDLED_THEMES.get(effectiveColorTheme)
      if (fallbackTheme) {
        if (!cancelled) {
          setPresetTheme(fallbackTheme)
          setThemeResolvedFrom('fallback')
          setThemeLoadError(reason)
        }
        console.warn(`[ThemeContext] ${reason} Falling back to bundled theme: ${effectiveColorTheme}`)
        return
      }

      if (!cancelled) {
        setPresetTheme(null)
        setThemeResolvedFrom('none')
        setThemeLoadError(reason)
      }
      console.error(`[ThemeContext] ${reason} No bundled fallback found for: ${effectiveColorTheme}`)
    }

    if (!effectiveColorTheme || effectiveColorTheme === 'default') {
      setPresetTheme(null)
      setThemeResolvedFrom('none')
      setThemeLoadError(null)
      return () => {
        cancelled = true
      }
    }

    // Load preset theme via IPC (app-level), then fallback to bundled themes.
    // In playground/browser mode electronAPI may exist without loadPresetTheme.
    const loadPresetTheme = window.electronAPI?.loadPresetTheme
    if (!loadPresetTheme) {
      applyFallback(`electronAPI.loadPresetTheme is unavailable for "${effectiveColorTheme}".`)
      return () => {
        cancelled = true
      }
    }

    loadPresetTheme(effectiveColorTheme).then((preset) => {
      if (cancelled) return

      if (preset?.theme) {
        setPresetTheme(preset.theme)
        setThemeResolvedFrom('ipc')
        setThemeLoadError(null)
        return
      }

      applyFallback(`Preset theme was not returned by IPC for "${effectiveColorTheme}".`)
    }).catch((error) => {
      applyFallback(`Failed to load preset theme via IPC for "${effectiveColorTheme}": ${error instanceof Error ? error.message : String(error)}.`)
    })

    return () => {
      cancelled = true
    }
  }, [effectiveColorTheme])

  // Resolve theme (preset → pack colors win → final)
  const resolvedTheme = useMemo(() => {
    const packColors = activeThemePack?.manifest.colors
    const base = packColors ? { ...presetTheme, ...packColors } : presetTheme
    return resolveTheme(base ?? undefined)
  }, [presetTheme, activeThemePack])

  // Determine scenic mode (background image with glass panels).
  // A pack is scenic when it declares a background (light/dark pair or single image).
  const isScenic = useMemo(() => {
    if (activeThemePack) {
      return Boolean(
        activeThemePack.manifest.background?.light ||
        activeThemePack.manifest.background?.dark ||
        activeThemePack.manifest.backgroundImage
      )
    }
    return resolvedTheme.mode === 'scenic' && !!resolvedTheme.backgroundImage
  }, [resolvedTheme, activeThemePack])

  // Dark-only themes (e.g. Dracula) force dark mode regardless of system mode
  const isDarkOnlyTheme = presetTheme?.supportedModes?.length === 1 && presetTheme.supportedModes[0] === 'dark'

  // isDark reflects actual visual appearance: scenic, dark-only themes, or system dark mode
  const isDark = isScenic || isDarkOnlyTheme ? true : isDarkFromMode

  // Shiki theme configuration
  const shikiConfig = useMemo(() => {
    return presetTheme?.shikiTheme || DEFAULT_SHIKI_THEME
  }, [presetTheme])

  // Get current Shiki theme name based on mode
  const shikiTheme = useMemo(() => {
    const supportedModes = presetTheme?.supportedModes
    const currentMode = isDark ? 'dark' : 'light'

    // If theme has limited mode support and doesn't include current mode,
    // use the mode it does support for Shiki
    if (supportedModes && supportedModes.length > 0 && !supportedModes.includes(currentMode)) {
      const effectiveMode = supportedModes[0] === 'dark'
      return getShikiTheme(shikiConfig, effectiveMode)
    }

    return getShikiTheme(shikiConfig, isDark)
  }, [shikiConfig, isDark, presetTheme])

  // === DOM Effects (SINGLETON - all theme DOM manipulation happens here) ===

  // Apply base theme class and data attributes
  useEffect(() => {
    const root = document.documentElement

    // Apply font
    if (font === 'inter') {
      root.dataset.font = 'inter'
    } else {
      delete root.dataset.font
    }

    // Apply color theme data attribute
    if (effectiveColorTheme && effectiveColorTheme !== 'default') {
      root.dataset.theme = effectiveColorTheme
    } else {
      delete root.dataset.theme
    }

    // Always set theme override for semi-transparent background (vibrancy effect)
    root.dataset.themeOverride = 'true'
    root.style.setProperty('--craft-chat-panel-opacity', `${chatOpacity * 100}%`)
    root.style.setProperty('--craft-chat-bubble-opacity', `${chatOpacity * 100}%`)
    root.style.setProperty('--craft-chat-opacity-number', String(chatOpacity))
  }, [effectiveColorTheme, font, chatOpacity])

  // Apply declarative CSS shipped by Harness-compatible packs. The bundle is
  // parsed on the server as text; executable compatibility scripts are handled
  // separately below and remain opt-in.
  useEffect(() => {
    const pack = activeThemePack
    const body = document.body
    const candidateAttr = pack?.manifest.bodyAttr?.trim()
    const attr = candidateAttr && /^[A-Za-z_:][A-Za-z0-9_.:-]*$/.test(candidateAttr) ? candidateAttr : undefined
    const styleId = 'craft-theme-pack-css'
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null
    if (pack?.manifest.customCss) {
      if (!styleEl) {
        styleEl = document.createElement('style')
        styleEl.id = styleId
        document.head.appendChild(styleEl)
      }
      styleEl.textContent = pack.manifest.customCss
    } else if (styleEl) {
      styleEl.remove()
      styleEl = null
    }

    const hadPackAttr = attr ? body.hasAttribute(attr) : false
    if (attr) body.setAttribute(attr, '')
    const isDsh = pack?.source === 'dsh'
    const hadDarkAttr = body.hasAttribute('data-ds-dark-theme')
    if (isDsh) body.toggleAttribute('data-ds-dark-theme', isDark)

    return () => {
      if (attr && !hadPackAttr) body.removeAttribute(attr)
      if (isDsh && !hadDarkAttr) body.removeAttribute('data-ds-dark-theme')
      if (styleEl) styleEl.remove()
    }
  }, [activeThemePack, isDark])

  // Optional compatibility execution for Harness client bundles. The CSS and
  // extra assets are always loaded; this effect only runs when explicitly on.
  useEffect(() => {
    const pack = activeThemePack
    if (!pack || !themePackScriptsEnabled || !pack.manifest.scripts?.length) return
    let cancelled = false
    const disposers: Array<() => void> = []
    void (async () => {
      for (const scriptPath of pack.manifest.scripts ?? []) {
        const asset = await window.electronAPI?.getThemePackAsset?.(pack.id, scriptPath)
        if (cancelled || !asset?.dataUrl) continue
        const source = decodeAssetDataUrl(asset.dataUrl)
        if (!source) continue
        disposers.push(runThemeCompatibilityScript(source))
      }
    })()
    return () => {
      cancelled = true
      for (const dispose of disposers.reverse()) dispose()
    }
  }, [activeThemePack, themePackScriptsEnabled])

  // Apply dark/light class and theme-specific DOM attributes
  // This runs when preset loads or mode changes
  useEffect(() => {
    const root = document.documentElement

    // Check if this is a dark-only theme (forces dark mode)
    const isDarkOnlyTheme = presetTheme?.supportedModes?.length === 1 && presetTheme.supportedModes[0] === 'dark'

    // Apply mode class
    // Scenic and dark-only themes force dark mode
    const effectiveMode = (isScenic || isDarkOnlyTheme) ? 'dark' : resolvedMode
    root.classList.remove('light', 'dark')
    root.classList.add(effectiveMode)

    // Handle themeMismatch - set solid background when:
    // 1. Theme doesn't support current mode (e.g., dark-only Dracula in light mode), OR
    // 2. Resolved mode differs from system preference (vibrancy mismatch)
    const supportedModes = presetTheme?.supportedModes
    const currentMode = isDarkFromMode ? 'dark' : 'light'
    const themeModeUnsupported = supportedModes && supportedModes.length > 0 && !supportedModes.includes(currentMode)
    const vibrancyMismatch = resolvedMode !== systemPreference

    if (themeModeUnsupported || vibrancyMismatch) {
      root.dataset.themeMismatch = 'true'
    } else {
      delete root.dataset.themeMismatch
    }

    // Set scenic mode data attribute for CSS targeting
    if (isScenic) {
      root.dataset.scenic = 'true'
      const bgImage = packAssets.background?.dataUrl ?? resolvedTheme.backgroundImage
      if (bgImage) {
        root.style.setProperty('--background-image', `url("${bgImage}")`)
      }
    } else {
      delete root.dataset.scenic
      root.style.removeProperty('--background-image')
    }

    // Theme pack texture + style variables
    const style = { ...DEFAULT_THEME_PACK_STYLE, ...(activeThemePack?.manifest.style ?? {}) }
    const setPackVar = (name: string, value: string | undefined) => {
      if (value !== undefined && value !== '') root.style.setProperty(name, value)
      else root.style.removeProperty(name)
    }
    if (activeThemePack) {
      root.dataset.themePack = 'true'
      setPackVar('--theme-pack-chat-texture', packAssets.chat?.dataUrl ? `url("${packAssets.chat.dataUrl}")` : undefined)
      setPackVar('--theme-pack-sidebar-texture', packAssets.sidebar?.dataUrl ? `url("${packAssets.sidebar.dataUrl}")` : undefined)
      setPackVar('--theme-pack-chat-opacity', String(style.chatOpacity))
      setPackVar('--theme-pack-chat-blend', style.chatBlend)
      setPackVar('--theme-pack-sidebar-opacity', String(style.sidebarOpacity))
      setPackVar('--theme-pack-sidebar-blend', style.sidebarBlend)
      setPackVar('--theme-pack-texture-size', style.textureSize)
      setPackVar('--theme-pack-texture-position', style.texturePosition)
      setPackVar('--theme-pack-texture-repeat', style.textureRepeat)
      setPackVar('--theme-pack-chat-size', style.chatTextureSize)
      setPackVar('--theme-pack-chat-position', style.chatTexturePosition)
      setPackVar('--theme-pack-sidebar-size', style.sidebarTextureSize)
      setPackVar('--theme-pack-sidebar-position', style.sidebarTexturePosition)
      setPackVar('--theme-pack-char-height', style.characterHeight)
      setPackVar('--theme-pack-char-bottom', style.characterBottom)
      setPackVar('--theme-pack-char-opacity', String(style.characterOpacity))
      setPackVar('--theme-pack-radius', style.borderRadius)
      setPackVar('--theme-pack-blur', `${style.backgroundBlur}px`)
      setPackVar('--theme-pack-bg-size', style.backgroundSize)
      setPackVar('--theme-pack-bg-position', style.backgroundPosition)
    } else {
      delete root.dataset.themePack
      for (const name of [
        '--theme-pack-chat-texture', '--theme-pack-sidebar-texture',
        '--theme-pack-chat-opacity', '--theme-pack-chat-blend',
        '--theme-pack-sidebar-opacity', '--theme-pack-sidebar-blend',
        '--theme-pack-texture-size', '--theme-pack-texture-position',
        '--theme-pack-texture-repeat',
        '--theme-pack-chat-size', '--theme-pack-chat-position',
        '--theme-pack-sidebar-size', '--theme-pack-sidebar-position',
        '--theme-pack-char-height', '--theme-pack-char-bottom',
        '--theme-pack-char-opacity',
        '--theme-pack-radius', '--theme-pack-blur',
        '--theme-pack-bg-size', '--theme-pack-bg-position',
      ]) {
        root.style.removeProperty(name)
      }
    }

  }, [presetTheme, resolvedMode, systemPreference, isScenic, resolvedTheme, isDarkFromMode, activeThemePack, packAssets])

  // Inject CSS variables
  useEffect(() => {
    const styleId = 'craft-theme-overrides'
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null

    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = styleId
      document.head.appendChild(styleEl)
    }

    // When using default theme, clear custom CSS
    if (!effectiveColorTheme || effectiveColorTheme === 'default') {
      styleEl.textContent = ''
      return
    }

    // Only inject CSS when preset is loaded (prevents flash with empty/wrong values)
    if (!presetTheme) {
      // Keep existing CSS while loading
      return
    }

    // Generate CSS variable declarations
    const cssVars = themeToCSS(resolvedTheme, isDark)

    if (cssVars) {
      styleEl.textContent = `:root {\n  ${cssVars}\n}`
    } else {
      styleEl.textContent = ''
    }
  }, [effectiveColorTheme, presetTheme, resolvedTheme, isDark])

  // === System preference listener ===
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleMediaChange = (e: MediaQueryListEvent) => {
      setSystemPreference(e.matches ? 'dark' : 'light')
    }

    mediaQuery.addEventListener('change', handleMediaChange)

    // Listen via Electron IPC if available (more reliable on macOS)
    let cleanup: (() => void) | undefined
    if (window.electronAPI?.onSystemThemeChange) {
      cleanup = window.electronAPI.onSystemThemeChange((isDark) => {
        setSystemPreference(isDark ? 'dark' : 'light')
      })
    }

    // Fetch initial system theme from Electron
    if (window.electronAPI?.getSystemTheme) {
      window.electronAPI.getSystemTheme().then((isDark) => {
        setSystemPreference(isDark ? 'dark' : 'light')
      })
    }

    return () => {
      mediaQuery.removeEventListener('change', handleMediaChange)
      cleanup?.()
    }
  }, [])

  // === Cross-window sync listener ===
  useEffect(() => {
    if (!window.electronAPI?.onThemePreferencesChange) return

    const cleanup = window.electronAPI.onThemePreferencesChange((preferences) => {
      isExternalUpdate.current = true
      setModeState(preferences.mode as ThemeMode)
      setColorThemeState(preferences.colorTheme)
      setFontState(preferences.font as FontFamily)
      // When syncing from another window, mark as user override since user explicitly changed theme
      saveTheme({
        mode: preferences.mode as ThemeMode,
        colorTheme: preferences.colorTheme,
        font: preferences.font as FontFamily,
        isUserOverride: true
      })
      setTimeout(() => {
        isExternalUpdate.current = false
      }, 0)
    })

    return cleanup
  }, [])

  // === Setters with persistence and broadcast ===
  const setMode = useCallback((newMode: ThemeMode) => {
    setModeState(newMode)
    // Preserve existing isUserOverride flag
    const existing = loadStoredTheme()
    saveTheme({ mode: newMode, colorTheme, font, isUserOverride: existing?.isUserOverride })
    if (!isExternalUpdate.current && window.electronAPI?.broadcastThemePreferences) {
      window.electronAPI.broadcastThemePreferences({ mode: newMode, colorTheme, font })
    }
  }, [colorTheme, font])

  const setColorTheme = useCallback((newTheme: string) => {
    setColorThemeState(newTheme)
    // Mark as user override - user explicitly changed theme via UI
    saveTheme({ mode, colorTheme: newTheme, font, isUserOverride: true })
    if (!isExternalUpdate.current && window.electronAPI?.broadcastThemePreferences) {
      window.electronAPI.broadcastThemePreferences({ mode, colorTheme: newTheme, font })
    }
  }, [mode, font])

  const setFont = useCallback((newFont: FontFamily) => {
    setFontState(newFont)
    // Preserve existing isUserOverride flag
    const existing = loadStoredTheme()
    saveTheme({ mode, colorTheme, font: newFont, isUserOverride: existing?.isUserOverride })
    if (!isExternalUpdate.current && window.electronAPI?.broadcastThemePreferences) {
      window.electronAPI.broadcastThemePreferences({ mode, colorTheme, font: newFont })
    }
  }, [mode, colorTheme])

  // Set workspace-specific color theme override
  const setWorkspaceColorTheme = useCallback((newTheme: string | null) => {
    if (!activeWorkspaceId) return
    setWorkspaceColorThemeState(newTheme)
    window.electronAPI?.setWorkspaceColorTheme?.(activeWorkspaceId, newTheme)
    // Broadcast to other windows
    window.electronAPI?.broadcastWorkspaceThemeChange?.(activeWorkspaceId, newTheme)
  }, [activeWorkspaceId])

  // Listen for workspace theme changes from other windows
  useEffect(() => {
    if (!window.electronAPI?.onWorkspaceThemeChange) return

    const cleanup = window.electronAPI.onWorkspaceThemeChange(({ workspaceId, themeId }) => {
      // Only update if this is our active workspace
      if (workspaceId === activeWorkspaceId) {
        setWorkspaceColorThemeState(themeId)
      }
    })

    return cleanup
  }, [activeWorkspaceId])

  // === Theme pack loading ===

  const refreshThemePacks = useCallback(() => {
    window.electronAPI?.getThemePacks?.().then(setThemePacks).catch(() => setThemePacks([]))
  }, [])

  useEffect(() => {
    refreshThemePacks()
    window.electronAPI?.getSelectedThemePack?.().then((pack) => {
      setThemePackId(pack?.id ?? null)
      setActiveThemePack(pack)
    }).catch(() => {
      setThemePackId(null)
      setActiveThemePack(null)
    })

    const cleanup = window.electronAPI?.onThemePackChange?.((payload) => {
      refreshThemePacks()
      if (payload.packId) {
        window.electronAPI?.getThemePack?.(payload.packId).then((pack) => {
          setThemePackId(pack?.id ?? null)
          setActiveThemePack(pack)
        }).catch(() => {})
      } else {
        setThemePackId(null)
        setActiveThemePack(null)
      }
    })
    return cleanup
  }, [refreshThemePacks])

  // Load pack artwork as data URLs (re-loads when the active pack or dark mode changes)
  useEffect(() => {
    const pack = activeThemePack
    if (!pack) {
      setPackAssets({ background: null, chat: null, sidebar: null, characters: { left: null, right: null } })
      return
    }
    let cancelled = false
    const backgroundRef = isDark
      ? (pack.manifest.background?.dark ?? pack.manifest.background?.light)
      : (pack.manifest.background?.light ?? pack.manifest.background?.dark)
    const refs = {
      background: backgroundRef ?? pack.manifest.backgroundImage,
      chat: pack.manifest.chatTexture,
      sidebar: pack.manifest.sidebarTexture,
      charLeft: pack.manifest.characters?.left,
      charRight: pack.manifest.characters?.right,
    }
    void (async () => {
      const [bg, chat, sidebar, charLeft, charRight] = await Promise.all([
        refs.background ? window.electronAPI?.getThemePackAsset?.(pack.id, refs.background) ?? null : null,
        refs.chat ? window.electronAPI?.getThemePackAsset?.(pack.id, refs.chat) ?? null : null,
        refs.sidebar ? window.electronAPI?.getThemePackAsset?.(pack.id, refs.sidebar) ?? null : null,
        refs.charLeft ? window.electronAPI?.getThemePackAsset?.(pack.id, refs.charLeft) ?? null : null,
        refs.charRight ? window.electronAPI?.getThemePackAsset?.(pack.id, refs.charRight) ?? null : null,
      ])
      if (!cancelled) {
        setPackAssets({ background: bg, chat, sidebar, characters: { left: charLeft, right: charRight } })
      }
    })()
    return () => { cancelled = true }
  }, [activeThemePack, isDark])

  // === Theme pack setters ===

  const setThemePack = useCallback((packId: string | null) => {
    setThemePackId(packId)
    window.electronAPI?.setSelectedThemePack?.(packId)
    if (packId) {
      window.electronAPI?.getThemePack?.(packId).then((pack) => {
        setActiveThemePack(pack)
      }).catch(() => {})
    } else {
      setActiveThemePack(null)
    }
  }, [])

  const importThemePack = useCallback(async (): Promise<ThemePack | null> => {
    const pack = await window.electronAPI?.importThemePackFolder?.() ?? null
    if (pack) {
      refreshThemePacks()
      setThemePack(pack.id)
    }
    return pack
  }, [refreshThemePacks, setThemePack])

  const deleteThemePack = useCallback(async (packId: string): Promise<boolean> => {
    const ok = (await window.electronAPI?.deleteThemePack?.(packId)) ?? false
    if (ok) {
      refreshThemePacks()
      if (themePackId === packId) {
        setThemePackId(null)
        setActiveThemePack(null)
      }
    }
    return ok
  }, [refreshThemePacks, themePackId])

  const setThemePackScriptsEnabled = useCallback((enabled: boolean) => {
    setThemePackScriptsEnabledState(enabled)
    storage.set(storage.KEYS.themePackScripts, enabled)
  }, [])

  const setChatOpacity = useCallback((opacity: number) => {
    const next = Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1
    setChatOpacityState(next)
    storage.set(storage.KEYS.chatOpacity, next)
  }, [])

  const themePackName = activeThemePack?.manifest.name ?? null

  // Character standees (立绘) — rendered through the fixed stage element
  // declared in index.html (before #root so app UI paints above them).
  const characterStage =
    typeof document !== 'undefined' &&
    (packAssets.characters.left || packAssets.characters.right)
      ? createPortal(
          <>
            {packAssets.characters.left?.dataUrl ? (
              <img data-char="left" alt="" src={packAssets.characters.left.dataUrl} />
            ) : null}
            {packAssets.characters.right?.dataUrl ? (
              <img data-char="right" alt="" src={packAssets.characters.right.dataUrl} />
            ) : null}
          </>,
          document.getElementById('theme-pack-character-stage') ?? document.body,
        )
      : null

  return (
    <ThemeContext.Provider
      value={{
        // App-level preferences
        mode,
        colorTheme,
        font,
        setMode,
        setColorTheme,
        setFont,
        chatOpacity,
        setChatOpacity,

        // Workspace-level theme override
        activeWorkspaceId,
        workspaceColorTheme,
        setWorkspaceColorTheme,

        // Derived
        resolvedMode,
        systemPreference,
        effectiveColorTheme,
        previewColorTheme,
        setPreviewColorTheme,
        effectiveColorThemeSource,
        themeResolvedFrom,
        themeLoadError,

        // Theme resolution (singleton)
        presetTheme,
        resolvedTheme,
        isDark,
        isScenic,
        shikiTheme,
        shikiConfig,

        // Theme packs
        themePacks,
        themePackId,
        activeThemePack,
        themePackName,
        refreshThemePacks,
        setThemePack,
        importThemePack,
        deleteThemePack,
        themePackScriptsEnabled,
        setThemePackScriptsEnabled,
      }}
    >
      {children}
      {characterStage}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext)
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
