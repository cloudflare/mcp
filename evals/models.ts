import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { env } from 'cloudflare:workers'
import { describe, it } from 'vitest'

export interface EvalModel {
  /** Short id used in describe-block names and test output. */
  name: string
  model: LanguageModel
}

/**
 * Provider API keys for the eval suite, forwarded in as plain miniflare
 * bindings by `vitest.config.evals.ts` (from `process.env`/`.env` on the host
 * — the workerd runtime these tests execute in does not inherit the host
 * process's environment). Not part of the worker's real `Env` — these vars
 * only ever exist in the eval test run — so read through an unknown cast
 * instead of extending the generated `Env` type.
 */
interface EvalProviderEnv {
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  GOOGLE_GENERATIVE_AI_API_KEY?: string
}

const providerEnv = env as unknown as EvalProviderEnv

/**
 * Every model in this list needs a real provider API key, so the suite reads
 * them from the environment instead of hardcoding a fixed roster: only
 * providers with a key configured (locally via `.env`, or in CI via repo
 * secrets) run. Add a model here to add it to every `*.eval.ts` file that
 * iterates `EVAL_MODELS` — nothing else needs to change.
 */
function discoverModels(): EvalModel[] {
  const models: EvalModel[] = []

  if (providerEnv.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: providerEnv.OPENAI_API_KEY })
    models.push({ name: 'gpt-5-mini', model: openai('gpt-5-mini') })
  }
  if (providerEnv.ANTHROPIC_API_KEY) {
    const anthropic = createAnthropic({ apiKey: providerEnv.ANTHROPIC_API_KEY })
    models.push({ name: 'claude-haiku-4-5', model: anthropic('claude-haiku-4-5') })
  }
  if (providerEnv.GOOGLE_GENERATIVE_AI_API_KEY) {
    const google = createGoogleGenerativeAI({ apiKey: providerEnv.GOOGLE_GENERATIVE_AI_API_KEY })
    models.push({ name: 'gemini-2.5-flash', model: google('gemini-2.5-flash') })
  }

  return models
}

export const EVAL_MODELS = discoverModels()

/**
 * Run `fn` once per configured model, each in its own `describe(name, ...)`
 * block (`name` may contain `$modelName`, replaced with the model's id). With
 * no provider keys configured this still registers one skipped test instead of
 * leaving the file empty, so `npm run eval` reports "skipped" rather than
 * silently running nothing or erroring on an empty test file.
 */
export function eachEvalModel(
  name: string,
  fn: (context: { model: LanguageModel; modelName: string }) => void
): void {
  if (EVAL_MODELS.length === 0) {
    describe.skip(name.replace('$modelName', '(no provider API key configured)'), () => {
      it('skipped — set OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY', () => {})
    })
    return
  }

  for (const evalModel of EVAL_MODELS) {
    describe(name.replace('$modelName', evalModel.name), () =>
      fn({ model: evalModel.model, modelName: evalModel.name })
    )
  }
}
