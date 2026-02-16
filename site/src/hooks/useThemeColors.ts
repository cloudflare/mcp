import { useTheme } from '@/components/ThemeProvider'
import { useMemo } from 'react'

// Colors for the Hero 3D scene based on current theme
export function useHeroColors() {
  // Try to get theme from context, fallback to light mode if not available (SSR)
  let theme = 'light'
  try {
    const context = useTheme()
    theme = context.theme
  } catch {
    // Context not available during SSR, use default light theme
    theme = 'light'
  }

  return useMemo(() => {
    if (theme === 'dark') {
      return {
        background: '#000000',
        gridLine: '#ffffff',
        solidText: '#e5e5e5',
        wireframe: '#ffffff',
        // Icon card base colors - same as light mode (colorful)
        iconBoxBg: '#000000', // Black icon background (inverted from white)
        labelText: '#000000', // White label text (same as light mode)
        // Monochrome overlay uses white in dark mode (inverted from black)
        monochromeColor: '#ffffff',
        // Shader parameters for dark mode
        edgeBrightness: -0.3,
        lightIntensity: 0.0,
        colorVibrancy: 2.0,
        xrayColorTint: 0.0, // No color tint in dark mode
        gridVisibleByDefault: false, // Grid only visible on xray in dark mode
        glowEnabled: false // No glow effects in dark mode
      }
    }
    // Light mode (default)
    return {
      background: '#ffffff',
      gridLine: '#000000',
      solidText: '#333333',
      wireframe: '#000000',
      // Icon card base colors
      iconBoxBg: '#ffffff', // White icon background
      labelText: '#ffffff', // White label text
      // Monochrome overlay uses black in light mode
      monochromeColor: '#000000',
      // Shader parameters for light mode
      edgeBrightness: 0.7,
      lightIntensity: 1.2,
      colorVibrancy: 1.5,
      xrayColorTint: 0.15, // Normal color tint in light mode
      gridVisibleByDefault: true, // Grid always visible in light mode
      glowEnabled: true // Glow effects enabled in light mode
    }
  }, [theme])
}
