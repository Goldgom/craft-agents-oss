import type { Plugin } from 'vite'
import postcss from 'postcss'
import { replaceModernColors, rgbColor } from '../apps/webui/src/compat/win7-colors'

export function lowerSupportsCondition(condition: string): string {
  // Vite/Tailwind wrap modern colors in @supports and leave an opaque fallback.
  // The guarded declarations are now RGB/var recipes, so their color feature
  // checks must also describe the lowered syntax, otherwise Chrome 108 ignores
  // the corrected alpha colors and selects the opaque fallback instead.
  return replaceModernColors(condition, expression => rgbColor(expression) || 'rgb(0, 0, 0)')
}

/** Keep dynamic theme colors as recipes evaluated by the remote client's shim. */
export function win7Css(): Plugin {
  return {
    name: 'win7-css-colors',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const recipes: Record<string, string> = {}
      const ids = new Map<string, string>()
      for (const asset of Object.values(bundle)) {
        if (asset.type !== 'asset' || !asset.fileName.endsWith('.css')) continue
        const root = postcss.parse(String(asset.source))
        root.walkAtRules('supports', rule => { rule.params = lowerSupportsCondition(rule.params) })
        root.walkDecls(declaration => {
          declaration.value = replaceModernColors(declaration.value, expression => {
            const rgb = rgbColor(expression)
            if (rgb) return rgb
            let id = ids.get(expression)
            if (!id) {
              id = `--win7-color-${ids.size}`
              ids.set(expression, id)
              recipes[id] = expression
            }
            return `var(${id}, transparent)`
          })
        })
        asset.source = root.toString()
      }
      this.emitFile({ type: 'asset', fileName: 'win7-colors.json', source: JSON.stringify(recipes) })
    },
  }
}
