interface CornerMarksProps {
  className?: string
}

/**
 * Decorative diagonal marks at corners of containers.
 * Inspired by sandbox.cloudflare.com's code block styling.
 */
export function CornerMarks({ className }: CornerMarksProps) {
  return (
    <>
      {/* Top-left */}
      <div
        className={`absolute top-0 left-0 hidden lg:block ${className ?? ''}`}
        style={{ width: 17, height: 17 }}
      >
        <svg width="100%" height="100%" aria-hidden="true" className="text-(--color-border)">
          <line x2="17" y2="17" stroke="currentColor" />
        </svg>
      </div>

      {/* Top-right */}
      <div
        className={`absolute top-0 right-0 hidden lg:block ${className ?? ''}`}
        style={{ width: 17, height: 17 }}
      >
        <svg width="100%" height="100%" aria-hidden="true" className="text-(--color-border)">
          <line y1="17" x2="17" stroke="currentColor" />
        </svg>
      </div>

      {/* Bottom-left */}
      <div
        className={`absolute bottom-0 left-0 hidden lg:block ${className ?? ''}`}
        style={{ width: 17, height: 17 }}
      >
        <svg width="100%" height="100%" aria-hidden="true" className="text-(--color-border)">
          <line y1="17" x2="17" stroke="currentColor" />
        </svg>
      </div>

      {/* Bottom-right */}
      <div
        className={`absolute bottom-0 right-0 hidden lg:block ${className ?? ''}`}
        style={{ width: 17, height: 17 }}
      >
        <svg width="100%" height="100%" aria-hidden="true" className="text-(--color-border)">
          <line x2="17" y2="17" stroke="currentColor" />
        </svg>
      </div>
    </>
  )
}
