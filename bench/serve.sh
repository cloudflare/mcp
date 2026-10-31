#!/usr/bin/env bash
# Serves this checkout locally: the MCP Worker and the forge tools service,
# calling the real Cloudflare API. Bearer tokens are Cloudflare credentials,
# such as `npx wrangler auth token`, so no OAuth is needed.
#
#   bench/serve.sh [port]    # default 8811; logs to /tmp/agent-bench/serve-<port>.log
set -euo pipefail
port="${1:-8811}"
cd "$(dirname "$0")/.."
mkdir -p /tmp/agent-bench
log="/tmp/agent-bench/serve-$port.log"
# The token audience is the MCP resource, which must be this server's URL.
npx wrangler dev -c wrangler.jsonc -c wrangler.forge-tools.jsonc \
  --port "$port" --inspector-port "$((port + 100))" \
  --var "MCP_RESOURCE:http://localhost:$port/mcp" >"$log" 2>&1 &
echo "wrangler dev pid $! on http://localhost:$port/mcp (log $log)"
for _ in $(seq 1 120); do
  grep -q "Ready on" "$log" && { echo ready; exit 0; }
  sleep 1
done
echo "not ready after 120s; see $log" >&2
exit 1
