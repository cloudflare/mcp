import { z } from 'zod'
import { DERIVED_OAUTH_SCOPES, type ScopeDefinition } from './derived-oauth-scopes'
import type { OperationInfo } from '../openapi'

export const POLICY_VERSION = 1
export const RESOLVER_VERSION = 'exact-label-v1'
export const PermissionLabels = z.array(z.string().min(1).max(256)).max(100)
const Alternative = z.object({
  label: z.string(),
  scopes: z.array(z.string()),
  unresolved: z.boolean()
})
const Policy = z.object({
  method: z.string(),
  path: z.string(),
  operationId: z.string().optional(),
  labels: PermissionLabels,
  alternatives: z.array(Alternative),
  state: z.enum(['absent', 'candidate', 'unresolved', 'reviewed']),
  review: z.object({ source: z.string(), version: z.string() }).optional(),
  excludedLabels: z.record(z.string(), z.string()).optional()
})
export const PolicyArtifact = z.object({
  version: z.literal(POLICY_VERSION),
  resolverVersion: z.literal(RESOLVER_VERSION),
  rawSchemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  catalogHash: z.string().regex(/^[a-f0-9]{64}$/),
  schemaVersion: z.string().optional(),
  operations: z.array(Policy)
})
export type OperationPolicy = z.infer<typeof Policy>
export type OperationPolicyArtifact = z.infer<typeof PolicyArtifact>
export interface ReviewedOperation {
  method: string
  path: string
  labels: string[]
  anyOf: string[][]
  excludedLabels?: Record<string, string>
  source: string
  version: string
  rawSchemaHash: string
  catalogHash: string
}

// A display-name join cannot prove OAuth permission equivalence. Enable a rule
// only after the API/OAuth contract and its alternatives have been reviewed.
const REVIEWED_OPERATIONS: readonly ReviewedOperation[] = []
const AMBIGUOUS_RESOURCE_SCOPES: Record<string, [string, string]> = {
  'Logs Read': ['account-logs.read', 'logs.read'],
  'Logs Write': ['account-logs.write', 'logs.write'],
  'Access: Apps and Policies Read': ['access.read', 'zone-access.read'],
  'Access: Apps and Policies Write': ['access.write', 'zone-access.write'],
  'Access: Apps and Policies Revoke': ['access.revoke', 'zone-access.revoke']
}

export function deriveOperationPolicies(
  paths: Record<string, Record<string, OperationInfo>>,
  catalog: Record<string, ScopeDefinition> = DERIVED_OAUTH_SCOPES,
  reviews: readonly ReviewedOperation[] = REVIEWED_OPERATIONS
): OperationPolicy[] {
  const labels = new Map<string, string[]>()
  for (const [scope, definition] of Object.entries(catalog).sort()) {
    labels.set(definition.name, [...(labels.get(definition.name) ?? []), scope])
  }
  const policies: OperationPolicy[] = []
  for (const path of Object.keys(paths).sort()) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = paths[path][method]
      if (!operation) continue
      const original = operation['x-api-token-group'] ?? []
      const leading = path.match(/^\/(accounts|zones)\/\{[^/{}]+\}(?:\/|$)/)?.[1]
      const contexts = new Set(
        [...path.matchAll(/\/(accounts|zones)\/\{[^/{}]+\}(?=\/|$)/g)].map((match) => match[1])
      )
      const context = contexts.size === 1 ? leading : undefined
      const alternatives = original.map((label) => {
        const matches = labels.get(label) ?? []
        const resourceChoice = AMBIGUOUS_RESOURCE_SCOPES[label]
        // These are candidates only; route context does not constitute review.
        const choice =
          resourceChoice && context ? resourceChoice[context === 'accounts' ? 0 : 1] : undefined
        const scopes =
          matches.length === 1 ? matches : choice && matches.includes(choice) ? [choice] : []
        return { label, scopes, unresolved: scopes.length === 0 }
      })
      const review = reviews.find(
        (rule) =>
          rule.method.toLowerCase() === method &&
          rule.path === path &&
          JSON.stringify(rule.labels) === JSON.stringify(original)
      )
      const reviewed =
        review &&
        Object.entries(review.excludedLabels ?? {}).every(
          ([label, source]) => original.includes(label) && source.length > 0
        ) &&
        review.anyOf.length ===
          original.filter((label) => !(label in (review.excludedLabels ?? {}))).length &&
        review.anyOf.length > 0 &&
        review.anyOf.every(
          (set) =>
            set.length > 0 &&
            set.every(
              (scope) =>
                scope !== 'offline_access' &&
                (scope in catalog || ['user:read', 'account:read'].includes(scope))
            )
        )
      policies.push({
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId,
        labels: [...original],
        alternatives: reviewed
          ? review.anyOf.map((scopes, index) => ({
              label: original.filter((label) => !(label in (review.excludedLabels ?? {})))[index],
              scopes: [...scopes].sort(),
              unresolved: false
            }))
          : alternatives,
        state: reviewed
          ? 'reviewed'
          : original.length === 0
            ? 'absent'
            : alternatives.some((item) => item.unresolved)
              ? 'unresolved'
              : 'candidate',
        ...(reviewed
          ? {
              review: { source: review.source, version: review.version },
              excludedLabels: review.excludedLabels
            }
          : {})
      })
    }
  }
  return policies
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export async function buildOperationPolicyArtifact(
  paths: Record<string, Record<string, OperationInfo>>,
  rawSchema: string,
  schemaVersion?: string
): Promise<OperationPolicyArtifact> {
  const info = z
    .object({ info: z.object({ version: z.string() }).optional() })
    .safeParse(JSON.parse(rawSchema))
  const artifact: OperationPolicyArtifact = {
    version: POLICY_VERSION,
    resolverVersion: RESOLVER_VERSION,
    rawSchemaHash: await sha256(rawSchema),
    catalogHash: await sha256(JSON.stringify(DERIVED_OAUTH_SCOPES)),
    schemaVersion: schemaVersion ?? (info.success ? info.data.info?.version : undefined),
    operations: deriveOperationPolicies(paths)
  }
  return { ...artifact, operations: deployedOperationPolicies(artifact) }
}

export function policyCoverage(operations: readonly OperationPolicy[]) {
  const counts = {
    total: operations.length,
    absent: 0,
    unmatched: 0,
    ambiguous: 0,
    completeCandidates: 0,
    routeResolvedCandidates: 0,
    unresolved: 0,
    enabled: 0
  }
  const names = new Map<string, number>()
  for (const definition of Object.values(DERIVED_OAUTH_SCOPES))
    names.set(definition.name, (names.get(definition.name) ?? 0) + 1)
  for (const policy of operations) {
    if (policy.state === 'absent') counts.absent++
    if (policy.state === 'candidate') {
      if (policy.labels.every((label) => names.get(label) === 1)) counts.completeCandidates++
      else counts.routeResolvedCandidates++
    }
    if (policy.state === 'unresolved') counts.unresolved++
    if (policy.state === 'reviewed') counts.enabled++
    if (policy.labels.some((label) => !names.has(label))) counts.unmatched++
    if (policy.labels.some((label) => (names.get(label) ?? 0) > 1)) counts.ambiguous++
  }
  return counts
}

/** Match the entire configured API path, never a suffix or a decoded separator. */
export function matchOperationPolicy(
  method: string,
  url: URL,
  apiBase: string,
  policies: readonly OperationPolicy[]
): OperationPolicy | undefined {
  const base = new URL(apiBase)
  const prefix = base.pathname.replace(/\/$/, '')
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix + '/')) return undefined
  const path = url.pathname.slice(prefix.length).replace(/\/$/, '')
  if (/%(?:2f|5c)/i.test(path)) return undefined
  let segments: string[]
  try {
    segments = path.split('/').map((part) => decodeURIComponent(part))
  } catch {
    return undefined
  }
  const matches = policies.filter(
    (policy) =>
      policy.method === method.toUpperCase() &&
      policy.path.split('/').length === segments.length &&
      policy.path
        .split('/')
        .every((part, index) =>
          /^\{[^/{}]+\}$/.test(part) ? segments[index].length > 0 : part === segments[index]
        )
  )
  return matches.length === 1 ? matches[0] : undefined
}

export type ScopeDecision =
  | { kind: 'allowed' | 'unknown' }
  | { kind: 'insufficient'; scopes: string[]; policy: OperationPolicy }
export function evaluateOperationScopes(
  policy: OperationPolicy | undefined,
  scopes: readonly string[] | undefined,
  implications: Readonly<Record<string, readonly string[]>> = {}
): ScopeDecision {
  if (!policy || !scopes || policy.state !== 'reviewed' || !policy.review)
    return { kind: 'unknown' }
  const granted = new Set(scopes)
  const pending = [...granted]
  for (let index = 0; index < pending.length; index++) {
    for (const implied of implications[pending[index]] ?? []) {
      if (!granted.has(implied)) {
        granted.add(implied)
        pending.push(implied)
      }
    }
  }
  const known = policy.alternatives.filter((item) => !item.unresolved && item.scopes.length > 0)
  if (known.some((item) => item.scopes.every((scope) => granted.has(scope))))
    return { kind: 'allowed' }
  if (known.length === 0 || policy.alternatives.some((item) => item.unresolved))
    return { kind: 'unknown' }
  // No suffix-derived scope hierarchy: every required scope must actually hold.
  // Prefer the least missing scopes, then read alternatives, then stable text.
  const sorted = known
    .map((item) => [...item.scopes].sort())
    .sort(
      (a, b) =>
        a.filter((scope) => !granted.has(scope)).length -
          b.filter((scope) => !granted.has(scope)).length ||
        a.filter((scope) => !scope.endsWith('.read')).length -
          b.filter((scope) => !scope.endsWith('.read')).length ||
        a.join(' ').localeCompare(b.join(' '))
    )
  return { kind: 'insufficient', scopes: sorted[0], policy }
}

/** R2 artifacts cannot activate a review that is absent from this deployment. */
export function deployedOperationPolicies(artifact: OperationPolicyArtifact): OperationPolicy[] {
  return artifact.operations.map((policy) => {
    if (policy.state !== 'reviewed') return policy
    const review = REVIEWED_OPERATIONS.find(
      (rule) =>
        rule.method.toUpperCase() === policy.method &&
        rule.rawSchemaHash === artifact.rawSchemaHash &&
        rule.catalogHash === artifact.catalogHash &&
        rule.path === policy.path &&
        JSON.stringify(rule.labels) === JSON.stringify(policy.labels) &&
        JSON.stringify(rule.excludedLabels) === JSON.stringify(policy.excludedLabels) &&
        rule.source === policy.review?.source &&
        rule.version === policy.review?.version &&
        JSON.stringify(rule.anyOf.map((set) => [...set].sort())) ===
          JSON.stringify(policy.alternatives.map((item) => item.scopes))
    )
    return review ? policy : { ...policy, state: 'candidate', review: undefined }
  })
}
