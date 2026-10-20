import { IDENTITY_SCOPES } from '../auth/scopes'

/**
 * Tool `_meta` declaring that the tool needs an OAuth token, for clients that
 * read OpenAI's per-tool `securitySchemes`. ChatGPT shows its re-authorization
 * prompt for a tool only when the tool declares one and a failing call carries
 * `_meta["mcp/www_authenticate"]` (https://developers.openai.com/apps-sdk/build/auth).
 *
 * `securitySchemes` isn't in the MCP spec (SEP-1488 is a draft), so it goes in
 * `_meta`, the spec's extension point; OpenAI reads it there too. The scopes
 * are the identity scopes every grant holds: anything more is asked for when a
 * call needs it (step-up).
 */
export const OAUTH_TOOL_META = {
  securitySchemes: [{ type: 'oauth2', scopes: IDENTITY_SCOPES }]
}
