import { describe, expect, it } from 'vitest'
import { DIRECT_CONNECTION } from '../src/api-permissions'
import type { Connection } from '../src/api-permissions'
import { executionErrorKind } from '../src/tools/execute'
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

  it('names a failed execute run by what the sandbox reported, most specific first', () => {
    const oauth: Connection = { kind: 'oauth', scopes: [] }
    const failed = (fields: Partial<Parameters<typeof executionErrorKind>[0]>) =>
      executionErrorKind(
        {
          ok: false,
          message: 'failed',
          replaySafe: true,
          rateLimits: undefined,
          errorKind: undefined,
          ...fields
        },
        oauth
      )

    expect(failed({ needsAccount: true, stopped: true, apiStatus: 500 })).toBe('needs_account')
    expect(failed({ stopped: true, graphqlRefusal: 'zone', apiStatus: 500 })).toBe('run_stopped')
    expect(failed({ graphqlRefusal: 'zone', errorKind: 'api_4xx', notSent: true })).toBe(
      'refused_missing_scope'
    )
    expect(failed({ errorKind: 'policy_refused', notSent: true, apiStatus: 403 })).toBe(
      'policy_refused'
    )
    expect(failed({ notSent: true, apiStatus: 429 })).toBe('not_sent')
    expect(failed({ apiStatus: 429 })).toBe('rate_limited')
    expect(failed({ apiStatus: 502 })).toBe('api_5xx')
    expect(failed({})).toBe('code_error')
  })

  it('names a GraphQL refusal by the connection and the dataset kind', () => {
    const refusal = (graphqlRefusal: 'zone' | 'account', connection: Connection) =>
      executionErrorKind(
        {
          ok: false,
          message: 'failed',
          replaySafe: true,
          rateLimits: undefined,
          errorKind: undefined,
          graphqlRefusal
        },
        connection
      )

    expect(refusal('zone', { kind: 'oauth', scopes: [] })).toBe('refused_missing_scope')
    expect(refusal('account', { kind: 'oauth', scopes: [] })).toBe('refused_missing_scope')
    expect(refusal('zone', { kind: 'oauth', scopes: ['analytics.read'] })).toBe('refused_other')
    expect(refusal('account', { kind: 'oauth', scopes: ['account-analytics.read'] })).toBe(
      'refused_other'
    )
    expect(refusal('zone', DIRECT_CONNECTION)).toBe('refused_other')
  })

  it('accepts only known kinds from the sandbox', () => {
    expect(isToolErrorKind('policy_refused')).toBe(true)
    expect(isToolErrorKind('made_up')).toBe(false)
    expect(isToolErrorKind(undefined)).toBe(false)
  })
})
