import { useId } from 'react'

interface DotPatternProps {
  className?: string
}

/**
 * SVG dot pattern background inspired by workers.cloudflare.com.
 * Uses 12px spacing with small dots.
 */
export function DotPattern({ className }: DotPatternProps) {
  const patternId = useId()

  return (
    <svg
      className={`pointer-events-none absolute inset-0 h-full w-full ${className ?? ''}`}
      aria-hidden="true"
    >
      <pattern id={patternId} x="0" y="0" width="12" height="12" patternUnits="userSpaceOnUse">
        <circle cx="6" cy="6" r="0.75" fill="var(--color-border)" />
      </pattern>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  )
}

/**
 * Full-width dot pattern container that appears in the margins
 * between the side rulers and the main content area.
 * Matches workers.cloudflare.com styling.
 */
export function DotPatternBackground() {
  return (
    <div
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ zIndex: 1 }}
      aria-hidden="true"
    >
      {/* Wider container for dots - extends beyond content area */}
      <div className="absolute top-0 left-1/2 h-full w-full max-w-[1600px] -translate-x-1/2">
        {/* Dot pattern fills the full width */}
        <DotPattern />

        {/* Dashed vertical border lines at the edges of the dot area */}
        <div
          className="absolute top-0 left-0 h-full w-px"
          style={{
            backgroundImage:
              'linear-gradient(to bottom, var(--color-border-50) 50%, transparent 50%)',
            backgroundSize: '1px 32px',
            backgroundRepeat: 'repeat-y'
          }}
        />
        <div
          className="absolute top-0 right-0 h-full w-px"
          style={{
            backgroundImage:
              'linear-gradient(to bottom, var(--color-border-50) 50%, transparent 50%)',
            backgroundSize: '1px 32px',
            backgroundRepeat: 'repeat-y'
          }}
        />
      </div>

      {/* Mask out the center content area so dots only show in margins */}
      <div
        className="absolute top-0 left-1/2 h-full w-full max-w-[var(--max-width)] -translate-x-1/2 bg-(--color-surface-secondary)"
        style={{ zIndex: 2 }}
      />
    </div>
  )
}
