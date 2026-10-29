# Windsurf

Add this to `~/.codeium/windsurf/mcp_config.json` (or the project MCP config Windsurf is using):

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

`"type": "http"` is required. Restart Windsurf, then authorize with Cloudflare when prompted.

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
