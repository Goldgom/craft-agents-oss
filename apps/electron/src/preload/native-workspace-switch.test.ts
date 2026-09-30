import { expect, it } from 'bun:test'
import { createNativeWorkspaceSwitcher } from './native-workspace-switch'

it('serializes native binding and transport work and allows recovery after rejection', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const calls: string[] = []
  const failure = new Error('synthetic switch failure')
  const change = createNativeWorkspaceSwitcher(async id => {
    calls.push(`start:${id}`)
    if (id === 'first') { await gate; throw failure }
    calls.push(`end:${id}`)
  })
  const first = change('first')
  const rejection = first.catch(error => error)
  const second = change('second')
  const third = change('third')
  await Promise.resolve()
  expect(calls).toEqual(['start:first'])
  release()
  expect(await rejection).toBe(failure)
  await Promise.all([second, third])
  expect(calls).toEqual(['start:first', 'start:second', 'end:second', 'start:third', 'end:third'])
})
