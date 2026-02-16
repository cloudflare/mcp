import { motion } from 'framer-motion'
import { useMemo } from 'react'
import type { MCPServer } from './mcpServers'
import { useHeroColors } from '@/hooks/useThemeColors'
import { useTheme } from '@/components/ThemeProvider'

interface GridSquareProps {
  server: MCPServer
  position: { x: number; y: number }
  cellSize: number // Square cell size in pixels
  grayscaleAmount?: number // 0-1, where 1 = fully B&W
  // Mouse drag effect - offset direction and strength
  pushOffset?: { x: number; y: number } // Pixel offset to apply
}

// Estimate text width based on character count and font size
// Mono fonts have consistent character widths (~0.6em per char)
function estimateTextWidth(text: string, fontSize: number): number {
  const charWidth = fontSize * 0.65 // Approximate for mono uppercase with tracking
  return text.length * charWidth
}

// Reusable card content component to avoid duplication
function CardContent({
  server,
  iconBoxSize,
  iconSize,
  labelHeight,
  labelWidth,
  labelPadding,
  fontSize,
  isMonochrome = false,
  iconBoxBg = '#ffffff',
  monochromeColor = '#000000',
  labelTextColor = '#ffffff',
  serverColor // The theme-appropriate color for this server
}: {
  server: MCPServer
  iconBoxSize: number
  iconSize: number
  labelHeight: number
  labelWidth: number
  labelPadding: number
  fontSize: number
  isMonochrome?: boolean
  iconBoxBg?: string
  monochromeColor?: string
  labelTextColor?: string
  serverColor: string
}) {
  const Icon = server.icon
  // Colored cards use theme-appropriate server color, monochrome uses the monochromeColor
  const borderColor = isMonochrome ? monochromeColor : serverColor
  const iconColor = isMonochrome ? monochromeColor : serverColor
  const bgColor = isMonochrome ? monochromeColor : serverColor

  return (
    <>
      {/* Icon box - themed background with border */}
      <div
        className="flex items-center justify-center"
        style={{
          backgroundColor: iconBoxBg,
          width: iconBoxSize,
          height: iconBoxSize,
          border: `2px solid ${borderColor}`,
          color: iconColor
        }}
      >
        <Icon size={iconSize} weight="regular" color={iconColor} />
      </div>

      {/* Label bar - width snaps to grid cells based on text length */}
      <div
        className="absolute flex items-center"
        style={{
          backgroundColor: bgColor,
          height: labelHeight,
          width: labelWidth,
          left: iconBoxSize,
          top: 0,
          paddingLeft: labelPadding,
          paddingRight: labelPadding
        }}
      >
        <div className="absolute inset-0 border border-l-0 mask-l-from-0 border-white dark:border-black" />
        <span
          className="font-bold uppercase tracking-wide leading-tight whitespace-nowrap"
          style={{ fontSize, color: labelTextColor }}
        >
          {server.name}
        </span>
      </div>
    </>
  )
}

export function GridSquare({
  server,
  position,
  cellSize,
  grayscaleAmount = 0,
  pushOffset = { x: 0, y: 0 }
}: GridSquareProps) {
  const heroColors = useHeroColors()
  const { theme } = useTheme()

  // Use darkColor in dark mode if available, otherwise fall back to color
  const serverColor = theme === 'dark' && server.darkColor ? server.darkColor : server.color

  // Icon box is 2x2 cells (4 squares)
  const iconBoxSize = cellSize * 2
  const iconSize = iconBoxSize * 0.4

  const fontSize = Math.max(14, Math.min(28, cellSize * 0.7))
  const labelHeight = cellSize * 2

  // Calculate label width to fit text, snapped to grid cells
  // Padding is 0.5 cells on each side (1 cell total)
  const labelPaddingCells = 0.5
  const labelPadding = labelPaddingCells * cellSize

  const labelWidth = useMemo(() => {
    const textWidth = estimateTextWidth(server.name, fontSize)
    // Text width in cells + padding cells on each side
    const textCells = textWidth / cellSize
    const totalCells = textCells + labelPaddingCells * 2
    // Round up to nearest whole cell, minimum 2 cells
    return Math.max(2, Math.ceil(totalCells)) * cellSize
  }, [server.name, fontSize, cellSize])

  // Monochrome overlay uses white in dark mode (inverted from black in light mode)
  const contentProps = {
    server,
    iconBoxSize,
    iconSize,
    labelHeight,
    labelWidth,
    labelPadding,
    fontSize,
    iconBoxBg: heroColors.iconBoxBg,
    monochromeColor: heroColors.monochromeColor,
    labelTextColor: heroColors.labelText,
    serverColor // Theme-appropriate color for this server
  }

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{
        opacity: 1,
        scale: 1,
        x: pushOffset.x,
        y: pushOffset.y
      }}
      exit={{ opacity: 0, scale: 0.9 }}
      whileHover={{ scale: 1.02 }}
      transition={{
        // Default transition for opacity/scale
        duration: 0.4,
        ease: 'easeOut',
        // Smooth spring for position drag effect
        x: { type: 'spring', stiffness: 150, damping: 15, mass: 0.5 },
        y: { type: 'spring', stiffness: 150, damping: 15, mass: 0.5 }
      }}
      className="absolute pointer-events-auto cursor-default"
      style={{
        left: position.x,
        top: position.y
      }}
    >
      {/* Colored version (base layer) */}
      <div className="relative">
        <CardContent {...contentProps} isMonochrome={false} />
      </div>

      {/* Black & white version (overlay - fades in on proximity) */}
      <motion.div
        className="absolute inset-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: grayscaleAmount }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        style={{ pointerEvents: 'none' }}
      >
        <CardContent {...contentProps} isMonochrome={true} />
      </motion.div>
    </motion.div>
  )
}
