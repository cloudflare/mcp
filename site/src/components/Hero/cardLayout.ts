import type { MCPServer } from './mcpServers'

// Grid card layout constants
export const ICON_BOX_CELLS = 2 // Icon box is 2x2 grid cells
export const CARD_HEIGHT_CELLS = 2 // Cards are always 2 cells tall
export const LABEL_PADDING_CELLS = 0.5 // Padding on each side of the label text

// Font size range for card labels
const MIN_FONT_SIZE = 14
const MAX_FONT_SIZE = 28
const FONT_SIZE_SCALE = 0.7

// Minimum label width in cells
const MIN_LABEL_CELLS = 2

// Shared offscreen canvas for text measurement
let measureCanvas: HTMLCanvasElement | null = null
let measureCtx: CanvasRenderingContext2D | null = null

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  if (!measureCanvas) {
    measureCanvas = document.createElement('canvas')
    measureCtx = measureCanvas.getContext('2d')
  }
  return measureCtx
}

/**
 * Compute the label font size for a given cell size, clamped to a reasonable range.
 */
export function getLabelFontSize(cellSize: number): number {
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, cellSize * FONT_SIZE_SCALE))
}

// Cache measured widths per text+fontSize combo
const widthCache = new Map<string, number>()

/**
 * Measure text width using canvas, matching the CSS: font-bold uppercase tracking-wide.
 * tracking-wide = letter-spacing: 0.025em
 */
export function measureTextWidth(text: string, fontSize: number): number {
  const upper = text.toUpperCase()
  const key = `${upper}:${fontSize}`
  const cached = widthCache.get(key)
  if (cached !== undefined) return cached

  const ctx = getMeasureCtx()
  if (!ctx) {
    // SSR fallback: estimate
    const width = upper.length * fontSize * 0.65
    widthCache.set(key, width)
    return width
  }

  // Match CSS: font-bold = 700, font-family stack from the site
  ctx.font = `700 ${fontSize}px "Kunst Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
  const baseWidth = ctx.measureText(upper).width
  // Add letter-spacing: tracking-wide = 0.025em per character gap
  const letterSpacing = fontSize * 0.025 * (upper.length - 1)
  const width = baseWidth + letterSpacing

  widthCache.set(key, width)
  return width
}

/**
 * Calculate the label width in pixels, snapped to whole grid cells.
 */
export function getLabelWidth(serverName: string, cellSize: number): number {
  const fontSize = getLabelFontSize(cellSize)
  const textWidth = measureTextWidth(serverName, fontSize)
  const textCells = textWidth / cellSize
  const totalCells = textCells + LABEL_PADDING_CELLS * 2
  return Math.max(MIN_LABEL_CELLS, Math.ceil(totalCells)) * cellSize
}

/**
 * Calculate the total width of a card in grid cells (icon box + label).
 */
export function getCardCellsWide(server: MCPServer, cellSize: number): number {
  const fontSize = getLabelFontSize(cellSize)
  const textWidth = measureTextWidth(server.name, fontSize)
  const textCells = textWidth / cellSize
  const totalLabelCells = textCells + LABEL_PADDING_CELLS * 2
  const labelCells = Math.max(MIN_LABEL_CELLS, Math.ceil(totalLabelCells))
  return ICON_BOX_CELLS + labelCells
}

/**
 * Calculate the full pixel dimensions of a card.
 */
export function getCardDimensions(server: MCPServer, cellSize: number): {
  iconBoxSize: number
  labelWidth: number
  totalWidth: number
  totalHeight: number
} {
  const iconBoxSize = cellSize * ICON_BOX_CELLS
  const labelWidth = getLabelWidth(server.name, cellSize)
  return {
    iconBoxSize,
    labelWidth,
    totalWidth: iconBoxSize + labelWidth,
    totalHeight: iconBoxSize
  }
}
