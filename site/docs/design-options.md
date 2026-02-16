# Cloudflare Visual Design Options

This document outlines three levels of visual redesign for mcp.cloudflare.com,
based on analysis of sandbox.cloudflare.com, agents.cloudflare.com, and
workers.cloudflare.com.

---

## Option 1: Light Touch (Recommended Starting Point)

Add key visual elements while keeping the current layout structure.

### Elements Added

- Corner diagonal marks on code blocks
- Background dot pattern behind content
- Side ruler marks (fixed position)
- Cloudflare orange accent colors
- Enhanced code blocks with syntax highlighting
- Pill-shaped CTA buttons

### New Components

| Component | File | Description |
|-----------|------|-------------|
| `CornerMarks` | `src/components/ui/CornerMarks.tsx` | 17x17px diagonal SVG lines at corners |
| `DotPattern` | `src/components/ui/DotPattern.tsx` | SVG background pattern with 12px spacing |
| `SideRulers` | `src/components/ui/SideRulers.tsx` | Fixed vertical rulers with tick marks |
| `CodeBlock` | `src/components/ui/CodeBlock.tsx` | Enhanced with terminal chrome & syntax highlighting |
| `PillButton` | `src/components/ui/PillButton.tsx` | Rounded-full buttons with hover effects |

### CSS Additions

```css
:root {
  --cf-orange: #F6821F;
  --cf-orange-light: #FBAD41;
  --cf-orange-dim: rgba(246, 130, 31, 0.1);
}
```

### Implementation Effort

- ~4-6 hours of development
- Minimal structural changes
- Drop-in component replacements

---

## Option 2: Medium Redesign

Rework content sections with a grid-based layout and multiple decorative elements.

### Overview

This option introduces an 8-column CSS grid system and adds more sophisticated
visual elements while maintaining the general page flow.

### Changes from Light Touch

#### Grid Layout

Replace single-column content with 8-column CSS grid:

```tsx
<section className="lg:grid lg:grid-cols-8 border-l">
  <div
    className="border-r border-b p-8"
    style={{
      gridColumn: 'span 5',
      gridRow: 'span 2'
    }}
  >
    {/* Content */}
  </div>
  <div className="border-r border-b aspect-square">
    {/* Decorative cell with icon */}
  </div>
</section>
```

#### Section Structure

Content sections use CSS variables for dynamic positioning:

```css
.grid-cell {
  grid-column-start: var(--x);
  grid-row-start: var(--y);
  grid-column-end: span var(--width);
  grid-row-end: span var(--height);
}
```

#### New Components

| Component | Description |
|-----------|-------------|
| `GridSection` | Wrapper for 8-column grid layouts |
| `GridCell` | Individual cell with border and aspect ratio |
| `SectionHeader` | Numbered headers like agents.cloudflare.com |
| `IconCell` | Circular icon in grid cell |
| `CornerBrackets` | 64px L-shaped brackets framing sections |
| `AnimatedGridLines` | Dashed line animations on scroll |

#### Section Header Pattern (from agents.cloudflare.com)

```tsx
<header className="border-b border-dashed border-cf-orange p-6">
  <h3 className="text-sm text-cf-orange">
    <span className="tabular-nums">01</span> | Getting Started
  </h3>
</header>
```

#### Code Block Enhancements

- Full terminal window chrome (3 colored dots)
- Shiki syntax highlighting with Cloudflare orange theme
- Animated cursor in terminal blocks
- File tabs for multi-file examples
- Corner diagonal marks

```tsx
<div className="relative">
  {/* Corner marks */}
  <CornerMarks />

  {/* Terminal header */}
  <div className="flex gap-1.5 p-3 border-b">
    <div className="w-3 h-3 rounded-full bg-red-400" />
    <div className="w-3 h-3 rounded-full bg-yellow-400" />
    <div className="w-3 h-3 rounded-full bg-green-400" />
    <span className="ml-2 text-xs text-muted">{filename}</span>
  </div>

  {/* Code content */}
  <pre className="p-4">
    <code>{/* Syntax highlighted code */}</code>
  </pre>
</div>
```

#### Animated Grid Lines (workers.cloudflare.com style)

Horizontal dashed lines that animate on scroll:

```tsx
function AnimatedGridLine({ className }: { className?: string }) {
  return (
    <svg
      className={cn(
        "absolute left-1/2 h-1 w-[200dvw] -translate-x-1/2",
        "transition-opacity duration-[2000ms] ease-out",
        className
      )}
      preserveAspectRatio="none"
    >
      <line
        x1="0"
        y1="0.5"
        x2="100%"
        y2="0.5"
        stroke="var(--color-border)"
        strokeWidth="1"
        strokeDasharray="16,16"
      />
    </svg>
  );
}
```

#### Visual Additions

1. **L-shaped corner brackets** - 64px borders framing major sections
2. **Numbered section headers** - `01 | Section Name` pattern
3. **Service icons** - Circular containers with dashed borders
4. **Animated grid lines** - Dashed horizontal lines that fade in on scroll
5. **Decorative grid cells** - Pattern fills (dots, diagonal lines)

### Page Layout Example

```
┌─────────────────────────────────────────────────────────────┐
│ Header                                                       │
├─────────────────────────────────────────────────────────────┤
│ Hero (3D)                                                   │
├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤  <- animated dashed line
├───────┬───────┬───────┬───────┬───────┬───────┬───────┬─────┤
│       │ Intro text spanning          │ Logo  │ Icon  │     │
│       │ 4 columns                    │       │       │     │
├───────┼───────────────────────────────┼───────┼───────┼─────┤
│ Decor │                               │       │       │     │
│ cell  │   Code example spanning       │       │       │     │
│       │   4x4 cells                   │       │       │     │
│       │                               │       │       │     │
├ ─ ─ ─ ┼ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┼ ─ ─ ─ ┼ ─ ─ ─ ┼ ─ ─ ┤  <- animated dashed line
│       │ Feature list                  │       │       │     │
└───────┴───────────────────────────────┴───────┴───────┴─────┘
```

### Implementation Effort

- ~2-3 days of development
- New grid system requires restructuring all content sections
- Grid line animation work
- More complex responsive behavior

---

## Option 3: Full Overhaul (workers.cloudflare.com style)

Complete visual redesign following workers.cloudflare.com patterns closely.

### Overview

This option reimagines the page following the workers.cloudflare.com aesthetic,
featuring their sophisticated CSS custom property system, shadow-stack patterns,
corner markers, and dot pattern backgrounds.

### Major Structural Changes

#### CSS Custom Property System

Adopt workers.cloudflare.com's semantic variable naming:

```css
:root {
  /* Backgrounds */
  --color-background-100: #fafafa;
  --color-background-200: #f5f5f5;
  --color-background-300: #e5e5e5;

  /* Foregrounds */
  --color-foreground-100: #171717;
  --color-foreground-200: #525252;
  --color-foreground-100-70: rgba(23, 23, 23, 0.7);

  /* Accents (Cloudflare Orange) */
  --color-accent-100: #F6821F;
  --color-accent-200: #ea580c;

  /* Borders */
  --color-border-100: #e5e5e5;
  --color-border-100-50: rgba(229, 229, 229, 0.5);

  /* Light mode text on dark backgrounds */
  --color-light-foreground: #ffffff;
  --color-dark-accent: #171717;
}

.dark {
  --color-background-100: #0a0a0a;
  --color-background-200: #171717;
  --color-background-300: #262626;

  --color-foreground-100: #fafafa;
  --color-foreground-200: #a3a3a3;
  --color-foreground-100-70: rgba(250, 250, 250, 0.7);

  --color-border-100: #262626;
  --color-border-100-50: rgba(38, 38, 38, 0.5);
}
```

#### Hero Section with Shadow Stack

Orange accent background with layered depth effect:

```tsx
<section className="bg-accent-100 relative overflow-hidden min-h-[720px]">
  {/* Shadow stack creates layered depth */}
  <div className="shadow-stack" />

  {/* Content */}
  <div className="relative z-10 text-light-foreground">
    <h1>Model Context Protocol</h1>
    <p>Connect AI to your infrastructure</p>
  </div>
</section>
```

Shadow stack CSS:

```css
.shadow-stack {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    transparent 0%,
    rgba(0, 0, 0, 0.1) 100%
  );
}
```

#### Corner Diamond Markers

Small diamond-shaped markers at card corners (workers.cloudflare.com signature):

```tsx
function CornerMarkers() {
  return (
    <>
      {/* Top-left */}
      <div
        className="absolute bg-background-100 border border-border-100 rounded-[3px]"
        style={{ left: -7, top: -7, width: 14, height: 14 }}
      />
      {/* Top-right */}
      <div
        className="absolute bg-background-100 border border-border-100 rounded-[3px]"
        style={{ right: -7, top: -7, width: 14, height: 14 }}
      />
      {/* Bottom-left */}
      <div
        className="absolute bg-background-100 border border-border-100 rounded-[3px]"
        style={{ left: -7, bottom: -7, width: 14, height: 14 }}
      />
      {/* Bottom-right */}
      <div
        className="absolute bg-background-100 border border-border-100 rounded-[3px]"
        style={{ right: -7, bottom: -7, width: 14, height: 14 }}
      />
    </>
  );
}
```

#### Dot Pattern Background

Full-page dot pattern like workers.cloudflare.com:

```tsx
function DotPatternBackground() {
  return (
    <div className="absolute inset-0 -z-10 pointer-events-none">
      {/* Outer container with dashed vertical lines */}
      <div className="absolute top-0 left-1/2 h-full w-[1480px] -translate-x-1/2">
        <svg className="absolute inset-0 w-full h-full">
          <pattern
            id="dot-pattern"
            x="0"
            y="0"
            width="12"
            height="12"
            patternUnits="userSpaceOnUse"
          >
            <circle
              cx="6"
              cy="6"
              r="0.75"
              fill="var(--color-border-100)"
            />
          </pattern>
          <rect width="100%" height="100%" fill="url(#dot-pattern)" />
        </svg>

        {/* Dashed vertical border lines */}
        <div
          className="absolute top-0 left-0 h-full w-px"
          style={{
            backgroundImage: `linear-gradient(to bottom, var(--color-border-100-50) 50%, transparent 50%)`,
            backgroundSize: '1px 32px',
          }}
        />
        <div
          className="absolute top-0 right-0 h-full w-px"
          style={{
            backgroundImage: `linear-gradient(to bottom, var(--color-border-100-50) 50%, transparent 50%)`,
            backgroundSize: '1px 32px',
          }}
        />
      </div>
    </div>
  );
}
```

#### Animated Dashed Lines (CornerLines component)

Horizontal dashed lines that span the viewport:

```tsx
function CornerLines({ position }: { position: 'top' | 'bottom' }) {
  return (
    <svg
      className={cn(
        "absolute left-1/2 h-1 w-[200dvw] -translate-x-1/2",
        "transition-opacity duration-[2000ms] ease-out",
        position === 'top' ? 'top-0' : 'bottom-0'
      )}
      preserveAspectRatio="none"
    >
      <line
        x1="0"
        y1="0.5"
        x2="100%"
        y2="0.5"
        stroke="var(--color-border-100-50)"
        strokeWidth="1"
        strokeDasharray="16,16"
      />
    </svg>
  );
}
```

#### Sophisticated Button System

Workers-style buttons with press effects:

```tsx
function Button({ variant = 'primary', children, ...props }) {
  const baseClasses = `
    relative inline-flex items-center justify-center gap-2
    border whitespace-nowrap font-medium rounded-full
    transition-[scale,translate] duration-[0.16s]
    ease-[cubic-bezier(0.25,0.46,0.45,0.94)]
    active:scale-[0.98] active:translate-y-[1px]
    isolate
  `;

  const variants = {
    primary: `
      bg-light-foreground text-dark-accent border-light-foreground
      hover:bg-transparent hover:text-light-foreground
    `,
    secondary: `
      bg-accent-200 text-light-foreground border-light-foreground/10
      hover:border-light-foreground hover:bg-transparent
    `,
    ghost: `
      bg-background-200 text-foreground-100
      hover:bg-background-200 hover:text-foreground-100/70
    `,
  };

  return (
    <button className={cn(baseClasses, variants[variant])} {...props}>
      {/* Press effect overlay */}
      <span className="absolute -inset-[1px] rounded-[inherit] bg-current opacity-0 transition-opacity active:opacity-[0.26]" />
      <span className="relative z-10">{children}</span>
    </button>
  );
}
```

#### Feature Cards with Corner Markers

```tsx
function FeatureCard({ title, description, icon }) {
  return (
    <div className="relative bg-background-100 p-8 transition-colors">
      <CornerMarkers />

      <div className="mb-4">{icon}</div>
      <h3 className="text-xl font-medium mb-2">{title}</h3>
      <p className="text-foreground-200">{description}</p>
    </div>
  );
}
```

#### Orange Accent Sections

Full-width orange sections for CTAs (workers-style):

```tsx
function AccentSection({ children }) {
  return (
    <section className="bg-accent-100 shadow-stack text-light-foreground relative">
      <CornerLines position="top" />

      <div className="relative z-10 py-24 px-6">
        <div className="mx-auto max-w-3xl text-center">
          {children}
        </div>
      </div>

      <CornerLines position="bottom" />
    </section>
  );
}
```

### New Components Required

| Component | Description |
|-----------|-------------|
| `DotPatternBackground` | Full-page dot grid with dashed vertical lines |
| `CornerMarkers` | 14x14px diamond markers at card corners |
| `CornerLines` | Animated dashed horizontal lines |
| `ShadowStack` | Gradient overlay for depth effect |
| `Button` | Workers-style buttons with press effects |
| `FeatureCard` | Card with corner markers |
| `AccentSection` | Orange background section wrapper |
| `AnimatedSection` | Fade-in on scroll with keyframe support |

### Animation Patterns

Workers.cloudflare.com uses subtle, sophisticated animations:

```css
/* Keyframe container - starts invisible */
.keyframe-container {
  opacity: 0;
}

/* Standard transitions */
.transition-colors {
  transition-property: color, background-color, border-color;
  transition-timing-function: ease-out;
  transition-duration: 200ms;
}

/* Slow fade for decorative elements */
.transition-slow {
  transition-duration: 2000ms;
}

/* Button press easing */
.ease-button {
  transition-timing-function: cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

/* Mask utilities for gradient fades */
.mask-fade-bottom {
  mask-image: linear-gradient(to bottom, black 80%, transparent 100%);
}
```

### Page Structure

```
┌─────────────────────────────────────────────────────────────┐
│ ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● │  <- dot pattern
│ ┆                                                         ┆ │  <- dashed vertical lines
│ ┆  ┌─────────────────────────────────────────────────┐   ┆ │
│ ┆  │            Hero (Orange Accent)                  │   ┆ │
│ ┆  │            with shadow-stack                     │   ┆ │
│ ┆  └─────────────────────────────────────────────────┘   ┆ │
│ ┆ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┆ │  <- corner line
│ ┆                                                         ┆ │
│ ┆  ◇─────────────────────────────────────────────────◇   ┆ │  <- corner markers
│ ┆  │            Content Section                       │   ┆ │
│ ┆  │                                                  │   ┆ │
│ ┆  ◇─────────────────────────────────────────────────◇   ┆ │
│ ┆                                                         ┆ │
│ ┆ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┆ │
│ ┆                                                         ┆ │
│ ┆  ┌─────────────────────────────────────────────────┐   ┆ │
│ ┆  │            CTA (Orange Accent)                   │   ┆ │
│ ┆  └─────────────────────────────────────────────────┘   ┆ │
│ ┆                                                         ┆ │
│ ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● │
└─────────────────────────────────────────────────────────────┘
```

### Implementation Effort

- ~1-2 weeks of development
- Complete CSS architecture overhaul
- New component library
- May require additional dependencies:
  - Shiki for syntax highlighting
  - Intersection Observer for scroll animations
- Extensive dark mode testing

---

## Visual Reference

### Key Sites Analyzed

| Site | Key Patterns |
|------|--------------|
| workers.cloudflare.com | Dot patterns, shadow-stack, corner diamonds, dashed lines, orange accents |
| agents.cloudflare.com | Orange monochrome, corner brackets, numbered sections |
| sandbox.cloudflare.com | 8-column grid, side rulers, stacked text |

### Cloudflare Orange Palette

```css
--cf-orange-50: #fff7ed;
--cf-orange-100: #ffedd5;
--cf-orange-200: #fed7aa;
--cf-orange-300: #fdba74;
--cf-orange-400: #fb923c;
--cf-orange-500: #f97316;
--cf-orange-600: #ea580c;
--cf-orange-700: #c2410c;
--cf-orange-800: #9a3412;
--cf-orange: #F6821F;       /* Brand primary */
--cf-orange-light: #FBAD41; /* Brand secondary */
```

### Pattern SVGs

**Dot Pattern (workers.cloudflare.com style):**

```html
<svg>
  <pattern id="dots" x="0" y="0" width="12" height="12" patternUnits="userSpaceOnUse">
    <circle cx="6" cy="6" r="0.75" fill="var(--color-border-100)" />
  </pattern>
  <rect width="100%" height="100%" fill="url(#dots)" />
</svg>
```

**Dashed Vertical Line:**

```css
.dashed-vertical {
  background-image: linear-gradient(
    to bottom,
    var(--color-border-100-50) 50%,
    transparent 50%
  );
  background-size: 1px 32px;
  background-repeat: repeat-y;
}
```

**Corner Marker:**

```html
<div
  class="absolute bg-background-100 border border-border-100 rounded-[3px]"
  style="width: 14px; height: 14px; left: -7px; top: -7px;"
/>
```

---

## Recommendation

Start with **Option 1 (Light Touch)** to quickly improve visual polish, then
evaluate whether the additional complexity of Option 2 or 3 is warranted based on:

1. User feedback on the lighter changes
2. Time available for development
3. Whether the grid-based layout aligns with content strategy

The components built for Option 1 can be reused and extended for Options 2 and 3.

For the full overhaul, workers.cloudflare.com provides the most polished and
mature design system to follow, with well-documented patterns for:
- Semantic CSS custom properties
- Dark mode support
- Subtle, professional animations
- Consistent component styling
