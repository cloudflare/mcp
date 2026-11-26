import { z } from 'zod'
import { env } from 'cloudflare:workers'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { acceptedPermissions, authorize, explainRefusal, findOperation } from '../api-permissions'
import { getPermissionPaths } from '../isolate-cache'
import { apiCallResult } from '../tools/api-call-result'
import { WWW_AUTHENTICATE_META_KEY } from '../scope-challenge'
import { truncateResponse } from '../truncate'
import { fetchWithRetry } from '../utils/fetch-retry'
import type { AppContext } from './define'

/** The most an App reads from one response. Apps show summaries, not pages of records. */
export const MAX_READ_BYTES = 1024 * 1024

/**
 * Cloudflare refused or failed a read. `result` is the tool error the direct
 * tools would give for the same request: method, path, status, Cloudflare's
 * errors, an explanation and, for a missing OAuth scope, the step-up `_meta`.
 */
export class ApiReadError extends Error {
  constructor(readonly result: CallToolResult) {
    super('Cloudflare API read refused or failed')
  }
  /** The tool error's text. */
  get text(): string {
    const text = this.result.content.find((c) => c.type === 'text')
    return text?.type === 'text' ? text.text : this.message
  }
}

/** A response larger than {@link MAX_READ_BYTES}, or not JSON. */
export class ApiReadUnsupported extends Error {}

/** The GraphQL Analytics API, which the spec doesn't list, and the permission each dataset kind needs. */
const GRAPHQL_PERMISSIONS = {
  zone: ['Analytics Read'],
  account: ['Account Analytics Read']
} as const

/**
 * Whether GraphQL errors say the credential lacks the dataset's analytics
 * permission. A zone dataset names the permission; an account dataset says
 * only `authorization denied`. Kept in step with `graphqlRefusal` in
 * `src/tools/execute.ts`.
 */
export function graphqlRefused(
  messages: readonly string[],
  dataset: keyof typeof GRAPHQL_PERMISSIONS
): boolean {
  return dataset === 'zone'
    ? messages.some((m) => m.includes("'com.cloudflare.api.account.zone.analytics.read'"))
    : messages.some(
        (m) =>
          /^authorization denied$/i.test(m.trim()) ||
          m.includes("'com.cloudflare.api.account.analytics.read'")
      )
}

async function readBounded(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  if (reader)
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_READ_BYTES) {
        await reader.cancel()
        throw new ApiReadUnsupported('Response exceeded the 1 MB App read limit.')
      }
      chunks.push(part.value)
    }
  const raw = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    raw.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return JSON.parse(new TextDecoder().decode(raw))
  } catch {
    throw new ApiReadUnsupported('Cloudflare returned a non-JSON response.')
  }
}

/**
 * Read-only Cloudflare API access for one App call. Every read is a GET to a
 * fixed path, a POST to a documented read-only query endpoint
 * ({@link READ_ONLY_POSTS}), or a GraphQL Analytics query (which has no
 * mutations), sent with the request's credential from this Worker: the token
 * never reaches the App.
 */
export interface ApiReader {
  /**
   * GET `path` below the API base and parse its body with `schema`.
   *
   * @throws {ApiReadError} for a refusal or failure, explained like the direct tools.
   * @throws {ApiReadUnsupported} for an oversized or non-JSON body.
   * @throws {z.ZodError} when the body doesn't match `schema`.
   */
  get<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>>
  /**
   * POST a body to one of the API's read-only query endpoints
   * ({@link READ_ONLY_POSTS}) and parse the response with `schema`. Any other
   * path throws before anything is sent: an App's reader never writes.
   *
   * @throws {ApiReadError} for a refusal or failure, explained like the direct tools.
   * @throws {ApiReadUnsupported} for an oversized or non-JSON body.
   * @throws {z.ZodError} when the body doesn't match `schema`.
   */
  query<S extends z.ZodType>(path: string, body: object, schema: S): Promise<z.output<S>>
  /**
   * POST a GraphQL Analytics query and parse its `data` with `schema`.
   *
   * @param dataset - Which permission the query's datasets need: `account` or `zone`.
   * @throws {ApiReadError} when it returns errors, with or without data, explained as a refusal of the analytics permission when it is one.
   */
  graphql<S extends z.ZodType>(
    query: string,
    variables: Record<string, unknown>,
    dataset: keyof typeof GRAPHQL_PERMISSIONS,
    schema: S
  ): Promise<z.output<S>>
}

/**
 * The POST endpoints an App may read with: each one the API documents as a
 * read-only query that takes its filters in a body. Matched by template, so a
 * path that only starts like one is refused.
 */
export const READ_ONLY_POSTS: ReadonlyArray<string> = [
  // Billable usage and cost: "the filterable counterpart to GET on the same path".
  '/accounts/{account_id}/billable/usage'
]

/**
 * Create the reader for one App call.
 *
 * @param context - The request's credential, connection and step-up challenge.
 * @param signal - Aborts every read when the call is cancelled.
 * @param caller - Names the App in `fetchWithRetry` logs.
 */
export function apiReader(context: AppContext, signal: AbortSignal, caller: string): ApiReader {
  const base = env.CLOUDFLARE_API_BASE.replace(/\/$/, '')
  const basePath = new URL(base).pathname
  const send = (path: string, init: RequestInit) =>
    fetchWithRetry(
      base + path,
      {
        ...init,
        redirect: 'manual',
        signal,
        headers: {
          ...init.headers,
          authorization: `Bearer ${context.props.accessToken}`,
          accept: 'application/json'
        }
      },
      { caller }
    )

  /** Send one read and parse it, or throw the tool error the direct tools would give. */
  async function read<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    init: RequestInit,
    schema: S
  ): Promise<z.output<S>> {
    const requestPath = new URL(base + path).pathname.slice(basePath.length)
    const match = findOperation(getPermissionPaths(), method, requestPath)
    if (method === 'POST' && !READ_ONLY_POSTS.includes(match?.template ?? '')) {
      throw new Error(`${method} ${requestPath} is not a read-only query an App may send`)
    }
    const response = await send(path, { ...init, method })
    const body = await readBounded(response)
    const result = apiCallResult(
      {
        method,
        path: requestPath,
        template: match?.template ?? requestPath,
        permissions: acceptedPermissions(match?.operation),
        status: response.status,
        body
      },
      [],
      { ...context, formatResult: truncateResponse }
    )
    if (result.isError) throw new ApiReadError(result)
    return schema.parse(body)
  }

  return {
    get: (path, schema) => read('GET', path, {}, schema),

    query: (path, body, schema) =>
      read(
        'POST',
        path,
        { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
        schema
      ),

    async graphql(query, variables, dataset, schema) {
      const response = await send('/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables })
      })
      const body = (await readBounded(response)) as { data?: unknown; errors?: unknown }
      const errors = Array.isArray(body?.errors) ? (body.errors as { message?: unknown }[]) : []
      // Data with errors is partial: one alias failed (a quota, a timeout) and is missing. A
      // summary read from it would show a missing window as no traffic, so it fails as a whole.
      if (response.ok && body?.data != null && !errors.length) return schema.parse(body.data)
      const messages = errors.map((e) => String(e.message ?? '')).filter(Boolean)
      // The API answers a missing permission with 200 and `data: null`, as it
      // does a quota or a bad query, so only a permission message is a refusal.
      const refused = graphqlRefused(messages, dataset)
      const authorization = refused
        ? authorize(
            context.connection,
            { method: 'POST', path: '/graphql' },
            GRAPHQL_PERMISSIONS[dataset]
          )
        : undefined
      const text = [
        `Cloudflare API error: POST /graphql returned HTTP ${response.status} with ${body?.data == null ? 'no data' : 'partial data'}.`,
        truncateResponse(messages),
        authorization && explainRefusal(403, authorization)
      ]
        .filter(Boolean)
        .join('\n\n')
      const challenge =
        authorization?.kind === 'missing' && authorization.scope
          ? context.scopeChallenge.require(authorization.scope)
          : undefined
      throw new ApiReadError({
        isError: true,
        content: [{ type: 'text', text }],
        ...(challenge ? { _meta: { [WWW_AUTHENTICATE_META_KEY]: [challenge] } } : {})
      })
    }
  }
}
