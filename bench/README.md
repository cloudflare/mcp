# Agent bench

Blind tests of the tools with real agents: a local server, calling the real Cloudflare API, and pi agents in herdr panes that know nothing of this repo and see one MCP server called `cloudflare`.

```bash
bench/serve.sh 8811                                                  # this checkout, at http://localhost:8811/mcp
bench/agent.sh blind-a 'http://localhost:8811/mcp?codemode=false'    # an agent with only that server
bench/run.sh bench/tasks/bodies.md blind-a                           # the task; report in /tmp/agent-bench/blind-a/report.md
```

`agent.sh` authenticates with `npx wrangler auth token`, so tasks run against your account. To compare two versions, serve each checkout on its own port and give an agent each. Each task asks the agent to clean up what it created.
