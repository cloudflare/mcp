import { exports } from 'cloudflare:workers'
import { http, HttpResponse } from 'msw'
import { server } from '../setup/msw'
import { cfAccountsSuccess, cfSuccess } from './cloudflare-api'

const ORIGIN = 'https://mcp.cloudflare.com'
const RESOURCE = `${ORIGIN}/mcp`
const REDIRECT_URI = 'https://app.example.com/cb'
const CODE_VERIFIER = 'test-downstream-code-verifier'
const CODE_CHALLENGE = 'I4fhllfHqqQsgap17V2SDI0scSei8H7U0e0rZBDIcbo'

function cookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`OAuth test flow: no ${what}`)
  return value
}

/**
 * Connect through the real OAuth flow and return the MCP access token.
 *
 * Cloudflare's token endpoint is mocked to grant exactly `scopes`, and the
 * identity probes return one user with one account.
 *
 * @param scopes - The scopes to request at consent and have Cloudflare grant.
 * @param account - The account the identity probe returns.
 * @param resource - The RFC 8707 resource the client names at /authorize and /token.
 * @returns A provider-issued MCP access token.
 */
export async function connectWithOAuth(
  scopes: readonly string[],
  account = { id: 'acc-1', name: 'Account One' },
  resource = RESOURCE
): Promise<string> {
  const scope = scopes.join(' ')
  server.use(
    http.post('https://dash.cloudflare.com/oauth2/token', () =>
      HttpResponse.json({
        access_token: 'upstream-access-token',
        expires_in: 3600,
        refresh_token: 'upstream-refresh-token',
        scope,
        token_type: 'bearer'
      })
    ),
    http.get('https://api.cloudflare.com/client/v4/user', () =>
      HttpResponse.json(cfSuccess({ id: 'user-1', email: 'user@example.com' }))
    ),
    http.get('https://api.cloudflare.com/client/v4/accounts', () =>
      HttpResponse.json(cfAccountsSuccess([account]))
    )
  )

  const registered = await exports.default.fetch(
    new Request(`${ORIGIN}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' })
    })
  )
  const { client_id: clientId } = (await registered.json()) as { client_id: string }

  const authorize = new URL(`${ORIGIN}/authorize`)
  for (const [key, value] of Object.entries({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    resource,
    scope,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256'
  })) {
    authorize.searchParams.set(key, value)
  }
  const consentPage = await exports.default.fetch(new Request(authorize))
  const html = await consentPage.text()
  const handle = required(html.match(/name="handle" value="([^"]+)"/)?.[1], 'consent handle')

  const approved = await exports.default.fetch(
    new Request(`${ORIGIN}/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookies(consentPage)
      },
      body: new URLSearchParams([
        ['handle', handle],
        ...scopes.map((s) => ['scopes', s])
      ]).toString(),
      redirect: 'manual'
    })
  )
  const state = required(
    new URL(required(approved.headers.get('location'), 'upstream redirect')).searchParams.get(
      'state'
    ),
    'state'
  )

  const callback = await exports.default.fetch(
    new Request(`${ORIGIN}/oauth/callback?code=authcode&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: cookies(approved) },
      redirect: 'manual'
    })
  )
  const code = required(
    new URL(required(callback.headers.get('location'), 'client redirect')).searchParams.get('code'),
    'authorization code'
  )

  const token = await exports.default.fetch(
    new Request(`${ORIGIN}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
        resource
      }).toString()
    })
  )
  return ((await token.json()) as { access_token: string }).access_token
}
