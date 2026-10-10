import undici from 'win7-undici'
export * from 'win7-undici'
export class EnvHttpProxyAgent extends undici.Dispatcher {
  constructor(options) {
    super()
    this.agent = new undici.Agent(options)
    const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY
    this.proxy = proxy ? new undici.ProxyAgent({ ...options, uri: proxy }) : this.agent
  }
  dispatch(options, handler) {
    const url = new URL(options.origin)
    const bypass = (process.env.no_proxy || process.env.NO_PROXY || '').split(',').map(value => value.trim().toLowerCase())
    const host = url.hostname.toLowerCase()
    const direct = ['127.0.0.1', 'localhost', '[::1]'].includes(host) || bypass.some(value =>
      value === '*' || value === host || value === url.host.toLowerCase()
      || (value.startsWith('.') && (host === value.slice(1) || host.endsWith(value))))
    return (direct ? this.agent : this.proxy).dispatch(options, handler)
  }
  async close() { await this.agent.close(); if (this.proxy !== this.agent) await this.proxy.close() }
  async destroy(error) { await this.agent.destroy(error); if (this.proxy !== this.agent) await this.proxy.destroy(error) }
}
export function install() {
  for (const name of ['fetch', 'Headers', 'Request', 'Response', 'FormData', 'File']) globalThis[name] = undici[name]
}
