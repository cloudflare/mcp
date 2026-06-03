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

export const AccountAuthProps = z.object({
  type: z.literal('account_token'),
  accessToken: z.string(),
  account: AccountSchema
})

export const UserAuthProps = z.object({
  type: z.literal('user_token'),
  accessToken: z.string(),
  user: UserSchema,
  accounts: AccountsSchema,
  refreshToken: z.string().optional(),
  // Epoch seconds when the current upstream refresh token was issued (initial
  // auth or last successful refresh). Lets us report the dead token's age on an
  // invalid_grant denial. Optional: grants minted before this field shipped
  // won't have it until their next successful refresh.
  upstreamTokenIssuedAt: z.number().optional()
})

export const AuthProps = z.discriminatedUnion('type', [AccountAuthProps, UserAuthProps])

export type AuthProps = z.infer<typeof AuthProps>
export type UserSchema = z.infer<typeof UserSchema>
export type AccountSchema = z.infer<typeof AccountSchema>
export type AccountsSchema = z.infer<typeof AccountsSchema>
