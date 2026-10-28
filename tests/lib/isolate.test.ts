import { describe, expect, it, vi } from 'vitest'
import { isolate } from '../../src/lib/isolate'

describe('isolate.value', () => {
  it('shares one load between concurrent callers', async () => {
    const load = vi.fn(async () => ({ loaded: true }))
    const cache = isolate.value(load)

    const results = await Promise.all(Array.from({ length: 10 }, () => cache.get()))

    expect(load).toHaveBeenCalledTimes(1)
    expect(new Set(results).size).toBe(1)
  })

  it('serves the loaded value until it expires', async () => {
    let now = 1_000
    let version = 0
    const cache = isolate.value(async () => ++version, { ttlMs: 100, now: () => now })

    expect(await cache.get()).toBe(1)
    now += 99
    expect(await cache.get()).toBe(1)
    now += 1
    expect(await cache.get()).toBe(2)
  })

  it('does not cache a failed load', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('service down'))
      .mockResolvedValueOnce('ok')
    const cache = isolate.value(load)

    await expect(cache.get()).rejects.toThrow('service down')
    await expect(cache.get()).resolves.toBe('ok')
    await expect(cache.get()).resolves.toBe('ok')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('loads for itself when a shared load never settles', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce('fresh')
    const cache = isolate.value(load, { sharedLoadWaitMs: 10 })

    void cache.get()
    await expect(cache.get()).resolves.toBe('fresh')
  })

  it('reloads after reset', async () => {
    let version = 0
    const cache = isolate.value(async () => ++version)

    expect(await cache.get()).toBe(1)
    cache.reset()
    expect(await cache.get()).toBe(2)
  })
})

describe('isolate.lazy', () => {
  it('builds once', () => {
    const build = vi.fn(() => ({ built: true }))
    const get = isolate.lazy(build)

    expect(get()).toBe(get())
    expect(build).toHaveBeenCalledTimes(1)
  })

  it('does not cache a build that throws', () => {
    const build = vi
      .fn<() => string>()
      .mockImplementationOnce(() => {
        throw new Error('bad')
      })
      .mockReturnValueOnce('ok')
    const get = isolate.lazy(build)

    expect(() => get()).toThrow('bad')
    expect(get()).toBe('ok')
  })

  it('caches undefined like any other value', () => {
    const build = vi.fn(() => undefined)
    const get = isolate.lazy(build)

    get()
    get()
    expect(build).toHaveBeenCalledTimes(1)
  })
})

describe('isolate.map', () => {
  it('computes each key once', () => {
    const compute = vi.fn((key: string) => key.toUpperCase())
    const cache = isolate.map<string, string>()

    expect(cache.getOrSet('a', compute)).toBe('A')
    expect(cache.getOrSet('a', compute)).toBe('A')
    expect(cache.getOrSet('b', compute)).toBe('B')
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it('caches null and undefined results', () => {
    const compute = vi.fn(() => null)
    const cache = isolate.map<string, null>()

    cache.getOrSet('a', compute)
    cache.getOrSet('a', compute)
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('clears itself before passing maxEntries', () => {
    const cache = isolate.map<number, number>({ maxEntries: 2 })

    cache.set(1, 1)
    cache.set(2, 2)
    cache.set(3, 3)

    expect(cache.size).toBe(1)
    expect(cache.get(1)).toBeUndefined()
    expect(cache.get(3)).toBe(3)
  })

  it('clears itself before passing maxSize, and skips a value larger than the cap', () => {
    const cache = isolate.map<string, Uint8Array>({
      maxSize: 10,
      sizeOf: (bytes) => bytes.byteLength
    })

    cache.set('a', new Uint8Array(6))
    cache.set('b', new Uint8Array(6))
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeDefined()

    const huge = new Uint8Array(11)
    expect(cache.set('huge', huge)).toBe(huge)
    expect(cache.get('huge')).toBeUndefined()
    expect(cache.get('b')).toBeDefined()
  })

  it('replaces a key without counting it twice', () => {
    const cache = isolate.map<string, Uint8Array>({
      maxSize: 10,
      sizeOf: (bytes) => bytes.byteLength
    })

    cache.set('a', new Uint8Array(6))
    cache.set('a', new Uint8Array(6))
    cache.set('b', new Uint8Array(4))

    expect(cache.size).toBe(2)
  })
})

describe('isolate.derived', () => {
  it('computes once per source object', () => {
    const compute = vi.fn((source: { items: number[] }) => source.items.length)
    const count = isolate.derived(compute)
    const first = { items: [1, 2] }

    expect(count(first)).toBe(2)
    expect(count(first)).toBe(2)
    expect(compute).toHaveBeenCalledTimes(1)

    // A reloaded source is a new object, so the value is computed again.
    expect(count({ items: [1, 2, 3] })).toBe(3)
    expect(compute).toHaveBeenCalledTimes(2)
  })
})

describe('isolate.resetAll', () => {
  it('drops every registered cache', async () => {
    let version = 0
    const value = isolate.value(async () => ++version)
    const lazy = isolate.lazy(() => ++version)
    const map = isolate.map<string, number>()
    const source = {}
    const derived = isolate.derived(() => ++version)

    await value.get()
    lazy()
    map.set('a', 1)
    derived(source)

    isolate.resetAll()

    expect(map.size).toBe(0)
    expect(await value.get()).toBe(4)
    expect(lazy()).toBe(5)
    expect(derived(source)).toBe(6)
  })
})
