import {
  useRef,
  useEffect,
  useState,
  useMemo,
  Suspense,
  useCallback,
  Component,
  type ReactNode,
  type ErrorInfo
} from 'react'
import { Canvas, useFrame, useThree, createPortal } from '@react-three/fiber'
import { useFBO, Text3D, Center } from '@react-three/drei'
import fontJson from './special-gothic-expanded-one-regular.json'
import { useControls } from 'leva'
import * as THREE from 'three'
import { GridEffect } from '../three/GridEffect'
import '../three/TexturedLetterMaterial'
import { GridSquares } from './GridSquares'
import { GlowColorProvider, useGlowColors, useGlowShaderData } from './GlowColorContext'
import { useHeroColors } from '@/hooks/useThemeColors'

// Check if we're on the client
const isClient = typeof window !== 'undefined'

// Error boundary to catch R3F errors and recover gracefully
interface CanvasErrorBoundaryProps {
  children: ReactNode
  onError?: () => void
}

interface CanvasErrorBoundaryState {
  hasError: boolean
}

class CanvasErrorBoundary extends Component<CanvasErrorBoundaryProps, CanvasErrorBoundaryState> {
  constructor(props: CanvasErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): CanvasErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Ignore data-tsd-source errors (TanStack devtools injection)
    // These happen when devtools tries to track R3F components
    if (error.message?.includes('data-tsd-source')) {
      // Just reset, don't remount the canvas (that causes WebGL context loss)
      setTimeout(() => {
        this.setState({ hasError: false })
      }, 50)
      return
    }
    console.error('Canvas error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      // Return null briefly while recovering
      return null
    }
    return this.props.children
  }
}

// Shared letter props interface
interface LetterProps {
  font: string
  size: number
  height: number
  curveSegments: number
  bevelEnabled: boolean
  bevelThickness: number
  bevelSize: number
  bevelSegments: number
}

// Component that renders clean wireframe edges from Text3D geometry
function WireframeText({
  children,
  color = '#000000',
  thresholdAngle = 15,
  font,
  position,
  curveSegments,
  bevelSegments,
  ...props
}: {
  children: string
  color?: string
  thresholdAngle?: number
  font: string
  size?: number
  height?: number
  curveSegments?: number
  bevelEnabled?: boolean
  bevelThickness?: number
  bevelSize?: number
  bevelSegments?: number
  position?: [number, number, number]
}) {
  const textRef = useRef<THREE.Mesh>(null)
  const edgesRef = useRef<THREE.LineSegments>(null)
  const [edgesGeometry, setEdgesGeometry] = useState<THREE.EdgesGeometry | null>(null)

  useEffect(() => {
    if (textRef.current?.geometry) {
      // Create edges geometry from the text mesh - only shows edges above threshold angle
      const edges = new THREE.EdgesGeometry(textRef.current.geometry, thresholdAngle)
      setEdgesGeometry(edges)

      return () => {
        edges.dispose()
      }
    }
  }, [thresholdAngle])

  return (
    <group position={position}>
      {/* Hidden mesh just to generate geometry */}
      <Text3D
        ref={textRef}
        font={font}
        curveSegments={curveSegments}
        bevelSegments={bevelSegments}
        {...props}
        visible={false}
      >
        {children}
        <meshBasicMaterial />
      </Text3D>

      {/* Clean edge lines */}
      {edgesGeometry && (
        <lineSegments ref={edgesRef} geometry={edgesGeometry}>
          <lineBasicMaterial color={color} />
        </lineSegments>
      )}
    </group>
  )
}

// Solid textured letters component
function SolidLetters({
  letterProps,
  groupRef,
  color = '#333333',
  noiseScale = 6.0,
  noiseStrength = 0.0,
  grainAmount = 0.15,
  rimGlowStrength = 0.5,
  rimGlowWidth = 0.3,
  lightIntensity = 1.0,
  edgeBrightness = 0.1,
  lightDirection = [5, 5, 5]
}: {
  letterProps: LetterProps
  groupRef: React.RefObject<THREE.Group | null>
  color?: string
  noiseScale?: number
  noiseStrength?: number
  grainAmount?: number
  rimGlowStrength?: number
  rimGlowWidth?: number
  lightIntensity?: number
  edgeBrightness?: number
  lightDirection?: [number, number, number]
}) {
  const materialRefs = useRef<THREE.ShaderMaterial[]>([])

  // Get glow data for shader uniforms
  const glowData = useGlowShaderData(8)

  // Update shader uniforms
  useFrame((state) => {
    materialRefs.current.forEach((mat) => {
      if (mat?.uniforms) {
        if (mat.uniforms.uTime) {
          mat.uniforms.uTime.value = state.clock.elapsedTime
        }
        if (mat.uniforms.uBaseColor) {
          mat.uniforms.uBaseColor.value.set(color)
        }
        if (mat.uniforms.uNoiseScale) {
          mat.uniforms.uNoiseScale.value = noiseScale
        }
        if (mat.uniforms.uNoiseStrength) {
          mat.uniforms.uNoiseStrength.value = noiseStrength
        }
        if (mat.uniforms.uGrainAmount) {
          mat.uniforms.uGrainAmount.value = grainAmount
        }
        // Lighting uniforms
        if (mat.uniforms.uLightIntensity) {
          mat.uniforms.uLightIntensity.value = lightIntensity
        }
        if (mat.uniforms.uEdgeBrightness) {
          mat.uniforms.uEdgeBrightness.value = edgeBrightness
        }
        if (mat.uniforms.uLightDirection) {
          mat.uniforms.uLightDirection.value.set(
            lightDirection[0],
            lightDirection[1],
            lightDirection[2]
          )
        }
        // Rim glow uniforms
        if (mat.uniforms.uRimGlowStrength) {
          mat.uniforms.uRimGlowStrength.value = rimGlowStrength
        }
        if (mat.uniforms.uRimGlowWidth) {
          mat.uniforms.uRimGlowWidth.value = rimGlowWidth
        }
        if (mat.uniforms.uGlowCount) {
          mat.uniforms.uGlowCount.value = glowData.count
        }
        // Update glow arrays
        if (mat.uniforms.uGlowPositions) {
          glowData.positions.forEach((pos, i) => {
            mat.uniforms.uGlowPositions.value[i].copy(pos)
          })
        }
        if (mat.uniforms.uGlowColors) {
          glowData.colors.forEach((col, i) => {
            mat.uniforms.uGlowColors.value[i].copy(col)
          })
        }
        if (mat.uniforms.uGlowIntensities) {
          mat.uniforms.uGlowIntensities.value = glowData.intensities
        }
      }
    })
  })

  return (
    <group ref={groupRef}>
      <Center>
        <group>
          <Text3D {...letterProps} position={[0, 1.5, 0]}>
            MODEL
            <texturedLetterMaterial
              ref={(ref: THREE.ShaderMaterial) => {
                if (ref) materialRefs.current[0] = ref
              }}
            />
          </Text3D>
          <Text3D {...letterProps} position={[0, 0, 0]}>
            CONTEXT
            <texturedLetterMaterial
              ref={(ref: THREE.ShaderMaterial) => {
                if (ref) materialRefs.current[1] = ref
              }}
            />
          </Text3D>
          <Text3D {...letterProps} position={[0, -1.5, 0]}>
            PROTOCOL
            <texturedLetterMaterial
              ref={(ref: THREE.ShaderMaterial) => {
                if (ref) materialRefs.current[2] = ref
              }}
            />
          </Text3D>
        </group>
      </Center>
    </group>
  )
}

// Wireframe letters component
function WireframeLetters({
  letterProps,
  wireframeControls,
  groupRef
}: {
  letterProps: LetterProps
  wireframeControls: {
    color: string
    thresholdAngle: number
  }
  groupRef: React.RefObject<THREE.Group | null>
}) {
  return (
    <group ref={groupRef}>
      <Center>
        <group>
          <WireframeText
            {...letterProps}
            position={[0, 1.5, 0]}
            color={wireframeControls.color}
            thresholdAngle={wireframeControls.thresholdAngle}
          >
            MODEL
          </WireframeText>
          <WireframeText
            {...letterProps}
            position={[0, 0, 0]}
            color={wireframeControls.color}
            thresholdAngle={wireframeControls.thresholdAngle}
          >
            CONTEXT
          </WireframeText>
          <WireframeText
            {...letterProps}
            position={[0, -1.5, 0]}
            color={wireframeControls.color}
            thresholdAngle={wireframeControls.thresholdAngle}
          >
            PROTOCOL
          </WireframeText>
        </group>
      </Center>
    </group>
  )
}

// Background plane that always fills the camera view
const BG_PLANE_Z = -5
const CAMERA_Z = 6
const BG_PLANE_OVERFLOW = 1.2 // Scale factor to ensure full coverage at edges

function BackgroundPlane() {
  const { camera, size } = useThree()
  const heroColors = useHeroColors()

  const distanceFromCamera = CAMERA_Z - BG_PLANE_Z
  const fovRad = (camera as THREE.PerspectiveCamera).fov * (Math.PI / 180)
  const height = 2 * Math.tan(fovRad / 2) * distanceFromCamera
  const width = height * (size.width / size.height)

  return (
    <mesh position={[0, 0, BG_PLANE_Z]}>
      <planeGeometry args={[width * BG_PLANE_OVERFLOW, height * BG_PLANE_OVERFLOW]} />
      <meshStandardMaterial color={heroColors.background} />
    </mesh>
  )
}

// Dynamic lights that follow icon positions and colors
function DynamicGlowLights({
  intensity = 1.0,
  distance = 8,
  decay = 2
}: {
  intensity?: number
  distance?: number
  decay?: number
}) {
  const { glowSources } = useGlowColors()
  const { camera, size } = useThree()
  const lightsRef = useRef<THREE.PointLight[]>([])

  // Convert NDC position to world position
  const ndcToWorld = useCallback(
    (ndcX: number, ndcY: number, z: number): THREE.Vector3 => {
      // Get camera properties
      const perspCamera = camera as THREE.PerspectiveCamera
      const fov = perspCamera.fov * (Math.PI / 180)
      const aspect = size.width / size.height

      // Calculate frustum dimensions at the given z distance from camera
      const cameraZ = perspCamera.position.z
      const distFromCamera = cameraZ - z
      const frustumHeight = 2 * Math.tan(fov / 2) * distFromCamera
      const frustumWidth = frustumHeight * aspect

      // Map NDC (-1 to 1) to world coordinates
      const worldX = (ndcX * frustumWidth) / 2
      const worldY = (ndcY * frustumHeight) / 2

      return new THREE.Vector3(worldX, worldY, z)
    },
    [camera, size.width, size.height]
  )

  return (
    <>
      {glowSources.slice(0, 8).map((source, index) => {
        // Position lights in front of the letters (z=2) so they illuminate them
        const worldPos = ndcToWorld(source.position.x, source.position.y, 2)
        const lightIntensity = intensity * source.intensity

        return (
          <pointLight
            key={source.id}
            ref={(ref) => {
              if (ref) lightsRef.current[index] = ref
            }}
            position={[worldPos.x, worldPos.y, worldPos.z]}
            color={source.color}
            intensity={lightIntensity}
            distance={distance}
            decay={decay}
          />
        )
      })}
    </>
  )
}

// Effect layer that renders scene to FBO then applies grid effect
function EffectLayer() {
  const { gl, size, camera } = useThree()
  const heroColors = useHeroColors()

  // Refs for letter groups (shared transform)
  const solidGroupRef = useRef<THREE.Group>(null)
  const wireframeGroupRef = useRef<THREE.Group>(null)
  const mouseRef = useRef({ x: 0, y: 0 })

  // Get glow data for GridEffect shader
  const glowData = useGlowShaderData(8)

  // Leva controls for grid effect (gridDensity is shared with Scene component)
  const gridControls = useControls('Grid', {
    gridDensity: { value: 30, min: 5, max: 80, step: 1 },
    lineColor: '#000000',
    lineOpacity: { value: 0.1, min: 0, max: 1, step: 0.05 }
  })

  // Leva controls for scene lighting
  const lightingControls = useControls('Scene Lighting', {
    ambientIntensity: { value: 1.2, min: 0, max: 3, step: 0.1 },
    directionalIntensity: { value: 6, min: 0, max: 15, step: 0.5 },
    directionalColor: '#ffffff',
    directionalX: { value: 5, min: -10, max: 10, step: 0.5 },
    directionalY: { value: 5, min: -10, max: 10, step: 0.5 },
    directionalZ: { value: 5, min: -10, max: 10, step: 0.5 },
    fillLightIntensity: { value: 2, min: 0, max: 8, step: 0.5 },
    fillLightColor: '#ff6633'
  })

  // Leva controls for solid letters
  const solidControls = useControls('Solid Letters', {
    color: '#333333',
    noiseScale: { value: 6.0, min: 1.0, max: 30.0, step: 0.5 },
    noiseStrength: { value: 0.0, min: 0.0, max: 2.0, step: 0.05 },
    grainAmount: { value: 0.15, min: 0.0, max: 0.3, step: 0.01 },
    lightIntensity: { value: 1.2, min: 0, max: 3, step: 0.1 },
    edgeBrightness: { value: 0.7, min: -0.3, max: 1, step: 0.01 }
  })

  // Leva controls for wireframe letters
  const wireframeControls = useControls('Wireframe Letters', {
    color: '#000000',
    thresholdAngle: { value: 1, min: 1, max: 90, step: 1 },
    curveSegments: { value: 4, min: 4, max: 64, step: 4 },
    bevelSegments: { value: 1, min: 1, max: 16, step: 1 }
  })

  // Leva controls for mouse influence
  const influenceControls = useControls('Mouse Influence', {
    maxIntensity: { value: 0.4, min: 0.05, max: 1.0, step: 0.05 },
    shiftAmount: { value: 0.3, min: 0.01, max: 0.8, step: 0.005 },
    dragStrength: { value: 1, min: 0, max: 1, step: 0.05 },
    influenceRadius: { value: 0.5, min: 0.1, max: 1.5, step: 0.05 },
    trailDecay: { value: 0.96, min: 0.8, max: 0.99, step: 0.005 },
    trailStrength: { value: 0.8, min: 0, max: 1, step: 0.05 },
    returnSpeed: { value: 0.0, min: 0.001, max: 0.3, step: 0.001 },
    chromaticAberration: { value: 0.01, min: 0, max: 0.1, step: 0.001 }
  })

  // Leva controls for X-ray effect (trail-based paint smear)
  const xrayControls = useControls('X-Ray Effect', {
    xraySize: { value: 1.0, min: 0.1, max: 2.0, step: 0.05 }, // Intensity of reveal
    xraySoftness: { value: 1, min: 0.0, max: 1.0, step: 0.05 }, // Edge softness
    xrayGlow: { value: 1, min: 0.0, max: 1.0, step: 0.05 },
    xrayColorTint: { value: 0.15, min: 0.0, max: 5.0, step: 0.05 }, // Icon color tint intensity
    colorVibrancy: { value: 1.5, min: 0.0, max: 2.0, step: 0.05 }, // Boost color saturation
    letterBrightness: { value: 0.0, min: 0.0, max: 1.0, step: 0.05 }, // Brighten letters
    colorRadius: { value: 0.2, min: 0.2, max: 3.0, step: 0.1 } // How far icon colors spread
  })

  // Leva controls for icon glow effects
  const glowControls = useControls('Icon Glow', {
    // Scene lighting from icons
    lightIntensity: { value: 10, min: 0, max: 10, step: 0.1 },
    lightDistance: { value: 20, min: 1, max: 20, step: 0.5 },
    lightDecay: { value: 4, min: 0.5, max: 4, step: 0.1 },
    // Trail color smear (follows mouse trail, picks up icon colors)
    gradientStrength: { value: 1, min: 0, max: 1, step: 0.01 },
    gradientRadius: { value: 2, min: 0.1, max: 2, step: 0.05 },
    // Bloom on trail (glowing smear effect)
    bloomIntensity: { value: 1, min: 0, max: 1, step: 0.01 },
    bloomThreshold: { value: 1, min: 0, max: 1, step: 0.01 },
    bloomRadius: { value: 2, min: 0.1, max: 2, step: 0.05 },
    // Rim glow on letters
    rimGlowStrength: { value: 1, min: 0, max: 1, step: 0.01 },
    rimGlowWidth: { value: 1, min: 0, max: 1, step: 0.01 }
  })

  // Letter props shared between solid and wireframe
  const letterProps: LetterProps = useMemo(
    () => ({
      font: fontJson as unknown as string,
      size: 1.2,
      height: 0.3,
      curveSegments: wireframeControls.curveSegments,
      bevelEnabled: false,
      bevelThickness: 0.02,
      bevelSize: 0.02,
      bevelSegments: wireframeControls.bevelSegments
    }),
    [wireframeControls.curveSegments, wireframeControls.bevelSegments]
  )

  // Calculate grid dimensions based on canvas aspect ratio
  const aspect = size.width / size.height
  const gridWidth =
    aspect >= 1 ? Math.round(gridControls.gridDensity * aspect) : gridControls.gridDensity
  const gridHeight =
    aspect >= 1 ? gridControls.gridDensity : Math.round(gridControls.gridDensity / aspect)

  // Create scenes for solid and wireframe renders
  const solidSceneRef = useRef<THREE.Scene | null>(null)
  const wireframeSceneRef = useRef<THREE.Scene | null>(null)
  const postSceneRef = useRef<THREE.Scene | null>(null)

  if (!solidSceneRef.current) {
    solidSceneRef.current = new THREE.Scene()
  }
  if (!wireframeSceneRef.current) {
    wireframeSceneRef.current = new THREE.Scene()
  }
  if (!postSceneRef.current) {
    postSceneRef.current = new THREE.Scene()
  }

  const solidScene = solidSceneRef.current
  const wireframeScene = wireframeSceneRef.current
  const postScene = postSceneRef.current

  // Create orthographic camera for the full-screen quad
  const orthoCamera = useMemo(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), [])

  // Create FBOs at physical pixel resolution for sharp rendering on high-DPI screens
  const dpr = gl.getPixelRatio()
  const solidTarget = useFBO(size.width * dpr, size.height * dpr, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType
  })

  const wireframeTarget = useFBO(size.width * dpr, size.height * dpr, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType
  })

  // Track mouse position
  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const canvas = document.querySelector('canvas')
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      mouseRef.current.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1)
    }

    window.addEventListener('mousemove', handleMouseMove)
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [])

  // Render: both scenes to FBOs, then post-process quad to screen
  useFrame(() => {
    if (gl.getContext().isContextLost()) return

    // 1. Render solid scene to FBO
    gl.setRenderTarget(solidTarget)
    gl.clear()
    gl.render(solidScene, camera)

    // 2. Render wireframe scene to FBO
    gl.setRenderTarget(wireframeTarget)
    gl.clear()
    gl.render(wireframeScene, camera)

    // 3. Render post-processing quad to screen
    gl.setRenderTarget(null)
    gl.render(postScene, orthoCamera)
  }, 1)

  return (
    <>
      {/* Render solid letters scene */}
      {createPortal(
        <>
          <ambientLight intensity={lightingControls.ambientIntensity} />
          <directionalLight
            position={[
              lightingControls.directionalX,
              lightingControls.directionalY,
              lightingControls.directionalZ
            ]}
            intensity={lightingControls.directionalIntensity}
            color={lightingControls.directionalColor}
          />
          <pointLight
            position={[-5, -5, 5]}
            intensity={lightingControls.fillLightIntensity}
            color={lightingControls.fillLightColor}
          />
          {/* Dynamic lights from icon colors */}
          <DynamicGlowLights
            intensity={glowControls.lightIntensity}
            distance={glowControls.lightDistance}
            decay={glowControls.lightDecay}
          />
          <BackgroundPlane />
          <Suspense fallback={null}>
            <SolidLetters
              letterProps={letterProps}
              groupRef={solidGroupRef}
              color={heroColors.solidText}
              noiseScale={solidControls.noiseScale}
              noiseStrength={solidControls.noiseStrength}
              grainAmount={solidControls.grainAmount}
              lightIntensity={heroColors.lightIntensity}
              edgeBrightness={heroColors.edgeBrightness}
              rimGlowStrength={glowControls.rimGlowStrength}
              rimGlowWidth={glowControls.rimGlowWidth}
              lightDirection={[
                lightingControls.directionalX,
                lightingControls.directionalY,
                lightingControls.directionalZ
              ]}
            />
          </Suspense>
        </>,
        solidScene
      )}

      {/* Render wireframe letters scene */}
      {createPortal(
        <>
          <ambientLight intensity={1} />
          <BackgroundPlane />
          <Suspense fallback={null}>
            <WireframeLetters
              letterProps={letterProps}
              wireframeControls={{
                ...wireframeControls,
                color: heroColors.wireframe
              }}
              groupRef={wireframeGroupRef}
            />
          </Suspense>
        </>,
        wireframeScene
      )}

      {/* Render full-screen quad with grid effect into the post scene */}
      {createPortal(
        <mesh frustumCulled={false}>
          <planeGeometry args={[2, 2]} />
          <GridEffect
            texture={solidTarget.texture}
            wireframeTexture={wireframeTarget.texture}
            gridWidth={gridWidth}
            gridHeight={gridHeight}
            lineColor={heroColors.gridLine}
            lineOpacity={gridControls.lineOpacity}
            maxIntensity={influenceControls.maxIntensity}
            shiftAmount={influenceControls.shiftAmount}
            dragStrength={influenceControls.dragStrength}
            influenceRadius={influenceControls.influenceRadius}
            trailDecay={influenceControls.trailDecay}
            trailStrength={influenceControls.trailStrength}
            returnSpeed={influenceControls.returnSpeed}
            chromaticAberration={influenceControls.chromaticAberration}
            xraySize={xrayControls.xraySize}
            xraySoftness={xrayControls.xraySoftness}
            xrayGlow={xrayControls.xrayGlow}
            xrayColorTint={heroColors.xrayColorTint}
            colorVibrancy={heroColors.colorVibrancy}
            letterBrightness={xrayControls.letterBrightness}
            colorRadius={xrayControls.colorRadius}
            gridVisibleByDefault={heroColors.gridVisibleByDefault}
            glowEnabled={heroColors.glowEnabled}
            // Icon glow props
            glowPositions={glowData.positions}
            glowColors={glowData.colors}
            glowIntensities={glowData.intensities}
            glowCount={glowData.count}
            gradientStrength={glowControls.gradientStrength}
            gradientRadius={glowControls.gradientRadius}
            bloomIntensity={glowControls.bloomIntensity}
            bloomThreshold={glowControls.bloomThreshold}
            bloomRadius={glowControls.bloomRadius}
          />
        </mesh>,
        postScene
      )}
    </>
  )
}

// Handle WebGL context loss/restore
function ContextHandler() {
  const { gl } = useThree()

  useEffect(() => {
    const canvas = gl.domElement

    const handleContextLost = (event: Event) => {
      event.preventDefault()
      console.warn('WebGL context lost - will attempt to restore')
    }

    const handleContextRestored = () => {
      console.log('WebGL context restored')
    }

    canvas.addEventListener('webglcontextlost', handleContextLost)
    canvas.addEventListener('webglcontextrestored', handleContextRestored)

    return () => {
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      canvas.removeEventListener('webglcontextrestored', handleContextRestored)
    }
  }, [gl])

  return null
}

// Adjust camera FOV based on aspect ratio so the 3D text fills a consistent
// proportion of the screen at any size. At the reference aspect (~2.3,
// desktop 60vh hero), baseFov=50 looks right. As the viewport narrows
// (mobile / portrait), the FOV widens to keep the same visible width.
const BASE_FOV = 50
const REFERENCE_ASPECT = 2.3
const MAX_FOV = 85

function ResponsiveFOV() {
  const { camera, size } = useThree()

  useEffect(() => {
    const perspCamera = camera as THREE.PerspectiveCamera
    const aspect = size.width / size.height

    const baseFovRad = (BASE_FOV * Math.PI) / 360 // half-angle in radians
    const adjustedFov = 2 * Math.atan(Math.tan(baseFovRad) * REFERENCE_ASPECT / aspect) * (180 / Math.PI)

    perspCamera.fov = Math.min(MAX_FOV, Math.max(BASE_FOV, adjustedFov))
    perspCamera.updateProjectionMatrix()
  }, [camera, size.width, size.height])

  return null
}

// Component to report canvas size back to parent
function SizeReporter({ onSizeChange }: { onSizeChange: (width: number, height: number) => void }) {
  const { size } = useThree()

  useEffect(() => {
    onSizeChange(size.width, size.height)
  }, [size.width, size.height, onSizeChange])

  return null
}

// Inner scene component that uses glow context
function SceneContent() {
  const [mounted, setMounted] = useState(false)
  const [canvasKey, setCanvasKey] = useState(0)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const containerRef = useRef<HTMLDivElement>(null)
  const glowContext = useGlowColors()
  const heroColors = useHeroColors()

  // Grid density and quality controls (needs to be here so GridSquares can access it)
  const { gridDensity, pixelRatio } = useControls('Grid', {
    gridDensity: { value: 30, min: 5, max: 80, step: 1 },
    pixelRatio: { value: 3, min: 1, max: 3, step: 0.5 }
  })

  // Icon desaturation controls (icons go B&W near mouse)
  const iconDesatControls = useControls('Icon Desaturation', {
    enabled: { value: true },
    radius: { value: 150, min: 50, max: 500, step: 10 },
    cutoff: { value: 50, min: 0, max: 200, step: 5 },
    style: { options: ['smooth', 'sharp'] },
    trailPersist: { value: 0.5, min: 0, max: 2, step: 0.1 },
    // Drag effect - icons pulled toward mouse
    pushStrength: { value: 15, min: 0, max: 50, step: 1 },
    pushRadius: { value: 200, min: 50, max: 500, step: 10 }
  })

  const handleSizeChange = useCallback((width: number, height: number) => {
    setCanvasSize({ width, height })
  }, [])

  // Track mouse position for icon desaturation effect
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      glowContext.setMousePosition(e.clientX - rect.left, e.clientY - rect.top)
    },
    [glowContext]
  )

  const handleMouseLeave = useCallback(() => {
    // Move mouse "far away" so icons return to full color
    glowContext.setMousePosition(-9999, -9999)
  }, [glowContext])

  useEffect(() => {
    setMounted(true)
  }, [])

  // Handle context loss by remounting the canvas
  useEffect(() => {
    if (!mounted) return

    const canvas = containerRef.current?.querySelector('canvas')
    if (!canvas) return

    const handleContextLost = (event: Event) => {
      event.preventDefault()
      console.warn('Context lost - remounting canvas')
      // Delay remount to let GPU recover
      setTimeout(() => setCanvasKey((k) => k + 1), 1000)
    }

    canvas.addEventListener('webglcontextlost', handleContextLost)
    return () => canvas.removeEventListener('webglcontextlost', handleContextLost)
  }, [mounted])

  // SSR guard
  if (!isClient || !mounted) {
    return null
  }

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{
        // Ensure smooth resize transitions
        contain: 'strict'
      }}
    >
      <CanvasErrorBoundary onError={() => setCanvasKey((k) => k + 1)}>
        <Canvas
          key={`${canvasKey}-${heroColors.background}`}
          camera={{
            position: [0, 0, CAMERA_Z],
            fov: BASE_FOV
          }}
          gl={{
            antialias: true,
            alpha: false,
            powerPreference: 'high-performance',
            // Helps with context loss recovery
            preserveDrawingBuffer: false
          }}
          frameloop="always"
          resize={{
            scroll: false,
            debounce: { scroll: 0, resize: 0 }
          }}
          style={{
            // Crop 1px from edges to avoid doubling up with parent border
            width: 'calc(100% + 2px)',
            height: 'calc(100% + 2px)',
            margin: '-1px',
            display: 'block'
          }}
          dpr={Math.max(pixelRatio, window.devicePixelRatio)}
        >
          <SizeReporter onSizeChange={handleSizeChange} />
          <ResponsiveFOV />
          <ContextHandler />
          <EffectLayer />
        </Canvas>
      </CanvasErrorBoundary>

      {/* Grid squares overlay */}
      <GridSquares
        gridDensity={gridDensity}
        canvasWidth={canvasSize.width}
        canvasHeight={canvasSize.height}
        desatEnabled={iconDesatControls.enabled}
        desatRadius={iconDesatControls.radius}
        desatCutoff={iconDesatControls.cutoff}
        desatStyle={iconDesatControls.style as 'smooth' | 'sharp'}
        desatTrailPersist={iconDesatControls.trailPersist}
        pushStrength={iconDesatControls.pushStrength}
        pushRadius={iconDesatControls.pushRadius}
      />
    </div>
  )
}

// Main scene export wrapped with GlowColorProvider
export function Scene() {
  return (
    <GlowColorProvider>
      <SceneContent />
    </GlowColorProvider>
  )
}
