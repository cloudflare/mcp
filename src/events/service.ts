import { z } from 'zod'
import type { AuthProps } from '../auth/types'
import { USER_AGENT } from '../constants'
import { fetchWithRetry } from '../utils/fetch-retry'
import {
  EventApi,
  EventApiError,
  AUTOMATIONS,
  AUTOMATIONS_LISTING,
  POLICIES,
  WEBHOOKS
} from './api'
import {
  CallbackUrl,
  SubscribeParams,
  UnsubscribeParams,
  alertEventDefinitions,
  isSupportedEventName,
  readJson,
  subscriptionExpiration,
  subscriptionId,
  verifyCallback,
  type CallbackFailureReason
} from './ans-bridge'
import {
  credentialInfo,
  decryptState,
  deleteSubscriptionRecord,
  encryptState,
  hashSecret,
  parsePolicyState,
  readSubscriptionRecord,
  sealDeliverySecret,
  writeSubscriptionRecord,
  type EventEnvironment,
  type PolicyState
} from './state'

export const ManagedPolicy = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().default(''),
  enabled: z.boolean(),
  alert_type: z.string(),
  mechanisms: z.object({ webhooks: z.array(z.object({ id: z.string() })).default([]) })
})
export type ManagedPolicy = z.infer<typeof ManagedPolicy>

const mutations = new Map<string, Promise<unknown>>()

async function serialized<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const pending = (mutations.get(id) ?? Promise.resolve()).catch(() => {}).then(operation)
  mutations.set(id, pending)
  try {
    return await pending
  } finally {
    if (mutations.get(id) === pending) mutations.delete(id)
  }
}

/** The callback endpoint failed the verification handshake (`-32015`). */
export class CallbackError extends Error {
  readonly _tag = 'CallbackError' as const

  constructor(readonly reason: CallbackFailureReason) {
    super('Callback endpoint verification failed')
  }
}

/** The event is not offered to this principal, or not offered at all (`-32011`). */
export class EventNotFound extends Error {
  readonly _tag = 'EventNotFound' as const

  constructor(readonly eventName: string) {
    super(`Unknown event: ${eventName}`)
  }
}

/** The subscription key belongs to a different principal (`-32012`). */
export class SubscriptionForbidden extends Error {
  readonly _tag = 'SubscriptionForbidden' as const

  constructor() {
    super('This subscription belongs to a different principal')
  }
}

/**
 * Fetch for client callback URLs: re-checks the URL, never follows redirects,
 * and identifies this server with the shared `User-Agent`.
 */
export const publicWebhookFetch: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  CallbackUrl.parse(url)
  const headers = new Headers(init?.headers)
  headers.set('User-Agent', USER_AGENT)
  return fetch(url, { ...init, headers, redirect: 'manual' })
}

export async function readPolicyState(
  env: EventEnvironment,
  policy: ManagedPolicy,
  id: string
): Promise<PolicyState> {
  const state = await parsePolicyState(await decryptState(env, `policy:${id}`, policy.description))
  if (
    state.id !== id ||
    policy.name !== managedName(id) ||
    policy.alert_type !== state.params.name.slice('cloudflare.alert.'.length)
  ) {
    throw new Error('Policy subscription identity mismatch')
  }
  return state
}

export function managedName(id: string) {
  return `MCP Events ${id}`
}

export class EventService {
  private readonly principal: string

  constructor(
    private readonly env: EventEnvironment,
    private readonly props: AuthProps,
    private readonly bearer: string
  ) {
    this.principal =
      props.type === 'account_token' ? `account:${props.account.id}` : `user:${props.user.id}`
  }

  private api(accountId: string) {
    if (this.props.type === 'account_token' && this.props.account.id !== accountId)
      throw new EventApiError(403)
    return new EventApi(this.env.CLOUDFLARE_API_BASE, this.props.accessToken, accountId)
  }

  async list(cursor?: string) {
    let accounts: Array<{ id: string }>
    let nextCursor: string | undefined
    if (this.props.type === 'account_token') {
      accounts = [this.props.account]
    } else {
      const page = Number(cursor ?? '1')
      const response = await fetchWithRetry(
        `${this.env.CLOUDFLARE_API_BASE}/accounts?page=${page}&per_page=20`,
        {
          headers: { Authorization: `Bearer ${this.props.accessToken}` },
          redirect: 'manual',
          signal: AbortSignal.timeout(10_000)
        },
        { maxRetries: 0, caller: 'mcp_events_account_discovery' }
      )
      if (!response.ok) throw new EventApiError(response.status)
      const value = z
        .object({
          success: z.literal(true),
          result: z.array(z.object({ id: z.string().regex(/^[a-f0-9]{32}$/) })),
          result_info: z.object({ total_pages: z.number() })
        })
        .parse(await readJson(response))
      accounts = value.result
      if (page < value.result_info.total_pages) nextCursor = String(page + 1)
    }
    for (const account of accounts) {
      try {
        const events = await this.available(account.id)
        if (events.length) return { events }
      } catch (error) {
        if (!(error instanceof EventApiError && [401, 403, 404].includes(error.status))) throw error
      }
    }
    return { events: [], ...(nextCursor ? { nextCursor } : {}) }
  }

  private async available(accountId: string) {
    const api = this.api(accountId)
    const events = alertEventDefinitions(await api.result('/alerting/v3/available_alerts'))
    if (events.length) await api.result(AUTOMATIONS)
    return events
  }

  async subscribe(input: unknown) {
    const params = SubscribeParams.parse(input)
    if (!isSupportedEventName(params.name)) throw new EventNotFound(params.name)
    const id = await subscriptionId(`${this.env.MCP_RESOURCE}:${this.principal}`, params)
    return serialized(id, async () => {
      if (
        !(await this.available(params.arguments.account_id)).some(
          (event) => event.name === params.name
        )
      )
        throw new EventNotFound(params.name)
      const api = this.api(params.arguments.account_id)
      const name = managedName(id)
      const policyId = await api.find(POLICIES, name)
      const previousPolicy = policyId
        ? ManagedPolicy.parse(await api.result(`${POLICIES}/${encodeURIComponent(policyId)}`))
        : undefined
      const previous = previousPolicy
        ? await readPolicyState(this.env, previousPolicy, id)
        : undefined
      if (previous && previous.principal !== this.principal) throw new SubscriptionForbidden()
      const credential = await credentialInfo(this.env, this.bearer)
      const now = Date.now()
      const expiresAt = Math.min(
        subscriptionExpiration(now, params.ttlMs),
        credential.expiresAt - 60_000
      )
      if (expiresAt <= now) throw new Error('Refresh authentication before subscribing')
      const signingSecretHash = await hashSecret(params.delivery.secret)
      const { secret: signingSecret, ...delivery } = params.delivery
      const state: PolicyState = {
        version: 2,
        id,
        principal: this.principal,
        params: { name: params.name, arguments: params.arguments, delivery },
        signingSecretHash,
        webhookId: previous?.webhookId ?? '',
        expiresAt,
        verifiedUntil: previous?.verifiedUntil ?? 0
      }
      const secretChanged = previous?.signingSecretHash !== signingSecretHash
      if (secretChanged || state.verifiedUntil <= now) {
        const verification = await verifyCallback(
          {
            id,
            accountId: params.arguments.account_id,
            policyId: '',
            alertType: params.name.slice('cloudflare.alert.'.length),
            callbackUrl: params.delivery.url,
            signingSecret,
            ingressSecret: '',
            expiresAt
          },
          publicWebhookFetch,
          now
        )
        if (verification._tag === 'failed') throw new CallbackError(verification.reason)
        state.verifiedUntil = now + 5 * 60_000
      }
      const url = new URL(`/events/ans/${id}`, this.env.MCP_RESOURCE).href
      CallbackUrl.parse(url)
      // TODO(2026-10-16): drop the "destination from an older version" case once subscriptions made before #283 have expired or been refreshed (they last at most an hour).
      // The signing secret lives only in the ANS destination's secret, sealed
      // with the callback URL. ANS ignores updates to a destination's secret,
      // so a new signing secret (or a destination from an older version, or a
      // half-finished subscribe) gets a new destination; the old ones are
      // deleted once the policy points at the new one. ANS probes a new
      // destination on creation; the callback acknowledges the probe because
      // the KV record does not match it yet.
      const record = await readSubscriptionRecord(this.env, id)
      const destinations = await api.findAll(WEBHOOKS, name)
      const reusable =
        !secretChanged &&
        record?.signingSecretHash === signingSecretHash &&
        record.webhookId === state.webhookId &&
        destinations.includes(state.webhookId)
      if (!reusable) {
        state.webhookId = await api.create(WEBHOOKS, {
          name,
          url,
          secret: await sealDeliverySecret(this.env, {
            id,
            callbackUrl: params.delivery.url,
            signingSecret
          })
        })
      }
      const policyBody = {
        name,
        enabled: false,
        alert_type: params.name.slice('cloudflare.alert.'.length),
        description: await encryptState(this.env, `policy:${id}`, state),
        mechanisms: { webhooks: [{ id: state.webhookId }] }
      }
      const resolvedPolicyId = policyId ?? (await api.create(POLICIES, policyBody))
      const { account_id: _accountId, ...options } = params.arguments
      // With no trigger given, notify on new issues (first occurrence).
      const trigger =
        options.afterInactivitySeconds === undefined
          ? { ...options, afterOccurrences: options.afterOccurrences ?? 1 }
          : options
      const automationBody = { ...trigger, name, policyId: resolvedPolicyId, enabled: false }
      const automationId =
        (await api.find(AUTOMATIONS, name, AUTOMATIONS_LISTING)) ??
        (await api.create(AUTOMATIONS, automationBody, 'automation'))
      // Write the record before enabling delivery, so the first alert finds it.
      await writeSubscriptionRecord(
        this.env,
        {
          id,
          accountId: params.arguments.account_id,
          policyId: resolvedPolicyId,
          alertType: params.name.slice('cloudflare.alert.'.length),
          webhookId: state.webhookId,
          signingSecretHash,
          expiresAt
        },
        now
      )
      await api.result(`${POLICIES}/${encodeURIComponent(resolvedPolicyId)}`, 'PUT', {
        ...policyBody,
        enabled: true
      })
      await api.result(`${AUTOMATIONS}/${encodeURIComponent(automationId)}`, 'PUT', {
        ...automationBody,
        enabled: true
      })
      for (const stale of destinations.filter((destination) => destination !== state.webhookId))
        await api.remove(`${WEBHOOKS}/${encodeURIComponent(stale)}`)
      return {
        id,
        refreshBefore: new Date(expiresAt).toISOString(),
        cursor: null,
        truncated: false
      }
    })
  }

  async unsubscribe(input: unknown) {
    const params = UnsubscribeParams.parse(input)
    if (!isSupportedEventName(params.name)) throw new EventNotFound(params.name)
    const id = await subscriptionId(`${this.env.MCP_RESOURCE}:${this.principal}`, params)
    return serialized(id, async () => {
      // Stop forwarding first, so delivery ends even if ANS cleanup fails. The
      // ID is derived from this principal, so it can only name its own ticket.
      await deleteSubscriptionRecord(this.env, id)
      const api = this.api(params.arguments.account_id)
      const name = managedName(id)
      const policyId = await api.find(POLICIES, name)
      if (policyId) {
        const policy = ManagedPolicy.parse(
          await api.result(`${POLICIES}/${encodeURIComponent(policyId)}`)
        )
        const state = await readPolicyState(this.env, policy, id)
        if (state.principal !== this.principal) throw new SubscriptionForbidden()
        const { id: _policyId, ...body } = policy
        await api.result(`${POLICIES}/${encodeURIComponent(policyId)}`, 'PUT', {
          ...body,
          enabled: false
        })
      }
      const automationId = await api.find(AUTOMATIONS, name, AUTOMATIONS_LISTING)
      if (automationId) await api.remove(`${AUTOMATIONS}/${encodeURIComponent(automationId)}`)
      if (policyId) await api.remove(`${POLICIES}/${encodeURIComponent(policyId)}`)
      for (const webhookId of await api.findAll(WEBHOOKS, name))
        await api.remove(`${WEBHOOKS}/${encodeURIComponent(webhookId)}`)
      return {}
    })
  }
}
