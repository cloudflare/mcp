/**
 * Values kept for the life of a Worker isolate.
 *
 * A warm isolate serves many requests, so anything that doesn't depend on the
 * request (a spec artifact, a parsed listing, a compiled validator, a JSON
 * Schema) should be built once and reused. Each helper here covers one way
 * this server does that:
 *
 * - {@link isolate.value}: an async load, shared by concurrent requests, with an optional TTL.
 * - {@link isolate.lazy}: a synchronous value built on first use.
 * - {@link isolate.map}: values by key, cleared when a count or size cap is reached.
 * - {@link isolate.derived}: a value computed from another cached object, rebuilt when that object changes.
 *
 * Every cache registers itself, so {@link isolate.resetAll} drops them all.
 * Tests use it to start from a cold isolate.
 *
 * Nothing here may hold per-request or per-user data: one isolate serves every
 * user.
 */

/** Something {@link isolate.resetAll} can drop. */
interface Resettable {
  reset(): void
}

const registry = new Set<Resettable>()

function register<T extends Resettable>(cache: T): T {
  registry.add(cache)
  return cache
}

/** An async value loaded once per isolate. */
export interface IsolateValue<T> {
  /** The value, loading it if it is missing or expired. */
  get(): Promise<T>
  /** Drop the value, so the next {@link get} loads it again. */
  reset(): void
}

export interface IsolateValueOptions {
  /** How long a loaded value is served before the next `get` reloads it. Default: forever. */
  readonly ttlMs?: number
  /**
   * How long a request waits on a load another request started before loading
   * for itself. Default: 15 seconds.
   */
  readonly sharedLoadWaitMs?: number
  /** The clock, for tests. Default: `Date.now`. */
  readonly now?: () => number
}

const DEFAULT_SHARED_LOAD_WAIT_MS = 15_000

/**
 * An async value loaded once per isolate and shared.
 *
 * Concurrent requests on a cold isolate share one load instead of each
 * fetching and parsing a multi-megabyte artifact, which could exceed the
 * isolate's memory. A failed load is not cached: the next `get` tries again.
 * With `ttlMs`, the value is reloaded once it is that old.
 *
 * A load is I/O owned by the request that began it. When that request ends
 * first (its client disconnected), workerd rejects every other request's wait
 * on the promise at once: "This promise was created by a request that has
 * since ended, so it can never settle". The promise itself stays pending for
 * ever. So a request whose wait on another's load fails, or outlasts
 * `sharedLoadWaitMs`, takes the load over: it loads in its own request, and
 * that load is the one later requests share. Without this, every direct
 * `tools/list` on the isolate failed until the dead load's TTL ran out, which
 * was about 70 exceptions a day in production and 1,700 in the minutes after
 * a deploy, when every isolate is cold.
 *
 * @param load - Loads the value. Called at most once at a time, unless a
 *   request takes over another's load.
 */
function value<T>(load: () => Promise<T>, options: IsolateValueOptions = {}): IsolateValue<T> {
  const {
    ttlMs = Infinity,
    sharedLoadWaitMs = DEFAULT_SHARED_LOAD_WAIT_MS,
    now = Date.now
  } = options
  let entry: { promise: Promise<T>; expiresAt: number; settled: boolean } | undefined

  const start = (at: number): Promise<T> => {
    const promise = load()
    const current = { promise, expiresAt: at + ttlMs, settled: false }
    entry = current
    promise.then(
      () => {
        current.settled = true
      },
      () => {
        if (entry === current) {
          entry = undefined
        }
      }
    )
    return promise
  }

  return register({
    get(): Promise<T> {
      const at = now()
      if (!entry || entry.expiresAt <= at) {
        return start(at)
      }
      if (entry.settled) {
        return entry.promise
      }
      // Another request is loading. Wait for it, but take the load over if the
      // wait fails or goes on too long. If a third request already has, share its load.
      const waitedOn = entry
      const takeOver = (): Promise<T> =>
        entry && entry !== waitedOn ? entry.promise : start(now())
      let timer: ReturnType<typeof setTimeout> | undefined
      const tooLong = new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          void takeOver().then(resolve, reject)
        }, sharedLoadWaitMs)
      })
      // Awaited here, in this request: workerd rejects the await itself when the load's
      // request has ended, and the load's own promise never settles.
      const shared = (async () => {
        try {
          return await waitedOn.promise
        } catch {
          return takeOver()
        }
      })()
      return Promise.race([shared, tooLong]).finally(() => {
        if (timer !== undefined) {
          clearTimeout(timer)
        }
      })
    },
    reset() {
      entry = undefined
    }
  })
}

/** A synchronous value built once per isolate. */
export interface IsolateLazy<T> {
  /** The value, building it on first use. */
  (): T
  /** Drop the value, so the next call builds it again. */
  reset(): void
}

/**
 * A synchronous value built on first use and kept for the life of the isolate.
 * A build that throws is not cached.
 *
 * @param build - Builds the value from nothing request-specific.
 */
function lazy<T>(build: () => T): IsolateLazy<T> {
  let built: { value: T } | undefined
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The registry preserves the type of the handle inserted under this key.
  const get = (() => {
    built ??= { value: build() }
    return built.value
  }) as IsolateLazy<T>
  get.reset = () => {
    built = undefined
  }
  return register(get)
}

/** Values by key, kept per isolate. */
export interface IsolateMap<K, V> {
  /** The cached value for `key`, if any. */
  get(key: K): V | undefined
  /** Cache `value` for `key`, clearing the map first if it would exceed a cap. */
  set(key: K, value: V): V
  /** The cached value for `key`, computing and caching it if missing. */
  getOrSet(key: K, compute: (key: K) => V): V
  /** How many values are cached. */
  readonly size: number
  /** Drop every value. */
  reset(): void
}

export interface IsolateMapOptions<V> {
  /** The most values kept. Default: no limit. */
  readonly maxEntries?: number
  /** The most total size kept, measured by `sizeOf`. Default: no limit. */
  readonly maxSize?: number
  /** A value's size, for `maxSize`. Default: 1 per value. */
  readonly sizeOf?: (value: V) => number
}

/**
 * Values by key, kept for the life of the isolate and bounded.
 *
 * When adding a value would pass `maxEntries` or `maxSize`, the whole map is
 * cleared first. That is cheaper than tracking recency, and fits caches whose
 * working set is far below the cap: the cap only stops a long-lived isolate
 * from growing without bound. A value larger than `maxSize` on its own is
 * returned but not kept.
 */
function map<K, V>(options: IsolateMapOptions<V> = {}): IsolateMap<K, V> {
  const { maxEntries = Infinity, maxSize = Infinity, sizeOf = () => 1 } = options
  let entries = new Map<K, V>()
  let size = 0

  const cache: IsolateMap<K, V> = {
    get: (key) => entries.get(key),
    set(key, value) {
      const valueSize = sizeOf(value)
      if (valueSize > maxSize) {
        return value
      }
      const previous = entries.get(key)
      if (previous !== undefined) {
        entries.delete(key)
        size -= sizeOf(previous)
      }
      if (entries.size + 1 > maxEntries || size + valueSize > maxSize) {
        entries = new Map()
        size = 0
      }
      entries.set(key, value)
      size += valueSize
      return value
    },
    getOrSet(key, compute) {
      if (entries.has(key)) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The registry preserves the type of the handle inserted under this key.
        return entries.get(key) as V
      }
      return cache.set(key, compute(key))
    },
    get size() {
      return entries.size
    },
    reset() {
      entries = new Map()
      size = 0
    }
  }
  return register(cache)
}

/** A value computed from another cached object. */
export interface IsolateDerived<S extends object, T> {
  /** The value computed from `source`, computing it the first time `source` is seen. */
  (source: S): T
  /** Drop every computed value. */
  reset(): void
}

/**
 * A value computed from another isolate-cached object: an index over a
 * listing, its serialized bytes, a schema's JSON Schema.
 *
 * Keyed on the source object's identity, so when the source's own cache
 * reloads (a TTL refresh hands out a new object), the value is computed again,
 * and the old one is collected with its source.
 *
 * @param compute - Computes the value. It must depend only on `source`.
 */
function derived<S extends object, T>(compute: (source: S) => T): IsolateDerived<S, T> {
  let computed = new WeakMap<S, { value: T }>()
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- The registry preserves the type of the handle inserted under this key.
  const get = ((source: S) => {
    let hit = computed.get(source)
    if (!hit) {
      hit = { value: compute(source) }
      computed.set(source, hit)
    }
    return hit.value
  }) as IsolateDerived<S, T>
  get.reset = () => {
    computed = new WeakMap()
  }
  return register(get)
}

/** Drop every isolate cache, as if the isolate had just started. For tests. */
function resetAll(): void {
  for (const cache of registry) {
    cache.reset()
  }
}

/** Isolate-lifetime caches. See the module documentation. */
export const isolate = { value, lazy, map, derived, resetAll }
