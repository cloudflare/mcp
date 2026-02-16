import { useRef, useEffect } from 'react'
import { useFrame, useThree, extend } from '@react-three/fiber'
import { shaderMaterial } from '@react-three/drei'
import type * as THREE from 'three'
import { Vector2 } from 'three'
import type { ShaderMaterial } from 'three'

// Vertex shader - simple pass-through for full-screen quad
const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// Fragment shader - Zajno-style slice displacement
const fragmentShader = /* glsl */ `
uniform sampler2D uTexture;
uniform vec2 uMouse;
uniform vec2 uMouseVelocity;
uniform float uTime;
uniform float uPixelSize;
uniform float uIntensity;
uniform float uChromaStrength;
uniform float uRadius;
uniform float uSmearStrength;
uniform vec2 uResolution;

varying vec2 vUv;

void main() {
  vec2 mouseUV = uMouse * 0.5 + 0.5;
  float velocityMag = length(uMouseVelocity);
  vec2 velDir = velocityMag > 0.001 ? normalize(uMouseVelocity) : vec2(0.0, 1.0);
  
  // Distance from mouse
  float dist = length(vUv - mouseUV);
  
  // Influence falloff
  float influence = 1.0 - smoothstep(0.0, uRadius, dist);
  influence = pow(influence, 0.6);
  influence *= velocityMag * uIntensity;
  influence = clamp(influence, 0.0, 1.0);
  
  // Pixel size SCALES with influence - pixels shrink back to normal
  float effectivePixelSize = uPixelSize * influence;
  
  vec2 displacedUV = vUv;
  
  // Perpendicular to velocity direction
  vec2 perpDir = vec2(-velDir.y, velDir.x);
  
  // Displacement scales with influence
  float offsetAmount = influence * uSmearStrength;
  
  if (effectivePixelSize > 0.0001) {
    // Project UV onto perpendicular axis to determine which "slice" we're in
    float sliceCoord = dot(vUv, perpDir);
    float sliceIndex = floor(sliceCoord / effectivePixelSize);
    
    // Add variation per slice for organic feel
    float rowVariation = sin(sliceIndex * 0.7 + uTime * 1.5) * 0.15 + 0.85;
    offsetAmount *= rowVariation;
    
    // Displace in velocity direction
    displacedUV += velDir * offsetAmount;
    
    // Snap to slice grid (perpendicular to movement)
    float snappedSliceCoord = sliceIndex * effectivePixelSize + effectivePixelSize * 0.5;
    displacedUV = displacedUV - perpDir * dot(displacedUV, perpDir) + perpDir * snappedSliceCoord;
    
    // Pixelate along velocity direction too (stretched pixels)
    float velCoord = dot(displacedUV, velDir);
    float velPixelSize = effectivePixelSize * 1.5;
    float snappedVelCoord = floor(velCoord / velPixelSize) * velPixelSize + velPixelSize * 0.5;
    displacedUV = displacedUV - velDir * dot(displacedUV, velDir) + velDir * snappedVelCoord;
  }
  
  // Chromatic aberration scales with influence
  vec3 color;
  float chromaAmount = uChromaStrength * influence;
  
  if (chromaAmount > 0.0005) {
    float r = texture2D(uTexture, displacedUV + velDir * chromaAmount).r;
    float g = texture2D(uTexture, displacedUV).g;
    float b = texture2D(uTexture, displacedUV - velDir * chromaAmount).b;
    color = vec3(r, g, b);
  } else {
    color = texture2D(uTexture, displacedUV).rgb;
  }
  
  gl_FragColor = vec4(color, 1.0);
}
`

// Create the shader material using drei's shaderMaterial
const PixelSmearMaterial = shaderMaterial(
  {
    uTexture: null,
    uMouse: new Vector2(0, 0),
    uMouseVelocity: new Vector2(0, 0),
    uTime: 0,
    uPixelSize: 0.02,
    uIntensity: 2.5,
    uChromaStrength: 0.02,
    uRadius: 0.5,
    uSmearStrength: 0.25,
    uResolution: new Vector2(1, 1)
  },
  vertexShader,
  fragmentShader
)

// Extend so it's available as a JSX element
extend({ PixelSmearMaterial })

// Extend ThreeElements for R3F
declare module '@react-three/fiber' {
  interface ThreeElements {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pixelSmearMaterial: any
  }
}

interface PixelSmearEffectProps {
  texture: THREE.Texture | null
  intensity?: number
  pixelSize?: number
  chromaStrength?: number
  radius?: number
  smearStrength?: number
  velocityAttack?: number
  velocityDecay?: number
  velocityScale?: number
}

export function PixelSmearEffect({
  texture,
  intensity = 2.5,
  pixelSize = 0.02,
  chromaStrength = 0.02,
  radius = 0.5,
  smearStrength = 0.25,
  velocityAttack = 0.3,
  velocityDecay = 0.95,
  velocityScale = 0.8
}: PixelSmearEffectProps) {
  const materialRef = useRef<ShaderMaterial>(null)
  const mouseRef = useRef(new Vector2(0, 0))
  const lastMouseRef = useRef(new Vector2(0, 0))
  const smoothVelocityRef = useRef(new Vector2(0, 0))
  const { size } = useThree()

  // Mouse tracking
  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      const canvas = document.querySelector('canvas')
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const relX = (event.clientX - rect.left) / rect.width
      const relY = (event.clientY - rect.top) / rect.height
      const x = relX * 2 - 1
      const y = -(relY * 2 - 1)

      mouseRef.current.set(x, y)
    }

    window.addEventListener('mousemove', handleMouseMove)
    return () => window.removeEventListener('mousemove', handleMouseMove)
  }, [])

  // Update uniforms each frame
  useFrame((_, delta) => {
    if (!materialRef.current) return

    const mat = materialRef.current

    // Calculate raw velocity
    const dx = mouseRef.current.x - lastMouseRef.current.x
    const dy = mouseRef.current.y - lastMouseRef.current.y
    const rawVelX = (dx / Math.max(delta, 0.001)) * velocityScale
    const rawVelY = (dy / Math.max(delta, 0.001)) * velocityScale

    // Asymmetric smoothing: fast attack, slow decay
    // If new velocity is greater (in magnitude), use attack (fast response)
    // If new velocity is smaller (decaying), use decay (slow fade out)
    // Use attack when speeding up, decay when slowing down
    const smoothingX =
      Math.abs(rawVelX) > Math.abs(smoothVelocityRef.current.x) ? 1 - velocityAttack : velocityDecay
    const smoothingY =
      Math.abs(rawVelY) > Math.abs(smoothVelocityRef.current.y) ? 1 - velocityAttack : velocityDecay

    smoothVelocityRef.current.x =
      smoothVelocityRef.current.x * smoothingX + rawVelX * (1 - smoothingX)
    smoothVelocityRef.current.y =
      smoothVelocityRef.current.y * smoothingY + rawVelY * (1 - smoothingY)

    lastMouseRef.current.copy(mouseRef.current)

    // Update uniforms
    ;(mat.uniforms.uMouse.value as Vector2).copy(mouseRef.current)
    ;(mat.uniforms.uMouseVelocity.value as Vector2).copy(smoothVelocityRef.current)
    mat.uniforms.uTime.value += delta
    mat.uniforms.uTexture.value = texture
    mat.uniforms.uPixelSize.value = pixelSize
    mat.uniforms.uIntensity.value = intensity
    mat.uniforms.uChromaStrength.value = chromaStrength
    mat.uniforms.uRadius.value = radius
    mat.uniforms.uSmearStrength.value = smearStrength
    ;(mat.uniforms.uResolution.value as Vector2).set(size.width, size.height)
  })

  return <pixelSmearMaterial ref={materialRef} depthTest={false} depthWrite={false} />
}
