import { describe, expect, it } from 'vitest'
import {
  apiFailureKind,
  classified,
  isToolErrorKind,
  refusalKind,
  toolErrorOf
} from '../src/tool-errors'

describe('toolErrorOf', () => {
  it('reads the kind and status a tool tagged its error result with', () => {
    const result = classified({ content: [], isError: true }, 'api_5xx', 502)
    expect(toolErrorOf(result)).toEqual({ kind: 'api_5xx', status: 502 })
  })

  it('calls an untagged error result other, and a success nothing', () => {
    expect(toolErrorOf({ content: [], isError: true })).toEqual({ kind: 'other' })
    expect(toolErrorOf(classified({ content: [] }, 'internal'))).toBeUndefined()
    expect(toolErrorOf(undefined)).toBeUndefined()
  })

  it('keeps the tag off the result itself, so it never reaches the client', () => {
    const result = classified({ content: [], isError: true }, 'code_error')
    expect(JSON.parse(JSON.stringify(result))).toEqual({ content: [], isError: true })
  })
})

describe('error kinds', () => {
  it('names a refusal by the permission decision', () => {
    expect(refusalKind('missing')).toBe('refused_missing_scope')
    expect(refusalKind('unreachable')).toBe('refused_no_oauth_scope')
    expect(refusalKind('granted')).toBe('refused_other')
    expect(refusalKind('direct')).toBe('refused_other')
    expect(refusalKind('unlisted')).toBe('refused_other')
  })

  it('names any other failed answer by its status', () => {
    expect(apiFailureKind(429)).toBe('rate_limited')
    expect(apiFailureKind(404)).toBe('api_4xx')
    expect(apiFailureKind(503)).toBe('api_5xx')
    expect(apiFailureKind(200)).toBe('api_other')
  })

  it('accepts only known kinds from the sandbox', () => {
    expect(isToolErrorKind('policy_refused')).toBe(true)
    expect(isToolErrorKind('made_up')).toBe(false)
    expect(isToolErrorKind(undefined)).toBe(false)
  })
})
