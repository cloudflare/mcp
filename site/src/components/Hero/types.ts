import type { Body } from 'matter-js'

export interface MCPServer {
  id: string
  name: string
  color: string
  radius?: number
}

export interface PhysicsConfig {
  /** Pixels per Three.js unit */
  scale: number
  /** Gravity strength */
  gravity: { x: number; y: number }
  /** Restitution (bounciness) */
  restitution: number
  /** Friction */
  friction: number
}

export const DEFAULT_PHYSICS_CONFIG: PhysicsConfig = {
  scale: 100,
  gravity: { x: 0, y: 0.5 },
  restitution: 0.8,
  friction: 0.1
}

export interface CollisionEvent {
  position: { x: number; y: number }
  intensity: number
  timestamp: number
}

export interface PhysicsContextValue {
  engine: Matter.Engine | null
  world: Matter.World | null
  scale: number
  addBody: (body: Body) => void
  removeBody: (body: Body) => void
  collisionEvents: CollisionEvent[]
}

// Sample MCP servers data
export const MCP_SERVERS: MCPServer[] = [
  { id: '1', name: 'Workers AI', color: '#f38020', radius: 0.6 },
  { id: '2', name: 'KV', color: '#fbad41', radius: 0.45 },
  { id: '3', name: 'R2', color: '#ff6633', radius: 0.5 },
  { id: '4', name: 'D1', color: '#a855f7', radius: 0.55 },
  { id: '5', name: 'Queues', color: '#06b6d4', radius: 0.5 },
  { id: '6', name: 'Durable Objects', color: '#10b981', radius: 0.7 },
  { id: '7', name: 'Vectorize', color: '#ec4899', radius: 0.55 },
  { id: '8', name: 'Browser', color: '#6366f1', radius: 0.5 },
  { id: '9', name: 'Hyperdrive', color: '#f59e0b', radius: 0.6 },
  { id: '10', name: 'Analytics', color: '#8b5cf6', radius: 0.5 }
]
