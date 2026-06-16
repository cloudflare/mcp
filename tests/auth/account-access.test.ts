import { describe, expect, it } from 'vitest'
import {
  accountTokenId,
  autoResolvedAccountId,
  hasIncompleteLegacyAccountList,
  inlineableAccounts,
  isMultiAccountUser,
  isSingleAccountUser
} from '../../src/auth/account-access'
import { AUTH_PROPS_VERSION, LEGACY_ACCOUNTS_PAGE_SIZE, type AuthProps } from '../../src/auth/types'

const accountToken: AuthProps = {
  type: 'account_token',
  accessToken: 't',
  account: { id: 'acct-pinned', name: 'Pinned' }
}

function userToken(overrides: Partial<Extract<AuthProps, { type: 'user_token' }>>): AuthProps {
  return {
    type: 'user_token',
    accessToken: 't',
    user: { id: 'u1', email: 'u@example.com' },
    accounts: [],
    ...overrides
  }
}

function accountList(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `acct-${i + 1}`, name: `Account ${i + 1}` }))
}

describe('accountTokenId', () => {
  it('returns the pinned id for an account token', () => {
    expect(accountTokenId(accountToken)).toBe('acct-pinned')
  })

  it('returns undefined for user tokens and missing props', () => {
    expect(accountTokenId(userToken({ accounts: accountList(1) }))).toBeUndefined()
    expect(accountTokenId(undefined)).toBeUndefined()
  })
})

describe('autoResolvedAccountId', () => {
  it('resolves an account token to its pinned account', () => {
    expect(autoResolvedAccountId(accountToken)).toBe('acct-pinned')
  })

  it('resolves a single-account user token to its only account', () => {
    expect(autoResolvedAccountId(userToken({ accounts: accountList(1) }))).toBe('acct-1')
  })

  it('does not resolve a multi-account user token', () => {
    expect(autoResolvedAccountId(userToken({ accounts: accountList(2) }))).toBeUndefined()
  })
})

describe('isSingleAccountUser', () => {
  it('is true only for a user token with exactly one account', () => {
    expect(isSingleAccountUser(userToken({ accounts: accountList(1) }))).toBe(true)
    expect(isSingleAccountUser(userToken({ accounts: accountList(2) }))).toBe(false)
    expect(isSingleAccountUser(accountToken)).toBe(false)
  })
})

describe('hasIncompleteLegacyAccountList', () => {
  it('flags an unversioned grant holding exactly the legacy page size', () => {
    const props = userToken({ accounts: accountList(LEGACY_ACCOUNTS_PAGE_SIZE) })
    expect(hasIncompleteLegacyAccountList(props as never)).toBe(true)
  })

  it('does not flag the same size once versioned', () => {
    const props = userToken({
      accounts: accountList(LEGACY_ACCOUNTS_PAGE_SIZE),
      version: AUTH_PROPS_VERSION
    })
    expect(hasIncompleteLegacyAccountList(props as never)).toBe(false)
  })
})

describe('isMultiAccountUser', () => {
  it('covers stored list, omitted count, and legacy-incomplete', () => {
    expect(isMultiAccountUser(userToken({ accounts: accountList(2) }))).toBe(true)
    expect(isMultiAccountUser(userToken({ accounts: [], accountCount: 137 }))).toBe(true)
    expect(
      isMultiAccountUser(userToken({ accounts: accountList(LEGACY_ACCOUNTS_PAGE_SIZE) }))
    ).toBe(true)
  })

  it('is false for single-account, account-token, and empty sessions', () => {
    expect(isMultiAccountUser(userToken({ accounts: accountList(1) }))).toBe(false)
    expect(isMultiAccountUser(accountToken)).toBe(false)
    expect(isMultiAccountUser(userToken({ accounts: [] }))).toBe(false)
  })
})

describe('inlineableAccounts', () => {
  it('returns the list for a versioned multi-account user', () => {
    const accounts = accountList(3)
    expect(inlineableAccounts(userToken({ accounts, version: AUTH_PROPS_VERSION }))).toEqual(
      accounts
    )
  })

  it('returns null when the list was omitted (count only)', () => {
    expect(inlineableAccounts(userToken({ accounts: [], accountCount: 137 }))).toBeNull()
  })

  it('returns null for an incomplete legacy list', () => {
    expect(
      inlineableAccounts(userToken({ accounts: accountList(LEGACY_ACCOUNTS_PAGE_SIZE) }))
    ).toBeNull()
  })
})
