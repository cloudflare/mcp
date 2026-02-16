import { extend } from '@react-three/fiber'
import { shaderMaterial } from '@react-three/drei'
import * as THREE from 'three'

// Maximum number of glow sources supported
const MAX_GLOW_SOURCES = 8

// Custom shader material for textured letters with noise and rim glow
export const TexturedLetterMaterial = shaderMaterial(
  {
    uTime: 0,
    uBaseColor: new THREE.Color('#000000'),
    uNoiseScale: 8.0,
    uNoiseStrength: 0.15,
    uGrainAmount: 0.08,
    // Lighting uniforms
    uLightIntensity: 1.0,
    uLightDirection: new THREE.Vector3(1, 1, 1),
    uEdgeBrightness: 0.1, // Positive = lighter edges, negative = darker edges
    // Rim glow uniforms
    uRimGlowStrength: 0.5,
    uRimGlowWidth: 0.3,
    uGlowCount: 0,
    // Arrays for glow source data (positions in NDC, colors, intensities)
    uGlowPositions: Array(MAX_GLOW_SOURCES)
      .fill(null)
      .map(() => new THREE.Vector2(0, 0)),
    uGlowColors: Array(MAX_GLOW_SOURCES)
      .fill(null)
      .map(() => new THREE.Color(0, 0, 0)),
    uGlowIntensities: Array(MAX_GLOW_SOURCES).fill(0)
  },
  // Vertex shader
  `
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vPosition;
    varying vec3 vWorldPosition;
    varying vec4 vScreenPosition;
    
    void main() {
      vUv = uv;
      vNormal = normalize(normalMatrix * normal);
      vPosition = position;
      
      // Calculate world position for proximity calculations
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vWorldPosition = worldPos.xyz;
      
      // Calculate screen position for glow proximity
      vec4 screenPos = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      vScreenPosition = screenPos;
      
      gl_Position = screenPos;
    }
  `,
  // Fragment shader
  `
    uniform float uTime;
    uniform vec3 uBaseColor;
    uniform float uNoiseScale;
    uniform float uNoiseStrength;
    uniform float uGrainAmount;
    // Lighting uniforms
    uniform float uLightIntensity;
    uniform vec3 uLightDirection;
    uniform float uEdgeBrightness;
    
    // Rim glow uniforms
    uniform float uRimGlowStrength;
    uniform float uRimGlowWidth;
    uniform int uGlowCount;
    uniform vec2 uGlowPositions[${MAX_GLOW_SOURCES}];
    uniform vec3 uGlowColors[${MAX_GLOW_SOURCES}];
    uniform float uGlowIntensities[${MAX_GLOW_SOURCES}];
    
    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vPosition;
    varying vec3 vWorldPosition;
    varying vec4 vScreenPosition;
    
    // Simplex 3D noise
    vec4 permute(vec4 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
    vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
    
    float snoise(vec3 v) {
      const vec2 C = vec2(1.0/6.0, 1.0/3.0);
      const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
      
      vec3 i = floor(v + dot(v, C.yyy));
      vec3 x0 = v - i + dot(i, C.xxx);
      
      vec3 g = step(x0.yzx, x0.xyz);
      vec3 l = 1.0 - g;
      vec3 i1 = min(g.xyz, l.zxy);
      vec3 i2 = max(g.xyz, l.zxy);
      
      vec3 x1 = x0 - i1 + C.xxx;
      vec3 x2 = x0 - i2 + C.yyy;
      vec3 x3 = x0 - D.yyy;
      
      i = mod(i, 289.0);
      vec4 p = permute(permute(permute(
        i.z + vec4(0.0, i1.z, i2.z, 1.0))
        + i.y + vec4(0.0, i1.y, i2.y, 1.0))
        + i.x + vec4(0.0, i1.x, i2.x, 1.0));
      
      float n_ = 1.0/7.0;
      vec3 ns = n_ * D.wyz - D.xzx;
      
      vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
      
      vec4 x_ = floor(j * ns.z);
      vec4 y_ = floor(j - 7.0 * x_);
      
      vec4 x = x_ * ns.x + ns.yyyy;
      vec4 y = y_ * ns.x + ns.yyyy;
      vec4 h = 1.0 - abs(x) - abs(y);
      
      vec4 b0 = vec4(x.xy, y.xy);
      vec4 b1 = vec4(x.zw, y.zw);
      
      vec4 s0 = floor(b0) * 2.0 + 1.0;
      vec4 s1 = floor(b1) * 2.0 + 1.0;
      vec4 sh = -step(h, vec4(0.0));
      
      vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
      vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
      
      vec3 p0 = vec3(a0.xy, h.x);
      vec3 p1 = vec3(a0.zw, h.y);
      vec3 p2 = vec3(a1.xy, h.z);
      vec3 p3 = vec3(a1.zw, h.w);
      
      vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
      p0 *= norm.x;
      p1 *= norm.y;
      p2 *= norm.z;
      p3 *= norm.w;
      
      vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
      m = m * m;
      return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
    }
    
    // Fractal brownian motion for more complex texture
    float fbm(vec3 p) {
      float value = 0.0;
      float amplitude = 0.5;
      float frequency = 1.0;
      
      for (int i = 0; i < 4; i++) {
        value += amplitude * snoise(p * frequency);
        amplitude *= 0.5;
        frequency *= 2.0;
      }
      return value;
    }
    
    // Random function for film grain
    float random(vec2 st) {
      return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453123);
    }
    
    void main() {
      // Create multi-layered noise texture based on 3D position
      vec3 noisePos = vPosition * uNoiseScale;
      
      // Layer 1: Base noise pattern
      float noise1 = fbm(noisePos);
      
      // Layer 2: Finer detail noise
      float noise2 = snoise(noisePos * 3.0 + vec3(100.0)) * 0.5;
      
      // Layer 3: Very fine scratchy detail
      float noise3 = snoise(noisePos * 12.0 + vec3(200.0)) * 0.15;
      
      // Combine noise layers
      float combinedNoise = noise1 + noise2 * 0.3 + noise3 * 0.15;
      
      // When noiseStrength is 0, textureValue should be 1.0 (no darkening)
      // When noiseStrength > 0, add noise variation centered around 1.0
      float textureValue = 1.0 + combinedNoise * uNoiseStrength;
      
      // Lighting based on normal and controllable light direction
      vec3 lightDir = normalize(uLightDirection);
      float diffuse = max(dot(vNormal, lightDir), 0.0);
      // Remap diffuse to avoid completely dark areas
      float lighting = 0.6 + diffuse * 0.4 * uLightIntensity;
      
      // Add film grain effect
      float grain = (random(vUv * 1000.0 + uTime * 0.1) - 0.5) * uGrainAmount;
      
      // Calculate final color
      vec3 finalColor = uBaseColor * textureValue * lighting;
      finalColor += grain;
      
      // Edge brightness - positive makes edges lighter, negative makes them darker
      // This creates a "lighter material" look on the sides
      float edgeFactor = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 1.5);
      finalColor += vec3(edgeFactor * uEdgeBrightness);
      
      // === RIM GLOW FROM ICON COLORS ===
      // Calculate Fresnel (rim) factor - stronger on edges viewed at grazing angles
      vec3 viewDir = normalize(-vWorldPosition); // Assuming camera at origin
      float fresnel = 1.0 - max(dot(vNormal, viewDir), 0.0);
      fresnel = pow(fresnel, 2.0 - uRimGlowWidth * 1.5); // Width controls falloff
      
      // Get screen position in NDC (-1 to 1)
      vec2 screenNDC = vScreenPosition.xy / vScreenPosition.w;
      
      // Accumulate glow color from nearby icons
      vec3 glowColor = vec3(0.0);
      float totalGlowWeight = 0.0;
      
      for (int i = 0; i < ${MAX_GLOW_SOURCES}; i++) {
        if (i >= uGlowCount) break;
        
        // Calculate distance from this fragment to the glow source (in NDC space)
        float dist = length(screenNDC - uGlowPositions[i]);
        
        // Proximity falloff - closer icons contribute more
        // Use a fairly wide radius so multiple icons can contribute
        float proximity = 1.0 - smoothstep(0.0, 1.5, dist);
        proximity = pow(proximity, 1.5); // Sharper falloff
        
        // Combine intensity with proximity
        float weight = uGlowIntensities[i] * proximity;
        
        // Accumulate weighted color
        glowColor += uGlowColors[i] * weight;
        totalGlowWeight += weight;
      }
      
      // Normalize glow color if we have contributions
      if (totalGlowWeight > 0.01) {
        glowColor /= totalGlowWeight;
        
        // Apply glow with Fresnel and overall strength
        float glowAmount = fresnel * uRimGlowStrength * min(totalGlowWeight, 1.0);
        
        // Add glow as additive blend to make it luminous
        finalColor += glowColor * glowAmount;
      }
      
      gl_FragColor = vec4(finalColor, 1.0);
    }
  `
)

// Extend Three.js with our custom material
extend({ TexturedLetterMaterial })

// TypeScript declaration for the custom material
declare global {
  namespace JSX {
    interface IntrinsicElements {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      texturedLetterMaterial: any
    }
  }
}
