import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'
import * as THREE from 'three'

// Represents a single glow source from an icon
export interface GlowSource {
  id: string
  // Position in normalized screen space (-1 to 1, matching Three.js NDC)
  position: THREE.Vector2
  // The icon's color
  color: THREE.Color
  // Current intensity (0-1), used for fade in/out animation
  intensity: number
  // Target intensity (1 when visible, 0 when removed)
  targetIntensity: number
}

// Data passed from GridSquares about active cards
export interface CardInfo {
  id: string
  // Position in pixels from top-left
  x: number
  y: number
  // Card dimensions for center calculation
  width: number
  height: number
  // Hex color string
  color: string
}

interface GlowColorContextType {
  // Current glow sources with animated intensities
  glowSources: GlowSource[]
  // Called by GridSquares to update card info
  updateCards: (cards: CardInfo[], canvasWidth: number, canvasHeight: number) => void
  // Canvas dimensions for coordinate conversion
  canvasDimensions: { width: number; height: number }
  setCanvasDimensions: (width: number, height: number) => void
  // Mouse position in pixel coordinates (for icon desaturation effect)
  mousePosition: { x: number; y: number }
  setMousePosition: (x: number, y: number) => void
}

const GlowColorContext = createContext<GlowColorContextType | null>(null)

export function useGlowColors() {
  const context = useContext(GlowColorContext)
  if (!context) {
    throw new Error('useGlowColors must be used within a GlowColorProvider')
  }
  return context
}

// Optional hook that doesn't throw if context is missing
export function useGlowColorsOptional() {
  return useContext(GlowColorContext)
}

interface GlowColorProviderProps {
  children: React.ReactNode
}

// Animation settings - slower for smoother transitions
const FADE_IN_DURATION = 1500 // ms - gentle fade in
const FADE_OUT_DURATION = 3000 // ms - slow fade out so colors linger

export function GlowColorProvider({ children }: GlowColorProviderProps) {
  const [glowSources, setGlowSources] = useState<GlowSource[]>([])
  const [canvasDimensions, setCanvasDimensionsState] = useState({
    width: 0,
    height: 0
  })
  // Mouse position in pixel coordinates (for icon desaturation effect)
  const [mousePosition, setMousePositionState] = useState({
    x: -9999,
    y: -9999
  })

  // Track cards that are fading out (removed but still animating)
  const fadingOutRef = useRef<Map<string, GlowSource>>(new Map())
  // Track active card IDs for comparison
  const activeCardIdsRef = useRef<Set<string>>(new Set())
  // Animation frame ref
  const animationFrameRef = useRef<number | null>(null)
  const lastTimeRef = useRef<number>(0)

  const setCanvasDimensions = useCallback((width: number, height: number) => {
    setCanvasDimensionsState({ width, height })
  }, [])

  const setMousePosition = useCallback((x: number, y: number) => {
    setMousePositionState({ x, y })
  }, [])

  // Convert pixel position to normalized screen space (-1 to 1)
  const pixelToNDC = useCallback(
    (x: number, y: number, canvasWidth: number, canvasHeight: number): THREE.Vector2 => {
      // Convert from pixel (0 to width/height) to NDC (-1 to 1)
      // Note: Y is inverted (screen Y goes down, NDC Y goes up)
      const ndcX = (x / canvasWidth) * 2 - 1
      const ndcY = -((y / canvasHeight) * 2 - 1)
      return new THREE.Vector2(ndcX, ndcY)
    },
    []
  )

  // Update cards from GridSquares
  const updateCards = useCallback(
    (cards: CardInfo[], canvasWidth: number, canvasHeight: number) => {
      const newActiveIds = new Set(cards.map((c) => c.id))
      const previousActiveIds = activeCardIdsRef.current

      // Find cards that were removed
      previousActiveIds.forEach((id) => {
        if (!newActiveIds.has(id)) {
          // Card was removed - find its current glow source and start fading
          const existingSource = glowSources.find((s) => s.id === id)
          if (existingSource) {
            fadingOutRef.current.set(id, {
              ...existingSource,
              targetIntensity: 0
            })
          }
        }
      })

      // Update active card IDs
      activeCardIdsRef.current = newActiveIds

      // Create/update glow sources for current cards
      setGlowSources((prev) => {
        const newSources: GlowSource[] = []

        // Process active cards
        cards.forEach((card) => {
          // Calculate center of the card
          const centerX = card.x + card.width / 2
          const centerY = card.y + card.height / 2
          const position = pixelToNDC(centerX, centerY, canvasWidth, canvasHeight)
          const color = new THREE.Color(card.color)

          // Find existing source
          const existing = prev.find((s) => s.id === card.id)

          if (existing) {
            // Update position and color, keep animating toward full intensity
            newSources.push({
              ...existing,
              position,
              color,
              targetIntensity: 1
            })
          } else {
            // New card - start at 0 intensity, animate to 1
            newSources.push({
              id: card.id,
              position,
              color,
              intensity: 0,
              targetIntensity: 1
            })
          }
        })

        // Add fading out sources
        fadingOutRef.current.forEach((source, id) => {
          if (source.intensity > 0.01) {
            newSources.push(source)
          } else {
            // Fully faded, remove
            fadingOutRef.current.delete(id)
          }
        })

        return newSources
      })
    },
    [pixelToNDC, glowSources]
  )

  // Animation loop for fade in/out with easing
  useEffect(() => {
    const animate = (currentTime: number) => {
      if (lastTimeRef.current === 0) {
        lastTimeRef.current = currentTime
      }
      const deltaTime = currentTime - lastTimeRef.current
      lastTimeRef.current = currentTime

      setGlowSources((prev) => {
        let hasChanges = false
        const updated = prev.map((source) => {
          const diff = source.targetIntensity - source.intensity
          if (Math.abs(diff) < 0.001) {
            return source
          }

          hasChanges = true
          const duration = diff > 0 ? FADE_IN_DURATION : FADE_OUT_DURATION

          // Use exponential easing for smoother transitions
          // Lerp factor based on duration - smaller = slower/smoother
          const lerpFactor = 1 - 0.5 ** ((deltaTime / duration) * 5)

          // Interpolate toward target with easing
          const newIntensity = source.intensity + diff * lerpFactor

          // Update fading out ref if this is a fading source
          if (source.targetIntensity === 0) {
            fadingOutRef.current.set(source.id, {
              ...source,
              intensity: newIntensity
            })
          }

          return {
            ...source,
            intensity: newIntensity
          }
        })

        // Filter out fully faded sources
        const filtered = updated.filter((s) => s.intensity > 0.001 || s.targetIntensity > 0)

        // Clean up fading out ref
        fadingOutRef.current.forEach((source, id) => {
          if (source.intensity <= 0.001) {
            fadingOutRef.current.delete(id)
          }
        })

        return hasChanges ? filtered : prev
      })

      animationFrameRef.current = requestAnimationFrame(animate)
    }

    animationFrameRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [])

  return (
    <GlowColorContext.Provider
      value={{
        glowSources,
        updateCards,
        canvasDimensions,
        setCanvasDimensions,
        mousePosition,
        setMousePosition
      }}
    >
      {children}
    </GlowColorContext.Provider>
  )
}

// Utility hook to get glow data formatted for shaders
export function useGlowShaderData(maxSources: number = 8) {
  const { glowSources } = useGlowColors()

  // Limit to maxSources, sorted by intensity (strongest first)
  const limitedSources = [...glowSources]
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, maxSources)

  // Pad arrays to fixed size for shader uniforms
  const positions: THREE.Vector2[] = []
  const colors: THREE.Color[] = []
  const intensities: number[] = []

  for (let i = 0; i < maxSources; i++) {
    if (i < limitedSources.length) {
      positions.push(limitedSources[i].position)
      colors.push(limitedSources[i].color)
      intensities.push(limitedSources[i].intensity)
    } else {
      positions.push(new THREE.Vector2(0, 0))
      colors.push(new THREE.Color(0, 0, 0))
      intensities.push(0)
    }
  }

  return {
    positions,
    colors,
    intensities,
    count: limitedSources.length
  }
}
