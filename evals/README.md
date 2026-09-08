# Evals

`npm run test` checks that the `search` and `execute` tools behave correctly for
hand-written inputs. It does not check whether a model, given only the tools'
descriptions, reaches for the right one and writes correct code for a
natural-language task. That's what this directory does.

Each case in `*.eval.ts` sends a real prompt to a real model with the worker's
actual `search`/`execute` tools attached (built live from `tools/list`, so a
case exercises the exact descriptions and JSON schemas production clients see)
and asserts on what happened — which tools were called, and/or the real
outbound Cloudflare API request MSW observed. Everything except the model call
itself is real: a genuine Worker Loader isolate runs the generated code, and
the only mocked boundary is the Cloudflare API (same as the rest of the test
suite).

## Running

```bash
npm run eval          # once
npm run eval:watch    # watch mode
```

Each provider only runs if its API key is set. With none set, every case is
reported as skipped rather than failing — useful for `npm run eval` in an
environment with no keys configured, and safe as a CI job that doesn't yet
have secrets provisioned.

```bash
export OPENAI_API_KEY=...              # gpt-5-mini
export ANTHROPIC_API_KEY=...           # claude-haiku-4-5
export GOOGLE_GENERATIVE_AI_API_KEY=...  # gemini-2.5-flash
npm run eval
```

Or drop the same variables in a local `.env` file (already gitignored) instead
of exporting them — `vitest.config.evals.ts` loads it automatically.

Model calls are real API calls: they cost money and can be slow/flaky. Keep
that in mind before wiring this into required PR checks (see
`.github/workflows/evals.yml`, which runs it nightly instead).

## How it's wired

- `models.ts` — the model roster (`EVAL_MODELS`), built from whichever
  provider keys are configured, plus `eachEvalModel(...)`, the `describe.each`
  wrapper every `*.eval.ts` file uses to run its cases once per available
  model.
- `harness.ts` — `runAgentTask({ model, token, prompt, toolNames })` fetches
  the live `tools/list` response, turns the requested tools into AI SDK
  `dynamicTool`s whose `execute` drives the real worker (via the same
  `callTool` helper `tests/helpers/mcp.ts` uses for the deterministic e2e
  tests), and runs `generateText` with tool calling enabled. Returns the final
  text plus every tool call/result across all steps.
- `fixtures.ts` — a small, fixed slice of the OpenAPI spec (a handful of
  well-known Workers/KV/D1/DNS endpoints) that `beforeEach` seeds into the test
  worker's spec bucket. Evals seed this instead of the real ~2,500-endpoint
  spec so `search` stays fast and results stay predictable across runs,
  independent of what's in the live spec on any given day.
- `setup/msw-passthrough.ts` — the shared MSW server (`tests/setup/msw.ts`)
  fails any unmocked outbound request, which is exactly right for the
  Cloudflare API but would also block the real calls to model provider APIs
  that evals need to make. This file lets those specific hosts through to the
  real network while every other host — the Cloudflare API included — stays
  strictly mocked per test, same as the rest of the suite.

`tests/eval-harness.test.ts` is a separate, always-on regression test for
`harness.ts` itself: it drives `runAgentTask` with a scripted
`MockLanguageModelV4` (no API key, no network) standing in for the LLM, so CI
gets real coverage of the tools/list → tool-def → real-worker-execution wiring
even when no provider key is configured to run an actual eval.

## Adding a case

Pick the right file — `search.eval.ts` for "does it find the right endpoint",
`execute.eval.ts` for "does it call the right endpoint correctly",
`end-to-end.eval.ts` for "does it search then execute correctly" — seed
`fixtures.ts` with any endpoint you need that isn't already there, and add an
`it(...)` inside the existing `eachEvalModel(...)` block. Assert on
`toolCalls`/`toolResults` from `runAgentTask`, or (for `execute`) on the real
HTTP request captured via `server.use(...)` — not on the model's prose, which
is inherently non-deterministic.
