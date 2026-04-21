/**
 * All available OAuth scopes for the Cloudflare API MCP server.
 * If you need to add a new scope, first register it with the OAuth provider, then add it here.
 * Run tests to validate: npm test
 */
export const ALL_SCOPES = {
  // Core (required for basic functionality)
  offline_access: 'Grants refresh tokens for long-lived access',
  'user:read': 'See your user info such as name, email address, and account memberships',
  'account:read': 'See your account info such as account details, analytics, and memberships',

  // Access
  'access:read': 'View Access policies',
  'access:write': 'Configure Access policies',

  // Workers Platform
  'workers:read': 'See Cloudflare Workers data',
  'workers:write': 'Create and modify Cloudflare Workers',
  'workers_scripts:write': 'Upload and modify Worker scripts',
  'workers_kv:write': 'Create and modify KV namespaces and data',
  'workers_routes:write': 'Configure Worker routes',
  'workers_tail:read': 'View Worker logs via tail',
  'workers_deployments:read': 'View Worker deployment history and status',
  'workers_builds:read': 'View Worker builds',
  'workers_builds:write': 'Trigger Worker builds',
  'workers_observability:read': 'View Worker metrics and traces',
  'workers_observability:write': 'Configure Worker observability',
  'workers_observability_telemetry:write': 'Write Worker telemetry data',

  // Pages & D1
  'pages:read': 'View Cloudflare Pages projects',
  'pages:write': 'Create and modify Cloudflare Pages projects',
  'd1:write': 'Create and modify D1 databases',

  // AI & Machine Learning
  'ai:read': 'View AI models and inference results',
  'ai:write': 'Run AI inference',
  'aig:read': 'View AI Gateway configurations',
  'aig:write': 'Configure AI Gateway',
  'aiaudit:read': 'View AI audit logs',
  'aiaudit:write': 'Configure AI auditing',
  'ai-search:read': 'View AI Search configurations',
  'ai-search:write': 'Configure AI Search',
  'ai-search:run': 'Execute AI Search queries',

  // DNS Management
  'dns_records:read': 'View DNS records',
  'dns_records:edit': 'Create and modify DNS records',
  'dns_settings:read': 'View DNS settings',
  'dns_analytics:read': 'View DNS analytics',
  'zone:read': 'View zone configurations',

  // Observability & Logging
  'logpush:read': 'View Logpush jobs',
  'logpush:write': 'Configure Logpush jobs',
  'auditlogs:read': 'View audit logs',

  // Infrastructure & Networking
  'ssl_certs:write': 'Manage SSL certificates',
  'lb:read': 'View load balancer configurations',
  'lb:edit': 'Configure load balancers',
  'notification:read': 'View notification policies',
  'notification:write': 'Configure notifications',

  // Queues & Pipelines
  'queues:write': 'Create and modify Queues',
  'pipelines:read': 'View Pipeline configurations',
  'pipelines:setup': 'Set up Pipelines',
  'pipelines:write': 'Modify Pipelines',

  // Storage & Data
  'r2_catalog:write': 'Manage R2 buckets and objects',
  'vectorize:write': 'Create and modify Vectorize indexes',
  'query_cache:write': 'Configure query cache',
  'secrets_store:read': 'View secrets',
  'secrets_store:write': 'Create and modify secrets',

  // Browser & Containers
  'browser:read': 'View Browser Rendering configurations',
  'browser:write': 'Configure Browser Rendering',
  'containers:write': 'Manage containers',

  // Teams & Security
  'teams:read': 'View Cloudflare Zero Trust configurations',
  'teams:write': 'Configure Cloudflare Zero Trust',
  'teams:pii': 'Access PII in Zero Trust logs',
  'teams:secure_location': 'Manage secure locations',
  'sso-connector:read': 'View SSO connectors',
  'sso-connector:write': 'Configure SSO connectors',

  // Connectivity
  'connectivity:admin': 'Full connectivity administration',
  'connectivity:bind': 'Bind connectivity resources',
  'connectivity:read': 'View connectivity configurations',

  // Cloudflare One
  'cfone:read': 'View Cloudflare One configurations',
  'cfone:write': 'Configure Cloudflare One',

  // DEX (Digital Experience)
  'dex:read': 'View DEX configurations',
  'dex:write': 'Configure DEX',

  // URL Scanner & Radar
  'url_scanner:read': 'View URL Scanner results',
  'url_scanner:write': 'Configure URL Scanner',
  'radar:read': 'View Radar threat intelligence',

  // MCP Portals
  'mcp_portals:read': 'View MCP Portal configurations',
  'mcp_portals:write': 'Create and modify MCP Portals',

  // Email
  'email_routing:write': 'Configure email routing rules',
  'email_sending:write': 'Send emails via Email Workers'
} as const

/**
 * Maximum number of scopes that can be requested in a single OAuth authorization.
 * Cloudflare's OAuth server returns "Something went wrong!" when more than 76 scopes
 * are requested. This limit is enforced server-side.
 */
export const MAX_SCOPES = 76

export type ScopeName = keyof typeof ALL_SCOPES

/** Scopes required for basic functionality - always included */
export const REQUIRED_SCOPES: ScopeName[] = ['user:read', 'offline_access', 'account:read']

const yoloScopes = Object.keys(ALL_SCOPES) as ScopeName[]

const readOnlyScopes = Array.from(
  new Set<ScopeName>([
    ...REQUIRED_SCOPES,
    ...(Object.keys(ALL_SCOPES) as ScopeName[]).filter((s) => s.endsWith(':read'))
  ])
)

/** Scope templates for quick selection. `custom` is surfaced client-side only. */
export const SCOPE_TEMPLATES = {
  'read-only': {
    name: 'Read only',
    description:
      'View resources without making changes. Safest for exploration and read workflows.',
    scopes: readOnlyScopes
  },
  yolo: {
    name: 'Full access',
    description:
      'Everything the MCP server can do. Skips sensitive PII and deprecated scopes. Use with trusted clients only.',
    scopes: yoloScopes
  }
} as const

export type TemplateName = keyof typeof SCOPE_TEMPLATES

/** Default template - read only is safest */
export const DEFAULT_TEMPLATE: TemplateName = 'read-only'
