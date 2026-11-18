import type { DeploymentStatus } from './contract'

/** Canonical stage order shared by collection and presentation. */
export const BUILD_STAGES = [
  ['initializing', 'Initializing'],
  ['cloning', 'Cloning'],
  ['installing_tools_and_deps', 'Installing'],
  ['building', 'Building'],
  ['deploying', 'Deploying']
] as const

/**
 * Stratus's failure attribution: the terminal failed run's last started stage.
 * Events contain boundaries, not an error or root cause. Ambiguous boundaries
 * must not attribute a failure to a particular stage.
 */
export function failedBuildStage(
  build: DeploymentStatus['build'],
  events: DeploymentStatus['events']
): DeploymentStatus['failureStage'] {
  if (build?.status !== 'stopped' || build.build_outcome !== 'fail') return undefined
  const started = events.filter((e) => e.started_on)
  if (new Set(events.map((e) => e.type)).size !== events.length || !started.length) return undefined
  const ordered = [...started].sort((a, b) => Date.parse(b.started_on!) - Date.parse(a.started_on!))
  const latest = ordered[0]
  if (ordered[1]?.started_on === latest.started_on) return undefined
  if (
    events.some(
      (e) => e.started_on && e.ended_on && Date.parse(e.ended_on) < Date.parse(e.started_on)
    )
  )
    return undefined
  return latest.type
}
