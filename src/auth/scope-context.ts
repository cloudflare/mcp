import { z } from 'zod'
import { insufficientScope, type OAuthResourceAuth } from '@cloudflare/workers-oauth-provider'
import {
  evaluateOperationScopes,
  matchOperationPolicy,
  type OperationPolicy
} from './operation-scopes'

const VerifiedContext = z.object({
  audience: z.url(),
  scope: z.array(z.string()),
  userId: z.string().min(1),
  clientId: z.string().min(1)
})
export type ScopeContext = z.infer<typeof VerifiedContext>

/**
 * Pinned provider 1.2.1: only its internal token branch supplies both identities.
 * External credentials have scope: [] and neither identity. Do not infer this
 * distinction from encrypted props, token prefixes, or request headers.
 */
export function verifiedScopeContext(auth: unknown): ScopeContext | undefined {
  const parsed = VerifiedContext.safeParse(auth)
  return parsed.success ? parsed.data : undefined
}

type Denial = { handle: string; scopes: string[]; path: string; safe: boolean }
export type DispatchAdmission =
  | { allowed: true }
  | { allowed: false; handle: string; scopes: string[]; safe: boolean }

/** Capability reaches only trusted GlobalOutbound, never the user-code worker. */
export class ScopeController {
  #started = 0
  #inFlight = 0
  #stopped = false
  #denials = new Map<string, Denial>()
  #terminal?: Denial

  constructor(
    readonly context: ScopeContext | undefined,
    readonly policies: OperationPolicy[],
    readonly apiBase: string
  ) {}

  beginDispatch(method: string, url: string): DispatchAdmission {
    if (this.#stopped) return { allowed: false, handle: '', scopes: [], safe: false }
    const decision = evaluateOperationScopes(
      matchOperationPolicy(method, new URL(url), this.apiBase, this.policies),
      this.context?.scope
    )
    if (decision.kind === 'insufficient') {
      const denial = {
        handle: crypto.randomUUID(),
        scopes: decision.scopes,
        path: decision.policy.path,
        safe: this.#started === 0 && this.#inFlight === 0
      }
      this.#stopped = true
      this.#denials.set(denial.handle, denial)
      return { allowed: false, handle: denial.handle, scopes: denial.scopes, safe: denial.safe }
    }
    this.#started++
    this.#inFlight++
    return { allowed: true }
  }

  finishDispatch(): void {
    this.#inFlight--
  }

  // Called by trusted host after the isolate returns a terminal helper failure.
  // The handle alone is untrusted; it must name an actual proxy denial.
  terminalFailure(handle: unknown): Denial | undefined {
    const denial = typeof handle === 'string' ? this.#denials.get(handle) : undefined
    if (denial) this.#terminal = denial
    return denial
  }

  challenge(auth: OAuthResourceAuth | undefined): Response | undefined {
    if (
      !auth ||
      !this.context ||
      !this.#terminal?.safe ||
      this.#started !== 0 ||
      this.#inFlight !== 0
    )
      return undefined
    return insufficientScope(
      auth,
      this.#terminal.scopes,
      'Additional permission is required for this operation'
    )
  }

  denyEndpoint(method: string, url: string): Denial | undefined {
    const admission = this.beginDispatch(method, url)
    if (admission.allowed) return undefined
    return (
      this.terminalFailure(admission.handle) ?? { handle: '', scopes: [], path: '', safe: false }
    )
  }
}
