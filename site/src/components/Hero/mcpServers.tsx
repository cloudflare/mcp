import {
  Brain,
  Database,
  HardDrives,
  Table,
  Queue,
  Cube,
  Graph,
  Browser,
  Lightning,
  ChartLine
} from '@phosphor-icons/react'

// Inline SVG logos for partner companies
export const AsanaLogo = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M18.78 12.653c-2.882 0-5.22 2.337-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.337 5.22-5.22-2.337-5.22-5.22-5.22zm-13.56 0c-2.882 0-5.22 2.337-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.337 5.22-5.22-2.337-5.22-5.22-5.22zM12 1.907c-2.882 0-5.22 2.337-5.22 5.22s2.338 5.22 5.22 5.22 5.22-2.337 5.22-5.22-2.337-5.22-5.22-5.22z" />
  </svg>
)

export const AtlassianLogo = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M7.127 11.086a.681.681 0 0 0-1.14.134L.2 22.046a.682.682 0 0 0 .61.988h8.39a.684.684 0 0 0 .61-.378c1.756-3.528.787-8.762-2.683-11.57zm4.862-10.07a14.465 14.465 0 0 0-.573 14.318l3.575 7.18a.681.681 0 0 0 .61.378h8.39a.681.681 0 0 0 .61-.988L13.125 1.15a.68.68 0 0 0-1.136-.134z" />
  </svg>
)

export const IntercomLogo = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M20.747 0H3.253A3.253 3.253 0 0 0 0 3.253v17.494A3.253 3.253 0 0 0 3.253 24h17.494A3.253 3.253 0 0 0 24 20.747V3.253A3.253 3.253 0 0 0 20.747 0zM5.746 14.909a.748.748 0 0 1-1.496 0V9.091a.748.748 0 0 1 1.496 0v5.818zm3.5 1.75a.748.748 0 0 1-1.496 0V7.341a.748.748 0 0 1 1.496 0v9.318zm3.5.75a.748.748 0 0 1-1.496 0V6.591a.748.748 0 0 1 1.496 0v10.818zm3.5-.75a.748.748 0 0 1-1.496 0V7.341a.748.748 0 0 1 1.496 0v9.318zm3.5-1.75a.748.748 0 0 1-1.496 0V9.091a.748.748 0 0 1 1.496 0v5.818z" />
  </svg>
)

export const LinearLogo = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M2.886 10.699a10.949 10.949 0 0 0 10.415 10.415l-10.415-10.415zm-.799 2.409A10.968 10.968 0 0 0 12 23c6.075 0 11-4.925 11-11a10.968 10.968 0 0 0-9.892-10.913l9.805 9.805a.502.502 0 0 1 0 .71l-9.696 9.696a.502.502 0 0 1-.71 0L2.087 13.108zm1.012-4.41 11.203 11.203A10.949 10.949 0 0 0 3.099 8.698zm1.705-2.553 12.652 12.652a10.972 10.972 0 0 0 2.447-4.243L6.047 4.698a10.972 10.972 0 0 0-1.243 1.447zm2.655-2.056 12.348 12.348a10.947 10.947 0 0 0 .742-2.35L8.441 3.347a10.947 10.947 0 0 0-.982.742zm3.15-1.34 10.14 10.14a10.99 10.99 0 0 0-10.14-10.14z" />
  </svg>
)

export const PayPalLogo = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944.901C5.026.382 5.474 0 5.998 0h7.46c2.57 0 4.578.543 5.69 1.81 1.01 1.15 1.304 2.42 1.012 4.287-.023.143-.047.288-.077.437-.983 5.05-4.349 6.797-8.647 6.797h-2.19c-.524 0-.968.382-1.05.9l-1.12 7.106zm14.146-14.42a3.35 3.35 0 0 0-.607-.541c-.013.076-.026.175-.041.254-.93 4.778-4.005 7.201-9.138 7.201h-2.19a.563.563 0 0 0-.556.479l-1.187 7.527h-.506l-.24 1.516a.56.56 0 0 0 .554.647h3.882c.46 0 .85-.334.922-.788.06-.26.76-4.852.816-5.09a.932.932 0 0 1 .923-.788h.58c3.76 0 6.705-1.528 7.565-5.946.36-1.847.174-3.388-.777-4.471z" />
  </svg>
)

export const SentryLogo = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.258 13.258 0 0 0 5.784 9.814l-2.926 4.855a9.965 9.965 0 0 1 4.089 6.062H4.726a7.746 7.746 0 0 0-2.063-3.916l-.85 1.41a.475.475 0 0 0 .168.63l.463.266a9.963 9.963 0 0 1 2.063 3.61H.873a.475.475 0 0 1-.41-.715L6.31 11.95a11.039 11.039 0 0 1 5.663 8.78h2.222a13.257 13.257 0 0 0-6.942-11.296l1.855-3.078a15.477 15.477 0 0 1 7.453 11.883h2.222A17.7 17.7 0 0 0 10.455 4.39l1.533-2.544a.475.475 0 0 1 .82 0l10.065 16.7a.475.475 0 0 1-.41.715h-3.81v2.22h3.81a2.695 2.695 0 0 0 2.327-4.054L13.91 2.505z" />
  </svg>
)

export const SquareLogo = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M4.01 0A4.01 4.01 0 0 0 0 4.01v15.98A4.01 4.01 0 0 0 4.01 24h15.98A4.01 4.01 0 0 0 24 19.99V4.01A4.01 4.01 0 0 0 19.99 0H4.01zm2.186 4.856h11.608c.738 0 1.337.6 1.337 1.337v11.614c0 .738-.6 1.337-1.337 1.337H6.196a1.338 1.338 0 0 1-1.337-1.337V6.193c0-.738.6-1.337 1.337-1.337zm1.634 2.673v8.942h8.34V7.529H7.83zm2.085 2.079h4.17v4.785H9.915V9.608z" />
  </svg>
)

export const StripeLogo = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z" />
  </svg>
)

export const WebflowLogo = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.803 6.202c-1.416 0-2.443 1.066-2.861 2.124a4.096 4.096 0 0 0-1.834-2.124 4.105 4.105 0 0 0-2.093-.584c-1.51 0-2.594.896-3.135 2.123a4.026 4.026 0 0 0-.598-.954c-.837-1.07-2.153-1.17-3.074-1.17-.387 0-.695.008-.866.016v10.774s.479.016.866.016c.921 0 2.237-.1 3.074-1.17.221-.284.424-.595.598-.954.54 1.227 1.624 2.124 3.135 2.124.748 0 1.463-.205 2.093-.584a4.096 4.096 0 0 0 1.834-2.125c.418 1.06 1.445 2.125 2.861 2.125 2.02 0 3.156-1.448 3.156-3.812v-2.017c0-2.364-1.136-3.812-3.156-3.812zm-7.203 7.203a1.79 1.79 0 0 1-1.785-1.785V10.38a1.79 1.79 0 0 1 1.785-1.785 1.79 1.79 0 0 1 1.785 1.785v1.24a1.79 1.79 0 0 1-1.785 1.785zm7.203 0c-.654 0-1.185-.531-1.185-1.185v-2.44c0-.654.531-1.185 1.185-1.185.654 0 1.185.531 1.185 1.185v2.44c0 .654-.531 1.185-1.185 1.185z" />
  </svg>
)

export interface MCPServer {
  id: string
  name: string
  icon: React.ComponentType<{
    size?: number
    weight?: 'light' | 'regular' | 'bold' | 'fill' | 'duotone' | 'thin'
    color?: string
  }>
  color: string // Default/light mode color
  darkColor?: string // Optional dark mode color (defaults to color if not specified)
}

export const MCP_SERVERS: MCPServer[] = [
  // Cloudflare Services
  {
    id: 'workers-ai',
    name: 'Workers AI',
    icon: Brain,
    color: '#f38020',
    darkColor: '#f38020'
  },
  {
    id: 'kv',
    name: 'KV Storage',
    icon: Database,
    color: '#fbad41',
    darkColor: '#fbad41'
  },
  {
    id: 'r2',
    name: 'R2 Storage',
    icon: HardDrives,
    color: '#ff6633',
    darkColor: '#ff6633'
  },
  {
    id: 'd1',
    name: 'D1 Database',
    icon: Table,
    color: '#a855f7',
    darkColor: '#a855f7'
  },
  {
    id: 'queues',
    name: 'Queues',
    icon: Queue,
    color: '#06b6d4',
    darkColor: '#06b6d4'
  },
  {
    id: 'durable-objects',
    name: 'Durable Objects',
    icon: Cube,
    color: '#10b981',
    darkColor: '#10b981'
  },
  {
    id: 'vectorize',
    name: 'Vectorize',
    icon: Graph,
    color: '#ec4899',
    darkColor: '#ec4899'
  },
  {
    id: 'browser',
    name: 'Browser',
    icon: Browser,
    color: '#6366f1',
    darkColor: '#6366f1'
  },
  {
    id: 'hyperdrive',
    name: 'Hyperdrive',
    icon: Lightning,
    color: '#f59e0b',
    darkColor: '#f59e0b'
  },
  {
    id: 'analytics',
    name: 'Analytics',
    icon: ChartLine,
    color: '#8b5cf6',
    darkColor: '#8b5cf6'
  },

  // Partner Companies
  {
    id: 'asana',
    name: 'Asana',
    icon: AsanaLogo,
    color: '#F06A6A',
    darkColor: '#F06A6A'
  },
  {
    id: 'atlassian',
    name: 'Atlassian',
    icon: AtlassianLogo,
    color: '#0052CC',
    darkColor: '#2684FF'
  }, // Lighter blue for dark mode
  {
    id: 'intercom',
    name: 'Intercom',
    icon: IntercomLogo,
    color: '#6AFDEF',
    darkColor: '#6AFDEF'
  },
  {
    id: 'linear',
    name: 'Linear',
    icon: LinearLogo,
    color: '#5E6AD2',
    darkColor: '#8B94E8'
  }, // Lighter purple for dark mode
  {
    id: 'paypal',
    name: 'PayPal',
    icon: PayPalLogo,
    color: '#003087',
    darkColor: '#0070E0'
  }, // Lighter blue for dark mode
  {
    id: 'sentry',
    name: 'Sentry',
    icon: SentryLogo,
    color: '#362D59',
    darkColor: '#6C5FC7'
  }, // Lighter purple for dark mode
  {
    id: 'square',
    name: 'Square',
    icon: SquareLogo,
    color: '#000000',
    darkColor: '#FFFFFF'
  }, // White for dark mode
  {
    id: 'stripe',
    name: 'Stripe',
    icon: StripeLogo,
    color: '#635BFF',
    darkColor: '#7A73FF'
  }, // Slightly lighter for dark mode
  {
    id: 'webflow',
    name: 'Webflow',
    icon: WebflowLogo,
    color: '#4353FF',
    darkColor: '#6B79FF'
  } // Lighter blue for dark mode
]
