import { describe, expect, it } from 'vitest'
import {
  afterCreate,
  afterSave,
  afterUndo,
  buttonLabel,
  handoffOf,
  hintFor,
  undoFailureLine,
  unconfirmedNote
} from '../src/threshold-alert/form'
import type { Phase, WriteContext } from '../src/threshold-alert/form'
import { isPresetWrite } from '../src/threshold-alert/write-guard'
import {
  R2_STORAGE_BILLING,
  WORKERS_REQUESTS_BILLING,
  WORKERS_REQUESTS_MONITOR,
  WORKERS_SPEND,
  actionOf,
  monitorPolicy
} from '../src/threshold-alert/presets'
import { deriveModel, typicalPeriod } from '../src/threshold-alert/model'
import type { Day } from '../src/threshold-alert/model'

const ACCOUNT = '023e105f4ecef8ad9ca31a8372d0c353'
const POLICY = 'f'.repeat(32)

const context = (preset = WORKERS_REQUESTS_MONITOR, action = actionOf(preset)): WriteContext => ({
  preset,
  action,
  accountId: ACCOUNT,
  account: 'Usage Co',
  name: preset.name('1M', action.id),
  does: action.does('me@example.com'),
  what: preset.passes(1_000_000)
})

// The four answers a write can get, as `create.ts` classifies them.
const DONE = { status: 'done', ref: { id: POLICY } } as const
const REFUSED = {
  status: 'refused',
  error: 'Cloudflare API error: POST … returned HTTP 403\n{"errors":[{"message":"Forbidden"}]}'
} as const
const UNKNOWN = { status: 'unknown', error: 'Network connection lost' } as const

describe('the card after Create', () => {
  it('created: shows it on, remembers it for Undo, and tells the model the account it is on', () => {
    const step = afterCreate(DONE, context())
    expect(step).toMatchObject({ phase: { kind: 'created' }, made: { id: POLICY } })
    expect(step !== 'handoff' && step.tell).toContain(`(${POLICY}) on account Usage Co`)
  })

  it('refused: says it didn’t save and nothing was created, with Cloudflare’s reason', () => {
    const step = afterCreate(REFUSED, context())
    expect(step).toMatchObject({ phase: { kind: 'failed', write: 'create', unconfirmed: false } })
    if (step === 'handoff') throw new Error('handed off')
    expect(
      hintFor({ phase: step.phase, noun: 'alert', invalid: false, address: 'a@b.co' })
    ).toEqual({
      tone: 'bad',
      text: 'Didn’t save',
      say: 'Didn’t save: Forbidden. Nothing was created. Try again.'
    })
    expect(
      buttonLabel({
        phase: step.phase,
        action: actionOf(WORKERS_REQUESTS_MONITOR),
        saving: false,
        handoff: 'server'
      })
    ).toBe('Try again')
  })

  it('no answer: never says nothing was created, and tells the model to check first', () => {
    const step = afterCreate(UNKNOWN, context())
    if (step === 'handoff') throw new Error('handed off')
    expect(step.phase).toMatchObject({ kind: 'failed', write: 'create', unconfirmed: true })
    expect(step.tell).toContain('may have been created on account Usage Co')
    expect(
      hintFor({ phase: step.phase, noun: 'alert', invalid: false, address: 'a@b.co' })?.text
    ).toBe('May have saved')
    expect(unconfirmedNote(step.phase, 'alert')).toContain('may already exist')
    expect(
      buttonLabel({
        phase: step.phase,
        action: actionOf(WORKERS_REQUESTS_MONITOR),
        saving: false,
        handoff: 'server'
      })
    ).toBe('Create anyway')
  })

  it('no such tool: hands the alert to the chat instead', () => {
    expect(afterCreate({ status: 'unavailable' }, context())).toBe('handoff')
  })
})

describe('the card after Save, on the alert it made', () => {
  const made = { id: POLICY, version: 1 }

  it('saved: keeps the new version for the next write', () => {
    const step = afterSave(
      { status: 'done', ref: { id: POLICY, version: 2 } },
      made,
      context(WORKERS_SPEND)
    )
    expect(step).toMatchObject({ phase: { kind: 'created' }, made: { id: POLICY, version: 2 } })
    expect(step.tell).toContain(`${POLICY} updated on account Usage Co`)
  })

  it('refused: says it wasn’t changed', () => {
    const step = afterSave(REFUSED, made, context())
    expect(
      hintFor({ phase: step.phase, noun: 'alert', invalid: false, address: 'a@b.co' })?.say
    ).toBe('Didn’t save: Forbidden. The alert wasn’t changed. Try again.')
  })

  it('no answer: says it may have saved, never that it wasn’t changed, and tells the model', () => {
    const step = afterSave(UNKNOWN, made, context())
    expect(step.phase).toMatchObject({ kind: 'failed', write: 'save', unconfirmed: true })
    const hint = hintFor({ phase: step.phase, noun: 'alert', invalid: false, address: 'a@b.co' })
    expect(hint?.text).toBe('May have saved')
    expect(hint?.say).not.toContain('wasn’t changed')
    expect(step.tell).toContain('may or may not have been updated')
    expect(unconfirmedNote(step.phase, 'alert')).toContain('may already have the new threshold')
    expect(
      buttonLabel({
        phase: step.phase,
        action: actionOf(WORKERS_REQUESTS_MONITOR),
        saving: true,
        handoff: 'server'
      })
    ).toBe('Save anyway')
  })
})

describe('the card after Undo', () => {
  const made = { id: POLICY }

  it('deleted: back to the form, and the model told no alert exists', () => {
    const step = afterUndo({ status: 'done' }, made, context())
    expect(step).toMatchObject({ phase: { kind: 'editing', deleted: true }, made: null })
    expect(step.tell).toContain('deleted on account Usage Co')
  })

  it('refused: shows Cloudflare’s reason, and tells the model the alert still exists', () => {
    const step = afterUndo(REFUSED, made, context())
    expect(step.made).toBeUndefined()
    expect(step.phase).toEqual({
      kind: 'created',
      undo: { failed: 'Forbidden', unconfirmed: false }
    })
    expect(step.tell).toContain('it still exists on account Usage Co')
    if (step.phase.kind !== 'created' || typeof step.phase.undo !== 'object')
      throw new Error('no failure')
    expect(undoFailureLine(step.phase.undo, 'alert')).toBe(
      'Didn’t delete: Forbidden. The alert is still on.'
    )
  })

  it('no answer: says it may still exist', () => {
    const step = afterUndo(UNKNOWN, made, context())
    if (step.phase.kind !== 'created' || typeof step.phase.undo !== 'object')
      throw new Error('no failure')
    expect(step.tell).toContain('may still exist')
    expect(undoFailureLine(step.phase.undo, 'alert')).toBe('No answer: the alert may still exist')
  })
})

describe('the button, by what the host can do', () => {
  const editing: Phase = { kind: 'editing' }
  const label = (caps: Parameters<typeof handoffOf>[0]) =>
    buttonLabel({
      phase: editing,
      action: actionOf(WORKERS_REQUESTS_MONITOR),
      saving: false,
      handoff: handoffOf(caps)
    })

  it('says what the click does: create it, send it to chat, or show the request', () => {
    expect(label({ serverTools: {}, message: {} })).toBe('Create alert')
    expect(label({ message: {} })).toBe('Send to chat')
    expect(label({})).toBe('Show request')
    expect(label(undefined)).toBe('Show request')
  })
})

describe('a spending limit, which stops every Worker', () => {
  it('names the account, and asks for the tick when the user clicked without it', () => {
    const caution = actionOf(WORKERS_SPEND, 'usage_block').caution?.('Spend Co')
    expect(caution).toContain('every Worker on Spend Co')
    expect(
      hintFor({
        phase: { kind: 'editing' },
        noun: 'spending limit',
        invalid: false,
        address: 'a@b.co',
        unconfirmedCaution: caution
      })
    ).toMatchObject({ tone: 'bad', text: 'Confirm first' })
  })
})

describe('the app-only writes Code Mode serves', () => {
  const create = (preset: typeof WORKERS_REQUESTS_MONITOR, body: unknown) =>
    isPresetWrite(preset, {
      name: preset.target.tools[0],
      arguments: { path: { account_id: ACCOUNT }, body }
    })

  it('takes every body a card builds', () => {
    expect(
      create(
        WORKERS_REQUESTS_MONITOR,
        WORKERS_REQUESTS_MONITOR.policy(ACCOUNT, 7_000_000, 'a@b.co', 'alert')
      )
    ).toBe(true)
    expect(
      create(
        WORKERS_REQUESTS_BILLING,
        WORKERS_REQUESTS_BILLING.policy(ACCOUNT, 5e7, 'a@b.co', 'alert')
      )
    ).toBe(true)
    expect(
      create(R2_STORAGE_BILLING, R2_STORAGE_BILLING.policy(ACCOUNT, 1.5e12, 'a@b.co', 'alert'))
    ).toBe(true)
    for (const action of ['notification', 'usage_block'])
      expect(create(WORKERS_SPEND, WORKERS_SPEND.policy(ACCOUNT, 5000, 'a@b.co', action))).toBe(
        true
      )
    // Key order doesn't matter, only values.
    const body = WORKERS_REQUESTS_BILLING.policy(ACCOUNT, 5e7, 'a@b.co', 'alert')
    expect(
      create(WORKERS_REQUESTS_BILLING, Object.fromEntries(Object.entries(body).reverse()))
    ).toBe(true)
  })

  it('refuses any other body: another query, account, product, extra field, or a name that lies', () => {
    const monitor = monitorPolicy(
      ACCOUNT,
      7_000_000,
      'a@b.co',
      'Workers requests over 7M in 7 days'
    )
    expect(
      create(WORKERS_REQUESTS_MONITOR, {
        ...monitor,
        filters: { ...monitor.filters, selectors: ['SELECT 1 FROM events.workersInvocations'] }
      })
    ).toBe(false)
    expect(
      create(
        WORKERS_REQUESTS_MONITOR,
        WORKERS_REQUESTS_MONITOR.policy('a'.repeat(32), 7_000_000, 'a@b.co', 'alert')
      )
    ).toBe(false)
    expect(
      create(WORKERS_REQUESTS_MONITOR, {
        ...monitor,
        mechanisms: { email: [{ id: 'a@b.co' }], webhooks: [{ id: 'x' }] }
      })
    ).toBe(false)
    expect(
      create(WORKERS_REQUESTS_BILLING, {
        ...WORKERS_REQUESTS_BILLING.policy(ACCOUNT, 5e7, 'a@b.co', 'alert'),
        name: 'Billed Workers requests over 1B'
      })
    ).toBe(false)
    expect(
      create(WORKERS_SPEND, {
        ...WORKERS_SPEND.policy(ACCOUNT, 5000, 'a@b.co', 'notification'),
        product_id: 'durable_objects'
      })
    ).toBe(false)
    expect(
      create(WORKERS_REQUESTS_BILLING, {
        alert_type: 'billing_budget_alert',
        name: 'x',
        enabled: true,
        filters: { limit: ['1'] },
        mechanisms: { email: [{ id: 'a@b.co' }] }
      })
    ).toBe(false)
  })

  it('takes a delete or update only by policy id, with If-Match only on a spend policy', () => {
    const [, update, remove] = WORKERS_REQUESTS_MONITOR.target.tools
    const path = { account_id: ACCOUNT, policy_id: POLICY }
    const body = WORKERS_REQUESTS_MONITOR.policy(ACCOUNT, 7_000_000, 'a@b.co', 'alert')
    expect(isPresetWrite(WORKERS_REQUESTS_MONITOR, { name: remove, arguments: { path } })).toBe(
      true
    )
    expect(
      isPresetWrite(WORKERS_REQUESTS_MONITOR, { name: update, arguments: { path, body } })
    ).toBe(true)
    expect(
      isPresetWrite(WORKERS_REQUESTS_MONITOR, {
        name: update,
        arguments: { path: { account_id: ACCOUNT }, body }
      })
    ).toBe(false)
    expect(
      isPresetWrite(WORKERS_REQUESTS_MONITOR, {
        name: remove,
        arguments: { path, headers: { 'if-match': '1' } }
      })
    ).toBe(false)
    const spend = WORKERS_SPEND.target.tools
    expect(
      isPresetWrite(WORKERS_SPEND, {
        name: spend[2],
        arguments: { path, headers: { 'if-match': '3' } }
      })
    ).toBe(true)
    expect(
      isPresetWrite(WORKERS_SPEND, { name: 'alerting_policies_delete', arguments: { path } })
    ).toBe(false)
  })
})

describe('the typical period', () => {
  const weekdays = (from: string, n: number, weekday: number, weekend: number): Day[] =>
    Array.from({ length: n }, (_, i) => {
      const t = Date.parse(from) + i * 864e5
      const day = new Date(t).getUTCDay()
      return [new Date(t).toISOString().slice(0, 10), day === 0 || day === 6 ? weekend : weekday]
    })

  it('counts quiet weekends: a week of 5 busy days and 2 quiet ones, not 7 busy ones', () => {
    const days = weekdays('2026-08-03', 89, 100, 10)
    // 5 × 100 + 2 × 10 = 520 a week; a median day × 7 would say 700.
    expect(typicalPeriod(days)).toBe(520)
  })

  it('is never above the busiest month', () => {
    // Steady growth: the median week, scaled to a month, would pass every whole month read.
    const days: Day[] = Array.from({ length: 89 }, (_, i) => [
      new Date(Date.parse('2026-08-22') + i * 864e5).toISOString().slice(0, 10),
      i * i
    ])
    const m = deriveModel(days, '2026-11-19', { kind: 'month' })
    expect(m.typical).not.toBeNull()
    expect(m.typical!).toBeLessThanOrEqual(m.peak)
  })
})
