const ASSET_UPLOAD_PATHS = new Set([
  '/pages/assets/check-missing',
  '/pages/assets/upload',
  '/pages/assets/upsert-hashes'
])

const WORKERS_ASSET_UPLOAD_PATH = /^\/accounts\/[0-9a-f]{32}\/workers\/assets\/upload$/

const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/

const CLOCK_SKEW_SECONDS = 60

export function isAssetUploadPath(path: string): boolean {
  return ASSET_UPLOAD_PATHS.has(path) || WORKERS_ASSET_UPLOAD_PATH.test(path)
}

function decodeSegment(segment: string): unknown {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  return JSON.parse(atob(padded))
}

function isUnexpiredJwt(token: string, nowSeconds: number): boolean {
  const segments = token.split('.')
  if (segments.length !== 3 || !segments.every((segment) => JWT_SEGMENT.test(segment))) return false
  try {
    const header = decodeSegment(segments[0])
    const claims = decodeSegment(segments[1])
    if (
      typeof header !== 'object' ||
      header === null ||
      typeof claims !== 'object' ||
      claims === null
    )
      return false
    const exp = (claims as { exp?: unknown }).exp
    return typeof exp === 'number' && exp + CLOCK_SKEW_SECONDS > nowSeconds
  } catch {
    return false
  }
}

export function assetUploadToken(
  request: Request,
  path: string,
  sessionToken: string,
  nowSeconds: number = Date.now() / 1000
): string | undefined {
  if (request.method !== 'POST' || !isAssetUploadPath(path)) return undefined
  const match = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')
  const token = match?.[1]
  if (!token || token === sessionToken) return undefined
  return isUnexpiredJwt(token, nowSeconds) ? token : undefined
}
