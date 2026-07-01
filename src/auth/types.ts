import { z } from 'zod'

export const UserSchema = z.object({
  id: z.string(),
  email: z.string()
})

export const AccountSchema = z.object({
  id: z.string(),
  name: z.string()
})

export const AccountsSchema = z.array(AccountSchema)

/**
 * Max accounts whose IDs/names we are willing to store on a grant or in the
 * identity cache (and inline into prompt metadata). Above this, only the count
 * is kept so we never persist a long, potentially-sensitive account list.
 */
export const MAX_STORED_ACCOUNTS = 30

/**
 * Fetch one record past the storage cutoff. A full page proves the account list
 * is too large to persist even if pagination metadata is unexpectedly absent.
 */
export const ACCOUNTS_PROBE_PAGE_SIZE = MAX_STORED_ACCOUNTS + 1

/**
 * Account-list page size the identity probe used before MAX_STORED_ACCOUNTS
 * existed. A pre-versioning grant holding exactly this many accounts was almost
 * certainly truncated to the first page, so its list is treated as incomplete.
 */
export const LEGACY_ACCOUNTS_PAGE_SIZE = 20

/**
 * Schema version stamped onto props the current code writes. Props without a
 * version predate account-list versioning and may carry a truncated list.
 */
export const AUTH_PROPS_VERSION = 1

export const AccountAuthProps = z.object({
  type: z.literal('account_token'),
  accessToken: z.string(),
  account: AccountSchema
})

export const UserAuthProps = z.object({
  type: z.literal('user_token'),
  accessToken: z.string(),
  user: UserSchema,
  // Emptied when the user has more than MAX_STORED_ACCOUNTS accounts; the total
  // is then kept in accountCount instead of persisting the full list.
  accounts: AccountsSchema,
  accountCount: z.number().optional(),
  // Absent on pre-versioning grants (see AUTH_PROPS_VERSION).
  version: z.number().optional(),
  refreshToken: z.string().optional()
})

export const AuthProps = z.discriminatedUnion('type', [AccountAuthProps, UserAuthProps])

export type AuthProps = z.infer<typeof AuthProps>
export type UserSchema = z.infer<typeof UserSchema>
export type AccountSchema = z.infer<typeof AccountSchema>
export type AccountsSchema = z.infer<typeof AccountsSchema>
