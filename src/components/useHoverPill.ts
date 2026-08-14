import { useLayoutEffect } from 'react'

interface UseHoverPillOptions {
  /** Positioned (`position: relative`) wrapper the pill lives in. */
  containerRef: React.RefObject<HTMLElement | null>
  /** The absolutely-positioned pill element to drive. */
  pillRef: React.RefObject<HTMLElement | null>
  /** The currently hovered child element, or null when nothing is hovered. */
  hoveredEl: HTMLElement | null
}

/**
 * Drives a single "ghost" hover pill that smoothly slides + morphs to follow
 * the hovered element — the same effect the sidebar nav uses (see
 * `useNavPills`), distilled into a reusable hook for any list / table / menu.
 *
 * The pill is a sibling inside a `position: relative` container; this hook only
 * sets its `transform` / `width` / `height` / `opacity`. The smoothness comes
 * from a CSS `transition` on those properties (defined on the pill element):
 * moving between siblings animates the transform, so the pill glides.
 *
 * When the pill is currently hidden (no prior hover), it's snapped to the new
 * target with the transition momentarily disabled, then faded in — so it
 * appears in place instead of flying in from the origin. Subsequent moves
 * between siblings animate normally.
 */
export function useHoverPill({
  containerRef,
  pillRef,
  hoveredEl,
}: UseHoverPillOptions): void {
  useLayoutEffect(() => {
    const container = containerRef.current
    const pill = pillRef.current
    if (!container || !pill) return

    if (!hoveredEl || !container.contains(hoveredEl)) {
      pill.style.opacity = '0'
      return
    }

    const cRect = container.getBoundingClientRect()
    const rect = hoveredEl.getBoundingClientRect()
    const top = rect.top - cRect.top + container.scrollTop
    const left = rect.left - cRect.left + container.scrollLeft

    const wasHidden = pill.style.opacity === '' || pill.style.opacity === '0'

    const place = () => {
      pill.style.transform = `translate(${left}px, ${top}px)`
      pill.style.width = `${rect.width}px`
      pill.style.height = `${rect.height}px`
    }

    if (wasHidden) {
      // Snap into place without animating, then fade in.
      const prevTransition = pill.style.transition
      pill.style.transition = 'none'
      place()
      void pill.offsetWidth // force reflow before re-enabling the transition
      pill.style.transition = prevTransition
      pill.style.opacity = '1'
    } else {
      place()
      pill.style.opacity = '1'
    }
  }, [hoveredEl, containerRef, pillRef])
}

export default useHoverPill
