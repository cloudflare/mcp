# mcp.cloudflare.com

Landing page for MCP on Cloudflare. Built with Astro, React, Three.js, and Tailwind CSS. Deployed as static assets on Cloudflare Workers.

## Development

```bash
npm install
npm run dev
```

## Build & Deploy

```bash
npm run build
npx wrangler deploy
```

Deploys to the Cloudflare MCP account via `wrangler.jsonc`.
