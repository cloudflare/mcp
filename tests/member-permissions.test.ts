import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import {
  memberPermissions,
  permissionsForRoles,
  resetMemberRolesMemo,
  toolVisible,
  visibleTools
} from '../src/auth/member-permissions'
import type { AuthProps } from '../src/auth/types'
import { membership, mockMemberships } from './helpers/cloudflare-api'
import { clearKv } from './helpers/kv'

const SUPER_ADMIN = 'Super Administrator - All Privileges'
const ADMIN_READ_ONLY = 'Administrator Read Only'

function userProps(accessToken = 'cfut_member'): AuthProps {
  return {
    type: 'user_token',
    accessToken,
    user: { id: 'user', email: 'user@example.com' },
    accounts: []
  }
}

afterEach(async () => {
  resetMemberRolesMemo()
  await clearKv(env.OAUTH_KV)
})

describe('permissionsForRoles', () => {
  it('reaches read permissions but not write ones for Administrator Read Only', async () => {
    const granted = await permissionsForRoles([ADMIN_READ_ONLY])
    expect(granted?.has('D1 Read')).toBe(true)
    expect(granted?.has('D1 Write')).toBe(false)
  })

  it('combines roles', async () => {
    const granted = await permissionsForRoles(['Billing', 'DNS'])
    expect(granted?.has('Billing Write')).toBe(true)
    expect(granted?.has('DNS Write')).toBe(true)
  })

  it('shows every tool when the roles reach everything, include an unknown role, or are none', async () => {
    expect(await permissionsForRoles([SUPER_ADMIN])).toBeUndefined()
    expect(await permissionsForRoles([ADMIN_READ_ONLY, 'A Role From Next Year'])).toBeUndefined()
    expect(await permissionsForRoles([])).toBeUndefined()
  })
})

describe('toolVisible', () => {
  const granted = new Set(['D1 Read', 'Zone Read'])

  it('shows a tool when any permission it accepts is granted', () => {
    expect(toolVisible(['D1 Read', 'D1 Write'], granted)).toBe(true)
    expect(toolVisible(['D1 Write'], granted)).toBe(false)
  })

  it('reads the spec’s drifted permission names', () => {
    expect(toolVisible(['Zone Zone Read'], granted)).toBe(true)
  })

  it('shows tools whose permissions are unknown or unlisted, and every tool without a grant', () => {
    expect(toolVisible(['D1 Write', 'A Permission From Next Year'], granted)).toBe(true)
    expect(toolVisible(undefined, granted)).toBe(true)
    expect(toolVisible(['D1 Write'], undefined)).toBe(true)
  })

  it('filters a tool list', () => {
    const tools = [{ name: 'read' }, { name: 'write' }, { name: 'unlisted' }]
    const permissions: Record<string, string[]> = { read: ['D1 Read'], write: ['D1 Write'] }
    expect(visibleTools(tools, (name) => permissions[name], granted)).toEqual([
      { name: 'read' },
      { name: 'unlisted' }
    ])
  })
})

describe('memberPermissions', () => {
  it('reads the roles on accepted memberships’ allow policies, across pages', async () => {
    mockMemberships([
      [
        membership([ADMIN_READ_ONLY]),
        membership([SUPER_ADMIN], { status: 'pending' }),
        membership([], {
          policies: [{ access: 'deny', permission_groups: [{ id: 'g', name: SUPER_ADMIN }] }]
        })
      ],
      [membership(['Billing'])]
    ])

    const granted = await memberPermissions(userProps())

    expect(granted?.has('D1 Read')).toBe(true)
    expect(granted?.has('D1 Write')).toBe(false)
    expect(granted?.has('Billing Write')).toBe(true)
  })

  it('caches the roles for the token, in memory and in KV', async () => {
    const memberships = mockMemberships([[membership([ADMIN_READ_ONLY])]])

    await memberPermissions(userProps())
    await memberPermissions(userProps())
    resetMemberRolesMemo() // as a fresh isolate would
    const granted = await memberPermissions(userProps())

    expect(granted?.has('D1 Write')).toBe(false)
    expect(memberships.requests).toBe(1)
  })

  it('shows every tool to account tokens without asking for memberships', async () => {
    const memberships = mockMemberships([[membership([ADMIN_READ_ONLY])]])
    const props: AuthProps = {
      type: 'account_token',
      accessToken: 'cfat_account',
      account: { id: 'account', name: 'Account' }
    }

    expect(await memberPermissions(props)).toBeUndefined()
    expect(memberships.requests).toBe(0)
  })

  it('shows every tool to a token that can’t read memberships, and remembers that', async () => {
    const memberships = mockMemberships({ status: 403 })

    expect(await memberPermissions(userProps())).toBeUndefined()
    expect(await memberPermissions(userProps())).toBeUndefined()
    expect(memberships.requests).toBe(1)
  })

  it('shows every tool when memberships fail, and asks again next time', async () => {
    const memberships = mockMemberships({ status: 500 })

    expect(await memberPermissions(userProps())).toBeUndefined()
    expect(await memberPermissions(userProps())).toBeUndefined()
    expect(memberships.requests).toBe(2)
  })

  it('shows every tool to a user with more accounts than it reads', async () => {
    mockMemberships(Array.from({ length: 5 }, () => [membership([ADMIN_READ_ONLY])]))

    expect(await memberPermissions(userProps())).toBeUndefined()
  })
})
