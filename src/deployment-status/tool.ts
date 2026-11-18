import { z } from 'zod'
import { autoResolvedAccountId, missingAccountMessage } from '../auth/account-access'
import { defineMcpApp, type AppContext, type AppOutcome } from '../mcp-apps/define'
import { ApiReadError, ApiReadUnsupported, apiReader } from '../mcp-apps/api-read'
import {
  BuildSchema,
  BuildEventSchema,
  DEPLOYMENT_RESOURCE_URI,
  DEPLOYMENT_TOOL_CONFIG,
  DeploymentInputSchema,
  DeploymentStatusSchema,
  type DeploymentInput,
  type DeploymentStatus
} from './contract'
import { appHtml } from './app-html.generated'
import { BUILD_STAGES, failedBuildStage } from './stages'

const deploymentsSchema = z.object({
  result: z.object({
    deployments: z.array(
      z.object({
        id: z.string(),
        versions: z.array(
          z.object({ version_id: z.string(), percentage: z.number().min(0).max(100) })
        )
      })
    )
  })
})

/** Collects deployment evidence through fixed, read-only Cloudflare API paths. */
async function collect(
  input: DeploymentInput,
  context: AppContext,
  signal: AbortSignal
): Promise<AppOutcome<DeploymentStatus>> {
  const accountId = input.account_id ?? autoResolvedAccountId(context.props)
  if (!accountId)
    return { ok: false, text: missingAccountMessage(context.props, 'Use GET /accounts.') }
  const status: DeploymentStatus = {
    kind: 'worker_deployment_status',
    checkedAt: new Date().toISOString(),
    worker: input.script_name,
    accountId,
    state: 'unverified',
    message: 'Deployment could not be verified.',
    build: null,
    events: [],
    versions: [],
    limitations: [
      'Deployment records do not test HTTP availability, page content, or application correctness.'
    ]
  }
  let challenge: Record<string, unknown> | undefined
  const reader = apiReader(context, signal, 'deployment_status')
  const read = <S extends z.ZodType>(path: string, schema: S) => reader.get(path, schema)
  const prefix = `/accounts/${accountId}`
  try {
    const scripts = await read(
      `${prefix}/workers/scripts`,
      z.object({ result: z.array(z.object({ id: z.string(), tag: z.string().optional() })) })
    )
    const worker = scripts.result.find((s) => s.id === input.script_name)
    if (!worker)
      throw new Error(
        'Worker was not found in the accessible scripts list. Resolve its exact name and account.'
      )
    const deployment = await read(
      `${prefix}/workers/scripts/${encodeURIComponent(input.script_name)}/deployments`,
      deploymentsSchema
    )
    const active = deployment.result.deployments[0]
    if (active) {
      status.deploymentId = active.id
      status.versions = active.versions.map((v) => ({ id: v.version_id, percentage: v.percentage }))
    }
    if (!worker.tag) throw new Error('Worker tag unavailable; build history cannot be resolved.')
    let build
    if (input.build_id) {
      build = (
        await read(`${prefix}/builds/builds/${input.build_id}`, z.object({ result: BuildSchema }))
      ).result
      if (build.trigger?.external_script_id !== worker.tag)
        throw new Error('Requested build could not be linked to this Worker.')
    } else {
      const builds = await read(
        `${prefix}/builds/workers/${worker.tag}/builds?per_page=25&page=1`,
        z.object({ result: z.array(BuildSchema) })
      )
      status.limitations.push(
        'Latest build selected from the first 25 returned records; branch-specific history and log text are not inspected.'
      )
      build = [...builds.result].sort(
        (a, b) => Date.parse(b.created_on) - Date.parse(a.created_on)
      )[0]
    }
    if (!build) {
      status.state = 'no_builds'
      status.message =
        'No Workers Builds history was returned. This does not mean the Worker is not deployed.'
    } else {
      status.build = build
      try {
        const logs = await read(
          `${prefix}/builds/builds/${build.build_uuid}/logs`,
          z.object({ result: z.object({ events: z.array(BuildEventSchema).max(5).default([]) }) })
        )
        status.events = logs.result.events
      } catch (error) {
        if (signal.aborted) throw error
        status.limitations.push(
          'Stage events could not be read. Stage timing is unavailable; build and traffic evidence remain separate.'
        )
      }
      if (build.status === 'queued') {
        status.state = 'queued'
        status.message = 'The build is queued.'
      } else if (build.status !== 'stopped') {
        status.state = 'building'
        status.message = 'The build is still running.'
      } else if (build.build_outcome === 'fail') {
        status.state = 'failed'
        status.failureStage = failedBuildStage(build, status.events)
        const label = BUILD_STAGES.find(([type]) => type === status.failureStage)?.[1]
        status.message =
          status.failureStage === 'deploying'
            ? 'Deployment failed. This run is not established as deployed.'
            : label
              ? `The build run failed during ${label.toLowerCase()}. Its changes are not established as deployed.`
              : 'The build run failed. The failed stage and deployed changes could not be established.'
        status.limitations.push(
          'Only structured stage events were retained from the logs response. Log text was not inspected; the failure cause is not established by this status check.'
        )
      } else if (
        build.build_outcome === 'cancelled' ||
        build.build_outcome === 'terminated' ||
        build.build_outcome === 'skipped'
      ) {
        status.state = 'cancelled'
        status.message = `The build was ${build.build_outcome}.`
      } else if (build.build_outcome === 'success' && active) {
        const ids = active.versions.filter((v) => v.percentage > 0).map((v) => v.version_id)
        if (ids.length > 20)
          throw new Error('Too many active versions to verify in one status check.')
        if (ids.length) {
          const links = await read(
            `${prefix}/builds/builds?version_ids=${encodeURIComponent(ids.join(','))}`,
            z.object({
              result: z.object({
                builds: z.record(z.string(), z.object({ build_uuid: z.string() }))
              })
            })
          )
          const confirmed = active.versions
            .filter((v) => links.result.builds[v.version_id]?.build_uuid === build.build_uuid)
            .reduce((sum, v) => sum + v.percentage, 0)
          const again = await read(
            `${prefix}/workers/scripts/${encodeURIComponent(input.script_name)}/deployments`,
            deploymentsSchema
          )
          if (JSON.stringify(again.result.deployments[0]) !== JSON.stringify(active))
            throw new Error(
              'Deployment changed during the check. Check again for a coherent status.'
            )
          status.traffic = confirmed
          if (confirmed === 100) {
            status.state = 'live'
            status.message = 'This build is deployed to 100% of Worker traffic.'
          } else if (confirmed > 0) {
            status.state = 'partial'
            status.message = `This build receives ${confirmed}% of Worker traffic.`
          } else if (ids.every((id) => links.result.builds[id])) {
            status.state = 'not_live'
            status.message =
              'The build succeeded, but the active deployment serves a different build.'
          } else
            status.message =
              'The build succeeded, but active versions could not all be linked to builds.'
        }
      }
    }
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof ApiReadError) {
      challenge = error.result._meta
      status.limitations.push(
        'A Cloudflare API read was refused or failed. See the text result for details.'
      )
      status.message = 'A required Cloudflare status read failed.'
      status.state = 'unverified'
      status.limitations.push(error.text)
      delete status.traffic
    } else {
      status.state = 'unverified'
      status.message =
        error instanceof z.ZodError
          ? 'Cloudflare returned an unsupported status response.'
          : error instanceof ApiReadUnsupported
            ? error.message
            : error instanceof Error &&
                [
                  'Worker was',
                  'Worker tag',
                  'Requested build',
                  'Too many',
                  'Deployment changed'
                ].some((p) => error.message.startsWith(p))
              ? error.message
              : 'A required status read could not be completed.'
    }
  }
  status.checkedAt = new Date().toISOString()
  return { ok: true, value: status, ...(challenge ? { meta: challenge } : {}) }
}

/** The read-only Worker deployment status App, served in both tool modes. */
export const deploymentStatusApp = defineMcpApp({
  name: 'workers_deployment_status',
  ...DEPLOYMENT_TOOL_CONFIG,
  input: DeploymentInputSchema,
  output: DeploymentStatusSchema,
  resource: { uri: DEPLOYMENT_RESOURCE_URI, name: 'Worker deployment status', html: appHtml },
  run: collect
})
