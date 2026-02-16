import type { ComponentProps } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost'

interface PillButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant
}

interface PillLinkProps extends ComponentProps<'a'> {
  variant?: ButtonVariant
}

const baseClasses = `
  relative inline-flex items-center justify-center gap-2
  whitespace-nowrap font-medium rounded-full
  px-6 py-3
  transition-all duration-200 ease-out
  active:scale-[0.98] active:translate-y-[0.5px]
  focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2
`

const variantClasses: Record<ButtonVariant, string> = {
  primary: `
    bg-(--color-surface) text-(--color-surface-secondary)
    hover:opacity-90
    focus-visible:outline-(--color-surface)
  `,
  secondary: `
    border border-(--color-border) bg-transparent
    text-(--color-surface)
    hover:bg-(--color-subtle)
    focus-visible:outline-(--color-border)
  `,
  ghost: `
    bg-transparent text-(--color-surface)
    hover:bg-(--color-subtle)
    focus-visible:outline-(--color-border)
  `
}

function cn(...classes: (string | undefined)[]) {
  return classes
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function PillButton({ variant = 'primary', className, children, ...props }: PillButtonProps) {
  return (
    <button type="button" className={cn(baseClasses, variantClasses[variant], className)} {...props}>
      {children}
    </button>
  )
}

export function PillLink({ variant = 'primary', className, children, ...props }: PillLinkProps) {
  return (
    <a className={cn(baseClasses, variantClasses[variant], className)} {...props}>
      {children}
    </a>
  )
}
