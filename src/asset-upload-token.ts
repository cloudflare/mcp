import { z } from 'zod'

const ASSET_UPLOAD_PATHS = new Set([
  '/pages/assets/check-missing',
  '/pages/assets/upload',
  '/pages/assets/upsert-hashes'
])

const WORKERS_ASSET_UPLOAD_PATH = /^\/accounts\/[0-9a-f]{32}\/workers\/assets\/upload$/

const JWT_SEGMENT = /^[A-Za-z0-9_-]+$/

const CLOCK_SKEW_SECONDS = 60

const WORKERS_UPLOAD_TOKEN_PREFIX = 'cfwau_'

export function isAssetUploadPath(path: string): boolean {
  return ASSET_UPLOAD_PATHS.has(path) || WORKERS_ASSET_UPLOAD_PATH.test(path)
}

const JwtObject = z.looseObject({})

const JwtClaims = z.looseObject({ exp: z.number() })

function decodeSegment(segment: string): string {
  const base64 = segment.replaceAll('-', '+').replaceAll('_', '/')
  return atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
}

function isUnexpiredJwt(token: string, nowSeconds: number): boolean {
  const jwt = token.startsWith(WORKERS_UPLOAD_TOKEN_PREFIX)
    ? token.slice(WORKERS_UPLOAD_TOKEN_PREFIX.length)
    : token
  const segments = jwt.split('.')
  if (segments.length !== 3 || !segments.every((segment) => JWT_SEGMENT.test(segment))) {
    return false
  }
  try {
    const header = JwtObject.safeParse(JSON.parse(decodeSegment(segments[0])))
    const claims = JwtClaims.safeParse(JSON.parse(decodeSegment(segments[1])))
    if (!header.success || !claims.success) {
      return false
    }
    return claims.data.exp + CLOCK_SKEW_SECONDS > nowSeconds
  } catch {
    return false
  }
}

export function assetUploadAuthorization(
  request: Request,
  path: string,
  sessionToken: string,
  nowSeconds: number = Date.now() / 1000
): { token?: string } | undefined {
  if (request.method !== 'POST' || !isAssetUploadPath(path)) {
    return undefined
  }
  const match = /^Bearer (\S+)$/.exec(request.headers.get('authorization') ?? '')
  const token = match?.[1]
  return token && token !== sessionToken && isUnexpiredJwt(token, nowSeconds) ? { token } : {}
}
