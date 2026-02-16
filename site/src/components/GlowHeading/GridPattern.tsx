import { useId } from 'react'

interface GridPatternProps {
  cellSize?: number
}

// Default cell size calculated to match Hero grid:
// Hero uses gridDensity=30, so for a ~1400px container: 1400/30 ≈ 47px
export function GridPattern({ cellSize = 20 }: GridPatternProps) {
  const patternId = useId()

  return (
    <svg
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
      style={{
        maskImage:
          'radial-gradient(ellipse 85% 85% at 50% 50%, black 0%, rgba(0,0,0,0.5) 30%, transparent 60%)',
        WebkitMaskImage:
          'radial-gradient(ellipse 85% 85% at 50% 50%, black 0%, rgba(0,0,0,0.5) 30%, transparent 60%)'
      }}
    >
      <defs>
        <pattern id={patternId} width={cellSize} height={cellSize} patternUnits="userSpaceOnUse">
          <path
            d={`M ${cellSize} 0 L 0 0 0 ${cellSize}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeOpacity="1.0"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  )
}
