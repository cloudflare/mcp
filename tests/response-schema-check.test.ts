import { describe, expect, it } from 'vitest'
import type { ToolResponses } from '../src/generated/forge-mcp'
import {
  findMismatch,
  responseKeyFor,
  safeInstancePath,
  trimForCheck
} from '../src/response-schema-check'
import { productOf, sampleRateFrom } from '../src/response-validation'

const SECRET = 'customer-secret.example.com'
const MAX_ITEMS = 25

/** Response schemas in the shape forge generates them. */
const RESPONSES: ToolResponses = {
  schemas: {
    '200': {
      type: 'object',
      required: ['result'],
      properties: {
        result: { type: 'array', minItems: 30, items: { $ref: '#/$defs/record' } }
      }
    },
    '204': null,
    '4XX': { $ref: '#/$defs/failure' },
    default: { type: 'object', required: ['fallback'] }
  },
  $defs: {
    record: {
      type: 'object',
      required: ['id', 'type'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        type: { type: 'string', enum: ['A', 'AAAA'] },
        ttl: { anyOf: [{ type: 'integer' }, { type: 'string', enum: ['auto'] }] },
        meta: { type: 'object', additionalProperties: { type: 'integer' } }
      }
    },
    failure: {
      type: 'object',
      required: ['success', 'errors'],
      properties: { success: { type: 'boolean' }, errors: { type: 'array' } }
    }
  }
}

function check(body: unknown, status = 200, responses = RESPONSES) {
  return findMismatch(responses, trimForCheck(status, body, MAX_ITEMS), 'test_tool')
}

function records(count: number, record: Record<string, unknown> = { id: 'r', type: 'A' }) {
  return { result: Array.from({ length: count }, () => ({ ...record })) }
}

describe('findMismatch', () => {
  it('finds nothing when the body matches', () => {
    expect(check(records(30, { id: 'r', type: 'A', ttl: 'auto', meta: { a: 1 } }))).toBeUndefined()
  })

  it('names the keyword and the component schema it lives in', () => {
    const mismatch = check(records(30, { id: 'r', type: 'CNAME' }))

    // Only the first 25 items are checked, so the count is a lower bound.
    expect(mismatch).toMatchObject({ responseKey: '200', errorCount: 25, counted: false })
    expect(mismatch?.errors[0]).toEqual({
      keyword: 'enum',
      schemaLocation: '#/components/schemas/record/properties/type/enum',
      instancePath: '/result/*/type'
    })
  })

  it('locates violations in the response schema itself, naming a missing property', () => {
    expect(check({}, 200)?.errors[0]).toEqual({
      keyword: 'required',
      schemaLocation: '#/responses/200/schema/required',
      instancePath: '/result'
    })
    expect(check({ other: true }, 500)?.errors[0]).toEqual({
      keyword: 'required',
      schemaLocation: '#/responses/default/schema/required',
      instancePath: '/fallback'
    })
  })

  it('checks error responses: the status, then its class, then default', () => {
    expect(check({ success: false }, 403)).toMatchObject({
      responseKey: '4XX',
      errorCount: 1,
      counted: true,
      errors: [{ keyword: 'required', instancePath: '/errors' }]
    })
    expect(check({ success: false, errors: [] }, 404)).toBeUndefined()
    expect(check({}, 503)?.responseKey).toBe('default')
  })

  it('stops at a documented response that has no JSON body', () => {
    expect(check({ anything: true }, 204)).toBeUndefined()
    expect(
      check({}, 200, { schemas: { '200': null, default: { type: 'string' } } })
    ).toBeUndefined()
  })

  it('counts one violation for an anyOf, not one per alternative', () => {
    expect(check(records(30, { id: 'r', type: 'A', ttl: true }))?.errors).toEqual([
      expect.objectContaining({ keyword: 'anyOf', instancePath: '/result/*/ttl' }),
      ...Array.from({ length: 4 }, () => expect.objectContaining({ keyword: 'anyOf' }))
    ])
  })

  it('counts a declared property that fails once, though additionalProperties is false', () => {
    // The validator re-checks a failing declared property against
    // additionalProperties; that second report is dropped.
    expect(check(records(1, { id: 'r', type: 'MX' }))).toMatchObject({
      errorCount: 2,
      errors: [{ keyword: 'minItems' }, { keyword: 'enum' }]
    })
  })

  it('reports an unexpected property at its parent without naming it', () => {
    expect(check(records(30, { id: 'r', type: 'A', [SECRET]: 'x' }))?.errors[0]).toEqual({
      keyword: 'additionalProperties',
      schemaLocation: '#/components/schemas/record/additionalProperties',
      instancePath: '/result/*'
    })
  })

  it('never includes response values, keys the schema does not declare, or indices', () => {
    const mismatch = check(records(30, { id: SECRET, type: SECRET, meta: { [SECRET]: SECRET } }))

    expect(mismatch?.errors).toContainEqual({
      keyword: 'type',
      schemaLocation: '#/components/schemas/record/properties/meta/additionalProperties/type',
      instancePath: '/result/*/meta/*'
    })
    expect(JSON.stringify(mismatch)).not.toContain('customer-secret')
  })

  it(`checks only the first ${MAX_ITEMS} items of an array`, () => {
    const body = records(100)
    body.result[MAX_ITEMS] = { id: 'r', type: 'MX' }
    expect(check(body)).toBeUndefined()

    body.result[0] = { id: 'r', type: 'MX' }
    expect(check(body)).toMatchObject({ errorCount: 1, counted: false })
  })

  it('ignores minItems on an array it trimmed, but not on a whole one', () => {
    expect(check(records(MAX_ITEMS + 10))).toBeUndefined()
    expect(check(records(3))?.errors[0]).toMatchObject({
      keyword: 'minItems',
      instancePath: '/result'
    })
  })

  it('leaves the generated schemas untouched', () => {
    const before = JSON.stringify(RESPONSES)
    check(records(30))
    check(records(30, { id: 'r', type: 'X' }))
    expect(JSON.stringify(RESPONSES)).toBe(before)
  })

  it('throws on a broken schema; the caller catches it', () => {
    const broken: ToolResponses = { schemas: { '200': { $ref: '#/$defs/missing' } } }
    expect(() => findMismatch(broken, trimForCheck(200, {}, MAX_ITEMS), 'broken')).toThrow()
  })
})

describe('trimForCheck', () => {
  it('cuts arrays, records where in the validator’s location format, and counts values', () => {
    const trimmed = trimForCheck(
      200,
      { 'a/b c': Array.from({ length: 30 }, (_, i) => i), ok: [1] },
      MAX_ITEMS
    )
    expect(trimmed.trimmed).toEqual(['#/a~1b%20c'])
    expect((trimmed.body as { 'a/b c': number[] })['a/b c']).toHaveLength(MAX_ITEMS)
    expect(trimmed.values).toBe(1 + 1 + MAX_ITEMS + 1 + 1)
  })
})

describe('responseKeyFor', () => {
  it('prefers the exact status, then its class, then default', () => {
    const schemas = { '200': {}, '4XX': {}, default: {} }
    expect(responseKeyFor(schemas, 200)).toBe('200')
    expect(responseKeyFor(schemas, 429)).toBe('4XX')
    expect(responseKeyFor(schemas, 500)).toBe('default')
    expect(responseKeyFor({ '200': {} }, 500)).toBeUndefined()
  })
})

describe('safeInstancePath', () => {
  it('keeps declared property names and replaces indices and other keys with *', () => {
    const declared = new Set(['result', 'meta', '0'])
    expect(safeInstancePath('#/result/12/meta/host.example.com', declared)).toBe('/result/*/meta/*')
    expect(safeInstancePath('#', declared)).toBe('/')
  })

  it("reads the validator's URI-encoded tokens", () => {
    const declared = new Set(['zone name', 'a/b'])
    expect(safeInstancePath('#/zone%20name/a~1b/caf%C3%A9', declared)).toBe('/zone name/a~1b/*')
  })
})

describe('productOf', () => {
  it('routes by the segment after the account or zone, merged or not', () => {
    expect(productOf('/zones/{zone_id}/dns_records')).toBe('dns_records')
    expect(productOf('/{account_or_zone}/{account_or_zone_id}/access/apps')).toBe('access')
    expect(productOf('/user/tokens')).toBe('user')
  })
})

describe('sampleRateFrom', () => {
  it('reads a fraction, clamps it, and defaults to checking everything', () => {
    expect(sampleRateFrom('0.25')).toBe(0.25)
    expect(sampleRateFrom('0')).toBe(0)
    expect(sampleRateFrom('5')).toBe(1)
    expect(sampleRateFrom('-1')).toBe(0)
    expect(sampleRateFrom(undefined)).toBe(1)
    expect(sampleRateFrom('')).toBe(1)
    expect(sampleRateFrom('often')).toBe(1)
  })
})
