import { record } from './json-schema.ts'

/** An OpenAPI Overlay 1.0 document (https://spec.openapis.org/overlay/v1.0.0). */
export interface Overlay {
  overlay: string
  info: { title: string; version: string }
  actions: Array<{ target: string; description?: string; update?: unknown; remove?: boolean }>
}

/**
 * Parse a JSONPath of plain member accesses: `$.a.b['c d'].e`. Wildcards and
 * filters aren't needed for targeted fixes and are rejected.
 */
export function parseTarget(target: string): string[] {
  if (!target.startsWith('$')) throw new Error(`Overlay target must start with $: ${target}`)
  const segments: string[] = []
  const pattern = /\.([A-Za-z0-9_$-]+)|\['((?:[^'\\]|\\.)*)'\]/gy
  pattern.lastIndex = 1
  while (pattern.lastIndex < target.length) {
    const match = pattern.exec(target)
    if (!match) throw new Error(`Unsupported overlay target: ${target}`)
    segments.push(match[1] ?? match[2]!.replace(/\\(.)/g, '$1'))
  }
  return segments
}

function merge(target: Record<string, unknown>, update: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(update)) {
    const current = target[key]
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
      merge(current as Record<string, unknown>, value as Record<string, unknown>)
    } else {
      target[key] = structuredClone(value)
    }
  }
}

/**
 * Apply overlay actions in order to a copy of `document`. Every target must
 * exist, so an upstream fix or rename shows up as a build failure instead of
 * a silently stale override.
 */
export function applyOverlay<T>(document: T, overlay: Overlay): T {
  if (!overlay.overlay.startsWith('1.'))
    throw new Error(`Unsupported overlay version ${overlay.overlay}`)
  const result = structuredClone(document)
  for (const action of overlay.actions) {
    const path = parseTarget(action.target)
    let parent: unknown = result
    for (const segment of path.slice(0, -1)) parent = record(parent)[segment]
    const key = path.at(-1)
    const container = record(parent)
    if (key === undefined) throw new Error('An overlay action cannot target the document root')
    if (!(key in container)) throw new Error(`Overlay target not found: ${action.target}`)
    if (action.remove) delete container[key]
    else if (action.update !== undefined) {
      const current = container[key]
      if (
        current &&
        typeof current === 'object' &&
        action.update &&
        typeof action.update === 'object'
      ) {
        merge(current as Record<string, unknown>, action.update as Record<string, unknown>)
      } else container[key] = structuredClone(action.update)
    }
  }
  return result
}
