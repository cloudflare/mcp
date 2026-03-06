import { Agent, routeAgentRequest, callable } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { streamText, convertToModelMessages, pruneMessages, stepCountIs } from "ai";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";

// ── Grid Agent (existing multiplayer pixel grid) ─────────────────────

export type GridState = {
  cells: Record<string, number>;
};

const MAX_COORD = 200;
const MAX_CELLS = 500;
const DECAY_MS = 60_000;
const SWEEP_INTERVAL_S = 30;

export class GridAgent extends Agent<Env, GridState> {
  initialState: GridState = { cells: {} };

  async onStart() {
    const schedules = this.getSchedules();
    const hasDecay = schedules.some((s) => s.callback === "decayCells");
    if (!hasDecay) {
      await this.scheduleEvery(SWEEP_INTERVAL_S, "decayCells", {});
    }
  }

  async decayCells() {
    const now = Date.now();
    const cells = { ...this.state.cells };
    let changed = false;
    for (const key of Object.keys(cells)) {
      if (now - cells[key] > DECAY_MS) {
        delete cells[key];
        changed = true;
      }
    }
    if (changed) {
      this.setState({ cells });
    }
  }

  @callable()
  toggleCell(key: string) {
    const parts = key.split(",");
    if (parts.length !== 2) return;
    const row = Number.parseInt(parts[0], 10);
    const col = Number.parseInt(parts[1], 10);
    if (
      Number.isNaN(row) ||
      Number.isNaN(col) ||
      row < 0 ||
      row >= MAX_COORD ||
      col < 0 ||
      col >= MAX_COORD
    )
      return;

    const cells = { ...this.state.cells };
    if (cells[key]) {
      delete cells[key];
    } else {
      if (Object.keys(cells).length >= MAX_CELLS) return;
      cells[key] = Date.now();
    }
    this.setState({ cells });
  }

  @callable()
  clearGrid() {
    this.setState({ cells: {} });
  }
}

// ── Chat Agent (MCP client demo) ────────────────────────────────────

// Server-side allowlist of MCP servers — URLs never sent from the client
const MCP_SERVER_REGISTRY: Record<string, string> = {
  cloudflare: "https://mcp.cloudflare.com/mcp",
  asana: "https://mcp.asana.com/v2/mcp",
  atlassian: "https://mcp.atlassian.com/v1/mcp",
  intercom: "https://mcp.intercom.com/sse",
  linear: "https://mcp.linear.app/mcp",
  paypal: "https://mcp.paypal.com/http",
  sentry: "https://mcp.sentry.dev/mcp",
  square: "https://mcp.squareup.com/sse",
  stripe: "https://mcp.stripe.com",
  webflow: "https://mcp.webflow.com/sse",
};

const SYSTEM_PROMPT = `You are a demo assistant that helps users explore MCP servers hosted on Cloudflare. You have access to the tools provided by the connected MCP server.

Use the available tools to help the user accomplish their goals. Be concise and show results clearly.

Keep responses short and focused. This is a demo — help users see how powerful remote MCP servers are.`;

export type ChatAgentState = {
  useCodemode: boolean;
};

export class ChatAgent extends AIChatAgent<Env, ChatAgentState> {
  maxPersistedMessages = 50;
  initialState: ChatAgentState = { useCodemode: false };

  async onStart() {
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200,
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      },
    });
  }

  private async resetInactivityTimer() {
    const schedules = this.getSchedules();
    for (const s of schedules) {
      if (s.callback === "inactivityDestroy") {
        await this.cancelSchedule(s.id);
      }
    }
    await this.schedule(60 * 60, "inactivityDestroy", {});
  }

  async inactivityDestroy() {
    try {
      await this.destroy();
    } catch (e) {
      console.error("Failed to destroy agent:", e);
    }
  }

  /** Connect to one or more servers, removing any not in the list */
  @callable()
  async connectServers(serverIds: string[], useCodemode: boolean) {
    await this.resetInactivityTimer();
    this.setState({ ...this.state, useCodemode });

    // Validate all server IDs
    for (const id of serverIds) {
      if (!MCP_SERVER_REGISTRY[id]) {
        throw new Error(`Unknown MCP server: ${id}`);
      }
    }

    const currentServers = this.mcp.listServers();

    // Remove servers not in the new list
    for (const server of currentServers) {
      if (!serverIds.includes(server.name)) {
        try {
          await this.mcp.removeServer(server.id);
        } catch {}
      }
    }

    // Connect servers not yet connected
    const results: Array<{ id: string; state: string }> = [];
    for (const id of serverIds) {
      const existing = this.mcp.listServers().find((s) => s.name === id);
      if (existing) {
        results.push({ id: existing.id, state: "ready" });
        continue;
      }
      const result = await this.addMcpServer(id, MCP_SERVER_REGISTRY[id], {
        callbackHost: this.env.HOST,
      });
      results.push({ id, state: (result as any)?.state ?? "connecting" });
    }

    return results;
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    await this.resetInactivityTimer();
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const connectedNames = this.mcp.listServers().map((s) => s.name).join(", ");
    const systemPrompt = this.state.useCodemode
      ? `${SYSTEM_PROMPT}\n\nYou are in Code Mode. You have a single "codemode" tool that lets you write JavaScript code to call multiple MCP tools. The connected servers are: ${connectedNames}. Write code using the \`codemode\` object to call the available functions.`
      : SYSTEM_PROMPT;

    let tools;
    if (this.state.useCodemode) {
      const executor = new DynamicWorkerExecutor({ loader: this.env.LOADER });
      const codemode = createCodeTool({ tools: mcpTools, executor });
      tools = { codemode };
    } else {
      tools = mcpTools;
    }

    const result = streamText({
      abortSignal: options?.abortSignal,
      // @ts-ignore — not yet in public types
      model: workersai("@cf/moonshotai/kimi-k2.5"),
      system: systemPrompt,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message",
      }),
      tools,
      stopWhen: stepCountIs(10),
    });

    return result.toUIMessageStreamResponse();
  }
}

// ── Default Export ───────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
