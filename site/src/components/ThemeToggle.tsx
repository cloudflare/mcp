import { Sun, Moon } from '@phosphor-icons/react'
import { Button } from '@cloudflare/kumo/components/button'
import { useTheme } from './ThemeProvider'

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  function toggleTheme() {
    setTheme(theme === 'light' ? 'dark' : 'light')
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onPress={toggleTheme}
      aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
    >
      {theme === 'light' ? <Sun size={18} weight="bold" /> : <Moon size={18} weight="bold" />}
    </Button>
  )
}
