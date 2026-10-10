import { color, serializeRGB } from '@csstools/css-color-parser'
import { parseComponentValue } from '@csstools/css-parser-algorithms'
import { tokenize } from '@csstools/css-tokenizer'

export const modernColor = /(?:color-mix|oklch|oklab|lab|lch|color|light-dark)\(|(?:rgb|rgba|hsl|hsla)\(from\s/i

function closingParen(value: string, start: number): number {
  let depth = 0
  let quote = ''
  for (let i = start; i < value.length; i++) {
    const char = value[i]
    if (quote) { if (char === quote && value[i - 1] !== '\\') quote = ''; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '(') depth++
    if (char === ')' && --depth === 0) return i
  }
  return -1
}

export function substituteVariables(value: string, resolve: (name: string) => string | undefined, depth = 0): string {
  if (depth > 32) return value
  let result = ''
  let offset = 0
  while (offset < value.length) {
    const index = value.indexOf('var(', offset)
    if (index < 0) break
    const end = closingParen(value, index + 3)
    if (end < 0) break
    const contents = value.slice(index + 4, end)
    const comma = contents.indexOf(',')
    const name = (comma < 0 ? contents : contents.slice(0, comma)).trim()
    const fallback = comma < 0 ? undefined : contents.slice(comma + 1).trim()
    const replacement = resolve(name) || fallback
    result += value.slice(offset, index) + (replacement === undefined
      ? value.slice(index, end + 1)
      : substituteVariables(replacement, resolve, depth + 1))
    offset = end + 1
  }
  return result + value.slice(offset)
}

/** Convert a fully resolved CSS Color 4/5 expression to Chromium 108 RGB. */
export function rgbColor(expression: string): string | undefined {
  try {
    const component = parseComponentValue(tokenize({ css: expression }))
    if (!component) return undefined
    const parsed = color(component)
    return parsed ? serializeRGB(parsed).toString() : undefined
  } catch { return undefined }
}

/** Balanced function scanning: nested color-mix and relative colors stay whole. */
export function replaceModernColors(value: string, replace: (expression: string) => string): string {
  let result = ''
  let offset = 0
  const pattern = new RegExp(modernColor.source, 'ig')
  while (offset < value.length) {
    pattern.lastIndex = offset
    const match = pattern.exec(value)
    if (!match) break
    const start = match.index
    const end = closingParen(value, value.indexOf('(', start))
    if (end < 0) break
    result += value.slice(offset, start) + replace(value.slice(start, end + 1))
    offset = end + 1
  }
  return result + value.slice(offset)
}
