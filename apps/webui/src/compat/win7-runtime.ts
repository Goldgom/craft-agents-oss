import { replaceModernColors, rgbColor, substituteVariables } from './win7-colors'

export async function installLegacyColors() {
  const response = await fetch('./win7-colors.json')
  if (!response.ok) throw new Error('Win7 color compatibility data is missing')
  const recipes: Record<string, string> = await response.json()
  const root = document.documentElement
  const expressionIds = new Map(Object.entries(recipes).map(([id, expression]) => [expression, id]))
  let queued = false
  let lastRootSignature = ''
  const signature = () => root.className + root.style.cssText.replace(/--win7-color-[^;]+;?/g, '')

  function rewriteInjectedStyles() {
    for (const style of document.querySelectorAll('style')) {
      const original = style.textContent ?? ''
      const replacement = replaceModernColors(original, expression => {
        const rgb = rgbColor(expression)
        if (rgb) return rgb
        let id = expressionIds.get(expression)
        if (!id) {
          id = `--win7-color-${expressionIds.size}`
          expressionIds.set(expression, id)
          recipes[id] = expression
        }
        return `var(${id}, transparent)`
      })
      if (replacement !== original) style.textContent = replacement
    }
  }

  function collectRootVariables() {
    const variables = new Map<string, string>()
    const important = new Set<string>()
    function record(style: CSSStyleDeclaration) {
      for (const name of Array.from(style)) {
        if (!name.startsWith('--') || name.startsWith('--win7-color-')) continue
        const priority = style.getPropertyPriority(name)
        if (important.has(name) && !priority) continue
        variables.set(name, style.getPropertyValue(name).trim())
        if (priority) important.add(name)
      }
    }
    function walk(rules: CSSRuleList) {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          try { if (root.matches(rule.selectorText)) record(rule.style) } catch { /* newer selectors */ }
        } else if (rule instanceof CSSMediaRule && !matchMedia(rule.conditionText).matches) continue
        else if (rule instanceof CSSSupportsRule && !CSS.supports(rule.conditionText)) continue
        else if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      try { walk(sheet.cssRules) } catch { /* cross-origin fonts */ }
    }
    record(root.style)
    return variables
  }

  function refresh() {
    queued = false
    rewriteInjectedStyles()
    const variables = collectRootVariables()
    const computed = getComputedStyle(root)
    const cache = new Map<string, string>()
    const visiting = new Set<string>()
    function resolve(name: string): string | undefined {
      if (cache.has(name)) return cache.get(name)
      if (visiting.has(name)) return undefined
      visiting.add(name)
      const raw = recipes[name] || variables.get(name) || computed.getPropertyValue(name).trim()
      if (!raw) { visiting.delete(name); return undefined }
      const expanded = substituteVariables(raw, resolve).replace(/\bcurrentcolor\b/gi, computed.color)
      const result = recipes[name] ? rgbColor(expanded) : replaceModernColors(expanded, value => rgbColor(value) || 'transparent')
      visiting.delete(name)
      if (result) cache.set(name, result)
      return result
    }
    for (const id of Object.keys(recipes)) {
      // A few effect-only utilities use per-element --tw-* colors. They degrade
      // to transparent rather than borrowing an unrelated root color.
      const value = resolve(id) || 'transparent'
      if (root.style.getPropertyValue(id) !== value) root.style.setProperty(id, value)
    }
    lastRootSignature = signature()
  }

  function schedule() {
    if (queued) return
    queued = true
    requestAnimationFrame(refresh)
  }
  refresh()
  new MutationObserver(records => {
    if (signature() !== lastRootSignature || records.some(record => record.target !== root)) schedule()
  }).observe(root, { attributes: true, attributeFilter: ['class', 'style'] })
  new MutationObserver(records => {
    if (records.some(record => (record.target as Element).tagName === 'STYLE'
      || Array.from(record.addedNodes).some(node => node instanceof HTMLStyleElement))) schedule()
  }).observe(document.head, { childList: true, characterData: true, subtree: true })
  // Lazy-loaded editors ship additional CSS chunks.
  document.addEventListener('load', event => { if (event.target instanceof HTMLLinkElement) schedule() }, true)
}
