/**
 * Tool result rendering.
 *
 * Results over ~6,000 tokens are cut to fit. JSON is cut structurally, so the
 * text stays valid JSON: the largest values shrink first, lists keep whole
 * items from the start, and every cut leaves a `--- TRUNCATED ---` marker. A
 * clipped string ends with `--- TRUNCATED --- <n> chars`, a clipped array ends
 * with a `--- TRUNCATED --- <n> more items` element, and an object that lost
 * entries gains a `"--- TRUNCATED ---"` entry naming them. Plain text is sliced
 * and followed by a notice with the original size.
 *
 * The structural algorithm started as a port of `truncateResult` in
 * `@cloudflare/codemode` (cloudflare/agents, packages/codemode/src/truncate.ts).
 * It differs in one way: an array keeps each item at a floor that preserves
 * every object key (`keyFloor`), so a list of records keeps whole records
 * instead of cutting every record down to a few fields.
 */

const CHARS_PER_TOKEN = 4
const MAX_TOKENS = 6000
const MAX_CHARS = MAX_TOKENS * CHARS_PER_TOKEN
const TRUNCATION_MARKER = '--- TRUNCATED ---'
/**
 * The least a string or array is worth keeping at (see `floorSize`). A value
 * that would get fewer serialized characters than this is dropped in favour of
 * its siblings rather than reduced to a bare marker.
 */
const MIN_SLOT = 128

/** Renders a tool's result value as the text content sent to the MCP client. */
export type FormatToolResult = (content: unknown) => string

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/**
 * Render a tool result as text with no size cap. Strings pass through; other
 * values become pretty-printed JSON. A value JSON cannot represent, such as
 * `undefined` from code that returns nothing, becomes its `String()` form.
 */
export function stringifyResponse(content: unknown): string {
  if (typeof content === 'string') return content
  return JSON.stringify(content, null, 2) ?? String(content)
}

/**
 * Render a tool result as text capped at ~6,000 tokens.
 *
 * A value within the cap is pretty-printed, or compact when only the
 * indentation pushes it over. Oversized JSON, whether a value or a string that
 * holds a JSON object or array, is shrunk structurally and returned as compact
 * JSON that fits. Other oversized text is sliced and followed by a notice with
 * the original size, so the agent knows to narrow its request.
 */
export function truncateResponse(content: unknown): string {
  if (typeof content === 'string') {
    if (content.length <= MAX_CHARS) return content
    const json = parseJsonContainer(content)
    return json === undefined ? truncateText(content) : shrinkToText(json)
  }

  const compact: string | undefined = JSON.stringify(content)
  if (compact === undefined) return String(content)
  // Re-parse so `toJSON` and `undefined` members are seen the way they serialize.
  if (compact.length > MAX_CHARS) return shrinkToText(JSON.parse(compact))

  const pretty = JSON.stringify(content, null, 2)
  return pretty.length <= MAX_CHARS ? pretty : compact
}

function truncateText(text: string): string {
  const estimatedTokens = Math.ceil(text.length / CHARS_PER_TOKEN)
  return `${text.slice(0, MAX_CHARS)}\n\n${TRUNCATION_MARKER}\nResponse was ~${estimatedTokens.toLocaleString()} tokens (limit: ${MAX_TOKENS.toLocaleString()}). Use more specific queries to reduce response size.`
}

/** Parse text holding a JSON object or array. Anything else is plain text. */
function parseJsonContainer(text: string): Json | undefined {
  if (!/^\s*[[{]/.test(text)) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function shrinkToText(value: Json): string {
  return JSON.stringify(shrink(value, MAX_CHARS))
}

// ---------------------------------------------------------------------------
// Structural shrinking
// ---------------------------------------------------------------------------
//
// Every `shrink*` below returns a value whose compact serialization fits the
// budget it was given, provided the budget can hold an empty container (2
// chars). A container gives each child at least its floor, then shares what is
// left by water-filling: small children keep their full size and the largest
// absorb the cut. Children are only dropped when their floors cannot fit.
// Arrays drop from the tail (order carries meaning); objects drop their
// largest values first (keys are all meaningful).

/** Serialized size in characters (compact JSON). */
function size(value: Json): number {
  return JSON.stringify(value).length
}

/** Characters a container spends on brackets and commas for `count` children. */
function skeleton(count: number): number {
  return 2 + Math.max(0, count - 1)
}

/** Characters an object entry spends on its quoted key and colon. */
function keyCost(key: string): number {
  return size(key) + 1
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

/** Only strings and containers can give up characters; scalars are atomic. */
function shrinkable(value: Json): boolean {
  return typeof value === 'string' || (typeof value === 'object' && value !== null)
}

/**
 * The least budget a value is kept at when room is short; a scalar must fit
 * whole. The floor never exceeds half the container's own budget, so tiny
 * budgets still keep something rather than nothing.
 */
function floorSize(value: Json, maxChars: number): number {
  const full = size(value)
  return shrinkable(value) ? Math.min(full, MIN_SLOT, Math.max(2, Math.floor(maxChars / 2))) : full
}

/**
 * The least budget that keeps every object key inside `value`. Strings and
 * arrays inside may still be clipped to their `floorSize`, but no object loses
 * an entry.
 */
function keyFloor(value: Json, maxChars: number): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return floorSize(value, maxChars)
  }
  const entries = Object.entries(value)
  return skeleton(entries.length) + sum(entries.map(([k, v]) => keyCost(k) + keyFloor(v, maxChars)))
}

function shrink(value: Json, maxChars: number): Json {
  if (size(value) <= maxChars) return value
  if (typeof value === 'string') return shrinkString(value, maxChars)
  if (Array.isArray(value)) return shrinkArray(value, maxChars)
  if (typeof value === 'object' && value !== null) return shrinkObject(value, maxChars)
  return value
}

function shrinkString(value: string, maxChars: number): string {
  const suffix = ` ${TRUNCATION_MARKER} ${value.length.toLocaleString()} chars`
  let keep = Math.max(0, maxChars - suffix.length - 2)
  let out = value.slice(0, keep) + suffix
  // Escapes inflate the serialized form; back off until it fits.
  while (keep > 0 && size(out) > maxChars) {
    keep = Math.max(0, keep - (size(out) - maxChars))
    out = value.slice(0, keep) + suffix
  }
  // No room for a prefix and the size note: keep as much of the marker as fits.
  return size(out) <= maxChars ? out : TRUNCATION_MARKER.slice(0, Math.max(0, maxChars - 2))
}

/**
 * Split `available` characters across children: each gets its floor, then the
 * rest is water-filled over what each still wants, smallest want first, so
 * every child either reaches its full size or takes an equal share of what is
 * left. Requires `available >= Σ floors`.
 */
function allocate(sizes: number[], floors: number[], available: number): number[] {
  const allocation = [...floors]
  const wants = sizes.map((full, i) => full - floors[i])
  const order = wants.map((_, i) => i).sort((a, b) => wants[a] - wants[b])
  let remaining = available - sum(floors)
  let count = order.length
  for (const i of order) {
    const extra = Math.min(wants[i], Math.floor(remaining / count))
    allocation[i] += extra
    remaining -= extra
    count--
  }
  return allocation
}

function shrinkArray(items: Json[], maxChars: number): Json[] {
  const marker = (dropped: number) => `${TRUNCATION_MARKER} ${dropped.toLocaleString()} more items`
  // Items keep every key, so a list of records keeps whole records from the
  // start rather than every record cut down to a few fields.
  const floors = items.map((item) => keyFloor(item, maxChars))

  let keep = items.length
  if (sum(floors) + skeleton(keep) > maxChars) {
    // Keep the longest prefix whose floors fit beside a tail marker (sized for
    // the largest possible count, so the real one always fits).
    let used = skeleton(0) + size(marker(items.length)) + 1
    keep = 0
    while (keep < items.length && used + floors[keep] + 1 <= maxChars) {
      used += floors[keep] + 1
      keep++
    }
    // The next item cannot keep all its keys. Keep it cut down anyway when
    // nothing else fit or a quarter of the budget would otherwise go unused.
    const room = maxChars - used - 1
    const cutDown = floorSize(items[keep], maxChars)
    if ((keep === 0 || room >= maxChars / 4) && cutDown <= room) {
      floors[keep] = cutDown
      keep++
    }
  }

  const kept = items.slice(0, keep)
  const dropped = items.length - keep
  const tail = dropped > 0 ? size(marker(dropped)) + (keep > 0 ? 1 : 0) : 0
  const allocation = allocate(
    kept.map(size),
    floors.slice(0, keep),
    maxChars - skeleton(keep) - tail
  )
  const out = kept.map((item, i) => shrink(item, allocation[i]))
  if (dropped > 0 && size([...out, marker(dropped)]) <= maxChars) {
    out.push(marker(dropped))
  }
  return out
}

function shrinkObject(value: { [key: string]: Json }, maxChars: number): { [key: string]: Json } {
  const entries = Object.entries(value)
  const valueSizes = entries.map(([, v]) => size(v))

  // Every key fits: keep them all and share the rest. `Object.fromEntries`
  // keeps a `__proto__` key as data, where assignment would not.
  const keyFloors = entries.map(([, v]) => keyFloor(v, maxChars))
  const fixed = skeleton(entries.length) + sum(entries.map(([k]) => keyCost(k)))
  if (fixed + sum(keyFloors) <= maxChars) {
    const allocation = allocate(valueSizes, keyFloors, maxChars - fixed)
    return Object.fromEntries(entries.map(([k, v], i) => [k, shrink(v, allocation[i])]))
  }

  // The marker entry must not shadow a real key.
  let markerKey = TRUNCATION_MARKER
  while (Object.hasOwn(value, markerKey)) markerKey += ' '
  const floors = entries.map(([k, v]) => keyCost(k) + floorSize(v, maxChars))
  const noteFloor = (chars: number) =>
    Math.min(chars, MIN_SLOT, Math.max(2, Math.floor(maxChars / 2)))

  // Drop the largest values first, only until the rest fit at their
  // `floorSize`. Costs are tracked incrementally so a wide object stays linear
  // in its key count; the marker note's cost is derived from the omitted names.
  const byValueSize = entries.map((_, i) => i).sort((a, b) => valueSizes[b] - valueSizes[a])
  const dropped = new Set<number>()
  let present = entries.length
  let floorsSum = sum(floors)
  let namesLength = 0
  const noteLength = () =>
    `${dropped.size.toLocaleString()} keys omitted: `.length + namesLength + 2 * (dropped.size - 1)
  const cost = () => {
    const marker = dropped.size > 0 ? keyCost(markerKey) + noteFloor(noteLength() + 2) : 0
    return skeleton(present + (dropped.size > 0 ? 1 : 0)) + floorsSum + marker
  }
  for (const i of byValueSize) {
    if (cost() <= maxChars) break
    dropped.add(i)
    present--
    floorsSum -= floors[i]
    namesLength += size(entries[i][0]) - 2
  }

  const kept = entries.filter((_, i) => !dropped.has(i))
  const omitted = [...dropped].sort((a, b) => a - b).map((i) => entries[i][0])
  const note = `${omitted.length.toLocaleString()} keys omitted: ${omitted.join(', ')}`
  if (cost() > maxChars) {
    // Not even the marker fits at its floor: keep as much of it as there is
    // room for, or nothing.
    const room = maxChars - 2 - keyCost(markerKey)
    return room >= 2 ? { [markerKey]: shrink(note, room) } : {}
  }
  const all: [string, Json][] = [...kept]
  if (omitted.length > 0) all.push([markerKey, note])
  const values = all.map(([, v]) => v)
  // The note is shrunk like any other value, so it can never overshoot.
  const allocation = allocate(
    values.map(size),
    values.map((v) => floorSize(v, maxChars)),
    maxChars - skeleton(all.length) - sum(all.map(([k]) => keyCost(k)))
  )
  return Object.fromEntries(all.map(([k, v], i) => [k, shrink(v, allocation[i])]))
}
