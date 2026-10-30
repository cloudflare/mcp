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
  // Objects and arrays are sent as JSON. Bytes (Uint8Array, ArrayBuffer), Blob, FormData,
  // URLSearchParams, streams, and strings with a non-JSON contentType are sent as they are. A string
  // with a JSON contentType, or none, is sent as it is when it is already JSON, else as a JSON string.
  body?: unknown;
  // Content-Type header. Defaults to application/json for JSON bodies. Leave it unset for FormData,
  // whose multipart boundary fetch adds.
  contentType?: string;
}

interface CloudflareResponse<T = unknown> {
  success: boolean;
  status: number;
  // A JSON response's result. For any other response, its text, or a Uint8Array for binary content
  // (images, PDFs, archives, and anything else that isn't valid UTF-8). Bytes in the value your code
  // returns appear as { base64, byteLength }.
  result: T;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
}

declare const cloudflare: {
  request<T = unknown>(options: CloudflareRequestOptions): Promise<CloudflareResponse<T>>;
};

declare const accountId: string;
`
