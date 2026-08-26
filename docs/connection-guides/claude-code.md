# Connect Claude Code to the Cloudflare MCP server

The Cloudflare MCP server gives Claude Code access to the Cloudflare API through the remote HTTP transport.

## Add the server

Run this command from the project where you use Claude Code:

```sh
claude mcp add --transport http cloudflare-api https://mcp.cloudflare.com/mcp
```

This creates a local-scope configuration by default. It is private to you and loads only for the current project.

To load the server in every project for your user, set the scope to `user`:

```sh
claude mcp add --transport http --scope user cloudflare-api https://mcp.cloudflare.com/mcp
```

## Authenticate with Cloudflare

Start Claude Code, run `/mcp`, and select `cloudflare-api`. Follow the browser prompt to sign in to Cloudflare and choose the permissions Claude Code can use.

Claude Code stores and refreshes the OAuth credentials. They do not need to be added to a project file.

## Share the configuration with a project

Use project scope when everyone working in a repository should receive the same server configuration:

```sh
claude mcp add --transport http --scope project cloudflare-api https://mcp.cloudflare.com/mcp
```

This creates or updates `.mcp.json` in the project root:

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

Keep `"type": "http"` when editing the file manually. Without it, Claude Code does not treat the URL as a remote HTTP server. Claude Code asks each user to approve project-scoped servers before connecting.

## Verify the connection

Check the saved configuration from your terminal:

```sh
claude mcp get cloudflare-api
```

Within Claude Code, run `/mcp` to check the connection or repeat the OAuth flow. If the server is missing, confirm that the configuration uses the exact URL `https://mcp.cloudflare.com/mcp` and includes `"type": "http"`.

For details about configuration scopes and MCP commands, refer to the [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp).
