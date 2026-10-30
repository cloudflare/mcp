import { SPEC_ARTIFACTS } from './spec'

/** A value search code returns, as RPC carries it from the sandbox. */
export type SearchValue = null | undefined | boolean | number | bigint | string | object

/** What a search returns: the value the code returned, or why it failed. */
export interface SearchOutcome {
  result?: SearchValue
  error?: string
}

interface SearchSandbox {
  evaluate(): Promise<SearchOutcome>
}

/**
 * Runs `code`, an async arrow function, against the pinned spec in a fresh
 * sandbox with no network access.
 *
 * A fresh isolate runs each call, since dynamic-worker isolates disallow eval
 * and code can't be passed as data into a warm one. The spec is its own text
 * module, so the 27 MB string this service ships is handed over as is: splicing
 * it into the module source built a new string on every call, ~117 ms of CPU
 * per search, most of it garbage collection.
 */
export async function runSearch(loader: WorkerLoader, code: string): Promise<SearchOutcome> {
  const worker = loader.get(`cloudflare-search-${crypto.randomUUID()}`, () => ({
    compatibilityDate: '2026-01-12',
    globalOutbound: null,
    mainModule: 'worker.js',
    modules: {
      'spec.json.txt': { text: SPEC_ARTIFACTS['spec.json'] },
      'worker.js': `
import { WorkerEntrypoint } from "cloudflare:workers";
import specText from "./spec.json.txt";

const spec = JSON.parse(specText);

export default class SearchSandbox extends WorkerEntrypoint {
  async evaluate() {
    try {
      return { result: await (${code})() };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}
      `
    }
  }))

  return (worker.getEntrypoint() as unknown as SearchSandbox).evaluate()
}
