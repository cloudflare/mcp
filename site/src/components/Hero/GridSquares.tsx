import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { AnimatePresence } from 'framer-motion'
import { GridSquare } from './GridSquare'
import { MCP_SERVERS, type MCPServer } from './mcpServers'
import { useGlowColorsOptional, type CardInfo } from './GlowColorContext'

// Estimate text width based on character count and font size
// Must match the calculation in GridSquare
function estimateTextWidth(text: string, fontSize: number): number {
  const charWidth = fontSize * 0.65
  return text.length * charWidth
}

// Calculate how many cells wide a card will be for a given server
// Must match the calculation in GridSquare
function getCardCellsWide(server: MCPServer, cellSize: number): number {
  const fontSize = Math.max(14, Math.min(28, cellSize * 0.7))
  const labelPaddingCells = 0.5 // 0.5 cells padding on each side
  const textWidth = estimateTextWidth(server.name, fontSize)
  const textCells = textWidth / cellSize
  const totalLabelCells = textCells + labelPaddingCells * 2
  const labelCells = Math.max(2, Math.ceil(totalLabelCells))
  // Icon box is 2 cells + label cells
  return 2 + labelCells
}

interface ActiveCard {
  id: string
  server: MCPServer
  position: { x: number; y: number }
  gridCell: { x: number; y: number }
  cellsWide: number // Store the width for collision detection
}

interface GridSquaresProps {
  gridDensity: number
  canvasWidth: number
  canvasHeight: number
  // Icon desaturation props
  desatEnabled?: boolean
  desatRadius?: number
  desatCutoff?: number
  desatStyle?: 'smooth' | 'sharp'
  desatTrailPersist?: number
  // Drag effect - icons pulled toward mouse
  pushStrength?: number
  pushRadius?: number
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

  // For trail persistence animation
  const cardLastNearRef = useRef<Map<string, number>>(new Map())
  const [, forceUpdate] = useState(0)
  const animatingRef = useRef(false)

  // Calculate grid dimensions based on aspect ratio
  // Grid cells should be square, matching the shader calculation
  const gridDimensions = useMemo(() => {
    if (canvasWidth === 0 || canvasHeight === 0) {
      return {
        gridWidth: 0,
        gridHeight: 0,
        cellSize: 0,
        cellWidth: 0,
        cellHeight: 0
      }
    }

    const aspect = canvasWidth / canvasHeight
    const gridWidth = aspect >= 1 ? Math.round(gridDensity * aspect) : gridDensity
    const gridHeight = aspect >= 1 ? gridDensity : Math.round(gridDensity / aspect)

    // Calculate cell dimensions (they may not be perfectly square due to aspect ratio rounding)
    const cellWidth = canvasWidth / gridWidth
    const cellHeight = canvasHeight / gridHeight
    // Use the smaller dimension for square cards
    const cellSize = Math.min(cellWidth, cellHeight)

    return { gridWidth, gridHeight, cellSize, cellWidth, cellHeight }
  }, [gridDensity, canvasWidth, canvasHeight])

  // Define exclusion zone (center area where 3D text is)
  // Wider horizontally since text is wide, narrower vertically
  const exclusionZone = useMemo(() => {
    return {
      left: canvasWidth * 0.2,
      right: canvasWidth * 0.8,
      top: canvasHeight * 0.25,
      bottom: canvasHeight * 0.75
    }
  }, [canvasWidth, canvasHeight])

  // Check if a position overlaps with exclusion zone or existing cards
  // Cards have variable width based on text, but are always 2 cells tall
  const isValidPosition = useCallback(
    (cellX: number, cellY: number, cardCellsWide: number, existingCards: ActiveCard[]): boolean => {
      const { cellWidth, cellHeight, gridWidth, gridHeight } = gridDimensions

      const cardCellsTall = 2
      const edgeMargin = 2 // Must be at least 2 cells from any edge

      // Calculate pixel position
      const x = cellX * cellWidth
      const y = cellY * cellHeight
      const cardWidth = cardCellsWide * cellWidth
      const cardHeight = cardCellsTall * cellHeight

      // Check canvas bounds with margin (ensure card is 2 cells from edges)
      if (
        cellX < edgeMargin ||
        cellY < edgeMargin ||
        cellX + cardCellsWide > gridWidth - edgeMargin ||
        cellY + cardCellsTall > gridHeight - edgeMargin
      ) {
        return false
      }

      // Check exclusion zone overlap
      const cardRight = x + cardWidth
      const cardBottom = y + cardHeight
      const overlapsExclusion =
        x < exclusionZone.right &&
        cardRight > exclusionZone.left &&
        y < exclusionZone.bottom &&
        cardBottom > exclusionZone.top

      if (overlapsExclusion) {
        return false
      }

      // Check overlap with existing cards (each has its own width)
      // Must be at least 1 cell gap between cards
      const cardGap = 1
      for (const card of existingCards) {
        const existingX = card.gridCell.x
        const existingY = card.gridCell.y
        const existingWidth = card.cellsWide

        // Check if grid cells overlap (including 1 cell gap)
        const overlaps =
          cellX < existingX + existingWidth + cardGap &&
          cellX + cardCellsWide + cardGap > existingX &&
          cellY < existingY + cardCellsTall + cardGap &&
          cellY + cardCellsTall + cardGap > existingY

        if (overlaps) {
          return false
        }
      }

      return true
    },
    [gridDimensions, exclusionZone]
  )

  // Generate a random card position
  const generateRandomCard = useCallback(
    (existingCards: ActiveCard[]): ActiveCard | null => {
      const { gridWidth, gridHeight, cellWidth, cellHeight, cellSize } = gridDimensions

      if (gridWidth === 0 || gridHeight === 0) return null

      const cardCellsTall = 2

      // Get unused servers
      const usedServerIds = new Set(existingCards.map((c) => c.server.id))
      const availableServers = MCP_SERVERS.filter((s) => !usedServerIds.has(s.id))

      if (availableServers.length === 0) {
        return null
      }

      // Shuffle available servers to try different ones
      const shuffledServers = [...availableServers].sort(() => Math.random() - 0.5)

      // Try to find a valid position (max attempts to avoid infinite loop)
      const maxAttempts = 100
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // Pick a server to try
        const server = shuffledServers[attempt % shuffledServers.length]
        const cardCellsWide = getCardCellsWide(server, cellSize)

        // Random grid cell (ensure room for this card's width)
        const cellX = Math.floor(Math.random() * (gridWidth - cardCellsWide + 1))
        const cellY = Math.floor(Math.random() * (gridHeight - cardCellsTall + 1))

        if (isValidPosition(cellX, cellY, cardCellsWide, existingCards)) {
          return {
            id: `${server.id}-${Date.now()}-${Math.random()}`,
            server,
            position: {
              x: cellX * cellWidth,
              y: cellY * cellHeight
            },
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
    // Fewer cards on small screens to avoid crowding
    const targetCount = canvasWidth < 640 ? 3 : 6

    for (let i = 0; i < targetCount; i++) {
      const card = generateRandomCard(initialCards)
      if (card) {
        initialCards.push(card)
      }
    }

    setActiveCards(initialCards)
  }, [canvasWidth, canvasHeight, generateRandomCard])

  // Cycle cards every 5 seconds
  useEffect(() => {
    if (canvasWidth === 0 || canvasHeight === 0) return

    const interval = setInterval(() => {
      setActiveCards((prev) => {
        if (prev.length === 0) return prev

        // Remove a random card
        const removeIndex = Math.floor(Math.random() * prev.length)
        const newCards = prev.filter((_, i) => i !== removeIndex)

        // Add a new card
        const newCard = generateRandomCard(newCards)
        if (newCard) {
          newCards.push(newCard)
        }

        // Occasionally add an extra card if below target
        const minCards = canvasWidth < 640 ? 2 : 3
        if (newCards.length < minCards) {
          const extraCard = generateRandomCard(newCards)
          if (extraCard) {
            newCards.push(extraCard)
          }
        }

        return newCards
      })
    }, 5000)

    return () => clearInterval(interval)
  }, [canvasWidth, canvasHeight, generateRandomCard])

  // Report card changes to glow context
  useEffect(() => {
    if (!glowContext || canvasWidth === 0 || canvasHeight === 0) return

    // Create a fingerprint to avoid unnecessary updates
    const fingerprint = activeCards.map((c) => `${c.id}:${c.position.x}:${c.position.y}`).join('|')
    if (fingerprint === lastReportedRef.current) return
    lastReportedRef.current = fingerprint

    // Convert active cards to CardInfo format
    const cardInfos: CardInfo[] = activeCards.map((card) => {
      const iconBoxSize = gridDimensions.cellSize * 2
      const fontSize = Math.max(14, Math.min(28, gridDimensions.cellSize * 0.7))
      const labelPaddingCells = 0.5
      const textWidth = estimateTextWidth(card.server.name, fontSize)
      const textCells = textWidth / gridDimensions.cellSize
      const totalCells = textCells + labelPaddingCells * 2
      const labelWidth = Math.max(2, Math.ceil(totalCells)) * gridDimensions.cellSize

      return {
        id: card.id,
        x: card.position.x,
        y: card.position.y,
        width: iconBoxSize + labelWidth,
        height: iconBoxSize,
        color: card.server.color
      }
    })

    glowContext.updateCards(cardInfos, canvasWidth, canvasHeight)
  }, [activeCards, canvasWidth, canvasHeight, glowContext, gridDimensions.cellSize])

  // Get mouse position from context
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
        // Smooth gradient
        const innerRadius = Math.max(0, desatRadius - desatCutoff)
        if (distance >= desatRadius) {
          instantGrayscale = 0
        } else if (distance <= innerRadius) {
          instantGrayscale = 1
        } else {
          instantGrayscale = 1 - (distance - innerRadius) / (desatRadius - innerRadius)
        }
      }

      // Trail persistence: if currently affected, update last near time
      if (instantGrayscale > 0.5) {
        cardLastNearRef.current.set(cardId, currentTime)
      }

      // Check if we should still be grayscale due to trail
      const lastNear = cardLastNearRef.current.get(cardId) || 0
      const timeSinceNear = (currentTime - lastNear) / 1000 // Convert to seconds

      if (desatTrailPersist > 0 && timeSinceNear < desatTrailPersist) {
        // Fade out over the persist duration
        const trailGrayscale = 1 - timeSinceNear / desatTrailPersist
        return Math.max(instantGrayscale, trailGrayscale)
      }

      return instantGrayscale
    },
    [mousePosition, desatEnabled, desatRadius, desatCutoff, desatStyle, desatTrailPersist]
  )

  // Calculate push offset - icons are pushed AWAY from mouse (repelled by x-ray)
  const getPushOffset = useCallback(
    (cardCenterX: number, cardCenterY: number): { x: number; y: number } => {
      if (!desatEnabled || pushStrength === 0) return { x: 0, y: 0 }

      // Direction FROM mouse TO card (push away from mouse)
      const dx = cardCenterX - mousePosition.x
      const dy = cardCenterY - mousePosition.y
      const distance = Math.sqrt(dx * dx + dy * dy)

      // No push if mouse is far away (uses its own radius)
      if (distance >= pushRadius || distance < 1) return { x: 0, y: 0 }

      // Normalize direction (away from mouse)
      const normalizedX = dx / distance
      const normalizedY = dy / distance

      // Push strength falls off with distance (stronger when closer)
      const falloff = 1 - distance / pushRadius
      const strength = pushStrength * falloff * falloff // Quadratic falloff for snappy feel

      return {
        x: normalizedX * strength,
        y: normalizedY * strength
      }
    },
    [mousePosition, desatEnabled, pushRadius, pushStrength]
  )

  // Animation loop for trail persistence - re-render while cards are fading
  useEffect(() => {
    if (!desatEnabled || desatTrailPersist === 0) return

    const animate = () => {
      const now = performance.now()
      let stillAnimating = false

      // Check if any card is still fading
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

    // Start animation if we have cards that were recently near mouse
    if (!animatingRef.current && cardLastNearRef.current.size > 0) {
      requestAnimationFrame(animate)
    }
  }, [desatEnabled, desatTrailPersist])

  // Don't render until we have dimensions
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
          // Calculate card center for grayscale calculation
          const iconBoxSize = gridDimensions.cellSize * 2
          const fontSize = Math.max(14, Math.min(28, gridDimensions.cellSize * 0.7))
          const labelPaddingCells = 0.5
          const textWidth = estimateTextWidth(card.server.name, fontSize)
          const textCells = textWidth / gridDimensions.cellSize
          const totalCells = textCells + labelPaddingCells * 2
          const labelWidth = Math.max(2, Math.ceil(totalCells)) * gridDimensions.cellSize
          const cardWidth = iconBoxSize + labelWidth
          const cardHeight = iconBoxSize
          const cardCenterX = card.position.x + cardWidth / 2
          const cardCenterY = card.position.y + cardHeight / 2

          return (
            <GridSquare
              key={card.id}
              server={card.server}
              position={card.position}
              cellSize={gridDimensions.cellSize}
              grayscaleAmount={getGrayscaleAmount(card.id, cardCenterX, cardCenterY)}
              pushOffset={getPushOffset(cardCenterX, cardCenterY)}
            />
          )
        })}
      </AnimatePresence>
    </div>
  )
}
