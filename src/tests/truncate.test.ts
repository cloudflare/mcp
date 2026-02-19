import { describe, it, expect } from 'vitest'
import { truncateResponse } from '../truncate'

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

  it('should truncate large objects and add message', () => {
    const largeArray = Array(5000).fill({ key: 'value', nested: { a: 1, b: 2 } })
    const result = truncateResponse(largeArray)

    expect(result).toContain('--- TRUNCATED ---')
    expect(result).toContain('Use more specific queries')
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
})
