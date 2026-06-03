import type { OAuthHelpers, TokenExchangeCallbackResult } from '@cloudflare/workers-oauth-provider'

import { createLogger } from '../../observability/logger'
import { createTelemetry } from '../../observability/telemetry'
import { OAuthError } from '../workers-oauth-utils'
import { isTerminalRefreshError, shouldRevokeGrant } from './refresh-errors'
import { RefreshStore } from './refresh-store'

const log = createLogger('refresh-manager')

/**
 * Refresh outcome telemetry. One event per guarded refresh that fails; greppable
 * as `[refresh-telemetry] {...}` in Workers Logs.
 *
 *  - `upstream_terminal`: upstream actually returned a terminal error this
 *    request (the *first-time* failure). `grantsRevoked` reports whether we
 *    killed the dead grant.
 *  - `cached_replay`: a retry short-circuited on the cached failure (a *repeat*,
 *    never hit upstream).
 *  - `in_flight_collision`: another isolate was mid-refresh.
 */
interface RefreshTelemetryEvent {
  kind: 'upstream_terminal' | 'cached_replay' | 'in_flight_collision'
  code: string
  refreshTokenHash: string
  userId?: string
  clientId?: string
  grantsRevoked?: number
  /**
   * `createdAt` (epoch seconds) of the revoked grant, and its age at failure.
   * Lets us tell whether failing refreshes are recently-issued grants (a real
   * bug) or old pre-fix grants draining out (expected). When multiple grants
   * are revoked, this is the oldest.
   */
  revokedGrantCreatedAt?: number
  revokedGrantAgeSec?: number
}

const refreshTelemetry = createTelemetry<RefreshTelemetryEvent>('refresh-telemetry')

/**
 * Identifies the downstream grant so we can revoke it when the upstream refresh
 * token is permanently dead. `getHelpers` is lazy — only invoked on a terminal
 * `invalid_grant` — because `env.OAUTH_PROVIDER` is not injected during the
 * token endpoint, so helpers must be constructed on demand via `getOAuthApi`.
 */
export interface RefreshContext {
  userId?: string
  clientId?: string
  getHelpers?: () => OAuthHelpers
}

/** The actual upstream token exchange; provided by the caller. */
export type PerformRefresh = () => Promise<TokenExchangeCallbackResult | undefined>

/**
 * Guards and instruments the upstream refresh-token exchange.
 *
 * Responsibilities, in one place:
 *  - **Singleflight**: dedupe concurrent refreshes of the same token within an
 *    isolate (in-memory) and across isolates (KV in-flight marker).
 *  - **Fail-fast**: short-circuit retries of a token that recently failed.
 *  - **Revoke**: on `invalid_grant`, kill the dead downstream grant so the
 *    client is forced to re-authorize instead of looping forever.
 *  - **Telemetry**: emit a structured event for every failure mode.
 *
 * Behavior is identical to the previous inline `guardRefreshTokenExchange`; this
 * just gives the refresh lifecycle a cohesive home.
 */
class RefreshManager {
  /** In-isolate singleflight: collapse concurrent refreshes of the same token. */
  private readonly inFlight = new Map<string, Promise<TokenExchangeCallbackResult | undefined>>()

  async run(
    kv: KVNamespace,
    refreshToken: string,
    perform: PerformRefresh,
    context: RefreshContext = {}
  ): Promise<TokenExchangeCallbackResult | undefined> {
    const store = await RefreshStore.forToken(kv, refreshToken)
    const existing = this.inFlight.get(store.tokenHash)
    if (existing) return existing

    const promise = this.guard(store, perform, context).finally(() => {
      this.inFlight.delete(store.tokenHash)
    })
    this.inFlight.set(store.tokenHash, promise)
    return promise
  }

  private async guard(
    store: RefreshStore,
    perform: PerformRefresh,
    context: RefreshContext
  ): Promise<TokenExchangeCallbackResult | undefined> {
    const cachedFailure = await store.getCachedFailure()
    if (cachedFailure) {
      const code = cachedFailure.code || 'invalid_grant'
      // Retry of an already-failed token within the cache TTL. The grant was
      // already killed on the first failure; this never reaches upstream.
      this.emit('cached_replay', code, store, context)
      throw new OAuthError(
        code,
        cachedFailure.description || 'Token refresh recently failed; reauthorization is required',
        400
      )
    }

    if (await store.isInFlight()) {
      this.emit('in_flight_collision', 'temporarily_unavailable', store, context)
      throw new OAuthError(
        'temporarily_unavailable',
        'Token refresh is already in progress; retry shortly',
        429,
        { 'Retry-After': '30' }
      )
    }

    await store.markInFlight()
    try {
      return await perform()
    } catch (error) {
      if (isTerminalRefreshError(error)) {
        await store.cacheFailure(error)
        const revoked = await this.maybeRevoke(error, context)
        this.emit('upstream_terminal', error.code, store, context, revoked)
      }
      throw error
    } finally {
      await store.clearInFlight()
    }
  }

  /**
   * Kill the dead downstream grant on `invalid_grant`. Returns the revoke count
   * and the oldest revoked grant's `createdAt` (for age telemetry), or an empty
   * result if not applicable / revocation failed.
   */
  private async maybeRevoke(error: OAuthError, context: RefreshContext): Promise<RevokeResult> {
    if (!shouldRevokeGrant(error) || !context.userId || !context.clientId || !context.getHelpers) {
      return { count: 0 }
    }
    try {
      return await revokeGrantsForClient(context.getHelpers(), context.userId, context.clientId)
    } catch (revokeError) {
      log.error('failed to revoke grant after invalid_grant', { error: revokeError })
      return { count: 0 }
    }
  }

  private emit(
    kind: RefreshTelemetryEvent['kind'],
    code: string,
    store: RefreshStore,
    context: RefreshContext,
    revoked?: RevokeResult
  ): void {
    const ageFields =
      revoked?.oldestCreatedAt !== undefined
        ? {
            revokedGrantCreatedAt: revoked.oldestCreatedAt,
            revokedGrantAgeSec: Math.floor(Date.now() / 1000) - revoked.oldestCreatedAt
          }
        : {}
    refreshTelemetry({
      kind,
      code,
      refreshTokenHash: store.tokenHash,
      userId: context.userId,
      clientId: context.clientId,
      ...(revoked !== undefined ? { grantsRevoked: revoked.count } : {}),
      ...ageFields
    })
  }
}

/**
 * Revoke every grant for this user+client. `completeAuthorization` revokes prior
 * grants for the same user+client by default, so in practice there is at most
 * one, but we loop defensively (and paginate). `revokeGrant` deletes all access
 * tokens for the grant and the grant record itself, invalidating the downstream
 * refresh token too.
 */
interface RevokeResult {
  count: number
  /** Oldest `createdAt` (epoch seconds) among revoked grants, if any. */
  oldestCreatedAt?: number
}

async function revokeGrantsForClient(
  helpers: OAuthHelpers,
  userId: string,
  clientId: string
): Promise<RevokeResult> {
  let count = 0
  let oldestCreatedAt: number | undefined
  let cursor: string | undefined
  do {
    const page = await helpers.listUserGrants(userId, cursor ? { cursor } : undefined)
    for (const grant of page.items) {
      if (grant.clientId !== clientId) continue
      if (grant.createdAt !== undefined) {
        oldestCreatedAt =
          oldestCreatedAt === undefined
            ? grant.createdAt
            : Math.min(oldestCreatedAt, grant.createdAt)
      }
      await helpers.revokeGrant(grant.id, userId)
      count++
    }
    cursor = page.cursor
  } while (cursor)
  return { count, oldestCreatedAt }
}

/** Process-wide singleton so the in-isolate singleflight map is shared. */
export const refreshManager = new RefreshManager()
