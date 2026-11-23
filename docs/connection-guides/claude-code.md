# Claude Code

Claude Code needs an explicit HTTP transport. Without `"type": "http"` the Cloudflare MCP server never shows up.

Add this to `.mcp.json` in the project root (or `~/.claude/mcp.json` for every project):

```json
{
  "mcpServers": {
    "cloudflare-api": {
      "type": "http",
      "url": "https://mcp.cloudflare.com/mcp"
    }
  }
}
```

Restart Claude Code. On first use it opens Cloudflare so you can authorize and pick scopes.

## API token instead of OAuth

```json
{
  "mcpServers": {
    "cloudflare-api": {
      "type": "http",
      "url": "https://mcp.cloudflare.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_CLOUDFLARE_API_TOKEN"
      }
    }
  }
}
```

Create the token at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens). Tokens with Client IP Address Filtering are not supported.

## Disable Code Mode

If Claude Code already uses code mode, append `?codemode=false` to the URL. That registers one tool per Cloudflare API endpoint and costs far more context. See the [README](../../README.md#disable-code-mode).
