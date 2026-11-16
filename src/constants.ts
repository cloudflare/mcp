/**
 * Truly static, dependency-free values shared across the worker.
 */

export type ServerInfo = { name: string; version: string }

/**
 * Shared MCP server identity (name + version), consumed across layers: the MCP
 * server handshake (`new McpServer(SERVER_INFO)`) and the metrics tracker
 * (reported as blob1/blob2 on every datapoint, in both the request path and the
 * OAuth handler).
 */
export const SERVER_INFO: ServerInfo = { name: 'cloudflare-api', version: '0.1.0' }

/**
 * User-Agent sent on every outbound request to Cloudflare: the product name and, in an RFC 9110
 * comment, where to find whoever runs it. No version: one deployment is live at a time, so the
 * deploy history already says which commit sent a request.
 */
export const USER_AGENT = 'cloudflare-mcp (+https://github.com/cloudflare/mcp)'

/**
 * TypeScript declarations describing the `cloudflare` helper and `accountId`
 * binding available to the `execute` tool's sandboxed code. Inlined into the
 * execute tool description.
 */
export const CLOUDFLARE_TYPES = `
interface CloudflareRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  // Request headers the endpoint declares, such as { "cf-r2-jurisdiction": "eu" } for an R2 bucket
  // in a jurisdiction, or { "If-Match": etag }. Authorization is always the session's.
  headers?: Record<string, string>;
  // A string, bytes (Uint8Array, ArrayBuffer), Blob, FormData, URLSearchParams or stream is sent as
  // it is. Any other value is sent as JSON. Content-Type defaults to application/json for JSON and
  // for strings: set it in headers for other text, such as { "Content-Type": "text/plain" } for SQL,
  // and for bytes. FormData, Blob and URLSearchParams bring their own.
  body?: unknown;
}

// The response body as the API sends it. Most APIs wrap it in this envelope; a few send their JSON
// bare (the spec's response schema shows which). Non-JSON responses are text, or a Uint8Array for
// binary content (images, PDFs, archives). Bytes in the value your code returns appear as
// { base64, byteLength }. A failed request throws.
interface CloudflareEnvelope<T = unknown> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result: T;
  result_info?: { page: number; per_page: number; total_pages: number; count: number; total_count: number };
}

declare const cloudflare: {
  request<T = CloudflareEnvelope>(options: CloudflareRequestOptions): Promise<T>;
};

declare const accountId: string;
`
