import { describe, expect, it } from 'vitest'
import { holdsKey, memberRoleReach, parseRoles, reaches } from '../scripts/lib/member-role-coverage'

const BASELINE = ['com.cloudflare.api.account.read', 'com.cloudflare.api.account.zone.read']
const D1 = 'com.cloudflare.api.account.d1'

const D1_READ = [...BASELINE, `${D1}.read`, `${D1}.list`]
const D1_WRITE = [...D1_READ, `${D1}.create`, `${D1}.update`, `${D1}.delete`]

describe('holdsKey', () => {
  it('matches a key exactly or under a held wildcard', () => {
    expect(holdsKey([`${D1}.read`], `${D1}.read`)).toBe(true)
    expect(holdsKey([`${D1}.*`], `${D1}.content.update`)).toBe(true)
    expect(holdsKey(['com.cloudflare.api.account.*'], `${D1}.*`)).toBe(true)
    expect(holdsKey([`${D1}.read`], `${D1}.*`)).toBe(false)
    expect(holdsKey([`${D1}.*`], 'com.cloudflare.api.account.d10.read')).toBe(false)
  })
})

describe('reaches', () => {
  it('reaches a read group with one of its keys beyond the baseline', () => {
    expect(reaches([...BASELINE, `${D1}.read`], D1_READ, BASELINE)).toBe(true)
  })

  it('needs one of a write group’s write keys, so read-only roles never reach it', () => {
    expect(reaches([...BASELINE, `${D1}.read`, `${D1}.list`], D1_WRITE, BASELINE)).toBe(false)
    expect(reaches([...BASELINE, `${D1}.read`, `${D1}.update`], D1_WRITE, BASELINE)).toBe(true)
  })

  it('treats inspecting verbs such as peek and verify as reads', () => {
    const queues = [...BASELINE, 'com.cloudflare.edge.worker.queue.read']
    const write = [
      ...queues,
      'com.cloudflare.edge.worker.queue.peek',
      'com.cloudflare.edge.worker.queue.update'
    ]
    expect(reaches([...queues, 'com.cloudflare.edge.worker.queue.peek'], write, BASELINE)).toBe(
      false
    )
  })

  it('does not count the baseline every member holds', () => {
    expect(reaches(BASELINE, D1_READ, BASELINE)).toBe(false)
  })

  it('reaches a bundled group from a narrow role that holds part of it', () => {
    const accountSettingsRead = [
      ...BASELINE,
      'com.cloudflare.api.account.audit-log.read',
      'com.cloudflare.api.account.setting.read'
    ]
    const auditLogsViewer = [...BASELINE, 'com.cloudflare.api.account.audit-log.read']
    expect(reaches(auditLogsViewer, accountSettingsRead, BASELINE)).toBe(true)
  })
})

describe('parseRoles and memberRoleReach', () => {
  const seed = (name: string, keys: string[], extra = '') => `seed:
    - type: role
      data:
        name: ${name}
        attributes:
            applicable_scopes: com.cloudflare.api.account
        permissions:
${keys.map((key) => `            - key: ${key}`).join('\n')}
${extra}`

  it('reads names, earlier names, keys and scope from a seed file', () => {
    const [role] = parseRoles(
      seed('D1 Read', D1_READ, '      previous:\n        - name: OAuth D1 Read\n')
    )
    expect(role).toEqual({
      name: 'D1 Read',
      previousNames: ['OAuth D1 Read'],
      keys: D1_READ,
      scope: 'com.cloudflare.api.account'
    })
  })

  it('maps each member role to the groups it reaches, leaving out roles that reach none', () => {
    const groups = [
      ...parseRoles(seed('D1 Read', D1_READ)),
      ...parseRoles(seed('D1 Write', D1_WRITE))
    ]
    const members = [
      ...parseRoles(seed('D1 Admin', [...BASELINE, `${D1}.*`])),
      ...parseRoles(seed('Read Only', [...BASELINE, `${D1}.read`, `${D1}.list`])),
      ...parseRoles(seed('Minimal Account Access', BASELINE))
    ]
    expect(Object.fromEntries(memberRoleReach(members, groups, BASELINE))).toEqual({
      'D1 Admin': ['D1 Read', 'D1 Write'],
      'Read Only': ['D1 Read']
    })
  })
})
