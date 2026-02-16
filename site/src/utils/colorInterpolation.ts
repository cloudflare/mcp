/**
 * Interpolates between the glow spectrum colors based on position (0-1)
 * 0.0 = blue, 0.5 = purple, 1.0 = orange
 */
export function getGlowColor(position: number): string {
  // Clamp position to 0-1
  const t = Math.max(0, Math.min(1, position))

  const colors = [
    { r: 65, g: 105, b: 225 }, // blue (#4169E1)
    { r: 155, g: 89, b: 182 }, // purple (#9B59B6)
    { r: 230, g: 126, b: 34 } // orange (#E67E22)
  ]

  // Interpolate between color stops
  if (t <= 0.5) {
    const localT = t * 2
    return interpolateRGB(colors[0], colors[1], localT)
  } else {
    const localT = (t - 0.5) * 2
    return interpolateRGB(colors[1], colors[2], localT)
  }
}

function interpolateRGB(
  c1: { r: number; g: number; b: number },
  c2: { r: number; g: number; b: number },
  t: number
): string {
  const r = Math.round(c1.r + (c2.r - c1.r) * t)
  const g = Math.round(c1.g + (c2.g - c1.g) * t)
  const b = Math.round(c1.b + (c2.b - c1.b) * t)
  return `rgb(${r}, ${g}, ${b})`
}
