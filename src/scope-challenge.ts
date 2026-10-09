import { insufficientScope, type OAuthResourceAuth } from '@cloudflare/workers-oauth-provider'
import { REQUIRED_SCOPES } from './auth/scopes'

/** Scopes every connection needs. A challenge names them too; `offline_access` isn't a resource scope. */
const BASELINE_SCOPES = REQUIRED_SCOPES.filter((scope) => scope !== 'offline_access')

/** The `_meta` key ChatGPT reads a tool-level OAuth challenge from. */
export const WWW_AUTHENTICATE_META_KEY = 'mcp/www_authenticate'

/**
 * The `insufficient_scope` step-up challenge for one MCP request.
 *
 * A tool whose Cloudflare request was refused for a missing OAuth scope
 * records it here. The handler then answers the HTTP request with the `403`
 * challenge instead of the tool result, so the client re-authorizes and
 * retries (MCP scope challenge handling). Only tool calls that can be retried
 * safely record a scope.
 */
export class ScopeChallenge {
  readonly #auth: OAuthResourceAuth | undefined
  #response: Response | undefined

  /**
   * @param auth - The verified provider-issued token, or `undefined` for credentials that can't step up.
   */
  constructor(auth: OAuthResourceAuth | undefined) {
    this.#auth = auth
  }

  /**
   * Record that this request needs `scope`.
   *
   * @param scope - The missing OAuth scope.
   * @returns The `WWW-Authenticate` value, for the tool result's `_meta`, or
   *   `undefined` when the credential can't step up.
   */
  require(scope: string): string | undefined {
    if (!this.#auth) return undefined
    const response = insufficientScope(
      this.#auth,
      [...BASELINE_SCOPES, scope],
      `This operation needs the ${scope} scope`
    )
    this.#response ??= response
    return response.headers.get('WWW-Authenticate') ?? undefined
  }

  /** The `403 insufficient_scope` response, once a tool call has required a scope. */
  get response(): Response | undefined {
    return this.#response
  }
}
