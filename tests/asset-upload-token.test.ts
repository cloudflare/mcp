import { describe, expect, it } from 'vitest'
import { assetUploadAuthorization, isAssetUploadPath } from '../src/asset-upload-token'

const NOW = 1_800_000_000
const SESSION = 'session-token'
const ACCOUNT = '0123456789abcdef0123456789abcdef'

function base64Url(value: object): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function jwt(claims: object): string {
  return `${base64Url({ alg: 'HS256', typ: 'JWT' })}.${base64Url(claims)}.${base64Url({ test: true })}`
}

function post(token: string | undefined, method = 'POST'): Request {
  return new Request('https://api.cloudflare.com/client/v4/pages/assets/upload', {
    method,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` }
  })
}

describe('isAssetUploadPath', () => {
  it.each([
    '/pages/assets/check-missing',
    '/pages/assets/upload',
    '/pages/assets/upsert-hashes',
    `/accounts/${ACCOUNT}/workers/assets/upload`
  ])('accepts %s', (path) => {
    expect(isAssetUploadPath(path)).toBe(true)
  })

  it.each([
    '/pages/assets/upload/extra',
    '/pages/assets',
    `/accounts/${ACCOUNT}/workers/scripts/app/assets-upload-session`,
    `/accounts/${ACCOUNT}/pages/projects/site/upload-token`,
    '/accounts/not-an-id/workers/assets/upload',
    '/user/tokens'
  ])('refuses %s', (path) => {
    expect(isAssetUploadPath(path)).toBe(false)
  })
})

describe('assetUploadAuthorization', () => {
  const valid = jwt({ exp: NOW + 300 })

  it('keeps an unexpired upload JWT on an asset upload path', () => {
    expect(assetUploadAuthorization(post(valid), '/pages/assets/upload', SESSION, NOW)).toEqual({
      token: valid
    })
  })

  it('keeps a cfwau_ Workers upload JWT with its prefix', () => {
    const workers = `cfwau_${valid}`
    expect(
      assetUploadAuthorization(
        post(workers),
        `/accounts/${ACCOUNT}/workers/assets/upload`,
        SESSION,
        NOW
      )
    ).toEqual({ token: workers })
  })

  it('ignores an expired cfwau_ JWT', () => {
    expect(
      assetUploadAuthorization(
        post(`cfwau_${jwt({ exp: NOW - 120 })}`),
        '/pages/assets/upload',
        SESSION,
        NOW
      )
    ).toEqual({})
  })

  it('ignores the bearer on any other path', () => {
    expect(
      assetUploadAuthorization(post(valid), `/accounts/${ACCOUNT}/workers/scripts`, SESSION, NOW)
    ).toBeUndefined()
  })

  it('ignores the bearer on a GET', () => {
    expect(
      assetUploadAuthorization(post(valid, 'GET'), '/pages/assets/upload', SESSION, NOW)
    ).toBeUndefined()
  })

  it('ignores an expired JWT', () => {
    expect(
      assetUploadAuthorization(post(jwt({ exp: NOW - 120 })), '/pages/assets/upload', SESSION, NOW)
    ).toEqual({})
  })

  it('ignores a JWT without an expiry', () => {
    expect(
      assetUploadAuthorization(post(jwt({ sub: 'x' })), '/pages/assets/upload', SESSION, NOW)
    ).toEqual({})
  })

  it('ignores a bearer that is not a JWT', () => {
    expect(
      assetUploadAuthorization(post('someone-else'), '/pages/assets/upload', SESSION, NOW)
    ).toEqual({})
    expect(assetUploadAuthorization(post('a.b.c'), '/pages/assets/upload', SESSION, NOW)).toEqual(
      {}
    )
  })

  it('ignores the session token itself', () => {
    const session = jwt({ exp: NOW + 300 })
    expect(assetUploadAuthorization(post(session), '/pages/assets/upload', session, NOW)).toEqual(
      {}
    )
  })

  it('ignores a request without Authorization', () => {
    expect(assetUploadAuthorization(post(undefined), '/pages/assets/upload', SESSION, NOW)).toEqual(
      {}
    )
  })
})
