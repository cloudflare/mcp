import { DurableObject } from 'cloudflare:workers'

/**
 * Placeholder for the Forge daily build's Durable Object (#247). Staging
 * already has a `ToolsBuilder` Durable Object namespace, and Cloudflare
 * rejects any upload that stops exporting a class an existing namespace
 * depends on. Nothing binds or calls it yet; #247 replaces it.
 */
export class ToolsBuilder extends DurableObject<Env> {}
