import { useRef } from 'react'
import { motion, useInView } from 'framer-motion'
import { GridPattern } from './GridPattern'
import { CornerGrid, type CornerPosition } from '../CornerGrid'

interface GlowHeadingProps {
  children: React.ReactNode
  eyebrow?: string
}

// Text shadow uses CSS variable for theme support
const TEXT_SHADOW = 'var(--glow-heading-shadow)'

// Grid color uses CSS variable for theme support
const GRID_COLOR = 'var(--glow-heading-grid-color)'

export function GlowHeading({ children, eyebrow }: GlowHeadingProps) {
  return (
    <div className="relative isolate">
      {/* Grid background layer */}
      <div
        className="pointer-events-none absolute left-0 top-5.5 h-full z-0 w-screen max-w-lg overflow-hidden"
        style={{ color: GRID_COLOR }}
      >
        <GridPattern />
      </div>

      {/* Content */}
      <div className="relative z-10 py-8">
        {eyebrow && (
          <span className="font-mono text-xs uppercase tracking-widest text-(--color-muted)">
            {eyebrow}
          </span>
        )}
        <h2
          className="mt-3 text-4xl font-medium tracking-tight md:text-5xl"
          style={{ textShadow: TEXT_SHADOW }}
        >
          {children}
        </h2>
      </div>
    </div>
  )
}

// Wrapper component for fading in sections
export interface CornerGridConfig {
  position: CornerPosition
  color: string
}

interface FadeInSectionProps {
  children: React.ReactNode
  className?: string
  /** Optional corner grid decoration */
  cornerGrid?: CornerGridConfig
}

export function FadeInSection({ children, className, cornerGrid }: FadeInSectionProps) {
  const ref = useRef<HTMLElement>(null)
  const isInView = useInView(ref, { once: true, margin: '-100px' })

  return (
    <motion.section
      ref={ref}
      className={`relative overflow-hidden ${className || ''}`}
      initial={{ opacity: 0 }}
      animate={isInView ? { opacity: 1 } : {}}
      transition={{ duration: 0.8, ease: 'easeOut' }}
    >
      {cornerGrid && <CornerGrid position={cornerGrid.position} color={cornerGrid.color} />}
      {children}
    </motion.section>
  )
}
