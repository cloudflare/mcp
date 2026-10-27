import type { EncryptedSecret } from './tenant-store'

/**
 * AES-GCM encryption of a tenant's account token at rest.
 *
 * The key is derived with HKDF from `MCP_COOKIE_ENCRYPTION_KEY`, under its own `info`, so it is
 * never the cookie key itself. The account ID is the additional data: a ciphertext copied into
 * another tenant's record fails to decrypt.
 *
 * Unlike grant props, which only the token holder can decrypt, the service can decrypt these.
 * That is the trade-off of an admin-provisioned credential (see docs/enterprise-managed-auth.md).
 */

const HKDF_INFO = new TextEncoder().encode('cloudflare-mcp/ema-tenant-credential/v1')

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('MCP_COOKIE_ENCRYPTION_KEY is not set')
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: HKDF_INFO },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/** Encrypt `plaintext` for the tenant of `accountId`. */
export async function encryptCredential(
  secret: string,
  accountId: string,
  plaintext: string
): Promise<EncryptedSecret> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(accountId) },
    await deriveKey(secret),
    new TextEncoder().encode(plaintext)
  )
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) }
}

/** Decrypt a credential encrypted for the tenant of `accountId`. Throws if it was tampered with. */
export async function decryptCredential(
  secret: string,
  accountId: string,
  encrypted: EncryptedSecret
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: fromBase64(encrypted.iv),
      additionalData: new TextEncoder().encode(accountId)
    },
    await deriveKey(secret),
    fromBase64(encrypted.ciphertext)
  )
  return new TextDecoder().decode(plaintext)
}
