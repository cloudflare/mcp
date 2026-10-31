#!/usr/bin/env bash
# Gives each agent the same task file and waits for them to finish. Each
# writes its report to /tmp/agent-bench/<name>/report.md. In the task,
# {{REPORT}} becomes that path and {{NAME}} the agent's name.
#
#   bench/run.sh bench/tasks/bodies.md blind-a blind-b
set -euo pipefail
task="$1"
shift
for name in "$@"; do
  sed -e "s#{{REPORT}}#/tmp/agent-bench/$name/report.md#g" -e "s#{{NAME}}#$name#g" "$task" >"/tmp/agent-bench/$name/task.md"
  herdr agent prompt "$name" "Read /tmp/agent-bench/$name/task.md and do what it says." >/dev/null
done
for name in "$@"; do
  herdr agent wait "$name" --timeout 3600000 >/dev/null || true
  echo "== $name: /tmp/agent-bench/$name/report.md"
done
