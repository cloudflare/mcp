import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { AnimatePresence } from 'framer-motion'
import { GridSquare } from './GridSquare'
import { MCP_SERVERS, type MCPServer } from './mcpServers'
import { useGlowColorsOptional, type CardInfo } from './GlowColorContext'
import { CARD_HEIGHT_CELLS, getCardCellsWide, getCardDimensions } from './cardLayout'

// Responsive breakpoints (px)
const BREAKPOINT_SM = 480
const BREAKPOINT_MD = 768

// Card counts per breakpoint: [initial, minimum]
const CARD_COUNTS_SM = { initial: 2, minimum: 1 }
const CARD_COUNTS_MD = { initial: 4, minimum: 2 }
const CARD_COUNTS_LG = { initial: 6, minimum: 3 }

// Card scale per breakpoint
const CARD_SCALE_SM = 0.45
const CARD_SCALE_MD = 0.65
const CARD_SCALE_LG = 1

// Grid placement constraints
const EDGE_MARGIN_CELLS = 2
const CARD_GAP_CELLS = 1
const MAX_PLACEMENT_ATTEMPTS = 100

// Card cycling interval (ms)
const CYCLE_INTERVAL_MS = 5000

interface ActiveCard {
  id: string
  server: MCPServer
  position: { x: number; y: number }
  gridCell: { x: number; y: number }
  cellsWide: number
}

interface GridSquaresProps {
  gridDensity: number
  canvasWidth: number
  canvasHeight: number
  desatEnabled?: boolean
  desatRadius?: number
  desatCutoff?: number
  desatStyle?: 'smooth' | 'sharp'
  desatTrailPersist?: number
  pushStrength?: number
  pushRadius?: number
}

function getCardCountsForWidth(width: number): { initial: number; minimum: number } {
  if (width < BREAKPOINT_SM) return CARD_COUNTS_SM
  if (width < BREAKPOINT_MD) return CARD_COUNTS_MD
  return CARD_COUNTS_LG
}

function getCardScaleForWidth(width: number): number {
  if (width < BREAKPOINT_SM) return CARD_SCALE_SM
  if (width < BREAKPOINT_MD) return CARD_SCALE_MD
  return CARD_SCALE_LG
}

/** Calculate the center position of a card in pixel coordinates. */
function getCardCenter(
  card: ActiveCard,
  cellSize: number
): { x: number; y: number } {
  const dims = getCardDimensions(card.server, cellSize)
  return {
    x: card.position.x + dims.totalWidth / 2,
    y: card.position.y + dims.totalHeight / 2
  }
}

export function GridSquares({
  gridDensity,
  canvasWidth,
  canvasHeight,
  desatEnabled = true,
  desatRadius = 150,
  desatCutoff = 50,
  desatStyle = 'smooth',
  desatTrailPersist = 0.5,
  pushStrength = 15,
  pushRadius = 200
}: GridSquaresProps) {
  const [activeCards, setActiveCards] = useState<ActiveCard[]>([])
  const glowContext = useGlowColorsOptional()
  const lastReportedRef = useRef<string>('')

  // Trail persistence animation state
  const cardLastNearRef = useRef<Map<string, number>>(new Map())
  const [, forceUpdate] = useState(0)
  const animatingRef = useRef(false)

  // Calculate grid dimensions based on aspect ratio
  const gridDimensions = useMemo(() => {
    if (canvasWidth === 0 || canvasHeight === 0) {
      return { gridWidth: 0, gridHeight: 0, cellSize: 0, cellWidth: 0, cellHeight: 0 }
    }

    const aspect = canvasWidth / canvasHeight
    const gridWidth = aspect >= 1 ? Math.round(gridDensity * aspect) : gridDensity
    const gridHeight = aspect >= 1 ? gridDensity : Math.round(gridDensity / aspect)
    const cellWidth = canvasWidth / gridWidth
    const cellHeight = canvasHeight / gridHeight
    const cellSize = Math.min(cellWidth, cellHeight)

    return { gridWidth, gridHeight, cellSize, cellWidth, cellHeight }
  }, [gridDensity, canvasWidth, canvasHeight])

  // Exclusion zone: center area where 3D text is rendered
  const exclusionZone = useMemo(
    () => ({
      left: canvasWidth * 0.2,
      right: canvasWidth * 0.8,
      top: canvasHeight * 0.25,
      bottom: canvasHeight * 0.75
    }),
    [canvasWidth, canvasHeight]
  )

  // Check if a grid position is valid (no overlaps with exclusion zone or existing cards)
  const isValidPosition = useCallback(
    (cellX: number, cellY: number, cardCellsWide: number, existingCards: ActiveCard[]): boolean => {
      const { cellWidth, cellHeight, gridWidth, gridHeight } = gridDimensions

      // Check canvas bounds with edge margin
      if (
        cellX < EDGE_MARGIN_CELLS ||
        cellY < EDGE_MARGIN_CELLS ||
        cellX + cardCellsWide > gridWidth - EDGE_MARGIN_CELLS ||
        cellY + CARD_HEIGHT_CELLS > gridHeight - EDGE_MARGIN_CELLS
      ) {
        return false
      }

      // Check exclusion zone overlap (in pixel space)
      const x = cellX * cellWidth
      const y = cellY * cellHeight
      const cardRight = x + cardCellsWide * cellWidth
      const cardBottom = y + CARD_HEIGHT_CELLS * cellHeight

      const overlapsExclusion =
        x < exclusionZone.right &&
        cardRight > exclusionZone.left &&
        y < exclusionZone.bottom &&
        cardBottom > exclusionZone.top

      if (overlapsExclusion) {
        return false
      }

      // Check overlap with existing cards (with gap)
      for (const card of existingCards) {
        const overlaps =
          cellX < card.gridCell.x + card.cellsWide + CARD_GAP_CELLS &&
          cellX + cardCellsWide + CARD_GAP_CELLS > card.gridCell.x &&
          cellY < card.gridCell.y + CARD_HEIGHT_CELLS + CARD_GAP_CELLS &&
          cellY + CARD_HEIGHT_CELLS + CARD_GAP_CELLS > card.gridCell.y

        if (overlaps) {
          return false
        }
      }

      return true
    },
    [gridDimensions, exclusionZone]
  )

  // Generate a random card at a valid position
  const generateRandomCard = useCallback(
    (existingCards: ActiveCard[]): ActiveCard | null => {
      const { gridWidth, gridHeight, cellWidth, cellHeight, cellSize } = gridDimensions

      if (gridWidth === 0 || gridHeight === 0) return null

      const usedServerIds = new Set(existingCards.map((c) => c.server.id))
      const availableServers = MCP_SERVERS.filter((s) => !usedServerIds.has(s.id))

      if (availableServers.length === 0) return null

      const shuffledServers = [...availableServers].sort(() => Math.random() - 0.5)

      for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt++) {
        const server = shuffledServers[attempt % shuffledServers.length]
        const cardCellsWide = getCardCellsWide(server, cellSize)

        const cellX = Math.floor(Math.random() * (gridWidth - cardCellsWide + 1))
        const cellY = Math.floor(Math.random() * (gridHeight - CARD_HEIGHT_CELLS + 1))

        if (isValidPosition(cellX, cellY, cardCellsWide, existingCards)) {
          return {
            id: `${server.id}-${Date.now()}-${Math.random()}`,
            server,
            position: { x: cellX * cellWidth, y: cellY * cellHeight },
            gridCell: { x: cellX, y: cellY },
            cellsWide: cardCellsWide
          }
        }
      }

      return null
    },
    [gridDimensions, isValidPosition]
  )

  // Initialize cards
  useEffect(() => {
    if (canvasWidth === 0 || canvasHeight === 0) return

    const initialCards: ActiveCard[] = []
    const { initial: targetCount } = getCardCountsForWidth(canvasWidth)

    for (let i = 0; i < targetCount; i++) {
      const card = generateRandomCard(initialCards)
      if (card) {
        initialCards.push(card)
      }
    }

    setActiveCards(initialCards)
  }, [canvasWidth, canvasHeight, generateRandomCard])

  // Cycle cards periodically
  useEffect(() => {
    if (canvasWidth === 0 || canvasHeight === 0) return

    const interval = setInterval(() => {
      setActiveCards((prev) => {
        if (prev.length === 0) return prev

        // Remove a random card and add a new one
        const removeIndex = Math.floor(Math.random() * prev.length)
        const newCards = prev.filter((_, i) => i !== removeIndex)

        const newCard = generateRandomCard(newCards)
        if (newCard) {
          newCards.push(newCard)
        }

        // Add an extra card if below minimum
        const { minimum: minCards } = getCardCountsForWidth(canvasWidth)
        if (newCards.length < minCards) {
          const extraCard = generateRandomCard(newCards)
          if (extraCard) {
            newCards.push(extraCard)
          }
        }

        return newCards
      })
    }, CYCLE_INTERVAL_MS)

    return () => clearInterval(interval)
  }, [canvasWidth, canvasHeight, generateRandomCard])

  // Report card changes to glow context
  useEffect(() => {
    if (!glowContext || canvasWidth === 0 || canvasHeight === 0) return

    const fingerprint = activeCards.map((c) => `${c.id}:${c.position.x}:${c.position.y}`).join('|')
    if (fingerprint === lastReportedRef.current) return
    lastReportedRef.current = fingerprint

    const cardInfos: CardInfo[] = activeCards.map((card) => {
      const dims = getCardDimensions(card.server, gridDimensions.cellSize)
      return {
        id: card.id,
        x: card.position.x,
        y: card.position.y,
        width: dims.totalWidth,
        height: dims.totalHeight,
        color: card.server.color
      }
    })

    glowContext.updateCards(cardInfos, canvasWidth, canvasHeight)
  }, [activeCards, canvasWidth, canvasHeight, glowContext, gridDimensions.cellSize])

  const mousePosition = glowContext?.mousePosition ?? { x: -9999, y: -9999 }

  // Calculate grayscale amount for a card based on mouse proximity
  const getGrayscaleAmount = useCallback(
    (cardId: string, cardCenterX: number, cardCenterY: number): number => {
      if (!desatEnabled) return 0

      const dx = mousePosition.x - cardCenterX
      const dy = mousePosition.y - cardCenterY
      const distance = Math.sqrt(dx * dx + dy * dy)
      const currentTime = performance.now()

      let instantGrayscale: number
      if (desatStyle === 'sharp') {
        instantGrayscale = distance < desatRadius ? 1 : 0
      } else {
        const innerRadius = Math.max(0, desatRadius - desatCutoff)
        if (distance >= desatRadius) {
          instantGrayscale = 0
        } else if (distance <= innerRadius) {
          instantGrayscale = 1
        } else {
          instantGrayscale = 1 - (distance - innerRadius) / (desatRadius - innerRadius)
        }
      }

      // Trail persistence: update last-near timestamp when actively affected
      if (instantGrayscale > 0.5) {
        cardLastNearRef.current.set(cardId, currentTime)
      }

      const lastNear = cardLastNearRef.current.get(cardId) || 0
      const timeSinceNear = (currentTime - lastNear) / 1000

      if (desatTrailPersist > 0 && timeSinceNear < desatTrailPersist) {
        const trailGrayscale = 1 - timeSinceNear / desatTrailPersist
        return Math.max(instantGrayscale, trailGrayscale)
      }

      return instantGrayscale
    },
    [mousePosition, desatEnabled, desatRadius, desatCutoff, desatStyle, desatTrailPersist]
  )

  // Calculate push offset (icons are repelled away from mouse)
  const getPushOffset = useCallback(
    (cardCenterX: number, cardCenterY: number): { x: number; y: number } => {
      if (!desatEnabled || pushStrength === 0) return { x: 0, y: 0 }

      const dx = cardCenterX - mousePosition.x
      const dy = cardCenterY - mousePosition.y
      const distance = Math.sqrt(dx * dx + dy * dy)

      if (distance >= pushRadius || distance < 1) return { x: 0, y: 0 }

      const normalizedX = dx / distance
      const normalizedY = dy / distance
      const falloff = 1 - distance / pushRadius
      const strength = pushStrength * falloff * falloff

      return {
        x: normalizedX * strength,
        y: normalizedY * strength
      }
    },
    [mousePosition, desatEnabled, pushRadius, pushStrength]
  )

  // Animation loop for trail persistence
  useEffect(() => {
    if (!desatEnabled || desatTrailPersist === 0) return

    const animate = () => {
      const now = performance.now()
      let stillAnimating = false

      cardLastNearRef.current.forEach((lastNear) => {
        if ((now - lastNear) / 1000 < desatTrailPersist) {
          stillAnimating = true
        }
      })

      if (stillAnimating) {
        forceUpdate((n) => n + 1)
        animatingRef.current = true
        requestAnimationFrame(animate)
      } else {
        animatingRef.current = false
      }
    }

    if (!animatingRef.current && cardLastNearRef.current.size > 0) {
      requestAnimationFrame(animate)
    }
  }, [desatEnabled, desatTrailPersist])

  const cardScale = getCardScaleForWidth(canvasWidth)

  if (canvasWidth === 0 || canvasHeight === 0 || gridDimensions.cellSize === 0) {
    return null
  }

  return (
    <div
      className="absolute inset-0 pointer-events-none overflow-hidden text-white"
      style={{ width: canvasWidth, height: canvasHeight }}
    >
      <AnimatePresence mode="popLayout">
        {activeCards.map((card) => {
          const center = getCardCenter(card, gridDimensions.cellSize)

          return (
            <GridSquare
              key={card.id}
              server={card.server}
              position={card.position}
              cellSize={gridDimensions.cellSize}
              cardScale={cardScale}
              grayscaleAmount={getGrayscaleAmount(card.id, center.x, center.y)}
              pushOffset={getPushOffset(center.x, center.y)}
            />
          )
        })}
      </AnimatePresence>
    </div>
  )
}
