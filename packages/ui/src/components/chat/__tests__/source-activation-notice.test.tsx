import { describe, expect, it } from 'bun:test'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseSourceActivation } from '../SourceActivationNotice'
import { SystemMessage, type SystemMessageProps } from '../SystemMessage'
import zh from '../../../../../shared/src/i18n/locales/zh-Hans.json'

const i18n = createInstance()
await i18n.init({ lng: 'zh-Hans', resources: { 'zh-Hans': { translation: zh } }, initImmediate: false })
const render = (props: SystemMessageProps) => renderToStaticMarkup(<I18nextProvider i18n={i18n}><SystemMessage {...props} /></I18nextProvider>)

describe('source activation notices', () => {
  it('recognizes exact historical source markers without consuming other messages', () => {
    expect(parseSourceActivation('[binance-cli-mcp activated]')).toBe('binance-cli-mcp')
    expect(parseSourceActivation('[world_intel.v2 activated]')).toBe('world_intel.v2')
    for (const content of ['example: [binance-cli-mcp activated]', '[binance-cli-mcp activated]\ncontinue',
      '[binance-cli-mcp failed]', '[]', '[source with spaces activated]', '```\n[binance-cli-mcp activated]\n```']) {
      expect(parseSourceActivation(content)).toBeNull()
    }
  })
  it('renders the MCP logo and Chinese description in a compact success notice', () => {
    const html = render({ type: 'info', infoLevel: 'success', content: '[binance-cli-mcp activated]' })
    expect(html).toContain('data-source-activation')
    expect(html).toContain('role="status"')
    expect(html).toContain('viewBox="18 22 150 170"')
    expect(html).toContain('已启用')
    expect(html).toContain('binance-cli-mcp')
    expect(html).not.toContain('activated]')
  })
  it('does not turn warnings, errors or quoted user-facing text into a success notice', () => {
    for (const props of [
      { type: 'error', content: '[binance-cli-mcp activated]' },
      { type: 'warning', content: '[binance-cli-mcp activated]' },
      { type: 'info', infoLevel: 'error', content: '[binance-cli-mcp activated]' },
      { type: 'info', infoLevel: 'warning', content: '[binance-cli-mcp activated]' },
      { type: 'info', content: 'Source not activated; check authentication.' },
    ] satisfies SystemMessageProps[]) expect(render(props)).not.toContain('data-source-activation')
  })
})
