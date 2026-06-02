import { OAuthError } from '../workers-oauth-utils'

/**
 * Terminal refresh errors: the upstream refused the refresh in a way that won't
 * succeed on retry, so we cache the failure to stop hammering upstream.
 */
const TERMINAL_REFRESH_CODES = ['invalid_grant', 'invalid_client', 'unauthorized_client']

export function isTerminalRefreshError(error: unknown): error is OAuthError {
  return error instanceof OAuthError && TERMINAL_REFRESH_CODES.includes(error.code)
}

/**
 * Whether a terminal failure means the stored upstream refresh token is
 * permanently dead and the downstream grant should be killed to force re-auth.
 *
 * Only `invalid_grant` qualifies — the refresh token itself was rejected.
 * `invalid_client` / `unauthorized_client` are server-side credential/config
 * problems where revoking the user's grant would be pointless (re-auth wouldn't
 * fix bad client credentials).
 */
export function shouldRevokeGrant(error: OAuthError): boolean {
  return error.code === 'invalid_grant'
}
