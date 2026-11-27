/**
 * The threshold card's form, as data: what each write's answer does to the
 * form, what the card says about it, and what the model is told. Pure (no
 * DOM, no host), so every state the card can reach after a click is tested
 * without rendering it (`tests/threshold-alert-form.test.ts`).
 *
 * The rule throughout: a write with no answer from Cloudflare may have been
 * made, so the card and the model never say it wasn't.
 */
import type { WriteResult } from './create'
import type { PresetAction, SettingRef, ThresholdAlertPreset } from './presets'

/** Which write a failed or unanswered click was. */
export type Write = 'create' | 'save'

/**
 * Where the form is, with what only that step knows. The click is the user's
 * confirmation, so the App writes the setting itself with a tool this server
 * already lists: `created`. A host that can't call server tools gets the
 * setting handed to the chat (`sent`), or else the request to send (`review`).
 */
export type Phase =
  /** `deleted`: Undo just deleted the setting this card made; the field says so until the next edit. */
  | { readonly kind: 'editing'; readonly deleted?: true }
  | { readonly kind: 'sending' }
  /** `undo`: Undo is deleting it, or it didn't: refused with Cloudflare's reason, or unanswered. */
  | { readonly kind: 'created'; readonly undo?: 'deleting' | UndoFailure }
  /**
   * A refused write, with Cloudflare's reason, or one that got no answer
   * (`unconfirmed`): that write may have been made, so the card never says nothing changed.
   */
  | {
      readonly kind: 'failed'
      readonly write: Write
      readonly reason: string
      readonly unconfirmed: boolean
    }
  | { readonly kind: 'sent' }
  | { readonly kind: 'review' }

/** An Undo that didn't delete: Cloudflare's reason, and whether it answered at all. */
export interface UndoFailure {
  readonly failed: string
  readonly unconfirmed: boolean
}

export const EDITING: Phase = { kind: 'editing' }

/**
 * How Create reaches Cloudflare in this host: the App writes it (`server`),
 * hands it to the chat (`chat`), or shows the request to send (`request`).
 * The button says which, so it never reads "Create alert" when the click only
 * sends a message.
 */
export type Handoff = 'server' | 'chat' | 'request'

/** The host's capabilities, as far as the hand-off needs them. */
export function handoffOf(
  caps: { readonly serverTools?: unknown; readonly message?: unknown } | undefined
): Handoff {
  return caps?.serverTools ? 'server' : caps?.message ? 'chat' : 'request'
}

/** What a write was about: the card's preset and action, and the account it writes to. */
export interface WriteContext {
  readonly preset: ThresholdAlertPreset
  readonly action: PresetAction
  readonly accountId: string
  /** The account's name, or its id when the session doesn't know the name. */
  readonly account: string
  /** The setting's stored name, for the model to look it up. */
  readonly name: string
  /** What the setting does, for the model: "emails a@b.c". */
  readonly does: string
  /** What it waits for, for the model: "Workers requests pass 1,000,000 in 7 days". */
  readonly what: string
}

/** Where a write leaves the form, and what the model is told, if anything. */
export interface Step {
  readonly phase: Phase
  /** The setting the card made, which Undo deletes and Save updates; `undefined` leaves it as it was. */
  readonly made?: SettingRef | null
  readonly tell?: string
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Cloudflare's reason for a refused write, short enough for one line: its message, not the whole tool error. */
export function failureReason(text: string): string {
  const message = /"message"\s*:\s*"([^"]+)"/.exec(text)?.[1]
  return (message ?? (text.split('\n').find(Boolean) || 'try again')).slice(0, 120)
}

const listOf = (c: WriteContext) =>
  c.preset.target.kind === 'spend_policy' ? 'spend policies' : 'notification policies'

/** Create, with the host's `callServerTool`. `unavailable`: the connection lists no such tool, so hand it off. */
export function afterCreate(result: WriteResult, c: WriteContext): Step | 'handoff' {
  const { noun } = c.action
  switch (result.status) {
    case 'done':
      return {
        phase: { kind: 'created' },
        made: result.ref ?? null,
        // Tell the model, so it doesn't offer to create it again.
        tell: `${capital(noun)} created${result.ref ? ` (${result.ref.id})` : ''} on account ${c.account}: it ${c.does} when ${c.what}. The user clicked ${c.action.create} in the ${c.preset.toolName} App. It's done: don't create it again or ask to confirm it.`
      }
    case 'refused':
      return {
        phase: { kind: 'failed', write: 'create', reason: result.error, unconfirmed: false }
      }
    case 'unknown':
      return {
        phase: { kind: 'failed', write: 'create', reason: result.error, unconfirmed: true },
        tell: `${c.action.create} got no answer from Cloudflare (${failureReason(result.error)}): the ${noun} may have been created on account ${c.account} (${c.accountId}). Before creating it again, list the account's ${listOf(c)} and check for "${c.name}".`
      }
    case 'unavailable':
      return 'handoff'
  }
}

/** Save, on the setting the card made: update it to what the card now shows. */
export function afterSave(result: WriteResult, made: SettingRef, c: WriteContext): Step {
  const { noun } = c.action
  switch (result.status) {
    case 'done':
      return {
        phase: { kind: 'created' },
        // A spend policy's update returns its next version, which the next write must send.
        made: result.ref ? { ...made, ...result.ref } : made,
        tell: `${capital(noun)} ${made.id} updated on account ${c.account}: it ${c.does} when ${c.what}. The user clicked ${c.action.save} in the ${c.preset.toolName} App. It's done: don't change it again or ask to confirm it.`
      }
    case 'refused':
      return { phase: { kind: 'failed', write: 'save', reason: result.error, unconfirmed: false } }
    case 'unavailable':
      return {
        phase: {
          kind: 'failed',
          write: 'save',
          reason: `this connection can’t update the ${noun}`,
          unconfirmed: false
        }
      }
    case 'unknown':
      return {
        phase: { kind: 'failed', write: 'save', reason: result.error, unconfirmed: true },
        tell: `${c.action.save} got no answer from Cloudflare (${failureReason(result.error)}): ${noun} ${made.id} on account ${c.account} may or may not have been updated. Before changing it again, get it and check its threshold. It still exists either way.`
      }
  }
}

/**
 * Undo: delete the setting the card made. Done, the form returns as it was.
 * Not done, the setting still exists (or may), and the model is told, since
 * it may have read the card's Undo as done.
 */
export function afterUndo(result: WriteResult, made: SettingRef, c: WriteContext): Step {
  const { noun } = c.action
  if (result.status === 'done') {
    return {
      phase: { kind: 'editing', deleted: true },
      made: null,
      tell: `${capital(noun)} ${made.id} deleted on account ${c.account}: no ${noun} from this card exists now. The user clicked Undo in the ${c.preset.toolName} App. Don't recreate it unless the user asks.`
    }
  }
  const unconfirmed = result.status === 'unknown'
  const failed =
    result.status === 'unavailable'
      ? `this connection can’t delete the ${noun}`
      : failureReason(result.error)
  return {
    phase: { kind: 'created', undo: { failed, unconfirmed } },
    tell: unconfirmed
      ? `The user clicked Undo in the ${c.preset.toolName} App, but Cloudflare didn't answer (${failed}): ${noun} ${made.id} on account ${c.account} may still exist. Check before saying it's gone.`
      : `The user clicked Undo in the ${c.preset.toolName} App, but Cloudflare didn't delete ${noun} ${made.id} (${failed}): it still exists on account ${c.account} and still ${c.does} when ${c.what}.`
  }
}

/** The field's trailing message: a short phrase that never crowds the address, and the sentence a screen reader hears. */
export interface Hint {
  readonly tone: '' | 'bad'
  readonly text: string
  readonly say: string
}

/** What the form says next to the address, if anything. */
export function hintFor(f: {
  readonly phase: Phase
  readonly noun: string
  /** The address was checked and isn't one. */
  readonly invalid: boolean
  readonly address: string
  /** A setting that stops something needs its confirmation, and the user clicked without it. */
  readonly unconfirmedCaution?: string
}): Hint | null {
  const { phase, noun } = f
  if (f.invalid) {
    return f.address
      ? {
          tone: 'bad',
          text: 'Invalid email',
          say: 'Enter a full email address, like name@example.com.'
        }
      : { tone: 'bad', text: 'Required', say: `Enter the email address to send ${noun} emails to.` }
  }
  if (f.unconfirmedCaution) {
    return {
      tone: 'bad',
      text: 'Confirm first',
      say: `Tick “${f.unconfirmedCaution}” to set the ${noun}.`
    }
  }
  if (phase.kind === 'failed') {
    const saving = phase.write === 'save'
    if (phase.unconfirmed) {
      return saving
        ? {
            tone: 'bad',
            text: 'May have saved',
            say: `No answer from Cloudflare: the ${noun} may have been updated. It still exists either way.`
          }
        : {
            tone: 'bad',
            text: 'May have saved',
            say: `No answer from Cloudflare: the ${noun} may have been created. Check this account before trying again.`
          }
    }
    return {
      tone: 'bad',
      text: 'Didn’t save',
      say: `Didn’t save: ${failureReason(phase.reason)}. ${saving ? `The ${noun} wasn’t changed` : 'Nothing was created'}. Try again.`
    }
  }
  if (phase.kind === 'editing' && phase.deleted) {
    return {
      tone: '',
      text: 'Deleted',
      say: `The ${noun} was deleted. Nothing will happen at the line.`
    }
  }
  return null
}

/** The primary button's label. */
export function buttonLabel(f: {
  readonly phase: Phase
  readonly action: PresetAction
  /** The card made a setting, so the button updates it. */
  readonly saving: boolean
  readonly handoff: Handoff
}): string {
  const { phase, action } = f
  if (phase.kind === 'failed') {
    if (phase.unconfirmed) {
      return phase.write === 'save' ? 'Save anyway' : 'Create anyway'
    }
    return 'Try again'
  }
  if (f.saving) {
    return action.save
  }
  return f.handoff === 'server'
    ? action.create
    : f.handoff === 'chat'
      ? 'Send to chat'
      : 'Show request'
}

/** The note under the chart after a write with no answer: where everyone sees it, before the button. */
export function unconfirmedNote(phase: Phase, noun: string): string | null {
  if (phase.kind !== 'failed' || !phase.unconfirmed) {
    return null
  }
  return phase.write === 'save'
    ? `No answer from Cloudflare, so this ${noun} may already have the new threshold. Check it before saving again.`
    : `No answer from Cloudflare, so this ${noun} may already exist. Check this account before creating it again.`
}

/** The done line's second half after an Undo that didn't delete. */
export function undoFailureLine(undo: UndoFailure, noun: string): string {
  return undo.unconfirmed
    ? `No answer: the ${noun} may still exist`
    : `Didn’t delete: ${undo.failed}. The ${noun} is still on.`
}
