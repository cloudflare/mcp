/**
 * MCP clients that need behavior other than the spec's, and how to recognise them.
 *
 * Add an entry only for a client that deviates from the spec, and give it only
 * the fields that differ. Every other client gets {@link SPEC_BEHAVIOR}.
 */

/** What can differ between MCP clients. */
export interface ClientBehavior {
  /**
   * How the client learns it needs another OAuth scope.
   *
   * - `http`: the spec's `403` with `WWW-Authenticate: Bearer error="insufficient_scope"`
   *   replaces the response. Claude and Claude Code step up on it; an error tool
   *   result never prompts them.
   * - `tool`: the error tool result carries the same challenge in
   *   `_meta["mcp/www_authenticate"]`. Codex and ChatGPT step up only on this;
   *   an HTTP `403` fails their tool call (openai/codex#20518).
   */
  readonly scopeChallenge: 'http' | 'tool'
}

/** What the server knows about a connection's client. */
export interface ClientIdentity {
  /** The OAuth client ID: a Client ID Metadata Document URL or a registered ID. */
  readonly clientId: string
  /** Redirect URIs of a registered client. Read only when the client ID alone doesn't decide. */
  readonly redirectUris: () => Promise<readonly string[]>
}

interface KnownClient {
  readonly id: string
  readonly name: string
  /** The exact client ID the client publishes as its Client ID Metadata Document. */
  readonly clientIdMetadataDocument?: string
  /** A registered client is this one when any of its redirect URIs is on one of these hosts. */
  readonly redirectUriHosts?: readonly string[]
  readonly behavior: Partial<ClientBehavior>
}

/** Behavior for every client that isn't listed in {@link KNOWN_CLIENTS}. */
export const SPEC_BEHAVIOR: ClientBehavior = { scopeChallenge: 'http' }

const KNOWN_CLIENTS: readonly KnownClient[] = [
  {
    id: 'codex',
    name: 'Codex',
    clientIdMetadataDocument: 'https://chatgpt.com/oauth/codex/client.json',
    behavior: { scopeChallenge: 'tool' }
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    redirectUriHosts: ['chatgpt.com'],
    behavior: { scopeChallenge: 'tool' }
  }
]

function hostname(value: string): string | undefined {
  return URL.canParse(value) ? new URL(value).hostname : undefined
}

/**
 * Find the known client a connection belongs to.
 *
 * A URL client ID is a Client ID Metadata Document and is matched exactly
 * without I/O. Only a registered client ID needs its redirect URIs.
 *
 * @param identity - The connection's client.
 * @returns The matching entry's id and behavior, or the spec's behavior.
 */
export async function identifyClient(
  identity: ClientIdentity
): Promise<{ readonly id: string | undefined; readonly behavior: ClientBehavior }> {
  const known = URL.canParse(identity.clientId)
    ? KNOWN_CLIENTS.find((client) => client.clientIdMetadataDocument === identity.clientId)
    : await matchRegisteredClient(identity)
  return {
    id: known?.id,
    behavior: { ...SPEC_BEHAVIOR, ...known?.behavior }
  }
}

async function matchRegisteredClient(identity: ClientIdentity): Promise<KnownClient | undefined> {
  if (!KNOWN_CLIENTS.some((client) => client.redirectUriHosts)) return undefined
  const hosts = (await identity.redirectUris().catch(() => [])).map(hostname)
  return KNOWN_CLIENTS.find((client) =>
    (client.redirectUriHosts ?? []).some((host) => hosts.includes(host))
  )
}
