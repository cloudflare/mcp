#!/usr/bin/env bash
# Starts a pi agent that knows nothing of this repo, in a herdr pane, with one
# MCP server called "cloudflare" at <url>. It gets its own config directory:
# your model and provider, no skills, no AGENTS.md, no other servers.
#
#   bench/agent.sh <name> <url>    # e.g. bench/agent.sh blind-a 'http://localhost:8811/mcp?codemode=false'
set -euo pipefail
name="$1"
url="$2"
test "${HERDR_ENV:-}" = 1 || { echo "run inside herdr" >&2; exit 1; }
dir="/tmp/agent-bench/$name"
rm -rf "$dir"
mkdir -p "$dir/agent/extensions" "$dir/work"
src="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
cp "$src/auth.json" "$dir/agent/"
[ -f "$src/models.json" ] && cp "$src/models.json" "$dir/agent/"
for ext in opencode-cloudflare herdr-agent-state.ts; do
  [ -e "$src/extensions/$ext" ] && cp -R "$src/extensions/$ext" "$dir/agent/extensions/"
done
token="$(npx -y wrangler@latest auth token --json 2>/dev/null | node -e 'process.stdin.on("data", (d) => console.log(JSON.parse(d).token))')"
node -e '
  const [dir, url, token, provider, model] = process.argv.slice(1);
  const fs = require("node:fs");
  fs.writeFileSync(`${dir}/agent/settings.json`, JSON.stringify({ defaultProvider: provider, defaultModel: model, defaultThinkingLevel: "medium" }, null, 2));
  fs.writeFileSync(`${dir}/agent/mcp.json`, JSON.stringify({ mcpServers: { cloudflare: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2));
' "$dir" "$url" "$token" "${PI_PROVIDER:-fable.opencode.cloudflare.dev}" "${PI_MODEL:-claude-opus-5-5}"
pane="$(herdr pane split --current --direction "${BENCH_SPLIT:-right}" --cwd "$dir/work" --no-focus | node -e 'process.stdin.on("data", (d) => console.log(JSON.parse(d).result.pane.pane_id))')"
herdr pane run "$pane" "export PI_CODING_AGENT_DIR=$dir/agent; cd $dir/work; clear" >/dev/null
sleep 1
herdr agent start "$name" --kind pi --pane "$pane" --timeout 60000 >/dev/null
echo "$name in pane $pane, config $dir/agent"
