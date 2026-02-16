import { createContext, useContext, useState, useEffect, type PropsWithChildren } from 'react'
import { getInitialTheme, persistTheme, type Theme } from '@/lib/theme'

type ThemeContextValue = {
  theme: Theme
  setTheme: (theme: Theme) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: PropsWithChildren) {
  const [theme, setThemeState] = useState<Theme>('light')
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const initialTheme = getInitialTheme()
    setThemeState(initialTheme)
    document.documentElement.setAttribute('data-mode', initialTheme)
    setMounted(true)
  }, [])

  function setTheme(newTheme: Theme) {
    setThemeState(newTheme)
    persistTheme(newTheme)
  }

  if (!mounted) return <>{children}</>

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
