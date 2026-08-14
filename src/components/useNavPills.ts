import { useLayoutEffect, useRef } from 'react'

interface UseNavPillsOptions {
  navAreaRef: React.RefObject<HTMLDivElement | null>
  pillRef: React.RefObject<HTMLDivElement | null>
  hoverPillRef: React.RefObject<HTMLDivElement | null>
  hoveredEl: HTMLElement | null
  /** Composite key — change it whenever the panel's layout may have shifted
      (route change, accordion open/close, collapse toggle). Both effects
      re-run when this string changes. */
  syncKey: string
}

/**
 * Drives the active + hover pills in a nav area via FLIP: the pill's box snaps to the new target, an
 * inverse transform keeps it looking like it's at the old spot, then that transform animates back to
 * identity. Lets `top`/`left` follow live layout shifts (accordion or sidebar resize) without lag.
 */
export function useNavPills({
  navAreaRef,
  pillRef,
  hoverPillRef,
  hoveredEl,
  syncKey,
}: UseNavPillsOptions): void {
  const lastActiveElRef = useRef<HTMLElement | null>(null)
  const lastHoveredElRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const isInClosedContainer = (el: HTMLElement) => {
      let cur: HTMLElement | null = el.parentElement
      while (cur && cur !== navAreaRef.current) {
        if (cur.style.height === '0px') return true
        if (cur.offsetHeight === 0 && cur.scrollHeight > 0) return true
        cur = cur.parentElement
      }
      return false
    }

    const baseTransition =
      'transform 0.24s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.15s ease'

    const sync = () => {
      const navEl = navAreaRef.current
      const pill = pillRef.current
      if (!navEl || !pill) return

      const activeEl = navEl.querySelector<HTMLElement>('[data-nav-active="true"]')
      if (!activeEl || isInClosedContainer(activeEl)) {
        pill.style.opacity = '0'
        return
      }

      const containerRect = navEl.getBoundingClientRect()
      const rect = activeEl.getBoundingClientRect()
      const target = {
        top: rect.top - containerRect.top + navEl.scrollTop,
        left: rect.left - containerRect.left,
        width: rect.width,
        height: rect.height,
      }

      const lastActive = lastActiveElRef.current
      const isNewActive = activeEl !== lastActive && lastActive !== null

      if (isNewActive) {
        const pillRect = pill.getBoundingClientRect()
        const dx = pillRect.left - rect.left
        const dy = pillRect.top - rect.top
        const sx = (pillRect.width || rect.width) / rect.width
        const sy = (pillRect.height || rect.height) / rect.height

        pill.style.transition = 'none'
        pill.style.top = `${target.top}px`
        pill.style.left = `${target.left}px`
        pill.style.width = `${target.width}px`
        pill.style.height = `${target.height}px`
        pill.style.transformOrigin = 'top left'
        pill.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`
        pill.style.opacity = '1'

        void pill.offsetWidth // force reflow before re-enabling transition

        pill.style.transition = baseTransition
        pill.style.transform = 'translate(0, 0) scale(1, 1)'
      } else {
        pill.style.transition = baseTransition
        pill.style.transformOrigin = 'top left'
        pill.style.top = `${target.top}px`
        pill.style.left = `${target.left}px`
        pill.style.width = `${target.width}px`
        pill.style.height = `${target.height}px`
        pill.style.opacity = '1'
      }

      lastActiveElRef.current = activeEl
    }

    let raf = 0
    const stopAt = performance.now() + 600
    const loop = () => {
      sync()
      if (performance.now() < stopAt) {
        raf = requestAnimationFrame(loop)
      }
    }
    sync()
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncKey])

  useLayoutEffect(() => {
    const navEl = navAreaRef.current
    const pill = hoverPillRef.current
    if (!navEl || !pill) return

    const isVisible = (el: HTMLElement | null): el is HTMLElement => {
      if (!el || !navEl.contains(el)) return false
      if (el.dataset.navActive === 'true') return false
      let cur: HTMLElement | null = el.parentElement
      while (cur && cur !== navEl) {
        if (cur.style.height === '0px') return false
        if (cur.offsetHeight === 0 && cur.scrollHeight > 0) return false
        cur = cur.parentElement
      }
      return true
    }

    const baseTransition =
      'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.12s ease'

    const sync = (initial: boolean) => {
      if (!isVisible(hoveredEl)) {
        pill.style.opacity = '0'
        lastHoveredElRef.current = null
        return
      }
      const containerRect = navEl.getBoundingClientRect()
      const rect = hoveredEl.getBoundingClientRect()
      const target = {
        top: rect.top - containerRect.top + navEl.scrollTop,
        left: rect.left - containerRect.left,
        width: rect.width,
        height: rect.height,
      }
      const lastHovered = lastHoveredElRef.current

      if (initial && lastHovered && lastHovered !== hoveredEl && navEl.contains(lastHovered)) {
        const pillRect = pill.getBoundingClientRect()
        const dx = pillRect.left - rect.left
        const dy = pillRect.top - rect.top

        pill.style.transition = 'none'
        pill.style.top = `${target.top}px`
        pill.style.left = `${target.left}px`
        pill.style.width = `${target.width}px`
        pill.style.height = `${target.height}px`
        pill.style.transformOrigin = 'top left'
        pill.style.transform = `translate(${dx}px, ${dy}px)`
        pill.style.opacity = '1'

        void pill.offsetWidth

        pill.style.transition = baseTransition
        pill.style.transform = 'translate(0, 0)'
      } else {
        pill.style.transition = baseTransition
        pill.style.transformOrigin = 'top left'
        pill.style.top = `${target.top}px`
        pill.style.left = `${target.left}px`
        pill.style.width = `${target.width}px`
        pill.style.height = `${target.height}px`
        pill.style.transform = 'translate(0, 0)'
        pill.style.opacity = '1'
      }
    }

    sync(true)
    lastHoveredElRef.current = hoveredEl

    let raf = 0
    const stopAt = performance.now() + 400
    const loop = () => {
      if (!hoveredEl || !navEl.contains(hoveredEl)) return
      const r = hoveredEl.getBoundingClientRect()
      const cr = navEl.getBoundingClientRect()
      pill.style.top = `${r.top - cr.top + navEl.scrollTop}px`
      pill.style.left = `${r.left - cr.left}px`
      pill.style.width = `${r.width}px`
      pill.style.height = `${r.height}px`
      if (performance.now() < stopAt) raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoveredEl, syncKey])
}
