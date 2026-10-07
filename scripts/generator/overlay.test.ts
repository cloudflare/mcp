import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyOverlay, parseTarget } from './overlay.ts'
import overlay from './overlays/mcp.overlay.json' with { type: 'json' }

test('parses member and quoted member paths', () => {
  assert.deepEqual(parseTarget("$.components.schemas['iam_account settings'].properties"), [
    'components',
    'schemas',
    'iam_account settings',
    'properties'
  ])
  assert.throws(() => parseTarget('$.paths[*]'), /Unsupported overlay target/)
})

test('applies update, remove then update, and leaves the input untouched', () => {
  const document = { a: { b: { c: 1, d: { $ref: '#/x' } } } }
  const result = applyOverlay(document, {
    overlay: '1.0.0',
    info: { title: 't', version: '1' },
    actions: [
      { target: '$.a.b', update: { c: 2 } },
      { target: "$.a.b['d']", remove: true },
      { target: '$.a.b', update: { d: { type: 'string' } } }
    ]
  })
  assert.deepEqual(result, { a: { b: { c: 2, d: { type: 'string' } } } })
  assert.deepEqual(document, { a: { b: { c: 1, d: { $ref: '#/x' } } } })
})

test('fails when a target no longer exists, so stale overrides surface', () => {
  assert.throws(
    () =>
      applyOverlay(
        { a: {} },
        {
          overlay: '1.0.0',
          info: { title: 't', version: '1' },
          actions: [{ target: '$.a.gone', remove: true }]
        }
      ),
    /Overlay target not found: \$\.a\.gone/
  )
})

test('the shipped overlay is a valid Overlay 1.0 document', () => {
  assert.equal(overlay.overlay, '1.0.0')
  for (const action of overlay.actions) assert.doesNotThrow(() => parseTarget(action.target))
})
