import { describe, expect, it } from 'vitest'
import { declaresResult, isEnvelope, payloadOf } from '../src/forge-tools/envelope'

describe('isEnvelope', () => {
  it("matches Cloudflare's envelope, and nothing else", () => {
    expect(isEnvelope({ success: true, errors: [], messages: [], result: null })).toBe(true)
    expect(isEnvelope({ success: false, result: {} })).toBe(true)
    expect(isEnvelope({ result: {} })).toBe(false)
    expect(isEnvelope({ success: 'yes', result: {} })).toBe(false)
    expect(isEnvelope([{ success: true, result: 1 }])).toBe(false)
    expect(isEnvelope(null)).toBe(false)
  })
})

describe('declaresResult', () => {
  const defs = {
    page: { type: 'object', properties: { result: { type: 'array' }, result_info: {} } },
    zone: { type: 'object', properties: { id: { type: 'string' } } },
    loop: { $ref: '#/$defs/loop' }
  }

  it('reads properties directly, through $ref and allOf', () => {
    expect(declaresResult({ properties: { result: {} } })).toBe(true)
    expect(declaresResult({ $ref: '#/$defs/page' }, defs)).toBe(true)
    expect(
      declaresResult({ allOf: [{ $ref: '#/$defs/zone' }, { $ref: '#/$defs/page' }] }, defs)
    ).toBe(true)
    expect(declaresResult({ $ref: '#/$defs/zone' }, defs)).toBe(false)
    expect(declaresResult({ type: 'string' })).toBe(false)
  })

  it('needs every branch of a union, and stops at a $ref cycle', () => {
    expect(
      declaresResult({ oneOf: [{ $ref: '#/$defs/page' }, { $ref: '#/$defs/page' }] }, defs)
    ).toBe(true)
    expect(
      declaresResult({ anyOf: [{ $ref: '#/$defs/page' }, { $ref: '#/$defs/zone' }] }, defs)
    ).toBe(false)
    expect(declaresResult({ $ref: '#/$defs/loop' }, defs)).toBe(false)
  })
})

describe('payloadOf', () => {
  const envelope = {
    success: true,
    errors: [],
    messages: [{ code: 1, message: 'm' }],
    result: { id: 'z' }
  }

  it("takes an envelope's result, or keeps a listing's envelope whole", () => {
    expect(payloadOf(envelope, 'result')).toEqual({ payload: { id: 'z' }, at: '/result' })
    const listing = { ...envelope, result: [1], result_info: { page: 1 } }
    expect(payloadOf(listing, 'listing')).toEqual({ payload: listing, at: '' })
  })

  it("leaves a body that isn't an envelope as it is", () => {
    const body = { data: [1] }
    expect(payloadOf(body, 'result')).toEqual({ payload: body, at: '' })
    expect(payloadOf('text', 'listing')).toEqual({ payload: 'text', at: '' })
  })
})
