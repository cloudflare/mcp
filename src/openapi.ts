/**
 * Minimal shape of an OpenAPI operation, as stored in our pre-processed spec.
 */
export interface OperationInfo {
  summary?: string
  /** API token permissions the operation accepts; any one is enough. OAuth scopes share these names. */
  'x-api-token-group'?: string[]
  description?: string
  tags?: string[]
  parameters?: Array<{
    name: string
    in: string
    required?: boolean
    schema?: unknown
    description?: string
  }>
  requestBody?: {
    required?: boolean
    content?: Record<string, { schema?: unknown }>
  }
  responses?: Record<string, unknown>
}

/**
 * TypeScript declarations describing the `spec` object exposed to the `search`
 * tool's sandboxed code. Inlined into the search tool description.
 */
export const SPEC_TYPES = `
interface OperationInfo {
  summary?: string;
  "x-api-token-group"?: string[]; // API token permissions the endpoint accepts (any one); OAuth scopes have the same names
  description?: string;
  tags?: string[];
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: unknown; description?: string }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: unknown }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
}

interface PathItem {
  get?: OperationInfo;
  post?: OperationInfo;
  put?: OperationInfo;
  patch?: OperationInfo;
  delete?: OperationInfo;
}

declare const spec: {
  paths: Record<string, PathItem>;
};
`
