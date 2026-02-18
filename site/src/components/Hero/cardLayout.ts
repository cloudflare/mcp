import type { MCPServer } from './mcpServers'

// Grid card layout constants
export const ICON_BOX_CELLS = 2 // Icon box is 2x2 grid cells
export const CARD_HEIGHT_CELLS = 2 // Cards are always 2 cells tall
export const LABEL_PADDING_CELLS = 0.5 // Padding on each side of the label text

// Font size range for card labels
const MIN_FONT_SIZE = 14
const MAX_FONT_SIZE = 28
const FONT_SIZE_SCALE = 0.7

// Approximate character width ratio for mono uppercase with tracking
const CHAR_WIDTH_RATIO = 0.65

// Minimum label width in cells
const MIN_LABEL_CELLS = 2

/**
 * Compute the label font size for a given cell size, clamped to a reasonable range.
 */
export function getLabelFontSize(cellSize: number): number {
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, cellSize * FONT_SIZE_SCALE))
}

/**
 * Estimate text width in pixels based on character count and font size.
 * Mono fonts have consistent character widths (~0.65em per char).
 */
export function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * CHAR_WIDTH_RATIO
}

/**
 * Calculate the label width in pixels, snapped to whole grid cells.
 */
export function getLabelWidth(serverName: string, cellSize: number): number {
  const fontSize = getLabelFontSize(cellSize)
  const textWidth = estimateTextWidth(serverName, fontSize)
  const textCells = textWidth / cellSize
  const totalCells = textCells + LABEL_PADDING_CELLS * 2
  return Math.max(MIN_LABEL_CELLS, Math.ceil(totalCells)) * cellSize
}

/**
 * Calculate the total width of a card in grid cells (icon box + label).
 */
export function getCardCellsWide(server: MCPServer, cellSize: number): number {
  const fontSize = getLabelFontSize(cellSize)
  const textWidth = estimateTextWidth(server.name, fontSize)
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
