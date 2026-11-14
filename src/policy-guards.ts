const CHARGEABLE_WRITE =
  /\/(accounts\/[^/]+\/(registrar\/registrations|ai-gateway\/billing\/topup|payment-methods|billing\/profile\/payment-method|subscriptions)|user\/subscriptions|zones\/[^/]+\/subscriptions?)(\/|$)/i

const MEDIA_MODEL_RUN =
  /\/ai\/run\/.*(black-forest-labs|stabilityai|runwayml|lykon|leonardo|myshell-ai|stable-diffusion|deepgram\/aura)/i

/** Why a request that spends money was not sent (Software Directory Policy §4.A). */
export const CHARGEABLE_HINT =
  'This server does not send requests that spend money (domain registration or transfer, credit top-ups, subscriptions, payment methods). Ask the user to do it in the Cloudflare dashboard.'

/** Why a request whose path can't be decoded was not sent, since the guard can't read it. */
export const UNREADABLE_PATH_HINT =
  'This server could not read the request path, so it was not sent. Send the path without malformed percent-escapes.'

/** Why a Workers AI run of an image or audio model was not sent (Software Directory Policy §4.B). */
export const MEDIA_GENERATION_HINT =
  'This server does not run Workers AI models that generate images, video, or audio.'

function plainPath(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname).replace(/\/{2,}/g, '/')
  } catch {
    return undefined
  }
}

async function modelInBody(request: Request): Promise<string> {
  try {
    const body: unknown = await request.clone().json()
    return body !== null && typeof body === 'object' && 'model' in body ? String(body.model) : ''
  } catch {
    return ''
  }
}

/**
 * Why `request` must not be sent, or `undefined` to send it. Refuses writes to
 * endpoints that spend money and Workers AI runs of media-generation models,
 * named in the path or in the body's `model`. Reads never are. Both routes to
 * the API call it: `execute`'s `GlobalOutbound` and the generated tools.
 */
export async function policyRefusalHint(request: Request): Promise<string | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined
  const path = plainPath(new URL(request.url).pathname)
  if (path === undefined) return UNREADABLE_PATH_HINT
  if (CHARGEABLE_WRITE.test(path)) return CHARGEABLE_HINT
  const model = /\/ai\/run(\/|$)/i.test(path) ? await modelInBody(request) : ''
  if (MEDIA_MODEL_RUN.test(`${path}/${model}`)) return MEDIA_GENERATION_HINT
  return undefined
}
