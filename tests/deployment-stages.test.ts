import { describe, expect, it } from 'vitest'
import { failedBuildStage } from '../src/deployment-status/stages'
import type { DeploymentStatus } from '../src/deployment-status/contract'

const build: NonNullable<DeploymentStatus['build']> = {
  build_uuid: '11111111-1111-4111-8111-111111111111',
  status: 'stopped',
  build_outcome: 'fail',
  created_on: '2026-11-16T12:00:00Z'
}
const events: DeploymentStatus['events'] = [
  { type: 'building', started_on: '2026-11-16T12:00:00Z', ended_on: '2026-11-16T12:01:00Z' },
  { type: 'deploying', started_on: '2026-11-16T12:01:00Z', ended_on: '2026-11-16T12:02:00Z' }
]
describe('failedBuildStage: one source for failure text and visualization', () => {
  it('attributes a failed run to its last started stage, not the overall name', () => {
    expect(failedBuildStage(build, events)).toBe('deploying')
    expect(failedBuildStage(build, events.slice(0, 1))).toBe('building')
  })
  it('never infers failure from stage boundaries without a failed outcome', () => {
    expect(failedBuildStage({ ...build, build_outcome: 'success' }, events)).toBeUndefined()
    expect(failedBuildStage({ ...build, status: 'running' }, events)).toBeUndefined()
  })
  it('does not guess when events are absent, duplicated or reversed', () => {
    expect(failedBuildStage(build, [])).toBeUndefined()
    expect(failedBuildStage(build, [...events, events[0]])).toBeUndefined()
    expect(
      failedBuildStage(build, [{ ...events[0], ended_on: '2026-11-16T11:00:00Z' }])
    ).toBeUndefined()
  })
})
