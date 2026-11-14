// Both functions are interpolated into the execute sandbox: keep each self-contained.

export function decodeBody(bytes: Uint8Array, contentType: string | null): string | Uint8Array {
  const type = (contentType || '').split(';', 1)[0]!.trim().toLowerCase()
  if (
    /^(?:image|audio|video|font)\/|^application\/(?:pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|wasm|vnd\.tcpdump\.pcap|vnd\.google\.protobuf|x-protobuf)$/.test(
      type
    )
  ) {
    return bytes
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return bytes
  }
}

export function encodeBytes(value: unknown, seen = new Set<object>()): unknown {
  if (value instanceof ArrayBuffer) value = new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return { base64: btoa(binary), byteLength: bytes.byteLength }
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  const proto = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return value
  seen.add(value)
  const entries = value as Record<string, unknown>
  let copy: Record<string, unknown> | undefined
  for (const key of Object.keys(entries)) {
    const encoded = encodeBytes(entries[key], seen)
    if (encoded !== entries[key]) {
      copy ??= (Array.isArray(value) ? [...value] : { ...entries }) as Record<string, unknown>
      copy[key] = encoded
    }
  }
  return copy ?? value
}
