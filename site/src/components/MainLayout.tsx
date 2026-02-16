import { ThemeProvider } from './ThemeProvider'
import { Header } from './Header'
import { SideRulers, DotPatternBackground } from './ui'

interface MainLayoutProps {
  children: React.ReactNode
}

export function MainLayout({ children }: MainLayoutProps) {
  return (
    <ThemeProvider>
      <div className="relative min-h-screen bg-(--color-surface-secondary)">
        <DotPatternBackground />
        <SideRulers />
        <Header />
        <main className="relative z-10 mx-auto min-h-screen w-full max-w-[var(--max-width)] border-x border-dashed border-(--color-border)">
          {children}
        </main>
      </div>
    </ThemeProvider>
  )
}
