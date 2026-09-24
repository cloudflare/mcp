import { describe, it, expect } from 'vitest'
import { stringifyResponse, truncateResponse } from '../src/truncate'

describe('truncateResponse', () => {
  it('should return string content unchanged if under limit', () => {
    const content = 'Hello, world!'
    expect(truncateResponse(content)).toBe(content)
  })

  it('should return JSON-stringified objects if under limit', () => {
    const content = { foo: 'bar', num: 42 }
    expect(truncateResponse(content)).toBe(JSON.stringify(content, null, 2))
  })

  it('should truncate long strings and add message', () => {
    // MAX_CHARS = 6000 * 4 = 24000
    const longString = 'x'.repeat(30000)
    const result = truncateResponse(longString)

    expect(result.length).toBeLessThan(longString.length)
    expect(result).toContain('--- TRUNCATED ---')
    expect(result).toContain('tokens (limit: 6,000)')
  })

  it('should truncate large objects to valid JSON of the same shape', () => {
    const largeArray = Array(5000).fill({ key: 'value', nested: { a: 1, b: 2 } })
    const result = truncateResponse(largeArray)
    const parsed = JSON.parse(result)

    expect(result.length).toBeLessThanOrEqual(24000)
    expect(parsed.at(-1)).toMatch(/^--- TRUNCATED --- [\d,]+ more items$/)
    expect(parsed.slice(0, -1)).toEqual(largeArray.slice(0, parsed.length - 1))
  })

  it('should not truncate content at exactly the limit', () => {
    const exactContent = 'y'.repeat(24000) // MAX_CHARS exactly
    const result = truncateResponse(exactContent)

    expect(result).toBe(exactContent)
    expect(result).not.toContain('TRUNCATED')
  })

  it('should handle empty strings', () => {
    expect(truncateResponse('')).toBe('')
  })

  it('should handle null as JSON', () => {
    expect(truncateResponse(null)).toBe('null')
  })

  it('should handle arrays', () => {
    const arr = [1, 2, 3]
    expect(truncateResponse(arr)).toBe(JSON.stringify(arr, null, 2))
  })

  it('should render undefined as text instead of throwing', () => {
    expect(truncateResponse(undefined)).toBe('undefined')
  })
})

describe('truncateResponse with oversized JSON', () => {
  const MAX_CHARS = 24000

  it('cuts the largest values first so small fields survive', () => {
    const body = {
      success: true,
      errors: [],
      result: Array.from({ length: 2000 }, (_, i) => ({
        id: `record-${i}`,
        content: 'x'.repeat(40)
      })),
      result_info: { page: 1, per_page: 2000, total_count: 2000 }
    }
    const result = truncateResponse(body)
    const parsed = JSON.parse(result)

    expect(result.length).toBeLessThanOrEqual(MAX_CHARS)
    expect(parsed.success).toBe(true)
    expect(parsed.errors).toEqual([])
    expect(parsed.result_info).toEqual(body.result_info)
    expect(parsed.result.at(-1)).toMatch(/^--- TRUNCATED --- [\d,]+ more items$/)
  })

  it('keeps whole records from the start of a long list', () => {
    const records = Array.from({ length: 500 }, (_, i) => ({
      id: `record-${i}`,
      name: `host-${i}.example.com`,
      type: 'A',
      content: `198.51.100.${i % 255}`,
      proxied: true,
      ttl: 3600,
      comment: 'Domain verification record',
      meta: { auto_added: false, source: 'primary' }
    }))
    const parsed = JSON.parse(truncateResponse({ success: true, result: records }))
    const kept = parsed.result.slice(0, -1)

    expect(kept.length).toBeGreaterThan(50)
    expect(kept).toEqual(records.slice(0, kept.length))
    expect(parsed.result.at(-1)).toBe(
      `--- TRUNCATED --- ${(500 - kept.length).toLocaleString()} more items`
    )
  })

  it('clips a long field in each record rather than dropping its other fields', () => {
    const records = Array.from({ length: 300 }, (_, i) => ({
      id: i,
      name: `op-${i}`,
      description: 'd'.repeat(2000)
    }))
    const parsed = JSON.parse(truncateResponse(records))
    const kept = parsed.slice(0, -1)

    expect(kept.length).toBeGreaterThan(100)
    kept.forEach((record: { id: number; name: string; description: string }, i: number) => {
      expect(record.id).toBe(i)
      expect(record.name).toBe(`op-${i}`)
      expect(record.description).toMatch(/^d+ --- TRUNCATED --- 2,000 chars$/)
    })
  })

  it('cuts down a single record bigger than the cap instead of dropping it', () => {
    const record = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`field_${i}`, i]))
    const result = truncateResponse([record, record])
    const parsed = JSON.parse(result)

    expect(result.length).toBeLessThanOrEqual(MAX_CHARS)
    expect(parsed[0].field_0).toBe(0)
    expect(parsed[0]['--- TRUNCATED ---']).toMatch(/^[\d,]+ keys omitted: /)
    expect(parsed[1]).toBe('--- TRUNCATED --- 1 more items')
  })

  it('clips a long string value in place', () => {
    const parsed = JSON.parse(truncateResponse({ id: 'my-worker', script: 'x'.repeat(50000) }))

    expect(parsed.id).toBe('my-worker')
    expect(parsed.script).toMatch(/^x+ --- TRUNCATED --- 50,000 chars$/)
  })

  it('names the keys it drops without shadowing a real key', () => {
    const value: Record<string, string> = { '--- TRUNCATED ---': 'real' }
    for (let i = 0; i < 400; i++) value[`key_${i}`] = 'v'.repeat(200)
    const result = truncateResponse(value)
    const parsed = JSON.parse(result)

    expect(result.length).toBeLessThanOrEqual(MAX_CHARS)
    expect(parsed['--- TRUNCATED ---']).toBe('real')
    expect(parsed['--- TRUNCATED --- ']).toMatch(/^[\d,]+ keys omitted: key_/)
  })

  it('returns compact JSON whole when only the indentation overflows', () => {
    const rows = Array.from({ length: 700 }, (_, i) => ({ id: i, ok: true }))
    expect(JSON.stringify(rows, null, 2).length).toBeGreaterThan(MAX_CHARS)

    expect(truncateResponse(rows)).toBe(JSON.stringify(rows))
  })

  it('treats an oversized JSON string like the value it holds', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: i }))
    const result = truncateResponse(JSON.stringify(rows, null, 2))
    const parsed = JSON.parse(result)

    expect(result.length).toBeLessThanOrEqual(MAX_CHARS)
    expect(parsed.at(-1)).toMatch(/^--- TRUNCATED --- [\d,]+ more items$/)
    expect(parsed.slice(0, -1)).toEqual(rows.slice(0, parsed.length - 1))
  })

  it('cuts text that only looks like JSON as plain text', () => {
    const cutOff = '[' + '{"id":1},'.repeat(5000)
    const result = truncateResponse(cutOff)

    expect(result.startsWith(cutOff.slice(0, MAX_CHARS))).toBe(true)
    expect(result).toContain('Use more specific queries')
  })

  it('stays within the cap as valid JSON for any structure', () => {
    let seed = 42
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
    const gen = (depth: number): unknown => {
      const t = rnd()
      if (depth > 3 || t < 0.25) {
        // Quotes and newlines need escapes, so serialized strings outgrow their length.
        return t < 0.1 ? Math.floor(rnd() * 1e9) : 's\u00e9"\n'.repeat(Math.floor(rnd() * 400))
      }
      if (t < 0.6) return Array.from({ length: Math.floor(rnd() * 8) }, () => gen(depth + 1))
      const o: Record<string, unknown> = {}
      for (let i = 0; i < rnd() * 6; i++) o[`k${i}`] = gen(depth + 1)
      return o
    }

    let truncated = 0
    for (let i = 0; i < 200; i++) {
      const value = gen(0)
      // Plain text is sliced with a trailing notice rather than kept as JSON.
      if (typeof value === 'string') continue
      const result = truncateResponse(value)
      expect(result.length).toBeLessThanOrEqual(MAX_CHARS)
      expect(() => JSON.parse(result)).not.toThrow()
      if (result.includes('--- TRUNCATED ---')) truncated++
    }
    expect(truncated).toBeGreaterThan(30)
  })
})

describe('stringifyResponse', () => {
  it('returns oversized strings whole', () => {
    const longString = 'x'.repeat(30000)
    expect(stringifyResponse(longString)).toBe(longString)
  })

  it('pretty-prints oversized values whole', () => {
    const largeArray = Array(5000).fill({ key: 'value', nested: { a: 1, b: 2 } })
    expect(stringifyResponse(largeArray)).toBe(JSON.stringify(largeArray, null, 2))
  })

  it('renders undefined as text', () => {
    expect(stringifyResponse(undefined)).toBe('undefined')
  })
})
