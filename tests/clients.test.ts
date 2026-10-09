import { describe, expect, it, vi } from 'vitest'
import { identifyClient, SPEC_BEHAVIOR } from '../src/clients'

const noRedirectUris = () => Promise.resolve([])

describe('identifyClient', () => {
  it('recognises Codex by its Client ID Metadata Document without reading redirect URIs', async () => {
    const redirectUris = vi.fn(noRedirectUris)
    const client = await identifyClient({
      clientId: 'https://chatgpt.com/oauth/codex/client.json',
      redirectUris
    })

    expect(client).toEqual({ id: 'codex', behavior: { scopeChallenge: 'tool' } })
    expect(redirectUris).not.toHaveBeenCalled()
  })

  it('gives any other metadata document client the spec behavior without reading redirect URIs', async () => {
    const redirectUris = vi.fn(noRedirectUris)
    const client = await identifyClient({
      clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
      redirectUris
    })

    expect(client).toEqual({ id: undefined, behavior: SPEC_BEHAVIOR })
    expect(redirectUris).not.toHaveBeenCalled()
  })

  it('recognises a registered ChatGPT connector by its redirect URI', async () => {
    const client = await identifyClient({
      clientId: 'registered-client',
      redirectUris: () => Promise.resolve(['https://chatgpt.com/connector_platform_oauth_redirect'])
    })

    expect(client).toEqual({ id: 'chatgpt', behavior: { scopeChallenge: 'tool' } })
  })

  it('gives other registered clients the spec behavior', async () => {
    const client = await identifyClient({
      clientId: 'registered-client',
      redirectUris: () =>
        Promise.resolve(['https://app.example.com/cb', 'https://chatgpt.com.evil.example/cb'])
    })

    expect(client).toEqual({ id: undefined, behavior: SPEC_BEHAVIOR })
  })

  it('falls back to the spec behavior when the redirect URIs cannot be read', async () => {
    const client = await identifyClient({
      clientId: 'registered-client',
      redirectUris: () => Promise.reject(new Error('KV unavailable'))
    })

    expect(client.behavior).toEqual(SPEC_BEHAVIOR)
  })
})
