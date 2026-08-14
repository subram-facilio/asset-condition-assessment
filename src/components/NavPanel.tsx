import React, { useCallback, useRef, useState } from 'react'
import OverlayScrollbar from './OverlayScrollbar'
import { useNavPills } from './useNavPills'

interface NavPanelProps {
  /** Composite key — should change whenever the panel layout may have shifted
      (route change, accordion open/close, collapse toggle). */
  syncKey: string
  children: React.ReactNode
}

const NavPanel: React.FC<NavPanelProps> = ({ syncKey, children }) => {
  const navAreaRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const hoverPillRef = useRef<HTMLDivElement>(null)
  const [hoveredEl, setHoveredEl] = useState<HTMLElement | null>(null)

  useNavPills({ navAreaRef, pillRef, hoverPillRef, hoveredEl, syncKey })

  const handleMouseOver = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement | null
    if (!t) return
    const hoverable = t.closest('[data-nav-hoverable="true"]') as HTMLElement | null
    if (!hoverable || !navAreaRef.current?.contains(hoverable)) return
    if (hoverable.dataset.navActive === 'true') {
      setHoveredEl(null)
      return
    }
    setHoveredEl((prev) => (prev === hoverable ? prev : hoverable))
  }, [])

  const handleMouseLeave = useCallback(() => {
    setHoveredEl(null)
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        gap: 'var(--spacing-container-large)',
        boxSizing: 'border-box',
      }}
    >
      {/* The nav list scrolls via our overlay scrollbar (matches the rest of the
          app) rather than the native one. The inner wrapper — not the scroll
          viewport — is the positioning context for the pills and the hover
          target area: it grows with content, so the pill offsets stay in
          content-space and survive scrolling. `minHeight: 100%` lets the
          pinned footer's `margin-top: auto` reach the bottom when the list is
          shorter than the rail. */}
      <OverlayScrollbar style={{ flex: 1, minHeight: 0 }} rightInset={-4}>
        <div
          ref={navAreaRef}
          className="nav-scroll-area"
          onMouseOver={handleMouseOver}
          onMouseLeave={handleMouseLeave}
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--spacing-container-small)',
            minHeight: '100%',
          }}
        >
          {/* Hover pill */}
        <div
          ref={hoverPillRef}
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 0,
            height: 32,
            borderRadius: 'var(--border-medium)',
            backgroundColor: 'var(--colors-background-midground-dark)',
            opacity: 0,
            transformOrigin: 'top left',
            willChange: 'transform, top, opacity',
            transition: 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.12s ease',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
        {/* Active pill */}
        <div
          ref={pillRef}
          aria-hidden
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 0,
            height: 32,
            borderRadius: 'var(--border-medium)',
            backgroundColor: 'var(--colors-background-container)',
            // Hairline outline via inset box-shadow rather than a border:
            // a sub-pixel border + border-box gets clipped when the window is
            // dragged across monitors with different DPRs (re-rasterizes at a
            // different pixel grid). A painted shadow isn't part of the box and
            // doesn't clip.
            boxShadow: 'inset 0 0 0 1px var(--colors-border-neutral-inverse-base-subtle)',
            opacity: 0,
            transformOrigin: 'top left',
            willChange: 'transform, top, opacity',
            transition: 'transform 0.24s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.15s ease',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />

          {children}
        </div>
      </OverlayScrollbar>
    </div>
  )
}

export default NavPanel
