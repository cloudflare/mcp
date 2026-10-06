import { z } from 'zod'
import { serverRetryDelayMs } from './fetch-retry'

// These safety bounds apply even when ordinary tool-result truncation is disabled.
export const API_DIAGNOSTIC_MAX_BYTES = 8192
export const API_ERROR_MAX_COUNT = 8
export const API_ERROR_MAX_MESSAGE_BYTES = 512
const ERROR_BODY_MAX_BYTES = 32768

export function validDocumentationUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined
  try {
    const url = new URL(value)
    if (
      url.protocol === 'https:' &&
      url.hostname === 'developers.cloudflare.com' &&
      url.port === '' &&
      url.href.length <= 512 &&
      url.pathname.startsWith('/api/resources/') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !value.includes('?') &&
      !value.includes('#') &&
      !value.includes('\\')
    )
      return url.href
  } catch {
    /* Invalid links never hide the original error. */
  }
  return undefined
}

const providerErrorSchema = z.object({
  code: z.union([z.number().finite(), z.string().max(64)]).optional(),
  message: z.string().max(API_ERROR_MAX_MESSAGE_BYTES),
  documentation_url: z
    .string()
    .refine((value) => validDocumentationUrl(value) === value)
    .optional(),
  path: z
    .array(z.union([z.string().max(64), z.number().int()]))
    .max(8)
    .optional()
})

export const cloudflareApiErrorSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['cloudflare_api_error', 'graphql_error', 'invalid_api_response']),
    upstreamStatus: z.number().int().min(100).max(599),
    operation: z.object({ method: z.string().max(16), pathTemplate: z.string().max(256) }),
    errors: z.array(providerErrorSchema).max(API_ERROR_MAX_COUNT),
    requestId: z.string().max(64).optional(),
    retryAfterSeconds: z.number().int().min(0).max(86400).optional(),
    authorization: z.literal('unknown'),
    retry: z.enum(['do_not_retry_automatically', 'wait_before_retry'])
  })
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).length <= API_DIAGNOSTIC_MAX_BYTES
  )

export type CloudflareApiDiagnostic = z.infer<typeof cloudflareApiErrorSchema>

export class CloudflareApiError extends Error {
  constructor(readonly diagnostic: CloudflareApiDiagnostic) {
    super(apiErrorText(diagnostic))
  }
}

/** No request values or response bodies are copied into the route label. */
export function normalizedApiPath(path: string, templates: string[] = []): string {
  const segments = path.split('?')[0].replace(/\/+$/, '').split('/')
  for (const template of templates) {
    const parts = template.split('/')
    if (
      parts.length === segments.length &&
      parts.every((part, index) => /^\{[^}]+\}$/.test(part) || part === segments[index])
    )
      return boundedText(template, 256)
  }
  // Without a catalog match even apparently static segments may be object names.
  const root = ['accounts', 'zones', 'user', 'graphql'].includes(segments[1])
    ? segments[1]
    : '{redacted}'
  return `/${root}${segments.length > 2 ? '/{redacted}' : ''}`
}

function boundedText(value: string, maxBytes: number): string {
  return new TextDecoder()
    .decode(new TextEncoder().encode(value).slice(0, maxBytes))
    .replace(/\uFFFD$/, '')
}

function safeMessage(value: unknown, secret?: string): string {
  let message = typeof value === 'string' ? value : 'Cloudflare rejected the request'
  if (secret) message = message.split(secret).join('[redacted]')
  message = message
    .replace(/https?:\/\/[^\s]+/gi, '[redacted URL]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:cfat_|cfut_|cfoat_)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\p{Cc}/gu, ' ')
  return boundedText(message, API_ERROR_MAX_MESSAGE_BYTES)
}

function providerErrors(value: unknown, secret?: string): CloudflareApiDiagnostic['errors'] {
  if (!Array.isArray(value)) return []
  return value.slice(0, API_ERROR_MAX_COUNT).map((item) => {
    const error = item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const extensions =
      error.extensions && typeof error.extensions === 'object'
        ? (error.extensions as Record<string, unknown>)
        : {}
    const rawCode = error.code ?? extensions.code
    const code =
      typeof rawCode === 'number' && Number.isFinite(rawCode)
        ? rawCode
        : typeof rawCode === 'string'
          ? boundedText(safeMessage(rawCode, secret), 64)
          : undefined
    const link = validDocumentationUrl(error.documentation_url)
    const documentation_url = link && (!secret || !link.includes(secret)) ? link : undefined
    const path = Array.isArray(error.path)
      ? error.path
          .slice(0, 8)
          .flatMap<string | number>((part) =>
            typeof part === 'string'
              ? [boundedText(safeMessage(part, secret), 64)]
              : typeof part === 'number' && Number.isSafeInteger(part)
                ? [part]
                : []
          )
      : undefined
    return {
      ...(code !== undefined && { code }),
      message: safeMessage(error.message, secret),
      ...(documentation_url && { documentation_url }),
      ...(path && { path })
    }
  })
}

/** Consume only bounded failure JSON; discard HTML, text, and arbitrary error-body fields. */
async function readBoundedJson(
  response: Response
): Promise<{ value?: unknown; malformed?: boolean; oversized?: boolean }> {
  if (!response.headers.get('content-type')?.includes('application/json')) {
    void response.body?.cancel().catch(() => {})
    return {}
  }
  const reader = response.body?.getReader()
  if (!reader) return { malformed: true }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > ERROR_BODY_MAX_BYTES) {
        void reader.cancel().catch(() => {})
        return { oversized: true }
      }
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    return { value: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { malformed: true }
  } finally {
    reader.releaseLock()
  }
}

export type ApiResponseResult =
  | { kind: 'success'; value: unknown }
  | { kind: 'api_failure'; diagnostic: CloudflareApiDiagnostic }

export async function readApiResponse(
  response: Response,
  operation: CloudflareApiDiagnostic['operation'],
  secret?: string,
  inspectOnly = false
): Promise<ApiResponseResult> {
  let value: unknown
  let malformed = false
  if (!response.ok || inspectOnly) {
    const parsed = await readBoundedJson(response)
    if (response.ok && parsed.oversized) return { kind: 'success', value: undefined }
    value = parsed.value
    malformed = parsed.malformed === true
  } else {
    try {
      value = response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : await response.text()
    } catch {
      malformed = true
    }
  }
  const data = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const graphql =
    operation.pathTemplate === '/graphql' || operation.pathTemplate.endsWith('/graphql')
  const completeGraphqlFailure =
    graphql && Array.isArray(data.errors) && data.errors.length > 0 && data.data == null
  if (response.ok && !malformed && data.success !== false && !completeGraphqlFailure) {
    return { kind: 'success', value }
  }
  const delay = serverRetryDelayMs(response.headers)
  const ray = response.headers.get('CF-Ray')
  const diagnostic: CloudflareApiDiagnostic = {
    version: 1,
    kind: malformed
      ? 'invalid_api_response'
      : response.ok && completeGraphqlFailure
        ? 'graphql_error'
        : 'cloudflare_api_error',
    upstreamStatus: response.status,
    operation: {
      method: /^[A-Z]{1,16}$/.test(operation.method) ? operation.method : 'UNKNOWN',
      pathTemplate: boundedText(operation.pathTemplate, 256)
    },
    errors: providerErrors(data.errors, secret),
    ...(ray && /^[A-Za-z0-9-]{1,64}$/.test(ray) && { requestId: ray }),
    ...(delay !== undefined &&
      Number.isFinite(delay) && { retryAfterSeconds: Math.min(86400, Math.ceil(delay / 1000)) }),
    authorization: 'unknown',
    retry:
      response.status === 429 && delay !== undefined
        ? 'wait_before_retry'
        : 'do_not_retry_automatically'
  }
  while (
    diagnostic.errors.length > 0 &&
    new TextEncoder().encode(JSON.stringify(diagnostic)).length > API_DIAGNOSTIC_MAX_BYTES
  )
    diagnostic.errors.pop()
  return { kind: 'api_failure', diagnostic }
}

export function apiErrorText(diagnostic: CloudflareApiDiagnostic): string {
  const { method, pathTemplate } = diagnostic.operation
  const prefix = diagnostic.kind === 'graphql_error' ? 'GraphQL error' : 'Cloudflare API error'
  const errors = diagnostic.errors
    .map((error) => `${error.code !== undefined ? `${error.code}: ` : ''}${error.message}`)
    .join('; ')
  const docs = [
    ...new Set(
      diagnostic.errors.flatMap((error) =>
        error.documentation_url ? [error.documentation_url] : []
      )
    )
  ]
  return (
    `${prefix}: ${method} ${pathTemplate} returned HTTP ${diagnostic.upstreamStatus}${errors ? ` (${errors})` : ''}.` +
    (diagnostic.kind === 'invalid_api_response' ? ' The API returned malformed JSON.' : '') +
    (diagnostic.upstreamStatus === 401 || diagnostic.upstreamStatus === 403
      ? ' Check the endpoint documentation for accepted permissions and verify the credential’s access to this resource.'
      : '') +
    (diagnostic.retryAfterSeconds !== undefined
      ? ` Wait at least ${diagnostic.retryAfterSeconds} seconds before retrying.`
      : '') +
    docs.map((url) => `\nDocumentation: ${url}`).join('')
  )
}

export function formatApiError(diagnostic: CloudflareApiDiagnostic) {
  return {
    content: [{ type: 'text' as const, text: apiErrorText(diagnostic) }],
    structuredContent: diagnostic,
    isError: true as const
  }
}

/** Reapply redaction at the untrusted isolate boundary; shape validation is not authority. */
export function sanitizeApiDiagnostic(
  diagnostic: CloudflareApiDiagnostic,
  templates: string[],
  secret: string
): CloudflareApiDiagnostic {
  return {
    ...diagnostic,
    operation: {
      method: /^[A-Z]{1,16}$/.test(diagnostic.operation.method)
        ? diagnostic.operation.method
        : 'UNKNOWN',
      pathTemplate: normalizedApiPath(diagnostic.operation.pathTemplate, templates)
    },
    errors: providerErrors(diagnostic.errors, secret)
  }
}

/** Account guidance is optional detail, so it must share the diagnostic safety bounds. */
export function boundedApiHint(hint: string, secret: string): string {
  return safeMessage(hint, secret)
}
