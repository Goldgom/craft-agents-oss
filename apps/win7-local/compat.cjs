'use strict'
// Loaded in the Electron host and in each Node-mode agent subprocess.
require('core-js/actual')
const crypto = require('node:crypto')
const { serialize, deserialize } = require('node:v8')
const streams = require('node:stream/web')
const undici = require('win7-undici')
for (const [name, value] of Object.entries(streams)) if (!global[name]) global[name] = value
for (const name of ['fetch', 'Headers', 'Request', 'Response', 'FormData', 'File']) {
  // Always use the same fetch implementation as the agent's HTTP dispatcher.
  global[name] = undici[name]
}
global.DOMException ||= require('node-domexception')
global.crypto ||= crypto.webcrypto
global.structuredClone ||= value => deserialize(serialize(value))
process.getBuiltinModule ||= name => {
  if (!require('node:module').builtinModules.includes(name.replace(/^node:/, ''))) return undefined
  try { return require(name) } catch { return undefined }
}
// Weak references avoid keeping abandoned combined signals alive through a
// long-lived input signal. A WeakMap retains the controller while its signal
// is still in use; the finalizer removes listeners after the signal is dropped.
const combinedControllers = new WeakMap()
const clearListeners = listeners => {
  for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
  listeners.clear()
}
const signalFinalizer = new FinalizationRegistry(clearListeners)
function combinedListener(signal, reference, listeners) {
  return () => { reference.deref()?.abort(signal.reason); clearListeners(listeners) }
}
AbortSignal.any ||= signals => {
  const inputs = Array.from(signals)
  if (inputs.some(signal => !(signal instanceof AbortSignal))) throw new TypeError('Expected an AbortSignal')
  const controller = new AbortController()
  const listeners = new Map()
  const reference = new WeakRef(controller)
  const aborted = inputs.find(signal => signal.aborted)
  if (aborted) controller.abort(aborted.reason)
  else for (const signal of new Set(inputs)) {
    const listener = combinedListener(signal, reference, listeners)
    listeners.set(signal, listener)
    signal.addEventListener('abort', listener, { once: true })
  }
  combinedControllers.set(controller.signal, controller)
  signalFinalizer.register(controller.signal, listeners)
  return controller.signal
}
