import { describe, expect, it } from 'vitest'
import { parseClientInfo } from '../src/client-info'

describe('parseClientInfo', () => {
  it('keeps a well-formed pair', () => {
    expect(parseClientInfo({ name: 'cursor', version: '2.1.0' })).toEqual({
      name: 'cursor',
      version: '2.1.0'
    })
  })

  it('keeps the name as-is, unnormalized', () => {
    expect(parseClientInfo({ name: 'some-future-client', version: '9.9' })).toEqual({
      name: 'some-future-client',
      version: '9.9'
    })
  })

  it('returns undefined for missing or unusable info, never throws', () => {
    expect(parseClientInfo(undefined)).toBeUndefined()
    expect(parseClientInfo(null)).toBeUndefined()
    expect(parseClientInfo({})).toBeUndefined()
    expect(parseClientInfo({ name: '   ' })).toBeUndefined()
    expect(parseClientInfo({ name: 42 })).toBeUndefined()
    expect(parseClientInfo('cursor')).toBeUndefined()
  })

  it('bounds oversized values', () => {
    expect(parseClientInfo({ name: 'x'.repeat(65) })).toBeUndefined()
    expect(parseClientInfo({ name: 'cursor', version: 'v'.repeat(33) })).toBeUndefined()
  })
})
