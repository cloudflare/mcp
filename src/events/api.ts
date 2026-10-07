import { z } from 'zod'
import { fetchWithRetry } from '../utils/fetch-retry'
import { readJson } from './ans-bridge'

export class EventApiError extends Error {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? 'Cloudflare permission required: allow Notifications Edit and Workers Observability Edit for the selected account.'
        : status === 404
          ? 'Issue automations are unavailable for this account.'
          : 'Cloudflare could not complete the subscription operation. Retry the request.'
    )
  }
}

const Envelope = z.object({
  success: z.boolean(),
  result: z.unknown(),
  result_info: z.object({ total_pages: z.number().optional() }).optional()
})
const Resource = z.object({ id: z.string().min(1), name: z.string().optional() })

export class EventApi {
  constructor(
    readonly base: string,
    readonly token: string,
    readonly accountId: string,
    readonly signal?: AbortSignal
  ) {}

  async request(path: string, method = 'GET', body?: unknown) {
    const response = await fetchWithRetry(
      `${this.base}/accounts/${this.accountId}${path}`,
      {
        method,
        redirect: 'manual',
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      },
      { maxRetries: 0, caller: 'mcp_events_api' }
    )
    if (!response.ok) {
      await response.body?.cancel()
      throw new EventApiError(response.status)
    }
    const envelope = Envelope.parse(await readJson(response, 2 * 1024 * 1024))
    if (!envelope.success) throw new EventApiError(502)
    return envelope
  }

  async result(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    return (await this.request(path, method, body)).result
  }

  async find(path: string, name: string, collection?: string): Promise<string | undefined> {
    for (let page = 1; page <= 100; page++) {
      const envelope = await this.request(`${path}?page=${page}&per_page=100`)
      const value = collection
        ? z.record(z.string(), z.unknown()).parse(envelope.result)[collection]
        : envelope.result
      const resources = z.array(Resource).parse(value)
      const found = resources.find((resource) => resource.name === name)
      if (resources.filter((resource) => resource.name === name).length > 1)
        throw new EventApiError(409)
      if (found) return found.id
      if (!envelope.result_info?.total_pages || page >= envelope.result_info.total_pages) return
    }
    throw new EventApiError(503)
  }

  async create(path: string, body: unknown, collection?: string): Promise<string> {
    const result = await this.result(path, 'POST', body)
    return Resource.parse(
      collection ? z.record(z.string(), z.unknown()).parse(result)[collection] : result
    ).id
  }

  async remove(path: string): Promise<void> {
    try {
      await this.result(path, 'DELETE')
    } catch (error) {
      if (!(error instanceof EventApiError && error.status === 404)) throw error
    }
  }
}

export const WEBHOOKS = '/alerting/v3/destinations/webhooks'
export const POLICIES = '/alerting/v3/policies'
export const AUTOMATIONS = '/workers/observability/issues/automations'
