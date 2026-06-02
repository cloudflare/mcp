import { createLogger } from '../../observability/logger'
import { OAuthError } from '../workers-oauth-utils'

const log = createLogger('refresh-store')

/**
 * KV-backed state for the refresh guard, keyed by a hash of the upstream
 * refresh token. Two records per token:
 *  - `in-flight`: a short-lived marker that another isolate is mid-refresh.
 *  - `failure`:   a cached terminal failure so retries fail fast without
 *                 re-hitting upstream.
 *
 * All operations are best-effort: KV hiccups must never turn a recoverable
 * refresh into a hard failure, so reads degrade to "absent" and writes are
 * swallowed (with a warning).
 */
const GUARD_PREFIX = 'oauth:refresh-guard'
const IN_FLIGHT_TTL_SECONDS = 60
// Short on purpose. The cached failure only needs to cover the brief window
// where a retry could still hit upstream before suppression takes hold:
//  - the KV eventual-consistency lag after we revoke the dead grant, and
//  - the upstream OAuth server's ~1 min refresh coalescing grace window.
// Permanent loop-prevention is owned by grant revocation (on invalid_grant),
// not by this cache, so it no longer needs a long (1h) TTL.
const FAILURE_TTL_SECONDS = 120

export interface CachedRefreshFailure {
  code?: string
  description?: string
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export class RefreshStore {
  private constructor(
    private readonly kv: KVNamespace,
    readonly tokenHash: string
  ) {}

  /** Build a store scoped to one upstream refresh token (hashes it for keys). */
  static async forToken(kv: KVNamespace, refreshToken: string): Promise<RefreshStore> {
    return new RefreshStore(kv, await sha256Hex(refreshToken))
  }

  private get inFlightKey(): string {
    return `${GUARD_PREFIX}:${this.tokenHash}:in-flight`
  }

  private get failureKey(): string {
    return `${GUARD_PREFIX}:${this.tokenHash}:failure`
  }

  async getCachedFailure(): Promise<CachedRefreshFailure | null> {
    try {
      const failure = await this.kv.get(this.failureKey, { type: 'json' })
      if (!failure || typeof failure !== 'object') return null
      return failure as CachedRefreshFailure
    } catch (error) {
      log.warn('failed to read cached refresh failure', { error })
      return null
    }
  }

  async cacheFailure(error: OAuthError): Promise<void> {
    try {
      await this.kv.put(
        this.failureKey,
        JSON.stringify({
          code: error.code,
          description: 'Token refresh failed; reauthorization is required',
          failedAt: Date.now()
        }),
        { expirationTtl: FAILURE_TTL_SECONDS }
      )
    } catch (error) {
      log.warn('failed to cache terminal refresh failure', { error })
    }
  }

  async isInFlight(): Promise<boolean> {
    try {
      return Boolean(await this.kv.get(this.inFlightKey))
    } catch (error) {
      log.warn('failed to read in-flight marker', { error })
      return false
    }
  }

  async markInFlight(): Promise<void> {
    try {
      await this.kv.put(this.inFlightKey, JSON.stringify({ startedAt: Date.now() }), {
        expirationTtl: IN_FLIGHT_TTL_SECONDS
      })
    } catch (error) {
      log.warn('failed to write in-flight marker', { error })
    }
  }

  async clearInFlight(): Promise<void> {
    try {
      await this.kv.delete(this.inFlightKey)
    } catch (error) {
      log.warn('failed to clear in-flight marker', { error })
    }
  }
}
