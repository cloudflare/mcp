#!/bin/sh
# Rerun the whole check: the model through /statechart (two configs) and the replay against cardReducer.
# STATECHART must name the /statechart skill's command on this machine (see that skill; it is not copied here).
# Usage, from the repo root:  STATECHART=<the /statechart command> .agents/skills/verify-d1-card-run-send/check.sh
set -u
: "${STATECHART:?Set STATECHART to the command of the /statechart skill on this machine}"
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d "${TMPDIR:-/tmp}/verify-d1-card-run-send.XXXXXX")
for cfg in holds chart; do
  "$STATECHART" "$here/model/CardRunSend.tla" --config "$here/model/$cfg.cfg" \
    --view "$here/model/view.mjs" --out "$out/$cfg" >"$out/$cfg.log" 2>&1
  echo "== $cfg (exit $?): $out/$cfg/report.md"
  grep -A1 -E '^## (Rules|.* breaks$)' "$out/$cfg/report.md" 2>/dev/null | grep -v -E '^--$|shortest path' \
    || cat "$out/$cfg.log"
done
echo "== replay against cardReducer"
bun test "$here/replay/card-run-send.test.ts"
