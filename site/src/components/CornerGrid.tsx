import { useId } from 'react'

export type CornerPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

interface CornerGridProps {
  position?: CornerPosition
  color?: string
  cellSize?: number
  /** Size of the grid as percentage of container (default 40%) */
  size?: number
  /** Opacity of the grid lines (default 0.15) */
  opacity?: number
}

/**
 * Subtle colored grid pattern that emanates from a corner.
 * Very Vercel-inspired: minimal, masked, and elegant.
 */
export function CornerGrid({
  position = 'top-left',
  color = '#f38020',
  cellSize = 24,
  size = 50,
  opacity = 0.5
}: CornerGridProps) {
  const patternId = useId()

  // Position and gradient direction based on corner
  const positionStyles: Record<CornerPosition, { className: string; gradient: string }> = {
    'top-left': {
      className: 'top-0 left-0',
      gradient: `radial-gradient(ellipse 100% 100% at 0% 0%, black 0%, rgba(0,0,0,0.5) 40%, transparent 70%)`
    },
    'top-right': {
      className: 'top-0 right-0',
      gradient: `radial-gradient(ellipse 100% 100% at 100% 0%, black 0%, rgba(0,0,0,0.5) 40%, transparent 70%)`
    },
    'bottom-left': {
      className: 'bottom-0 left-0',
      gradient: `radial-gradient(ellipse 100% 100% at 0% 100%, black 0%, rgba(0,0,0,0.5) 40%, transparent 70%)`
    },
    'bottom-right': {
      className: 'bottom-0 right-0',
      gradient: `radial-gradient(ellipse 100% 100% at 100% 100%, black 0%, rgba(0,0,0,0.5) 40%, transparent 70%)`
    }
  }

  const { className, gradient } = positionStyles[position]

  return (
    <div
      className={`pointer-events-none absolute ${className} z-0 overflow-hidden`}
      style={{
        width: `${size}%`,
        height: `${size}%`
      }}
      aria-hidden="true"
    >
      <svg
        className="absolute inset-0 h-full w-full"
        role="img"
        aria-hidden="true"
        style={{
          maskImage: gradient,
          WebkitMaskImage: gradient
        }}
      >
        <title>Decorative grid pattern</title>
        <defs>
          <pattern id={patternId} width={cellSize} height={cellSize} patternUnits="userSpaceOnUse">
            <path
              d={`M ${cellSize} 0 L 0 0 0 ${cellSize}`}
              fill="none"
              stroke={color}
              strokeWidth="1"
              strokeOpacity={opacity}
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${patternId})`} />
      </svg>
    </div>
  )
}
