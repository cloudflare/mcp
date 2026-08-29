# Claude Code

Connect [Claude Code](https://code.claude.com/docs/en/overview) to the Cloudflare MCP server with one command:

```bash
claude mcp add --transport http cloudflare-api https://mcp.cloudflare.com/mcp
```

Then run `/mcp` inside Claude Code to sign in. Cloudflare will prompt you to
authorize access and select permissions with OAuth.

## API Token

For CI/CD and automation, skip OAuth and pass a
[Cloudflare API token](https://dash.cloudflare.com/profile/api-tokens) as a
bearer token:

```bash
claude mcp add --transport http cloudflare-api https://mcp.cloudflare.com/mcp \
  --header "Authorization: Bearer YOUR_CLOUDFLARE_API_TOKEN"
```

Both user tokens and account tokens are supported. For account tokens, include
the **Account Resources : Read** permission so the server can auto-detect your
account ID.

## Share with Your Team

To check the server into your repo, add a `.mcp.json` file at the project root
(or run the command above with `--scope project`):

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

Claude Code expands environment variables in `.mcp.json`, so an API token
header can reference `${CLOUDFLARE_API_TOKEN}` instead of committing the value
to the file.

## Disable Code Mode

To expose each Cloudflare API endpoint as an individual tool instead of the
compact code mode tools, add `?codemode=false` to the URL. This registers
~2,500 endpoint-specific tools and uses far more context, so only disable code
mode when you need it.
