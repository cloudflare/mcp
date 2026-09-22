import { dynamicTool, generateText, jsonSchema, stepCountIs, type LanguageModel } from 'ai'
import { callTool, toolText } from '../tests/helpers/mcp'

const SYSTEM_PROMPT =
  'You are an assistant that manages Cloudflare resources on the user’s behalf. ' +
  'Use the provided tools to satisfy the request: `search` to find the right API endpoint in the ' +
  'Cloudflare OpenAPI spec, then `execute` to call it. Always search before executing an endpoint ' +
  'you have not already found in this conversation.'

export interface AgentToolCall {
  toolName: string
  input: unknown
}

export interface AgentToolResult {
  toolName: string
  output: unknown
}

export interface AgentRunResult {
  text: string
  toolCalls: AgentToolCall[]
  toolResults: AgentToolResult[]
}

/**
 * Build live AI SDK tools for `toolNames` from the worker's real `tools/list`
 * response, so an eval exercises the exact descriptions and JSON schemas a
 * production MCP client would see — not a hand-maintained copy of them.
 * Each tool's `execute` drives the real worker via the same `callTool` helper
 * the deterministic e2e tests use (real Worker Loader isolate, MSW-mocked
 * outbound Cloudflare API).
 */
async function buildAgentTools(token: string, toolNames: readonly string[]) {
  const list = await callTool(token, '', null, { method: 'tools/list' })
  const available = list.result?.tools ?? []

  const tools: Record<string, ReturnType<typeof dynamicTool>> = {}
  for (const name of toolNames) {
    const definition = available.find((candidate) => candidate.name === name)
    if (!definition) {
      throw new Error(`tools/list did not return a "${name}" tool — is it registered?`)
    }

    tools[name] = dynamicTool({
      description: definition.description ?? '',
      inputSchema: jsonSchema(definition.inputSchema ?? { type: 'object', properties: {} }),
      // Always resolve, even on an MCP-level tool error: a real MCP client
      // relays `content` back to the model regardless of `isError` (it's the
      // model's job to notice the "Error: ..." text and recover), so throwing
      // here would short-circuit exactly the retry behavior real usage relies
      // on.
      execute: async (input) => {
        const result = await callTool(token, name, input as Record<string, unknown>)
        return toolText(result)
      }
    })
  }

  return tools
}

/**
 * Run a single natural-language task through a model with `search`/`execute`
 * (or a subset of them) wired up as real tools, and report which tools were
 * called and with what input. Assertions typically check `toolCalls` and/or
 * the underlying MSW-observed HTTP requests (see `tests/helpers/cloudflare-api.ts`).
 */
export async function runAgentTask(options: {
  model: LanguageModel
  token: string
  prompt: string
  toolNames?: readonly string[]
  maxSteps?: number
}): Promise<AgentRunResult> {
  const { model, token, prompt, toolNames = ['search', 'execute'], maxSteps = 6 } = options

  const tools = await buildAgentTools(token, toolNames)

  const result = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt,
    tools,
    stopWhen: stepCountIs(maxSteps)
  })

  return {
    text: result.text,
    toolCalls: result.dynamicToolCalls.map((call) => ({
      toolName: call.toolName,
      input: call.input
    })),
    toolResults: result.dynamicToolResults.map((toolResult) => ({
      toolName: toolResult.toolName,
      output: toolResult.output
    }))
  }
}
