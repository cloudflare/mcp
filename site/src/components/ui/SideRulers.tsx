/**
 * Fixed vertical ruler marks on left and right edges.
 * Inspired by sandbox.cloudflare.com's measurement aesthetic.
 */
export function SideRulers() {
  return (
    <>
      {/* Left ruler */}
      <div
        className="fixed top-6 bottom-6 left-6 z-10 hidden flex-col items-center justify-between lg:flex"
        aria-hidden="true"
      >
        {/* Vertical line */}
        <div className="absolute top-0 bottom-0 border-r border-(--color-border)" />
        {/* Tick marks */}
        <div className="w-3 border-t border-(--color-border)" />
        <div className="w-3 border-t border-(--color-border)" />
        <div className="w-3 border-t border-(--color-border)" />
        <div className="w-3 border-t border-(--color-border)" />
        <div className="w-3 border-t border-(--color-border)" />
        <div className="w-3 border-t border-(--color-border)" />
        <div className="w-3 border-t border-(--color-border)" />
      </div>

      {/* Right ruler */}
      <div
        className="fixed top-6 bottom-6 right-6 z-10 hidden flex-col items-center justify-between lg:flex"
        aria-hidden="true"
      >
        {/* Vertical line */}
        <div className="absolute top-0 bottom-0 border-r border-(--color-border)" />
        {/* Tick marks */}
        <div className="w-3 border-t border-(--color-border)" />
        <div className="w-3 border-t border-(--color-border)" />
        <div className="w-3 border-t border-(--color-border)" />
        <div className="w-3 border-t border-(--color-border)" />
        <div className="w-3 border-t border-(--color-border)" />
        <div className="w-3 border-t border-(--color-border)" />
        <div className="w-3 border-t border-(--color-border)" />
      </div>
    </>
  )
}
