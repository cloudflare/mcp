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

  /**
   * Find a managed resource by its exact name.
   *
   * ANS lists are paginated. The issue automations list is not, and rejects
   * any `page` or `per_page` query with 400 (an account holds at most 50).
   */
  async find(path: string, name: string, listing: Listing = PAGED): Promise<string | undefined> {
    for (let page = 1; page <= 100; page++) {
      const envelope = await this.request(
        listing.pagination === 'paged' ? `${path}?page=${page}&per_page=100` : path
      )
      const value = listing.collection
        ? z.record(z.string(), z.unknown()).parse(envelope.result)[listing.collection]
        : envelope.result
      const resources = z.array(Resource).parse(value)
      const found = resources.find((resource) => resource.name === name)
      if (resources.filter((resource) => resource.name === name).length > 1)
        throw new EventApiError(409)
      if (found) return found.id
      if (listing.pagination === 'unpaged') return
      if (!envelope.result_info?.total_pages || page >= envelope.result_info.total_pages) return
    }
    throw new EventApiError(503)
  }

  /**
   * Find every resource with this exact name. Used for destinations, which can
   * briefly share a name while a signing secret rotates.
   */
  async findAll(path: string, name: string): Promise<string[]> {
    const ids: string[] = []
    for (let page = 1; page <= 100; page++) {
      const envelope = await this.request(`${path}?page=${page}&per_page=100`)
      const resources = z.array(Resource).parse(envelope.result)
      ids.push(...resources.filter((resource) => resource.name === name).map(({ id }) => id))
      if (!envelope.result_info?.total_pages || page >= envelope.result_info.total_pages) return ids
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

/** How a Cloudflare list endpoint pages its results and where it nests them. */
export interface Listing {
  readonly pagination: 'paged' | 'unpaged'
  readonly collection?: string
}

const PAGED: Listing = { pagination: 'paged' }

/** The issue automations list: one unpaginated page under `result.automations`. */
export const AUTOMATIONS_LISTING: Listing = { pagination: 'unpaged', collection: 'automations' }

export const WEBHOOKS = '/alerting/v3/destinations/webhooks'
export const POLICIES = '/alerting/v3/policies'
export const AUTOMATIONS = '/workers/observability/issues/automations'
