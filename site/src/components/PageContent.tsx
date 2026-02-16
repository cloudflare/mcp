import { Scene } from '@/components/Hero'
import { FadeInSection, GlowHeading } from '@/components/GlowHeading'
import { CodeBlock, PillLink, TabbedCodeBlock } from '@/components/ui'

export function PageContent() {
  return (
    <div className="flex flex-col">
      {/* Hero */}
      <div className="h-[60vh]">
        <Scene />
      </div>

      {/* Use Cloudflare's MCP Servers */}
      <FadeInSection
        className="border-t border-dashed border-(--color-border) px-6 py-24"
        cornerGrid={{ position: 'bottom-left', color: '#f38020' }}
      >
        <div className="mx-auto max-w-3xl">
          <GlowHeading eyebrow="Use">Connect to Cloudflare's MCP server</GlowHeading>
          <p className="text-lg leading-relaxed text-(--color-label)">
            Connect from Claude, Cursor, Windsurf, or any MCP client.
            Manage Workers, KV, R2, D1, query analytics, and more — all through your AI assistant.
          </p>
          <div className="mt-8">
            <CodeBlock title="mcp.json" language="json">
              {`{
  "mcpServers": {
    "cloudflare": {
      "url": "https://mcp.cloudflare.com/mcp"
    }
  }
}`}
            </CodeBlock>
          </div>
          <p className="mt-4 text-sm text-(--color-muted)">
            Cloudflare also maintains domain-specific MCP servers for docs, radar, containers, and more.{' '}
            <a
              href="https://github.com/cloudflare/mcp-server-cloudflare"
              className="underline hover:text-(--color-surface)"
            >
              See all Cloudflare MCP servers
            </a>
          </p>
        </div>
      </FadeInSection>

      {/* Build Your Own */}
      <FadeInSection
        className="border-t border-dashed border-(--color-border) px-6 py-24"
        cornerGrid={{ position: 'top-right', color: '#06b6d4' }}
      >
        <div className="mx-auto max-w-3xl">
          <GlowHeading eyebrow="Build">Build your own MCP server</GlowHeading>
          <p className="text-lg leading-relaxed text-(--color-label)">
            Deploy MCP servers on Cloudflare Workers. Choose the pattern that fits —
            stateless with <code className="font-mono text-sm bg-(--color-subtle) px-1.5 py-0.5 rounded">createMcpHandler</code>,
            stateful with <code className="font-mono text-sm bg-(--color-subtle) px-1.5 py-0.5 rounded">McpAgent</code>,
            or use the MCP SDK directly.
          </p>
          <div className="mt-8">
            <TabbedCodeBlock
              tabs={[
                {
                  label: 'createMcpHandler',
                  title: 'mcp-worker/src/index.ts',
                  code: `import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

function createServer() {
  const server = new McpServer({
    name: "Hello MCP Server",
    version: "1.0.0",
  });

  server.registerTool(
    "hello",
    {
      description: "Returns a greeting message",
      inputSchema: { name: z.string().optional() },
    },
    async ({ name }) => ({
      content: [{ text: \`Hello, \${name ?? "World"}!\`, type: "text" }],
    })
  );

  return server;
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const server = createServer();
    return createMcpHandler(server)(request, env, ctx);
  },
};`,
                },
                {
                  label: 'McpAgent',
                  title: 'mcp/src/server.ts',
                  code: `import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type State = { counter: number };

export class MyMCP extends McpAgent<Env, State, {}> {
  server = new McpServer({ name: "Demo", version: "1.0.0" });
  initialState: State = { counter: 0 };

  async init() {
    this.server.registerTool(
      "add",
      {
        description: "Add to the counter",
        inputSchema: { a: z.number() },
      },
      async ({ a }) => {
        this.setState({ ...this.state, counter: this.state.counter + a });
        return {
          content: [{ text: \`Counter: \${this.state.counter}\`, type: "text" }],
        };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/sse")) {
      return MyMCP.serveSSE("/sse", { binding: "MyMCP" }).fetch(request, env, ctx);
    }
    if (url.pathname.startsWith("/mcp")) {
      return MyMCP.serve("/mcp", { binding: "MyMCP" }).fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};`,
                },
                {
                  label: 'Native MCP SDK',
                  title: 'mcp-server/src/index.ts',
                  code: `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport }
  from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

const createServer = () => {
  const server = new McpServer({
    name: "Native MCP Server",
    version: "1.0.0",
  });

  server.registerTool(
    "hello",
    {
      description: "Returns a greeting",
      inputSchema: { name: z.string().optional() },
    },
    async ({ name }) => ({
      content: [{ text: \`Hello, \${name ?? "World"}!\`, type: "text" }],
    })
  );

  return server;
};

export default {
  fetch: async (request: Request) => {
    const transport = new WebStandardStreamableHTTPServerTransport();
    const server = createServer();
    server.connect(transport);
    return transport.handleRequest(request);
  },
};`,
                },
              ]}
            />
          </div>
        </div>
      </FadeInSection>

      {/* MCP Client */}
      <FadeInSection
        className="border-t border-dashed border-(--color-border) px-6 py-24"
        cornerGrid={{ position: 'top-left', color: '#f38020' }}
      >
        <div className="mx-auto max-w-3xl">
          <GlowHeading eyebrow="Connect">Use MCP servers from your agents</GlowHeading>
          <p className="text-lg leading-relaxed text-(--color-label)">
            Agents built on Cloudflare can connect to remote MCP servers as a client.
            Add servers dynamically, list available tools, and call them from your agent code.
          </p>
          <div className="mt-8">
            <CodeBlock title="mcp-client/src/server.ts">
              {`import { Agent, routeAgentRequest } from "agents";

export class MyAgent extends Agent {
  async onRequest(request: Request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith("add-mcp") && request.method === "POST") {
      const { url: mcpUrl, name } = await request.json();
      await this.addMcpServer(name, mcpUrl);
      return new Response("Ok", { status: 200 });
    }

    if (url.pathname.endsWith("get-tools") && request.method === "POST") {
      const { serverId } = await request.json();
      const tools = this.mcp.listTools()
        .filter((tool) => tool.serverId === serverId);
      return Response.json({ tools });
    }

    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env, { cors: true })) ||
      new Response("Not found", { status: 404 })
    );
  },
};`}
            </CodeBlock>
          </div>
        </div>
      </FadeInSection>

      {/* Code Mode */}
      <FadeInSection
        className="border-t border-dashed border-(--color-border) px-6 py-24"
        cornerGrid={{ position: 'bottom-right', color: '#a855f7' }}
      >
        <div className="mx-auto max-w-3xl">
          <GlowHeading eyebrow="Code Mode">Let agents write code against your tools</GlowHeading>
          <p className="text-lg leading-relaxed text-(--color-label)">
            Code Mode wraps your tools into a typed SDK. Instead of calling tools one at a time,
            the model writes TypeScript that composes multiple calls in a single execution.
            Runs in a sandboxed Workers isolate.
          </p>
          <div className="mt-8">
            <CodeBlock title="codemode/src/server.ts">
              {`import { Agent, routeAgentRequest } from "agents";
import { experimental_codemode as codemode } from "@cloudflare/codemode/ai";
import { streamText, convertToModelMessages } from "ai";
import { openai } from "@ai-sdk/openai";
import { tools } from "./tools";

export class Codemode extends Agent<Env> {
  async onChatMessage() {
    const { prompt, tools: wrappedTools } = await codemode({
      prompt: "You are a helpful assistant.",
      tools,
      loader: this.env.LOADER,
      proxy: this.ctx.exports.CodeModeProxy({
        props: {
          binding: "Codemode",
          name: this.name,
          callback: "callTool",
        },
      }),
    });

    const result = streamText({
      system: prompt,
      messages: await convertToModelMessages(this.messages),
      model: openai("gpt-4o"),
      tools: wrappedTools,
    });

    return result.toUIMessageStream();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
};`}
            </CodeBlock>
          </div>
        </div>
      </FadeInSection>

      {/* CTA */}
      <FadeInSection
        className="border-t border-dashed border-(--color-border) px-6 py-24"
        cornerGrid={{ position: 'bottom-left', color: '#6366f1' }}
      >
        <div className="mx-auto max-w-3xl text-center">
          <GlowHeading eyebrow="Get started">Build with MCP on Cloudflare</GlowHeading>
          <p className="text-lg leading-relaxed text-(--color-label)">
            Deploy your first MCP server in minutes. Read the docs or explore the examples.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <PillLink href="https://developers.cloudflare.com/agents/model-context-protocol/" variant="primary">
              Read the docs
            </PillLink>
            <PillLink href="https://github.com/cloudflare/agents/tree/main/examples" variant="secondary">
              View examples
            </PillLink>
          </div>
        </div>
      </FadeInSection>

      {/* Footer */}
      <footer className="border-t border-(--color-border) bg-(--color-surface-secondary)">
        <div className="mx-auto flex max-w-[var(--max-width)] items-center justify-between border-x border-dashed border-(--color-border) px-6 py-6">
          <p className="font-mono text-xs text-(--color-muted)">&copy; 2026 Cloudflare, Inc.</p>
          <div className="flex gap-6">
            <a
              href="https://cloudflare.com/privacy"
              className="font-mono text-xs text-(--color-muted) hover:text-(--color-surface)"
            >
              Privacy
            </a>
            <a
              href="https://cloudflare.com/terms"
              className="font-mono text-xs text-(--color-muted) hover:text-(--color-surface)"
            >
              Terms
            </a>
            <a
              href="https://cloudflarestatus.com"
              className="font-mono text-xs text-(--color-muted) hover:text-(--color-surface)"
            >
              Status
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
