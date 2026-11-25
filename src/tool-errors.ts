/**
 * Why a tool call failed, for metrics (`tool_call` blob11 and double2, see
 * `src/metrics.ts`). A tool tags its error result with {@link classified};
 * the metrics wrapper reads the tag with {@link toolErrorOf}. The tag is held
 * in a WeakMap, so it never reaches the client.
 *
 * Every kind is a fixed label, never a message, so it can't carry customer data.
 */
import type { Authorization } from './api-permissions'

export const TOOL_ERROR_KINDS = [
  /** Arguments the input schema or the call planner rejected. */
  'invalid_arguments',
  /** A direct tool name that doesn't exist. */
  'unknown_tool',
  /** The call needs an account and the session has more than one. */
  'needs_account',
  /** This server's policy refused the request before it was sent. */
  'policy_refused',
  /** The user declined a subscription the call would create. */
  'declined',
  /** Cloudflare refused it; an OAuth scope the connection lacks would let it through. */
  'refused_missing_scope',
  /** Cloudflare refused it, and no OAuth scope covers the endpoint. */
  'refused_no_oauth_scope',
  /** Cloudflare refused it otherwise: a direct token, a held scope (usually the role), or an unlisted endpoint. */
  'refused_other',
  /** Cloudflare answered 429. */
  'rate_limited',
  /** The request was held back for a rate limit and never sent. */
  'not_sent',
  /** Any other 4xx from Cloudflare. */
  'api_4xx',
  /** A 5xx from Cloudflare. */
  'api_5xx',
  /** Any other failed Cloudflare answer, such as a 2xx with `success: false`. */
  'api_other',
  /** `search` or `execute` code threw, other than for a failed request. */
  'code_error',
  /** `execute` code was stopped for retrying requests a rate limit held back. */
  'run_stopped',
  /** This server failed, or a tool isn't configured here. */
  'internal',
  /** An error result no tool classified. */
  'other'
] as const

export type ToolErrorKind = (typeof TOOL_ERROR_KINDS)[number]

export interface ToolError {
  readonly kind: ToolErrorKind
  /** The HTTP status of the Cloudflare API answer that failed the call, if one did. */
  readonly status?: number
}

const errors = new WeakMap<object, ToolError>()

/** Tag a tool's error result with why it failed, and return it. */
export function classified<T extends object>(result: T, kind: ToolErrorKind, status?: number): T {
  errors.set(result, status === undefined ? { kind } : { kind, status })
  return result
}

/**
 * Why a tool result failed: its tag, or `other` for an untagged error result.
 * `undefined` for a result that isn't an error.
 */
export function toolErrorOf(result: unknown): ToolError | undefined {
  if (typeof result !== 'object' || result === null) {
    return undefined
  }
  if ((result as { isError?: unknown }).isError !== true) {
    return undefined
  }
  return errors.get(result) ?? { kind: 'other' }
}

export function isToolErrorKind(value: unknown): value is ToolErrorKind {
  return typeof value === 'string' && (TOOL_ERROR_KINDS as ReadonlyArray<string>).includes(value)
}

/** The kind of a refusal, from the permission check's decision. */
export function refusalKind(authorization: Authorization['kind']): ToolErrorKind {
  if (authorization === 'missing') {
    return 'refused_missing_scope'
  }
  if (authorization === 'unreachable') {
    return 'refused_no_oauth_scope'
  }
  return 'refused_other'
}

/** The kind of a failed Cloudflare answer that isn't a refusal. */
export function apiFailureKind(status: number): ToolErrorKind {
  if (status === 429) {
    return 'rate_limited'
  }
  if (status >= 400 && status < 500) {
    return 'api_4xx'
  }
  if (status >= 500) {
    return 'api_5xx'
  }
  return 'api_other'
}
