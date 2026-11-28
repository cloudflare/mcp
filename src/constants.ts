/**
 * Truly static, dependency-free values shared across the worker.
 */

/** An MCP icon (`Implementation.icons`, `Tool.icons`). */
export type Icon = { src: string; mimeType?: string; sizes?: Array<string> }

export type ServerInfo = { name: string; version: string; icons?: Array<Icon> }

/** The Cloudflare glyph (Kumo's `CloudflareLogo` glyph, paths rounded to 0.1), on a square canvas. */
const CLOUDFLARE_GLYPH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -13 48.3 48">' +
  '<path fill="#FF5E1F" d="M33.2 20.4C33.4 20 33.4 19.5 33.4 19.1C33.3 18.6 33.2 18.2 32.9 17.8C32.6 17.5 32.3 17.2 32 17C31.6 16.9 31.2 16.7 30.8 16.7L13.4 16.5C13.3 16.5 13.2 16.4 13.1 16.4C13.1 16.4 13.1 16.4 13 16.3C13 16.3 13 16.3 13 16.3C13 16.2 13 16.2 13 16.2C13.1 16.1 13.1 16.1 13.1 16.1C13.2 15.9 13.3 15.8 13.5 15.8L31 15.6C32.1 15.5 33.2 15.1 34.1 14.4C35 13.7 35.7 12.8 36.1 11.8L37.1 9.2C37.1 9.1 37.2 9 37.1 8.9C36.6 6.5 35.2 4.3 33.3 2.7C31.5 1.1 29.1 0.2 26.6 0C24.1 -0.1 21.7 0.6 19.6 1.9C17.6 3.3 16 5.4 15.2 7.7C14.2 7 12.9 6.6 11.6 6.7C10.4 6.8 9.3 7.4 8.5 8.2C7.7 9 7.1 10.1 7 11.3C6.9 11.9 7 12.5 7.1 13.1C5.2 13.2 3.4 13.9 2.1 15.3C0.7 16.7 0 18.5 0 20.4C0 20.8 0 21.1 0.1 21.5C0.1 21.6 0.1 21.7 0.2 21.7C0.3 21.8 0.3 21.8 0.4 21.8H32.5C32.7 21.8 32.9 21.7 32.9 21.5L33.2 20.4Z"/>' +
  '<path fill="#FF9911" d="M38.7 9.2H38.2C38.1 9.2 38 9.3 37.9 9.4L37.2 11.8C37 12.2 37 12.7 37 13.1C37.1 13.6 37.3 14 37.5 14.4C37.8 14.7 38.1 15 38.4 15.2C38.8 15.3 39.2 15.5 39.6 15.5L43.3 15.7C43.4 15.7 43.5 15.8 43.6 15.8C43.6 15.8 43.6 15.8 43.7 15.9C43.7 15.9 43.7 15.9 43.7 16C43.7 16 43.7 16 43.7 16C43.6 16.1 43.6 16.1 43.6 16.1C43.5 16.3 43.4 16.4 43.2 16.4L39.4 16.6C38.3 16.7 37.2 17.1 36.3 17.8C35.4 18.5 34.7 19.4 34.3 20.4L34.1 21.3C34 21.4 34.1 21.6 34.3 21.6H47.5C47.5 21.6 47.6 21.6 47.6 21.6C47.7 21.6 47.7 21.6 47.7 21.5C47.8 21.5 47.8 21.5 47.8 21.4C47.8 21.4 47.8 21.3 47.8 21.3C48 20.5 48.2 19.6 48.2 18.7C48.2 16.2 47.2 13.8 45.4 12C43.6 10.2 41.2 9.2 38.7 9.2Z"/>' +
  '</svg>'

/**
 * The Cloudflare mark, declared as the server's icon and each MCP App tool's,
 * so the host draws it in its own chrome: ChatGPT's App guidelines ask for no
 * logo in the response, and Claude draws a declared icon in the App's title
 * bar. A data URI, so no host fetches anything for it.
 */
export const CLOUDFLARE_ICONS: Array<Icon> = [
  {
    src: `data:image/svg+xml;base64,${btoa(CLOUDFLARE_GLYPH_SVG)}`,
    mimeType: 'image/svg+xml',
    sizes: ['any']
  }
]

/**
 * Shared MCP server identity (name + version), consumed across layers: the MCP
 * server handshake (`new McpServer(SERVER_INFO)`) and the metrics tracker
 * (reported as blob1/blob2 on every datapoint, in both the request path and the
 * OAuth handler).
 */
export const SERVER_INFO: ServerInfo = {
  name: 'cloudflare-api',
  version: '0.1.0',
  icons: CLOUDFLARE_ICONS
}

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
