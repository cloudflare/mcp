/**
 * Temporary diagnostics for workers-oauth-provider 1.2's redirect URI policy: logs why a dynamic
 * client registration was refused, and what the client asked for, so we can tell which clients the
 * policy turns away. Remove once that's decided.
 */

const MAX_REDIRECT_URIS = 10
const MAX_FIELD_LENGTH = 120

function truncate(value: string, length = MAX_FIELD_LENGTH): string {
  return value.length > length ? `${value.slice(0, length)}…` : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A redirect URI reduced to what identifies the client: scheme, host and path. Any query, fragment
 * or userinfo is dropped.
 */
export function describeRedirectUri(value: unknown): string {
  if (typeof value !== 'string') return '(not a string)'
  try {
    const url = new URL(value)
    return truncate(`${url.protocol}//${url.host}${url.pathname}`)
  } catch {
    const scheme = value.includes(':') ? value.slice(0, value.indexOf(':')) : ''
    return `(unparseable, scheme ${truncate(scheme, 30) || 'none'})`
  }
}

async function readJson(message: Request | Response): Promise<unknown> {
  try {
    return await message.json()
  } catch {
    return undefined
  }
}

/**
 * Logs one `dcr_refused` line for a refused registration. `request` and `response` must be
 * unread copies: the provider consumes the originals.
 */
export async function logRefusedRegistration(request: Request, response: Response): Promise<void> {
  const [metadata, error] = await Promise.all([readJson(request), readJson(response)])
  const redirectUris =
    isRecord(metadata) && Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : []
  console.warn(
    JSON.stringify({
      event: 'dcr_refused',
      status: response.status,
      error: isRecord(error) && typeof error.error === 'string' ? error.error : undefined,
      description:
        isRecord(error) && typeof error.error_description === 'string'
          ? truncate(error.error_description)
          : undefined,
      userAgent: truncate(request.headers.get('user-agent') ?? '(none)'),
      clientName:
        isRecord(metadata) && typeof metadata.client_name === 'string'
          ? truncate(metadata.client_name, 80)
          : undefined,
      redirectUris: redirectUris.slice(0, MAX_REDIRECT_URIS).map(describeRedirectUri),
      redirectUriCount: redirectUris.length
    })
  )
}
