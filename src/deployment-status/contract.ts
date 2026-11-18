import { z } from 'zod'

export const DEPLOYMENT_RESOURCE_URI = 'ui://cloudflare/deployment-status.html'
export const DeploymentInputSchema = z.strictObject({
  account_id: z
    .string()
    .regex(/^[a-f0-9]{32}$/i)
    .optional(),
  script_name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .describe('Exact Worker name. Resolve ambiguous site or account names before calling.'),
  build_id: z
    .uuid()
    .optional()
    .describe('Inspect a particular historical build; otherwise checks the latest build.')
})
export type DeploymentInput = z.infer<typeof DeploymentInputSchema>
export const BuildSchema = z.object({
  build_uuid: z.uuid(),
  created_on: z.iso.datetime({ offset: true }),
  status: z.enum(['queued', 'initializing', 'running', 'stopped']),
  build_outcome: z.enum(['success', 'fail', 'skipped', 'cancelled', 'terminated']).nullable(),
  running_on: z.string().nullable().optional(),
  stopped_on: z.string().nullable().optional(),
  trigger: z.object({ external_script_id: z.string() }).optional(),
  build_trigger_metadata: z
    .object({
      branch: z.string().max(512).optional(),
      commit_hash: z.string().max(128).optional(),
      commit_message: z.string().max(20000).optional(),
      author: z.string().max(512).optional()
    })
    .optional()
})
export const BuildEventSchema = z.object({
  type: z.enum(['initializing', 'cloning', 'installing_tools_and_deps', 'building', 'deploying']),
  started_on: z.iso.datetime({ offset: true }).optional(),
  ended_on: z.iso.datetime({ offset: true }).optional()
})
export const DeploymentStatusSchema = z.object({
  kind: z.literal('worker_deployment_status'),
  checkedAt: z.iso.datetime(),
  worker: z.string(),
  accountId: z.string(),
  state: z.enum([
    'live',
    'partial',
    'not_live',
    'building',
    'queued',
    'failed',
    'cancelled',
    'no_builds',
    'unverified'
  ]),
  message: z.string(),
  build: BuildSchema.nullable(),
  events: z.array(BuildEventSchema).default([]),
  failureStage: BuildEventSchema.shape.type.optional(),
  deploymentId: z.string().optional(),
  traffic: z.number().min(0).max(100).optional(),
  versions: z.array(z.object({ id: z.string(), percentage: z.number() })),
  limitations: z.array(z.string())
})
export type DeploymentStatus = z.infer<typeof DeploymentStatusSchema>
export const DEPLOYMENT_TOOL_CONFIG = {
  title: 'Worker deployment status',
  description:
    'Check whether a Worker’s latest build went out, what is currently deployed, or whether a build failed. Use for questions like “is my site live?”, “did my changes deploy?” and “why hasn’t my latest build gone out?” after resolving the site to a Worker. Reads Workers Builds and active deployment records, linking versions to builds. Read-only; never deploys or retries. Deployment traffic is not proof of HTTP availability or page correctness. Does not cover Pages or arbitrary external sites. Displays a compact status card in MCP Apps hosts; summarize the answer without repeating every field.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
}
