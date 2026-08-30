import { describe, expect, it } from 'bun:test'
import { McpRuntimeLimiter } from '../runtime-limiter.ts'

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe('McpRuntimeLimiter', () => {
  it('keeps a FIFO queue and replaces idle runtimes when the hard cap is full', async () => {
    const limiter = new McpRuntimeLimiter()
    limiter.configure({ hardLimit: 1, softLimit: 1 })
    const evicted: string[] = []

    const first = await limiter.acquire('first', async () => { evicted.push('first') })
    const secondPromise = limiter.acquire('second', async () => { evicted.push('second') })
    await flush()

    expect(limiter.getActiveCount()).toBe(1)
    expect(limiter.getQueuedCount()).toBe(1)

    first.release()
    const second = await secondPromise

    expect(evicted).toEqual(['first'])
    expect(limiter.getActiveCount()).toBe(1)
    expect(limiter.getQueuedCount()).toBe(0)
    second.release()
  })

  it('does not evict a runtime while a call is in flight', async () => {
    const limiter = new McpRuntimeLimiter()
    limiter.configure({ hardLimit: 1, softLimit: 0 })
    const evicted: string[] = []
    const lease = await limiter.acquire('busy', async () => { evicted.push('busy') })

    let finishCall!: () => void
    const callFinished = new Promise<void>(resolve => { finishCall = resolve })
    const running = limiter.run('busy', async () => {
      await callFinished
    })
    lease.release()

    await flush()
    expect(evicted).toEqual([])
    expect(limiter.getActiveCount()).toBe(1)

    finishCall()
    await running
    await limiter.enforceLimits()

    expect(evicted).toEqual(['busy'])
    expect(limiter.getActiveCount()).toBe(0)
  })

  it('services multiple queued sources in request order', async () => {
    const limiter = new McpRuntimeLimiter()
    limiter.configure({ hardLimit: 2, softLimit: 0 })
    const evicted: string[] = []
    const first = await limiter.acquire('first', async () => { evicted.push('first') })
    const second = await limiter.acquire('second', async () => { evicted.push('second') })
    const thirdPromise = limiter.acquire('third', async () => { evicted.push('third') })
    const fourthPromise = limiter.acquire('fourth', async () => { evicted.push('fourth') })

    expect(limiter.getQueuedCount()).toBe(2)
    first.release()
    const third = await thirdPromise
    expect(evicted).toEqual(['first'])

    second.release()
    const fourth = await fourthPromise
    expect(evicted).toEqual(['first', 'second'])

    third.release()
    fourth.release()
  })

  it('trims the least recently used idle runtimes when the memory cap is reached', async () => {
    const limiter = new McpRuntimeLimiter()
    limiter.configure({ hardLimit: 3, softLimit: 3, memoryHardLimitBytes: 100 })
    const evicted: string[] = []
    const memory = async () => 50
    const first = await limiter.acquire('first', async () => { evicted.push('first') }, memory)
    const second = await limiter.acquire('second', async () => { evicted.push('second') }, memory)
    const third = await limiter.acquire('third', async () => { evicted.push('third') }, memory)

    first.release()
    second.release()
    third.release()
    await limiter.enforceLimits()

    expect(evicted).toEqual(['first', 'second'])
    expect(limiter.getActiveCount()).toBe(1)
  })

  it('can explicitly clear all idle runtimes', async () => {
    const limiter = new McpRuntimeLimiter()
    limiter.configure({ hardLimit: 2, softLimit: 2 })
    let evicted = 0
    const first = await limiter.acquire('first', async () => { evicted++ })
    const second = await limiter.acquire('second', async () => { evicted++ })
    first.release()
    second.release()

    expect(await limiter.clearIdleRuntimes()).toBe(2)
    expect(evicted).toBe(2)
    expect(limiter.getActiveCount()).toBe(0)
  })
})
