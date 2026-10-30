import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { withCachedJsonSchema } from '../../src/lib/isolate-json-schema'

describe('withCachedJsonSchema', () => {
  const options = { target: 'draft-2020-12' } as const

  it('converts once per io and target, with the same result as zod', () => {
    const plain = z.object({ code: z.string().describe('Code'), n: z.number().optional() })
    const cached = withCachedJsonSchema(
      z.object({ code: z.string().describe('Code'), n: z.number().optional() })
    )
    const jsonSchema = cached['~standard'].jsonSchema

    const first = jsonSchema.input(options)
    expect(first).toEqual(plain['~standard'].jsonSchema.input(options))
    expect(jsonSchema.input(options)).toBe(first)
    expect(jsonSchema.output(options)).toEqual(plain['~standard'].jsonSchema.output(options))
    expect(jsonSchema.input({ target: 'draft-07' })).not.toBe(first)
  })

  it('still validates with zod', () => {
    const cached = withCachedJsonSchema(z.object({ code: z.string() }))

    expect(cached.safeParse({ code: 'x' }).success).toBe(true)
    expect(cached.safeParse({ code: 1 }).success).toBe(false)
    expect(cached['~standard'].validate({ code: 1 })).toHaveProperty('issues')
  })
})
