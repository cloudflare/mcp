import { writeFileSync } from 'node:fs'

const [prNumber, domainSuffix, kvId, bucketName] = process.argv.slice(2)
if (!/^\d+$/.test(prNumber ?? '') || !domainSuffix || !kvId || !bucketName) {
  throw new Error(
    'Usage: node scripts/preview-config.mjs <pr-number> <domain-suffix> <kv-id> <bucket-name>'
  )
}

const name = `cloudflare-api-mcp-pr-${prNumber}`
const hostname = `pr-${prNumber}.${domainSuffix}`

const config = {
  name,
  main: '../src/index.ts',
  compatibility_date: '2026-06-17',
  compatibility_flags: ['nodejs_compat', 'global_fetch_strictly_public'],
  workers_dev: false,
  preview_urls: false,
  observability: { logs: { enabled: true } },
  routes: [{ pattern: hostname, custom_domain: true }],
  ai: { binding: 'AI' },
  worker_loaders: [{ binding: 'LOADER' }],
  services: [{ binding: 'GLOBAL_OUTBOUND', service: name, entrypoint: 'GlobalOutbound' }],
  kv_namespaces: [{ binding: 'OAUTH_KV', id: kvId }],
  r2_buckets: [{ binding: 'SPEC_BUCKET', bucket_name: bucketName }],
  analytics_engine_datasets: [{ binding: 'MCP_METRICS', dataset: 'mcp-metrics-preview' }],
  vars: {
    CLOUDFLARE_API_BASE: 'https://api.cloudflare.com/client/v4',
    CLOUDFLARE_OAUTH_DOMAIN: 'https://dash.cloudflare.com',
    MCP_RESOURCE: `https://${hostname}/mcp`,
    OPENAPI_SPEC_URL: 'https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json'
  }
}

writeFileSync('.preview/wrangler.json', JSON.stringify(config, null, 2))
console.log(JSON.stringify({ name, url: config.vars.MCP_RESOURCE }))
