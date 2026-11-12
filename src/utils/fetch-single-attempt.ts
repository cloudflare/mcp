import { USER_AGENT } from '../constants'

/** Numeric provider codes only: error messages can echo uploaded source or credentials. */
function providerErrorCodes(body: unknown): number[] {
  if (!body || typeof body !== 'object' || !('errors' in body) || !Array.isArray(body.errors)) {
    return []
  }
  return body.errors.flatMap((error: unknown) =>
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'number' &&
    Number.isSafeInteger(error.code)
      ? [error.code]
      : []
  )
}

/**
 * One application-level fetch, with no redirect or retry. An interrupted fetch
 * may already have committed a mutation, so its outcome must not be called a rejection.
 */
export async function fetchSingleAttempt(request: Request): Promise<Response> {
  const headers = new Headers(request.headers)
  headers.set('User-Agent', USER_AGENT)
  let response: Response
  try {
    response = await fetch(new Request(request, { headers, redirect: 'manual' }))
  } catch {
    throw new Error(
      'Cloudflare API outcome unknown after 1 outbound attempt. No HTTP response was received; the request was not retried.'
    )
  }
  if (response.ok) return response
  if (response.status === 304) {
    // A 304 cannot carry the diagnostic JSON body below.
    throw new Error(
      'Cloudflare API returned HTTP 304 after 1 outbound attempt. The request was not retried.'
    )
  }

  let codes: number[] = []
  try {
    codes = providerErrorCodes(await response.json())
  } catch {
    // A non-JSON or interrupted error body supplies no trustworthy provider codes.
  }
  // Do not forward Location: a fetch in the calling isolate could follow it
  // even though this fetch used manual redirects. No private headers or raw
  // provider messages cross this boundary on a failed request.
  return Response.json(
    {
      success: false,
      errors: codes.map((code) => ({ code })),
      outboundAttempts: 1,
      httpStatus: response.status
    },
    { status: response.status }
  )
}
