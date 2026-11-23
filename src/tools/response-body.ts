import type { ContentBlock } from '@modelcontextprotocol/server'

/** A response body: parsed JSON, text, or the bytes of one that is neither. */
export type ResponseBody =
  | { readonly kind: 'json'; readonly value: unknown; readonly chars: number }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'binary'; readonly bytes: Uint8Array; readonly mimeType: string }

const BINARY_BY_DEFAULT = 'application/octet-stream'

/** The media type of a `Content-Type` header, lower case, without parameters. */
function mediaType(contentType: string | null): string {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

/** JSON, including `+json` types such as `application/scim+json`. */
function isJson(type: string): boolean {
  return type === 'application/json' || type.endsWith('+json')
}

/**
 * Read a Cloudflare API response. Its `Content-Type` says whether it is JSON.
 * Any other body is text when its bytes are valid UTF-8, whatever the type:
 * KV serves every value, text or not, as `application/octet-stream`. Bytes
 * that aren't are binary, and reading them as text would replace them with
 * U+FFFD.
 */
export async function readResponse(response: Response): Promise<ResponseBody> {
  const type = mediaType(response.headers.get('content-type'))
  if (isJson(type)) {
    const text = await response.text()
    return { kind: 'json', value: JSON.parse(text), chars: text.length }
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
    return { kind: 'text', text: decoder.decode(bytes) }
  } catch {
    return { kind: 'binary', bytes, mimeType: type || BINARY_BY_DEFAULT }
  }
}

/** The body as a tool result's text shows it: a binary one by its size and type. */
export function bodyValue(body: ResponseBody): unknown {
  if (body.kind === 'json') {
    return body.value
  }
  if (body.kind === 'text') {
    return body.text
  }
  return `[${body.bytes.byteLength} bytes of ${body.mimeType}]`
}

/**
 * The MCP content block for a binary body: image or audio content for those
 * media types, and an embedded resource with the bytes as its `blob` for any
 * other. All three carry the bytes as base64 with their media type, so a
 * client gets them back exactly.
 *
 * @param body - The bytes and their media type.
 * @param uri - The URL the bytes came from, which names the embedded resource.
 */
export function binaryContent(
  body: { bytes: Uint8Array; mimeType: string },
  uri: string
): ContentBlock {
  const { mimeType } = body
  const data = base64(body.bytes)
  if (mimeType.startsWith('image/')) {
    return { type: 'image', data, mimeType }
  }
  if (mimeType.startsWith('audio/')) {
    return { type: 'audio', data, mimeType }
  }
  return { type: 'resource', resource: { uri, mimeType, blob: data } }
}

function base64(bytes: Uint8Array): string {
  let binary = ''
  // In chunks: one call with every byte as an argument overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x80_00) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x80_00))
  }
  return btoa(binary)
}
