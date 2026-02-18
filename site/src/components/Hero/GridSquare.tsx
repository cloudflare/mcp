import { motion } from 'framer-motion'
import type { MCPServer } from './mcpServers'
import {
  ICON_BOX_CELLS,
  LABEL_PADDING_CELLS,
  getLabelFontSize,
  getLabelWidth
} from './cardLayout'
import { useHeroColors } from '@/hooks/useThemeColors'
import { useTheme } from '@/components/ThemeProvider'

// Icon size relative to the icon box
const ICON_SCALE = 0.4

// Spring config for the mouse-push drag effect
const PUSH_SPRING = { type: 'spring' as const, stiffness: 150, damping: 15, mass: 0.5 }

interface GridSquareProps {
  server: MCPServer
  position: { x: number; y: number }
  cellSize: number
  cardScale?: number
  grayscaleAmount?: number
  pushOffset?: { x: number; y: number }
}

interface CardContentProps {
  server: MCPServer
  iconBoxSize: number
  iconSize: number
  labelWidth: number
  labelPadding: number
  fontSize: number
  iconBoxBg: string
  labelTextColor: string
  accentColor: string
}

function CardContent({
  server,
  iconBoxSize,
  iconSize,
  labelWidth,
  labelPadding,
  fontSize,
  iconBoxBg,
  labelTextColor,
  accentColor
}: CardContentProps) {
  const Icon = server.icon

  return (
    <>
      <div
        className="flex items-center justify-center"
        style={{
          backgroundColor: iconBoxBg,
          width: iconBoxSize,
          height: iconBoxSize,
          border: `2px solid ${accentColor}`,
          color: accentColor
        }}
      >
        <Icon size={iconSize} weight="regular" color={accentColor} />
      </div>

      <div
        className="absolute flex items-center"
        style={{
          backgroundColor: accentColor,
          height: iconBoxSize,
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
  cardScale = 1,
  grayscaleAmount = 0,
  pushOffset = { x: 0, y: 0 }
}: GridSquareProps) {
  const heroColors = useHeroColors()
  const { theme } = useTheme()

  const serverColor = theme === 'dark' && server.darkColor ? server.darkColor : server.color

  const iconBoxSize = cellSize * ICON_BOX_CELLS
  const iconSize = iconBoxSize * ICON_SCALE
  const fontSize = getLabelFontSize(cellSize)
  const labelPadding = LABEL_PADDING_CELLS * cellSize
  const labelWidth = getLabelWidth(server.name, cellSize)

  const sharedProps = {
    server,
    iconBoxSize,
    iconSize,
    labelWidth,
    labelPadding,
    fontSize,
    iconBoxBg: heroColors.iconBoxBg,
    labelTextColor: heroColors.labelText
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
        duration: 0.4,
        ease: 'easeOut',
        x: PUSH_SPRING,
        y: PUSH_SPRING
      }}
      className="absolute pointer-events-auto cursor-default"
      style={{
        left: position.x,
        top: position.y,
        transformOrigin: 'top left',
        scale: cardScale
      }}
    >
      {/* Colored version (base layer) */}
      <div className="relative">
        <CardContent {...sharedProps} accentColor={serverColor} />
      </div>

      {/* Monochrome overlay (fades in on mouse proximity) */}
      <motion.div
        className="absolute inset-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: grayscaleAmount }}
        transition={{ duration: 0.15, ease: 'easeOut' }}
        style={{ pointerEvents: 'none' }}
      >
        <CardContent {...sharedProps} accentColor={heroColors.monochromeColor} />
      </motion.div>
    </motion.div>
  )
}
