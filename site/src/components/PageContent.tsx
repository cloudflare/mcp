import { Scene } from '@/components/Hero'
import { FadeInSection, GlowHeading } from '@/components/GlowHeading'
import { CodeBlock } from '@/components/ui'
import { Button } from '@cloudflare/kumo/components/button'

export function PageContent() {
  return (
    <>
      {/* Hero */}
      <div className="h-[60vh]">
        <Scene />
      </div>

      {/* Introduction */}
      <FadeInSection
        className="border-t border-dashed px-6 py-24"
        cornerGrid={{ position: 'bottom-left', color: '#f38020' }}
      >
        <div className="mx-auto max-w-3xl">
          <GlowHeading eyebrow="Introduction">Connect AI to your infrastructure</GlowHeading>
          <p className="text-lg leading-relaxed">
            The Model Context Protocol (MCP) is an open standard that enables AI assistants to
            securely connect to external data sources and tools. Cloudflare's MCP servers give AI
            models direct access to Workers, KV, R2, D1, and more.
          </p>
        </div>
      </FadeInSection>

      {/* Getting Started */}
      <FadeInSection
        className="border-t border-dashed px-6 py-24"
        cornerGrid={{ position: 'top-right', color: '#06b6d4' }}
      >
        <div className="mx-auto max-w-3xl">
          <GlowHeading eyebrow="Getting Started">Deploy in minutes</GlowHeading>
          <p className="text-lg leading-relaxed">
            Get started with Cloudflare MCP servers using our CLI. One command sets up
            authentication, configures your AI client, and connects you to Cloudflare's edge
            network.
          </p>
          <div className="mt-8">
            <CodeBlock title="terminal" language="bash">
              {`npx @cloudflare/mcp-server init

? Select the services to enable:
  ◉ Workers AI
  ◉ KV Storage
  ◉ R2 Object Storage
  ◉ D1 Database
  ◯ Queues
  ◯ Durable Objects

✓ MCP server configured
✓ Authentication complete
✓ Connected to Cloudflare edge`}
            </CodeBlock>
          </div>
        </div>
      </FadeInSection>

      {/* Workers AI */}
      <FadeInSection
        className="border-t border-dashed px-6 py-24"
        cornerGrid={{ position: 'top-left', color: '#f38020' }}
      >
        <div className="mx-auto max-w-3xl">
          <GlowHeading eyebrow="Workers AI">Run inference at the edge</GlowHeading>
          <p className="text-lg leading-relaxed">
            Access Cloudflare's fleet of GPUs running open-source models. Text generation,
            embeddings, image classification, and more—all without managing infrastructure.
          </p>
          <div className="mt-8 space-y-6">
            <CodeBlock title="workers-ai.ts">
              {`import { Ai } from '@cloudflare/ai';

export default {
  async fetch(request, env) {
    const ai = new Ai(env.AI);

    const response = await ai.run('@cf/meta/llama-2-7b-chat-int8', {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is MCP?' }
      ]
    });

    return Response.json(response);
  }
};`}
            </CodeBlock>
          </div>
        </div>
      </FadeInSection>

      {/* KV Storage */}
      <FadeInSection
        className="border-t border-dashed px-6 py-24"
        cornerGrid={{ position: 'bottom-right', color: '#fbad41' }}
      >
        <div className="mx-auto max-w-3xl">
          <GlowHeading eyebrow="KV Storage">Global key-value storage</GlowHeading>
          <p className="text-lg leading-relaxed">
            Store and retrieve data at the edge with sub-millisecond latency. KV is perfect for
            configuration, feature flags, and caching frequently accessed data.
          </p>
          <div className="mt-8">
            <CodeBlock title="kv-example.ts">
              {`// Store a value
await env.MY_KV.put('user:123', JSON.stringify({
  name: 'Alice',
  plan: 'pro',
  features: ['ai', 'analytics', 'api']
}));

// Retrieve with metadata
const { value, metadata } = await env.MY_KV.getWithMetadata(
  'user:123',
  { type: 'json' }
);

// List keys with prefix
const keys = await env.MY_KV.list({ prefix: 'user:' });`}
            </CodeBlock>
          </div>
        </div>
      </FadeInSection>

      {/* R2 Storage */}
      <FadeInSection
        className="border-t border-dashed px-6 py-24"
        cornerGrid={{ position: 'top-left', color: '#ff6633' }}
      >
        <div className="mx-auto max-w-3xl">
          <GlowHeading eyebrow="R2 Object Storage">S3-compatible storage, zero egress</GlowHeading>
          <p className="text-lg leading-relaxed">
            Store unlimited data with no egress fees. R2 is fully S3-compatible, making migration
            seamless while cutting your cloud storage costs.
          </p>
          <div className="mt-8">
            <CodeBlock title="r2-example.ts">
              {`// Upload an object
await env.MY_BUCKET.put('reports/2024/q1.pdf', pdfData, {
  httpMetadata: {
    contentType: 'application/pdf',
  },
  customMetadata: {
    author: 'finance-team',
    quarter: 'Q1-2024'
  }
});

// Generate presigned URL for downloads
const url = await env.MY_BUCKET.createPresignedUrl('reports/2024/q1.pdf', {
  expiresIn: 3600 // 1 hour
});`}
            </CodeBlock>
          </div>
        </div>
      </FadeInSection>

      {/* D1 Database */}
      <FadeInSection
        className="border-t border-dashed px-6 py-24"
        cornerGrid={{ position: 'bottom-right', color: '#a855f7' }}
      >
        <div className="mx-auto max-w-3xl">
          <GlowHeading eyebrow="D1 Database">SQLite at the edge</GlowHeading>
          <p className="text-lg leading-relaxed">
            A full SQL database that runs globally. D1 gives you the power of SQLite with automatic
            replication and zero configuration.
          </p>
          <div className="mt-8">
            <CodeBlock title="d1-example.ts">
              {`// Create a table
await env.DB.exec(\`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
\`);

// Insert with prepared statements
const result = await env.DB.prepare(
  'INSERT INTO users (email) VALUES (?) RETURNING *'
).bind('alice@example.com').first();

// Query with joins
const analytics = await env.DB.prepare(\`
  SELECT u.email, COUNT(e.id) as event_count
  FROM users u
  LEFT JOIN events e ON e.user_id = u.id
  WHERE e.created_at > datetime('now', '-7 days')
  GROUP BY u.id
\`).all();`}
            </CodeBlock>
          </div>
        </div>
      </FadeInSection>

      {/* Architecture */}
      <FadeInSection
        className="border-t border-dashed px-6 py-24"
        cornerGrid={{ position: 'top-left', color: '#10b981' }}
      >
        <div className="mx-auto max-w-3xl">
          <GlowHeading eyebrow="Architecture">How it works</GlowHeading>
          <p className="text-lg leading-relaxed">
            MCP servers run as Cloudflare Workers, deployed across 300+ cities worldwide. When your
            AI assistant needs data, it connects to the nearest edge location for minimal latency.
          </p>
          <div className="mt-8">
            <CodeBlock title="architecture" language="text">
              {`┌─────────────────┐     ┌───���──────────────┐     ┌─────────────────┐
│                 │     │                  │     │                 │
│   AI Assistant  │────▶│   MCP Server     │────▶│   Cloudflare    │
│   (Claude, etc) │     │   (Worker)       │     │   Services      │
│                 │◀────│                  │◀────│                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  Edge Location   │
                    │  (nearest to you)│
                    └──────────────────┘`}
            </CodeBlock>
          </div>
        </div>
      </FadeInSection>

      {/* CTA */}
      <FadeInSection
        className="border-t border-dashed px-6 py-24"
        cornerGrid={{ position: 'bottom-left', color: '#6366f1' }}
      >
        <div className="mx-auto max-w-3xl text-center">
          <GlowHeading eyebrow="Ready to start?">Build with Cloudflare MCP</GlowHeading>
          <p className="text-lg leading-relaxed">
            Join thousands of developers using MCP to connect AI to their infrastructure.
          </p>
          <div className="mt-8 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
            <Button as="a" href="https://developers.cloudflare.com/mcp" variant="solid">
              Read the docs
            </Button>
            <Button as="a" href="https://github.com/cloudflare/mcp-server" variant="outline">
              View on GitHub
            </Button>
          </div>
        </div>
      </FadeInSection>

      {/* Footer */}
      <footer className="border-t">
        <div className="mx-auto flex max-w-[var(--max-width)] items-center justify-between px-6 py-6">
          <p className="font-mono text-xs">© 2024 Cloudflare, Inc.</p>
          <div className="flex gap-6">
            <Button as="a" href="https://cloudflare.com/privacy" variant="ghost" size="sm">
              Privacy
            </Button>
            <Button as="a" href="https://cloudflare.com/terms" variant="ghost" size="sm">
              Terms
            </Button>
            <Button as="a" href="https://cloudflarestatus.com" variant="ghost" size="sm">
              Status
            </Button>
          </div>
        </div>
      </footer>
    </>
  )
}
