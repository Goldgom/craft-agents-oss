/** Saved native remote connections require verified TLS, except local loopback. */
export function validateNativeRemoteUrl(value: string): string {
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback))) {
    throw new Error('Remote connections require verified WSS, except local loopback connections')
  }
  return url.toString().replace(/\/$/, '')
}
