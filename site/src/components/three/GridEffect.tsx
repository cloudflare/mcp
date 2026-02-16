import { useRef, useEffect } from 'react'
import { useFrame, useThree, extend } from '@react-three/fiber'
import { shaderMaterial } from '@react-three/drei'
import * as THREE from 'three'
import { Vector2, Vector3, Color } from 'three'
import type { ShaderMaterial } from 'three'

// Maximum glow sources for shader arrays
const MAX_GLOW_SOURCES = 8

// Vertex shader - simple pass-through for full-screen quad
const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

// Fragment shader - Grid effect with distortion, X-ray reveal, and icon glow
// Letters get "pulled" radially from the mouse position
// X-ray effect reveals wireframe where mouse trail is active
// Icon glow adds gradient overlay and bloom based on icon positions
const fragmentShader = /* glsl */ `
uniform sampler2D uTexture;
uniform sampler2D uWireframeTexture;
uniform sampler2D uTrailTexture;
uniform vec2 uMouse;
uniform vec2 uMouseVelocity; // Current mouse velocity (for chromatic aberration direction)
uniform vec2 uGridSize;
uniform float uShiftAmount;
uniform float uDragStrength; // How much letters get pulled (now just scales the effect)
uniform float uLineWidth;
uniform vec3 uLineColor;
uniform vec2 uResolution;
uniform float uInfluenceRadius;
uniform float uTrailStrength;
uniform float uMouseActive; // 0-1, controls return to normal
uniform float uLineOpacity;
uniform float uChromaticAberration;
uniform float uXraySize; // Single control for x-ray intensity
uniform float uXraySoftness;
uniform float uXrayGlow;
uniform float uXrayColorTint; // How much icon colors tint the x-ray view
uniform float uColorVibrancy; // Boost saturation of icon colors
uniform float uLetterBrightness; // Brighten the letters
uniform float uColorRadius; // How far icon colors spread
uniform float uGridVisibleByDefault; // 1.0 = always visible, 0.0 = only on xray
uniform float uGlowEnabled; // 1.0 = glow effects on, 0.0 = off

// Icon glow uniforms
uniform int uGlowCount;
uniform vec2 uGlowPositions[${MAX_GLOW_SOURCES}];
uniform vec3 uGlowColors[${MAX_GLOW_SOURCES}];
uniform float uGlowIntensities[${MAX_GLOW_SOURCES}];
uniform float uGradientStrength;
uniform float uGradientRadius;
uniform float uBloomIntensity;
uniform float uBloomThreshold;
uniform float uBloomRadius;

varying vec2 vUv;

// Helper function to boost color saturation/vibrancy
vec3 boostSaturation(vec3 color, float boost) {
  float luminance = dot(color, vec3(0.299, 0.587, 0.114));
  return mix(vec3(luminance), color, 1.0 + boost);
}

void main() {
  // Get which cell we're in (separate width/height)
  vec2 cellIndex = floor(vUv * uGridSize);
  vec2 cellUv = fract(vUv * uGridSize);
  
  // Get the CENTER of the current cell in UV space
  vec2 cellCenter = (cellIndex + 0.5) / uGridSize;
  
  // Convert mouse from -1,1 to 0,1 UV space
  vec2 mouseUv = uMouse * 0.5 + 0.5;
  
  // Vector FROM mouse TO cell center
  vec2 fromMouse = cellCenter - mouseUv;
  float dist = length(fromMouse);
  
  // Normalize direction (avoid division by zero)
  vec2 radialDir = dist > 0.001 ? fromMouse / dist : vec2(0.0);
  
  // Distance-based influence - closer to mouse = more distortion
  float influence = 1.0 - smoothstep(0.0, uInfluenceRadius, dist);
  influence = pow(influence, 1.2);
  
  // Sample the trail texture to get accumulated influence (just R channel now)
  float trailInfluence = texture2D(uTrailTexture, cellCenter).r;
  
  float totalInfluence = influence * trailInfluence * uTrailStrength;
  
  // RADIAL DISTORTION: Pull letters outward from mouse position
  // Simple and stable - no per-pixel velocity storage that can "spin"
  float distortionAmount = uShiftAmount * totalInfluence * uDragStrength;
  
  // Cell offset is purely radial (away from mouse)
  vec2 cellOffset = radialDir * distortionAmount;
  
  // Apply offset to sample UV
  vec2 sampleUv = vUv - cellOffset;
  sampleUv = clamp(sampleUv, 0.0, 1.0);
  
  // X-RAY EFFECT: Pure trail-based "paint smear" behavior
  // The x-ray only appears where the trail has been painted
  // No spinning because trail just stores intensity, not direction
  
  // Trail influence IS the x-ray mask - where you've painted, you see through
  float xrayTrailMask = trailInfluence;
  
  // Softness controls the edge transition
  // Low softness = sharp edges, high softness = gradual fade
  float edgeSharpness = 1.0 - uXraySoftness * 0.8;
  float xrayMask = pow(xrayTrailMask, edgeSharpness);
  
  // Boost to ensure we can reach full opacity
  xrayMask = clamp(xrayMask * 1.5, 0.0, 1.0);
  
  // CHROMATIC ABERRATION - use CURRENT mouse velocity for color separation
  // This doesn't spin because it uses live velocity, not stored per-pixel velocity
  float currentVelocityMag = length(uMouseVelocity);
  vec2 currentVelocityDir = currentVelocityMag > 0.01 ? normalize(uMouseVelocity) : radialDir;
  float chromaAmount = uChromaticAberration * totalInfluence;
  vec2 chromaOffset = currentVelocityDir * chromaAmount;
  
  // Sample solid texture with chromatic aberration
  vec2 uvR = clamp(sampleUv + chromaOffset * 1.2, 0.0, 1.0);
  vec2 uvG = clamp(sampleUv, 0.0, 1.0);
  vec2 uvB = clamp(sampleUv - chromaOffset * 1.2, 0.0, 1.0);
  
  float solidR = texture2D(uTexture, uvR).r;
  float solidG = texture2D(uTexture, uvG).g;
  float solidB = texture2D(uTexture, uvB).b;
  vec3 solidColor = vec3(solidR, solidG, solidB);
  
  // Sample wireframe texture with same chromatic aberration
  float wireR = texture2D(uWireframeTexture, uvR).r;
  float wireG = texture2D(uWireframeTexture, uvG).g;
  float wireB = texture2D(uWireframeTexture, uvB).b;
  vec3 wireColor = vec3(wireR, wireG, wireB);
  
  // BOOST CHROMATIC COLORS - make them more vivid, not faded
  float chromaSeparation = chromaAmount * 20.0;
  vec3 originalSample = texture2D(uTexture, sampleUv).rgb;
  float luminance = dot(originalSample, vec3(0.299, 0.587, 0.114));
  float boostAmount = clamp(chromaSeparation * luminance * 2.0, 0.0, 1.0);
  
  // Saturate the RGB channels
  solidColor.r = mix(solidColor.r, solidColor.r > 0.5 ? 1.0 : solidColor.r * 1.5, boostAmount * 0.6);
  solidColor.g = mix(solidColor.g, solidColor.g > 0.5 ? 1.0 : solidColor.g * 1.5, boostAmount * 0.6);
  solidColor.b = mix(solidColor.b, solidColor.b > 0.5 ? 1.0 : solidColor.b * 1.5, boostAmount * 0.6);
  
  // LAYERED EFFECT:
  // Default state: Solid colored letters with grain + colorful wireframe showing through
  // On mouse trail: Reveal clean black & white wireframe
  
  // Wireframe texture has black lines on white background
  float wireLuminance = dot(wireColor, vec3(0.299, 0.587, 0.114));
  float isLine = 1.0 - smoothstep(0.0, 0.3, wireLuminance);
  
  // Detect if we're on a solid letter (dark areas in solid texture)
  float solidLuminance = dot(solidColor, vec3(0.299, 0.587, 0.114));
  // float isOnLetter = 1.0 - smoothstep(0.0, 0.85, solidLuminance);
  float isOnLetter = 1.0;
  
  // Clean black & white wireframe (revealed on trail)
  vec3 cleanWireframe = vec3(1.0 - isLine); // White bg, black lines
  
  // === COLORFUL TINTED WIREFRAME ===
  // Convert UV to NDC (-1 to 1)
  // Note: Icon positions from GlowColorContext are already in proper NDC
  // (screen Y=0 top → NDC Y=1, screen Y=bottom → NDC Y=-1)
  // UV Y=0 is bottom, Y=1 is top, so we need to flip to match screen coords
  vec2 xrayNDC = vUv * 2.0 - 1.0;
  // Don't flip - the icon positions already account for screen-to-NDC conversion
  
  // Calculate color tint from nearby icons
  vec3 tintColor = vec3(0.5, 0.7, 0.9); // Default subtle blue-ish tint
  float tintWeight = 0.0;
  
  if (uGlowCount > 0) {
    // Winner-take-all: use the closest/strongest icon's color
    // This prevents color averaging which produces muddy pinks
    float maxWeight = 0.0;
    vec3 winnerColor = tintColor; // Start with default
    
    for (int i = 0; i < ${MAX_GLOW_SOURCES}; i++) {
      if (i >= uGlowCount) break;
      
      // Distance from this pixel to the icon
      float iconDist = length(xrayNDC - uGlowPositions[i]);
      
      // Proximity falloff - uColorRadius controls spread distance
      float proximity = 1.0 - smoothstep(0.0, uColorRadius, iconDist);
      proximity = pow(proximity, 0.8);
      
      float weight = uGlowIntensities[i] * proximity;
      
      // Take the strongest icon's color (winner-take-all)
      if (weight > maxWeight) {
        maxWeight = weight;
        winnerColor = uGlowColors[i];
      }
    }
    
    tintWeight = maxWeight;
    
    if (tintWeight > 0.001) {
      tintColor = winnerColor;
      // Boost saturation for more vibrant/punchy colors
      tintColor = boostSaturation(tintColor, uColorVibrancy);
    }
  }
  
  // Create the colorful tinted wireframe overlay
  float tintAmount = uXrayColorTint * min(tintWeight * 2.0 + 0.3, 1.0);
  
  // Tinted wireframe: colored lines on near-white background
  // Use boosted tint color for more vibrant appearance
  vec3 tintedBackground = mix(vec3(1.0), vec3(0.92) + tintColor * 0.08, tintAmount * 0.4);
  vec3 lineColor = mix(vec3(0.15), tintColor * 0.8, tintAmount * 0.85);
  vec3 colorfulWireframe = mix(tintedBackground, lineColor, isLine);
  
  // === DEFAULT STATE: Solid + colorful wireframe blend ===
  // The solid texture shows through with the colorful wireframe overlaid
  float wireframeOpacity = 0.5; // How much wireframe shows through solid
  
  // Tint the solid letters with icon colors (same as wireframe tint)
  // This makes the letters pick up the nearby icon colors
  vec3 tintedSolid = solidColor;
  if (tintWeight > 0.001) {
    // Screen blend the tint color onto the solid
    vec3 solidTint = 1.0 - (1.0 - solidColor) * (1.0 - tintColor * uXrayColorTint * 0.3);
    tintedSolid = mix(solidColor, solidTint, min(tintWeight * 1.5, 1.0));
  }
  
  // Brighten and boost saturation
  vec3 brightenedSolid = tintedSolid + vec3(uLetterBrightness * 0.5);
  brightenedSolid = boostSaturation(brightenedSolid, uColorVibrancy * 0.8);
  
  // Use screen blend instead of multiply to avoid darkening
  // Screen blend: 1 - (1 - a) * (1 - b) - always lightens or stays same
  vec3 screenBlended = 1.0 - (1.0 - brightenedSolid) * (1.0 - colorfulWireframe * 0.6);
  
  // Mix between tinted solid and screen blend with wireframe
  vec3 solidWithWireframe = mix(brightenedSolid, screenBlended, wireframeOpacity + isLine * 0.3);
  
  // === TRAIL REVEAL: Clean B&W wireframe ===
  // Use xrayMask directly - softness is already applied via power function
  float blendAmount = xrayMask;
  
  // On trail: transition from solid+colorful to clean B&W wireframe
  // uXraySize controls the maximum reveal (1.0 = full B&W wireframe)
  // Ensure we can reach full transition by clamping and boosting
  float revealAmount = clamp(blendAmount * uXraySize * 1.5, 0.0, 1.0);
  vec3 letterView = mix(solidWithWireframe, cleanWireframe, revealAmount);
  
  // Detect letter areas using WIREFRAME (more reliable than solid which changes with lighting)
  // Wireframe has lines = letter area, pure white = background
  float hasWireframeContent = step(0.05, isLine); // Any wireframe line present
  // Also use solid detection as backup
  float onLetterSolid = step(0.5, isOnLetter);
  float onLetter = max(hasWireframeContent, onLetterSolid);
  
  // Final color: letter view on letters, solid background elsewhere
  vec3 color = mix(solidColor, letterView, onLetter);
  
  // Line detection
  vec2 cellSizePixels = uResolution / uGridSize;
  vec2 lineWidthUv = 0.5 / cellSizePixels;
  
  float lineX = step(cellUv.x, lineWidthUv.x) + step(1.0 - lineWidthUv.x, cellUv.x);
  float lineY = step(cellUv.y, lineWidthUv.y) + step(1.0 - lineWidthUv.y, cellUv.y);
  float line = clamp(lineX + lineY, 0.0, 1.0);
  
  // Grid visibility: if uGridVisibleByDefault is 0, only show grid on xray trail
  float gridVisibility = mix(xrayMask, 1.0, uGridVisibleByDefault);
  color = mix(color, uLineColor, line * uLineOpacity * gridVisibility);
  
  // === ICON GLOW: TRAIL-BASED COLOR SMEAR ===
  // The glow follows the mouse trail, picking up colors from nearby icons
  // This creates a paint/smear effect rather than a moving gradient
  
  // Convert UV to NDC for comparison with glow positions
  vec2 pixelNDC = vUv * 2.0 - 1.0;
  pixelNDC.y = -pixelNDC.y; // Flip Y to match screen coords
  
  // Use the trail influence to control where glow appears
  // trailInfluence is already calculated above and decays over time
  float glowTrailMask = trailInfluence;
  
  // Only calculate glow where there's trail activity and glow is enabled
  if (glowTrailMask > 0.01 && uGradientStrength > 0.0 && uGlowEnabled > 0.5) {
    vec3 trailGlowColor = vec3(0.0);
    float totalGlowWeight = 0.0;
    
    for (int i = 0; i < ${MAX_GLOW_SOURCES}; i++) {
      if (i >= uGlowCount) break;
      
      // Distance from this pixel to the icon
      float iconDist = length(pixelNDC - uGlowPositions[i]);
      
      // Icons contribute color based on proximity
      // Larger radius so icons can "paint" as trail passes nearby
      float iconProximity = 1.0 - smoothstep(0.0, uGradientRadius * 1.5, iconDist);
      iconProximity = pow(iconProximity, 1.5);
      
      // Weight combines icon proximity with its intensity
      float weight = uGlowIntensities[i] * iconProximity;
      
      trailGlowColor += uGlowColors[i] * weight;
      totalGlowWeight += weight;
    }
    
    // Apply glow only where trail exists - this is the key to "smear" behavior
    if (totalGlowWeight > 0.01) {
      trailGlowColor /= totalGlowWeight;
      
      // The trail mask makes glow fade along the trail path
      // Using pow to make the falloff sharper at the edges
      float glowAmount = glowTrailMask * uGradientStrength * min(totalGlowWeight, 1.0);
      glowAmount = pow(glowAmount, 0.7); // Slightly sharper falloff
      
      // Screen blend for luminous glow
      vec3 screenBlend = 1.0 - (1.0 - color) * (1.0 - trailGlowColor * glowAmount);
      color = mix(color, screenBlend, glowAmount * 0.6);
    }
  }
  
  // === ICON GLOW: BLOOM ON TRAIL ===
  // Bloom also follows the trail, creating a glowing smear effect
  if (uBloomIntensity > 0.0 && glowTrailMask > 0.02 && uGlowEnabled > 0.5) {
    vec3 bloomColor = vec3(0.0);
    float bloomWeight = 0.0;
    
    for (int i = 0; i < ${MAX_GLOW_SOURCES}; i++) {
      if (i >= uGlowCount) break;
      
      float iconDist = length(pixelNDC - uGlowPositions[i]);
      
      // Bloom radius for how far the glow spreads from icons
      float bloomProximity = 1.0 - smoothstep(0.0, uBloomRadius * 1.2, iconDist);
      bloomProximity = pow(bloomProximity, 1.2);
      
      float weight = uGlowIntensities[i] * bloomProximity;
      bloomColor += uGlowColors[i] * weight;
      bloomWeight += weight;
    }
    
    // Apply bloom modulated by trail - creates the smear glow
    if (bloomWeight > 0.01) {
      bloomColor /= bloomWeight;
      
      // Trail controls where bloom appears
      float bloomAmount = glowTrailMask * uBloomIntensity * min(bloomWeight, 1.0);
      
      // Additive blend for bright glow
      color += bloomColor * bloomAmount * 0.25;
    }
  }
  
  gl_FragColor = vec4(color, 1.0);
}
`

// Trail texture shader - renders the influence field that fades over time
// Stores: R = influence amount (that's it - no velocity to prevent spinning)
// The brush is circular - simple and stable
const trailFragmentShader = /* glsl */ `
uniform sampler2D uPrevTrail;
uniform vec2 uMouse;
uniform float uDecay;
uniform float uInfluenceRadius;
uniform float uMouseActive; // 0-1, how active the mouse is (based on movement)
uniform float uReturnDecay; // How fast to return to normal when mouse stops
uniform float uAspect; // Aspect ratio for circular brush

varying vec2 vUv;

void main() {
  // Get previous trail influence
  float prevInfluence = texture2D(uPrevTrail, vUv).r;
  
  // Always decay the trail - use faster decay when mouse is inactive
  float effectiveDecay = mix(uReturnDecay, uDecay, uMouseActive);
  float decayedInfluence = prevInfluence * effectiveDecay;
  
  // Convert mouse from -1,1 to 0,1 UV space
  vec2 mouseUv = uMouse * 0.5 + 0.5;
  
  // Calculate distance with aspect ratio correction for circular brush
  vec2 delta = vUv - mouseUv;
  delta.x *= uAspect; // Correct for aspect ratio
  float dist = length(delta);
  
  // Current influence based on distance - circular brush
  float currentInfluence = 1.0 - smoothstep(0.0, uInfluenceRadius, dist);
  currentInfluence = pow(currentInfluence, 1.5);
  
  // Scale by mouse activity
  currentInfluence *= uMouseActive;
  
  // Trail is MAX of decayed previous and current brush
  // This "paints" the trail - once painted, pixels stay painted (with decay)
  float finalInfluence = max(decayedInfluence, currentInfluence);
  
  // Only store influence - no velocity means no spinning
  gl_FragColor = vec4(finalInfluence, 0.5, 0.5, 1.0);
}
`

// Create the main grid shader material
const GridMaterial = shaderMaterial(
  {
    uTexture: null,
    uWireframeTexture: null,
    uTrailTexture: null,
    uMouse: new Vector2(0, 0),
    uMouseVelocity: new Vector2(0, 0),
    uGridSize: new Vector2(30, 30),
    uShiftAmount: 0.05,
    uDragStrength: 0.5,
    uLineWidth: 0.02,
    uLineColor: new Vector3(0, 0, 0),
    uLineOpacity: 0.1,
    uResolution: new Vector2(1, 1),
    uInfluenceRadius: 0.5,
    uTrailStrength: 0.8,
    uMouseActive: 1.0,
    uChromaticAberration: 0.0,
    uXraySize: 1.0, // Single control (was width * depth)
    uXraySoftness: 0.3,
    uXrayGlow: 0.5,
    uXrayColorTint: 0.5, // How much icon colors tint the x-ray view
    uColorVibrancy: 0.5, // Boost saturation of icon colors
    uLetterBrightness: 0.3, // Brighten the letters
    uColorRadius: 1.5, // How far icon colors spread
    uGridVisibleByDefault: 1.0, // 1.0 = always visible, 0.0 = only on xray
    uGlowEnabled: 1.0, // 1.0 = glow effects on, 0.0 = off
    // Icon glow uniforms
    uGlowCount: 0,
    uGlowPositions: Array(MAX_GLOW_SOURCES)
      .fill(null)
      .map(() => new Vector2(0, 0)),
    uGlowColors: Array(MAX_GLOW_SOURCES)
      .fill(null)
      .map(() => new Color(0, 0, 0)),
    uGlowIntensities: Array(MAX_GLOW_SOURCES).fill(0),
    uGradientStrength: 0.15,
    uGradientRadius: 0.5,
    uBloomIntensity: 0.3,
    uBloomThreshold: 0.6,
    uBloomRadius: 0.4
  },
  vertexShader,
  fragmentShader
)

// Create the trail shader material
const TrailMaterial = shaderMaterial(
  {
    uPrevTrail: null,
    uMouse: new Vector2(0, 0),
    uDecay: 0.95,
    uInfluenceRadius: 0.5,
    uMouseActive: 1.0,
    uReturnDecay: 0.92, // Faster decay when returning to normal
    uAspect: 1.0 // Aspect ratio for circular brush
  },
  vertexShader,
  trailFragmentShader
)

// Extend so they're available as JSX elements
extend({ GridMaterial, TrailMaterial })

// Type augmentation for R3F
declare global {
  namespace JSX {
    interface IntrinsicElements {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      gridMaterial: any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      trailMaterial: any
    }
  }
}

interface GridEffectProps {
  texture: THREE.Texture | null
  wireframeTexture?: THREE.Texture | null
  gridWidth?: number
  gridHeight?: number
  maxIntensity?: number
  shiftAmount?: number
  dragStrength?: number
  lineColor?: string
  lineOpacity?: number
  influenceRadius?: number
  trailDecay?: number
  trailStrength?: number
  returnSpeed?: number
  chromaticAberration?: number
  xraySize?: number // Single control for x-ray intensity
  xraySoftness?: number
  xrayGlow?: number
  xrayColorTint?: number // How much icon colors tint the x-ray view
  colorVibrancy?: number // Boost saturation of icon colors
  letterBrightness?: number // Brighten the letters
  colorRadius?: number // How far icon colors spread
  gridVisibleByDefault?: boolean // Whether grid is always visible or only on xray
  glowEnabled?: boolean // Whether glow effects are enabled
  // Icon glow props
  glowPositions?: THREE.Vector2[]
  glowColors?: THREE.Color[]
  glowIntensities?: number[]
  glowCount?: number
  gradientStrength?: number
  gradientRadius?: number
  bloomIntensity?: number
  bloomThreshold?: number
  bloomRadius?: number
}

export function GridEffect({
  texture,
  wireframeTexture = null,
  gridWidth = 30,
  gridHeight = 30,
  maxIntensity = 1.0,
  shiftAmount = 0.05,
  dragStrength = 0.5,
  lineColor = '#000000',
  lineOpacity = 0.1,
  influenceRadius = 0.5,
  trailDecay = 0.95,
  trailStrength = 0.8,
  returnSpeed = 0.02,
  chromaticAberration = 0.0,
  xraySize = 1.0,
  xraySoftness = 0.3,
  xrayGlow = 0.5,
  xrayColorTint = 0.5,
  colorVibrancy = 0.5,
  letterBrightness = 0.3,
  colorRadius = 1.5,
  gridVisibleByDefault = true,
  glowEnabled = true,
  // Icon glow props
  glowPositions = [],
  glowColors = [],
  glowIntensities = [],
  glowCount = 0,
  gradientStrength = 0.15,
  gradientRadius = 0.5,
  bloomIntensity = 0.3,
  bloomThreshold = 0.6,
  bloomRadius = 0.4
}: GridEffectProps) {
  const materialRef = useRef<ShaderMaterial>(null)
  const trailMaterialRef = useRef<ShaderMaterial>(null)
  const mouseRef = useRef(new Vector2(0, 0))
  const lastMouseRef = useRef(new Vector2(0, 0))
  const mouseVelocityRef = useRef(new Vector2(0, 0)) // Normalized velocity direction
  const smoothedVelocityDirRef = useRef(new Vector2(0, 0)) // Smoothed velocity direction
  const activeMultiplierRef = useRef(0) // 0 = no effect, 1 = full effect
  const smoothedVelocityRef = useRef(0) // Smoothed mouse velocity for easing
  const smoothedTargetRef = useRef(0) // Second layer of smoothing for the target
  const { gl, size } = useThree()

  // Create ping-pong trail buffers for the trail effect
  const trailTargetA = useRef<THREE.WebGLRenderTarget | null>(null)
  const trailTargetB = useRef<THREE.WebGLRenderTarget | null>(null)
  const currentTrailTarget = useRef<'A' | 'B'>('A')

  // Initialize trail render targets - use lower resolution for trail (it's just influence data)
  useEffect(() => {
    // Trail doesn't need full resolution - 1/4 size is plenty
    const trailWidth = Math.max(128, Math.floor(size.width / 4))
    const trailHeight = Math.max(128, Math.floor(size.height / 4))

    const options = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      // Use HalfFloat instead of Float - less GPU memory
      type: THREE.HalfFloatType
    }

    // Dispose old targets before creating new ones
    trailTargetA.current?.dispose()
    trailTargetB.current?.dispose()

    trailTargetA.current = new THREE.WebGLRenderTarget(trailWidth, trailHeight, options)
    trailTargetB.current = new THREE.WebGLRenderTarget(trailWidth, trailHeight, options)

    return () => {
      trailTargetA.current?.dispose()
      trailTargetB.current?.dispose()
      trailTargetA.current = null
      trailTargetB.current = null
    }
  }, [size.width, size.height])

  // Trail scene and camera for rendering trail updates
  const trailScene = useRef(new THREE.Scene())
  const trailCamera = useRef(new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1))
  const trailQuad = useRef<THREE.Mesh | null>(null)

  // Create trail quad
  useEffect(() => {
    const geometry = new THREE.PlaneGeometry(2, 2)
    const material = new TrailMaterial()
    trailQuad.current = new THREE.Mesh(geometry, material)
    trailScene.current.add(trailQuad.current)
    trailMaterialRef.current = material

    return () => {
      geometry.dispose()
      material.dispose()
      if (trailQuad.current) {
        trailScene.current.remove(trailQuad.current)
      }
    }
  }, [])

  // Parse hex color to RGB vector
  const lineColorVec = useRef(new Vector3(0, 0, 0))
  useEffect(() => {
    const hex = lineColor.replace('#', '')
    const r = parseInt(hex.substring(0, 2), 16) / 255
    const g = parseInt(hex.substring(2, 4), 16) / 255
    const b = parseInt(hex.substring(4, 6), 16) / 255
    lineColorVec.current.set(r, g, b)
  }, [lineColor])

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

  // Update uniforms and render trail each frame
  useFrame(() => {
    if (!materialRef.current || !trailMaterialRef.current) return
    if (!trailTargetA.current || !trailTargetB.current) return
    // Skip if WebGL context is lost
    if (gl.getContext().isContextLost()) return

    // Calculate mouse velocity to determine if mouse is moving
    const dx = mouseRef.current.x - lastMouseRef.current.x
    const dy = mouseRef.current.y - lastMouseRef.current.y
    const mouseSpeed = Math.sqrt(dx * dx + dy * dy)

    // Calculate velocity direction, scaled by speed
    // Instead of normalizing, keep the magnitude so it naturally decays when slow
    if (mouseSpeed > 0.0005) {
      // Scale velocity - faster movement = stronger direction signal
      const scaledSpeed = Math.min(mouseSpeed * 20, 1.0) // Cap at 1.0
      mouseVelocityRef.current.set((dx / mouseSpeed) * scaledSpeed, (dy / mouseSpeed) * scaledSpeed)
    } else {
      // When mouse stops, decay velocity quickly toward zero
      mouseVelocityRef.current.x *= 0.9
      mouseVelocityRef.current.y *= 0.9
    }

    // Heavy smoothing on velocity direction to prevent jitter
    // This is the key to smooth drag - direction changes must be gradual
    const velocitySmooth = 0.04
    smoothedVelocityDirRef.current.x +=
      (mouseVelocityRef.current.x - smoothedVelocityDirRef.current.x) * velocitySmooth
    smoothedVelocityDirRef.current.y +=
      (mouseVelocityRef.current.y - smoothedVelocityDirRef.current.y) * velocitySmooth

    // Update last mouse position
    lastMouseRef.current.copy(mouseRef.current)

    // === LAYER 1: Smooth the raw velocity ===
    // Heavier smoothing for gradual response, no jumping
    const velocitySmoothing = 0.05
    smoothedVelocityRef.current =
      smoothedVelocityRef.current * (1 - velocitySmoothing) + mouseSpeed * velocitySmoothing

    // Map smoothed velocity to activity level - NO threshold, linear response for slow movements
    const velocityCap = 0.03

    // Linear mapping for slow speeds, then curve for faster speeds
    // This ensures slow movements still register smoothly
    const normalizedVelocity = Math.min(1.5, smoothedVelocityRef.current / velocityCap)

    // Gentle easing curve - sqrt for smoother low-end response
    const rawTarget = Math.sqrt(normalizedVelocity) * Math.min(normalizedVelocity + 0.5, 1.5)

    // === LAYER 2: Smooth the target itself ===
    // Gentler smoothing for both rise and fall - prevents jumping
    const targetRiseSpeed = 0.06
    const targetFallSpeed = 0.04
    const targetDiff = rawTarget - smoothedTargetRef.current
    const targetSmoothing = targetDiff > 0 ? targetRiseSpeed : targetFallSpeed
    smoothedTargetRef.current += targetDiff * targetSmoothing

    // === LAYER 3: Smooth interpolation to final value ===
    // Gentler interpolation for smoother easing
    const rampUpSpeed = 0.08
    const decaySpeed = returnSpeed * 1.5

    const diff = smoothedTargetRef.current - activeMultiplierRef.current
    const interpolationSpeed = diff > 0 ? rampUpSpeed : decaySpeed

    // Smooth exponential interpolation toward smoothed target
    activeMultiplierRef.current += diff * interpolationSpeed

    // Hard cutoff to prevent floating point lingering
    if (activeMultiplierRef.current < 0.001 && smoothedTargetRef.current < 0.002) {
      activeMultiplierRef.current = 0
      smoothedTargetRef.current = 0
    }

    // Clamp to valid range - use maxIntensity to cap the effect
    activeMultiplierRef.current = Math.max(0, Math.min(maxIntensity, activeMultiplierRef.current))

    // Scale influence radius and shift amount based on the active multiplier
    // This persists the effect strength even after mouse stops
    // activeMultiplierRef decays very slowly, so effect lingers
    const velocityScale = activeMultiplierRef.current
    const dynamicInfluenceRadius = influenceRadius * Math.max(0.1, velocityScale)
    const dynamicShiftAmount = shiftAmount * velocityScale

    // Determine read/write targets for ping-pong
    const readTarget =
      currentTrailTarget.current === 'A' ? trailTargetB.current : trailTargetA.current
    const writeTarget =
      currentTrailTarget.current === 'A' ? trailTargetA.current : trailTargetB.current

    // Update trail material uniforms
    const trailMat = trailMaterialRef.current
    trailMat.uniforms.uPrevTrail.value = readTarget.texture
    ;(trailMat.uniforms.uMouse.value as Vector2).copy(mouseRef.current)
    trailMat.uniforms.uDecay.value = trailDecay
    trailMat.uniforms.uInfluenceRadius.value = dynamicInfluenceRadius
    trailMat.uniforms.uMouseActive.value = activeMultiplierRef.current
    // Return decay - how fast trail fades when mouse stops
    // Base decay of 0.96 ensures it always fades, returnSpeed makes it faster
    // returnSpeed 0 → decay 0.96, returnSpeed 0.3 → decay 0.90
    trailMat.uniforms.uReturnDecay.value = 0.96 - returnSpeed * 0.2
    // Aspect ratio for circular brush
    trailMat.uniforms.uAspect.value = size.width / size.height

    // Render trail update to write target
    gl.setRenderTarget(writeTarget)
    gl.render(trailScene.current, trailCamera.current)
    gl.setRenderTarget(null)

    // Flip ping-pong
    currentTrailTarget.current = currentTrailTarget.current === 'A' ? 'B' : 'A'

    // Update main grid material uniforms
    const mat = materialRef.current
    ;(mat.uniforms.uMouse.value as Vector2).copy(mouseRef.current)
    ;(mat.uniforms.uMouseVelocity.value as Vector2).copy(smoothedVelocityDirRef.current)
    mat.uniforms.uTexture.value = texture
    mat.uniforms.uWireframeTexture.value = wireframeTexture
    mat.uniforms.uTrailTexture.value = writeTarget.texture
    ;(mat.uniforms.uGridSize.value as Vector2).set(gridWidth, gridHeight)
    mat.uniforms.uShiftAmount.value = dynamicShiftAmount
    mat.uniforms.uDragStrength.value = dragStrength
    ;(mat.uniforms.uLineColor.value as Vector3).copy(lineColorVec.current)
    mat.uniforms.uLineOpacity.value = lineOpacity
    ;(mat.uniforms.uResolution.value as Vector2).set(size.width, size.height)
    mat.uniforms.uInfluenceRadius.value = dynamicInfluenceRadius
    mat.uniforms.uTrailStrength.value = trailStrength
    mat.uniforms.uMouseActive.value = activeMultiplierRef.current
    mat.uniforms.uChromaticAberration.value = chromaticAberration
    mat.uniforms.uXraySize.value = xraySize
    mat.uniforms.uXraySoftness.value = xraySoftness
    mat.uniforms.uXrayGlow.value = xrayGlow
    mat.uniforms.uXrayColorTint.value = xrayColorTint
    mat.uniforms.uColorVibrancy.value = colorVibrancy
    mat.uniforms.uLetterBrightness.value = letterBrightness
    mat.uniforms.uColorRadius.value = colorRadius
    mat.uniforms.uGridVisibleByDefault.value = gridVisibleByDefault ? 1.0 : 0.0
    mat.uniforms.uGlowEnabled.value = glowEnabled ? 1.0 : 0.0

    // Update glow uniforms
    mat.uniforms.uGlowCount.value = glowCount
    mat.uniforms.uGradientStrength.value = gradientStrength
    mat.uniforms.uGradientRadius.value = gradientRadius
    mat.uniforms.uBloomIntensity.value = bloomIntensity
    mat.uniforms.uBloomThreshold.value = bloomThreshold
    mat.uniforms.uBloomRadius.value = bloomRadius

    // Update glow arrays
    for (let i = 0; i < MAX_GLOW_SOURCES; i++) {
      if (i < glowPositions.length) {
        ;(mat.uniforms.uGlowPositions.value as Vector2[])[i].copy(glowPositions[i])
      }
      if (i < glowColors.length) {
        ;(mat.uniforms.uGlowColors.value as Color[])[i].copy(glowColors[i])
      }
      if (i < glowIntensities.length) {
        ;(mat.uniforms.uGlowIntensities.value as number[])[i] = glowIntensities[i]
      }
    }
  })

  return <gridMaterial ref={materialRef} depthTest={false} depthWrite={false} />
}
