import { OAuthError as ProviderOAuthError } from '@cloudflare/workers-oauth-provider'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  getCloudflareOAuthUser,
  resolveCloudflareCredential
} from '../../src/auth/cloudflare-identity'
import { OAuthError } from '../../src/auth/workers-oauth-utils'
import { API_BASE, cfAccountsSuccess, cfSuccess } from '../helpers/cloudflare-api'
import { server } from '../setup/msw'

const USER = { id: 'user-1', email: 'user@example.com' }
const ACCOUNT = { id: 'account-1', name: 'Account One' }

function mockProbes(opts: { user?: () => Response; accounts?: () => Response }) {
  if (opts.user) server.use(http.get(`${API_BASE}/user`, opts.user))
  if (opts.accounts) server.use(http.get(`${API_BASE}/accounts`, opts.accounts))
}

vi.mock('../../src/utils/fetch-retry', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/utils/fetch-retry')>()
  return {
    ...original,
    fetchWithRetry: (input: RequestInfo, init?: RequestInit) =>
      original.fetchWithRetry(input, init, { maxRetries: 0 })
  }
})

async function expectOAuthError(
  promise: Promise<unknown>,
  code: string,
  statusCode: number
): Promise<OAuthError> {
  try {
    await promise
    throw new Error('Expected OAuthError to be thrown')
  } catch (error) {
    expect(error).toBeInstanceOf(OAuthError)
    expect(error).toBeInstanceOf(ProviderOAuthError)
    expect(error).toMatchObject({ code, statusCode })
    return error as OAuthError
  }
}

afterEach(() => vi.restoreAllMocks())

describe('resolveCloudflareCredential', () => {
  it('resolves an account-owned token with one minimum-size /accounts probe', async () => {
    let userCalls = 0
    let accountsUrl = ''
    mockProbes({
      user: () => {
        userCalls++
        return HttpResponse.json(cfSuccess(USER))
      }
    })
    server.use(
      http.get(`${API_BASE}/accounts`, ({ request }) => {
        accountsUrl = request.url
        return HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
      })
    )

    await expect(resolveCloudflareCredential('cfat_token', 'account')).resolves.toEqual({
      type: 'account',
      account: ACCOUNT
    })
    expect(userCalls).toBe(0)
    expect(new URL(accountsUrl).searchParams.get('per_page')).toBe('5')
  })

  it('requires both identity probes for a known user credential', async () => {
    mockProbes({
      user: () => HttpResponse.json(cfSuccess(USER)),
      accounts: () => HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
    })

    await expect(resolveCloudflareCredential('cfut_token', 'user')).resolves.toEqual({
      type: 'user',
      user: USER,
      accounts: [ACCOUNT]
    })
  })

  it('does not infer account ownership for a known user credential', async () => {
    mockProbes({
      user: () => new HttpResponse('Forbidden', { status: 403 }),
      accounts: () => HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
    })

    await expectOAuthError(
      resolveCloudflareCredential('cfut_token', 'user'),
      'insufficient_scope',
      403
    )
  })

  it.each([
    ['forbidden user probe', () => new HttpResponse('Forbidden', { status: 403 })],
    ['invalid user JSON', () => new HttpResponse('not-json', { status: 200 })],
    ['unsuccessful user envelope', () => HttpResponse.json({ success: false })]
  ] as const)('retains legacy account inference for an %s', async (_, userResponse) => {
    mockProbes({
      user: userResponse,
      accounts: () => HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
    })

    await expect(resolveCloudflareCredential('legacy-token', 'unknown')).resolves.toEqual({
      type: 'account',
      account: ACCOUNT
    })
  })

  it('requires account discovery even when a legacy user probe succeeds', async () => {
    mockProbes({
      user: () => HttpResponse.json(cfSuccess(USER)),
      accounts: () => new HttpResponse('Forbidden', { status: 403 })
    })

    await expectOAuthError(
      resolveCloudflareCredential('legacy-token', 'unknown'),
      'insufficient_scope',
      403
    )
  })

  it('never infers account ownership from a transient /user failure', async () => {
    mockProbes({
      user: () => new HttpResponse('rate limited', { status: 429 }),
      accounts: () => HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
    })

    await expectOAuthError(
      resolveCloudflareCredential('legacy-token', 'unknown'),
      'temporarily_unavailable',
      429
    )
  })

  it('requires an account token to resolve to exactly one account', async () => {
    mockProbes({ accounts: () => HttpResponse.json(cfAccountsSuccess([])) })

    await expectOAuthError(
      resolveCloudflareCredential('cfat_token', 'account'),
      'invalid_token',
      401
    )
  })

  it('rejects a truncated account-token page whose total count exceeds one', async () => {
    mockProbes({
      accounts: () =>
        HttpResponse.json({
          ...cfSuccess([ACCOUNT]),
          result_info: { page: 1, per_page: 5, count: 1, total_count: 2 }
        })
    })

    await expectOAuthError(
      resolveCloudflareCredential('cfat_token', 'account'),
      'invalid_token',
      401
    )
  })
})

describe('user account metadata', () => {
  it('requests one account past the prompt-list cutoff', async () => {
    let accountsUrl = ''
    mockProbes({ user: () => HttpResponse.json(cfSuccess(USER)) })
    server.use(
      http.get(`${API_BASE}/accounts`, ({ request }) => {
        accountsUrl = request.url
        return HttpResponse.json(cfAccountsSuccess([]))
      })
    )

    await resolveCloudflareCredential('cfut_token', 'user')

    expect(new URL(accountsUrl).searchParams.get('per_page')).toBe('31')
  })

  it('stores only the count when the complete account list is too large', async () => {
    const accounts = Array.from({ length: 31 }, (_, index) => ({
      id: `account-${index + 1}`,
      name: `Account ${index + 1}`
    }))
    mockProbes({
      user: () => HttpResponse.json(cfSuccess(USER)),
      accounts: () =>
        HttpResponse.json({
          ...cfSuccess(accounts),
          result_info: { page: 1, per_page: 31, count: 31, total_count: 137 }
        })
    })

    await expect(resolveCloudflareCredential('cfut_token', 'user')).resolves.toEqual({
      type: 'user',
      user: USER,
      accounts: [],
      accountCount: 137
    })
  })

  it('keeps a verified user when an accounts payload is malformed', async () => {
    mockProbes({
      user: () => HttpResponse.json(cfSuccess(USER)),
      accounts: () => new HttpResponse('not-json', { status: 200 })
    })

    await expect(resolveCloudflareCredential('cfut_token', 'user')).resolves.toEqual({
      type: 'user',
      user: USER,
      accounts: []
    })
  })

  it('falls back to the page count when total_count is missing', async () => {
    const accounts = Array.from({ length: 31 }, (_, index) => ({
      id: `account-${index + 1}`,
      name: `Account ${index + 1}`
    }))
    mockProbes({
      user: () => HttpResponse.json(cfSuccess(USER)),
      accounts: () =>
        HttpResponse.json({
          ...cfSuccess(accounts),
          result_info: { page: 1, per_page: 31, count: 31 }
        })
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(resolveCloudflareCredential('cfut_token', 'user')).resolves.toEqual({
      type: 'user',
      user: USER,
      accounts: [],
      accountCount: 31
    })
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('missing a valid result_info.total_count')
    )
  })
})

describe('getCloudflareOAuthUser', () => {
  it('preserves OAuth availability when /accounts is forbidden', async () => {
    mockProbes({
      user: () => HttpResponse.json(cfSuccess(USER)),
      accounts: () => new HttpResponse('Forbidden', { status: 403 })
    })

    await expect(getCloudflareOAuthUser('oauth-token')).resolves.toEqual({
      type: 'user',
      user: USER,
      accounts: []
    })
  })

  it('rejects an OAuth result without a user', async () => {
    mockProbes({
      user: () => new HttpResponse('Forbidden', { status: 403 }),
      accounts: () => HttpResponse.json(cfAccountsSuccess([ACCOUNT]))
    })

    await expectOAuthError(getCloudflareOAuthUser('oauth-token'), 'server_error', 500)
  })
})

describe('identity probe errors', () => {
  it.each([
    [401, 401, 'invalid_token', 401],
    [429, 429, 'temporarily_unavailable', 429],
    [500, 500, 'server_error', 502],
    [418, 418, 'invalid_token', 418],
    [403, 500, 'server_error', 502]
  ] as const)(
    'maps /user=%i and /accounts=%i to %s',
    async (userStatus, accountsStatus, code, statusCode) => {
      mockProbes({
        user: () => new HttpResponse('upstream error', { status: userStatus }),
        accounts: () => new HttpResponse('upstream error', { status: accountsStatus })
      })

      await expectOAuthError(
        resolveCloudflareCredential('legacy-token', 'unknown'),
        code,
        statusCode
      )
    }
  )

  it('uses a default Retry-After when the upstream omits it', async () => {
    mockProbes({
      user: () => new HttpResponse('rate limited', { status: 429 }),
      accounts: () => new HttpResponse('rate limited', { status: 429 })
    })

    const error = await expectOAuthError(
      resolveCloudflareCredential('legacy-token', 'unknown'),
      'temporarily_unavailable',
      429
    )
    expect(error.headers).toEqual({ 'Retry-After': '30' })
  })

  it('preserves Retry-After from a rate-limited probe', async () => {
    mockProbes({
      user: () =>
        new HttpResponse('rate limited', { status: 429, headers: { 'Retry-After': '17' } }),
      accounts: () => new HttpResponse('rate limited', { status: 429 })
    })

    const error = await expectOAuthError(
      resolveCloudflareCredential('legacy-token', 'unknown'),
      'temporarily_unavailable',
      429
    )
    expect(error.headers).toEqual({ 'Retry-After': '17' })
  })

  it('maps a network failure to server_error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network failed'))

    await expectOAuthError(
      resolveCloudflareCredential('legacy-token', 'unknown'),
      'server_error',
      502
    )
  })
})
