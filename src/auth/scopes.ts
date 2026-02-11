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
  'agw:read': 'View AI Gateway analytics',
  'agw:run': 'Execute AI Gateway requests',
  'agw:write': 'Modify AI Gateway settings',
  'aiaudit:read': 'View AI audit logs',
  'aiaudit:write': 'Configure AI auditing',
  'ai-search:read': 'View AI Search configurations',
  'ai-search:write': 'Configure AI Search',
  'ai-search:run': 'Execute AI Search queries',
  'rag:read': 'View RAG configurations',
  'rag:write': 'Configure RAG pipelines',

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
  'constellation:write': 'Configure Constellation',
  'cloudchamber:write': 'Manage CloudChamber',

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

  // Billing
  'billing:read': 'View billing information',
  'billing:write': 'Modify billing settings',

  // Notebooks
  'notebook-examples:read': 'View notebook examples',
  'notebook-managed:read': 'View managed notebooks',

  // Other
  'firstpartytags:write': 'Configure first-party tags',
} as const

export type ScopeName = keyof typeof ALL_SCOPES

/** Scopes required for basic functionality - always included */
export const REQUIRED_SCOPES: ScopeName[] = ['user:read', 'offline_access', 'account:read']

/** All read-only scopes (ending in :read) */
export const READ_ONLY_SCOPES: ScopeName[] = (Object.keys(ALL_SCOPES) as ScopeName[]).filter(
  (scope) => scope.endsWith(':read'),
)

/** All write/edit scopes */
export const WRITE_SCOPES: ScopeName[] = (Object.keys(ALL_SCOPES) as ScopeName[]).filter(
  (scope) =>
    scope.endsWith(':write') ||
    scope.endsWith(':edit') ||
    scope.endsWith(':run') ||
    scope.endsWith(':setup') ||
    scope.endsWith(':admin') ||
    scope.endsWith(':bind') ||
    scope.endsWith(':pii'),
)

/** Scope templates for quick selection */
export const SCOPE_TEMPLATES = {
  'read-only': {
    name: 'Read Only (Recommended)',
    description: 'View resources without making changes. Safest option for exploration.',
    scopes: [
      ...REQUIRED_SCOPES,
      'zone:read',
      'workers:read',
      'workers_tail:read',
      'pages:read',
    ] as ScopeName[],
  },
  'workers-full': {
    name: 'Workers Full Access',
    description: 'Full access to Workers, KV, D1, R2, and related services.',
    scopes: [
      ...REQUIRED_SCOPES,
      'account:read',
      'workers:read',
      'workers:write',
      'workers_scripts:write',
      'workers_kv:write',
      'workers_routes:write',
      'workers_tail:read',
      'workers_builds:read',
      'workers_builds:write',
      'd1:write',
      'r2_catalog:write',
      'queues:write',
      'pages:read',
      'pages:write',
    ] as ScopeName[],
  },
  'dns-full': {
    name: 'DNS Full Access',
    description: 'Full access to DNS records and zone settings.',
    scopes: [
      ...REQUIRED_SCOPES,
      'account:read',
      'zone:read',
      'dns_records:read',
      'dns_records:edit',
      'dns_settings:read',
      'dns_analytics:read',
    ] as ScopeName[],
  },
  'full-access': {
    name: 'Full Access',
    description: 'Complete access to all Cloudflare APIs. Use with caution.',
    scopes: Object.keys(ALL_SCOPES) as ScopeName[],
  },
} as const

export type TemplateName = keyof typeof SCOPE_TEMPLATES

/** Default template - read only is safest */
export const DEFAULT_TEMPLATE: TemplateName = 'read-only'
