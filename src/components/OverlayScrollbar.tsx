import React, { useCallback, useEffect, useRef, useState } from 'react'

interface OverlayScrollbarProps {
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
  /** Fixed height (px) of the thumb pill. Stays constant regardless of content. */
  thumbHeight?: number
  /** Top/bottom inset (px) for the thumb's travel range within the track. */
  trackInset?: number
  /** Horizontal inset (px) pulling the thumb in from the right edge. The
   *  thumb is an overlay anchored at `right: 0`; bumping this moves only the
   *  scrollbar left without affecting the scrollable content's width. */
  rightInset?: number
  /** When this value changes, the scroll position is reset to the top. Use
   *  a stable identifier (e.g. the active tab key) so the reset only fires
   *  on intentional context switches, not on every render. */
  scrollResetKey?: string | number
  /** When true, applies a soft fade-mask at the top/bottom edges that only
   *  appears when content actually overflows in that direction. Disappears
   *  when the user reaches the top or bottom so the hard scroll edge isn't
   *  visible mid-page but resting against an absolute edge looks crisp. */
  edgeFade?: boolean
  /** Height (px) of the fade-mask band at each edge. Defaults to 56px. Pass
   *  a smaller value for compact scroll areas where 56px would eat too much
   *  of the visible content. */
  edgeFadeSize?: number
  /** Use a finer, smoothstep-eased fade curve (more gradient stops, gentle
   *  onset) instead of the default 5-stop ramp. Reads softer / more natural,
   *  especially with a larger `edgeFadeSize`. Opt-in so existing callers keep
   *  their current fade. */
  edgeFadeSoft?: boolean
  /** Suppress the TOP edge fade while keeping the bottom one (when `edgeFade`).
   *  Useful where content should stay crisp against the top edge — e.g. the Ask
   *  AI conversation, whose just-sent prompt is anchored flush to the top. */
  edgeFadeNoTop?: boolean
  /** Suppresses the custom overlay thumb entirely — content still scrolls
   *  and `edgeFade` still works, but no thumb is rendered. Useful when the
   *  caller wants scroll affordance via the fade alone. */
  hideThumb?: boolean
  /** Exposes the inner scrollable DOM node to the caller. Lets a parent
   *  forward wheel events (e.g. from surrounding whitespace) into this
   *  scroller without reaching through the DOM. */
  scrollableRef?: React.Ref<HTMLDivElement>
  /** `overscroll-behavior` for the inner scroller. Defaults to `'contain'`
   *  (stops scroll chaining to the page). Pass `'none'` to additionally kill
   *  the elastic rubber-band/bounce at the scroll edges. */
  overscrollBehavior?: React.CSSProperties['overscrollBehavior']
}

/**
 * Scrollable wrapper with a fixed-size overlay thumb. Used by IntakeBodyLayout
 * so the visible scrollbar pill is identical across every Intake config tab —
 * the native scrollbar thumb is content-proportional, which made the General
 * tab's thumb look very different from Calls/WhatsApp/etc.
 */
const OverlayScrollbar: React.FC<OverlayScrollbarProps> = ({
  children,
  className,
  style,
  thumbHeight = 80,
  trackInset = 16,
  rightInset = 0,
  scrollResetKey,
  edgeFade = false,
  edgeFadeSize = 56,
  edgeFadeSoft = false,
  edgeFadeNoTop = false,
  hideThumb = false,
  scrollableRef,
  overscrollBehavior = 'contain',
}) => {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Callback ref that keeps the internal ref authoritative while also
  // forwarding the node to an optional caller-supplied ref.
  const setScrollNode = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node
      if (typeof scrollableRef === 'function') {
        scrollableRef(node)
      } else if (scrollableRef) {
        ;(scrollableRef as React.MutableRefObject<HTMLDivElement | null>).current =
          node
      }
    },
    [scrollableRef],
  )
  const [metrics, setMetrics] = useState({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  })
  const [thumbHover, setThumbHover] = useState(false)
  const [thumbActive, setThumbActive] = useState(false)
  const [visible, setVisible] = useState(false)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showThumb = useCallback(() => {
    setVisible(true)
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setVisible(false), 800)
  }, [])

  const updateMetrics = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setMetrics({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    })
  }, [])

  const handleScroll = useCallback(() => {
    updateMetrics()
    showThumb()
  }, [updateMetrics, showThumb])

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    updateMetrics()
    // Coalesce bursts of mutations/resizes into one measurement per frame.
    // During streaming the content mutates dozens of times a second; measuring
    // (which reads layout) on every mutation forced a reflow each time and made
    // long threads janky. rAF-debounce keeps it to one reflow per frame.
    let raf: number | null = null
    const scheduleMeasure = () => {
      if (raf !== null) return
      raf = requestAnimationFrame(() => {
        raf = null
        updateMetrics()
      })
    }
    const ro = new ResizeObserver(scheduleMeasure)
    ro.observe(el)
    const mo = new MutationObserver(scheduleMeasure)
    mo.observe(el, { childList: true, subtree: true, attributes: true })
    return () => {
      if (raf !== null) cancelAnimationFrame(raf)
      ro.disconnect()
      mo.disconnect()
    }
  }, [updateMetrics])

  // Glide to the top whenever scrollResetKey flips. Uses a short rAF tween
  // with ease-out-quart so the scroll movement matches the visual character
  // of the cross-fade in IntakePage. First mount is skipped (scrollTop is
  // already 0). Tween cancels if scrollResetKey changes again mid-flight.
  const isFirstResetRef = useRef(true)
  useEffect(() => {
    if (isFirstResetRef.current) {
      isFirstResetRef.current = false
      return
    }
    const el = scrollRef.current
    if (!el) return
    if (el.scrollTop <= 0) return

    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches
    if (prefersReducedMotion) {
      el.scrollTop = 0
      updateMetrics()
      return
    }

    const startTop = el.scrollTop
    const startTime = performance.now()
    // Synced with the panel cross-fade duration (INTAKE_FADE_MS in
    // IntakePage.tsx) so both motions finish together — feels cohesive
    // rather than like two separate animations stacked.
    const duration = 280
    const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4)

    let rafId = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - startTime) / duration)
      el.scrollTop = startTop * (1 - easeOutQuart(t))
      if (t < 1) {
        rafId = requestAnimationFrame(tick)
      } else {
        updateMetrics()
      }
    }
    rafId = requestAnimationFrame(tick)

    return () => cancelAnimationFrame(rafId)
  }, [scrollResetKey, updateMetrics])

  const { scrollTop, scrollHeight, clientHeight } = metrics
  const maxScroll = Math.max(0, scrollHeight - clientHeight)
  // Clamp the (possibly stale) scrollTop against the live scroll range. When
  // content shrinks — e.g. a filtered list drops most of its rows — the browser
  // hasn't necessarily reset scrollTop by the time we read it, so the raw value
  // can exceed maxScroll. Using it directly would leave the top edge-fade stuck
  // (atTop reads false) and overshoot the thumb. maxScroll = 0 → clamps to 0.
  const clampedScrollTop = Math.min(Math.max(0, scrollTop), maxScroll)
  const scrollable = maxScroll > 1
  const trackHeight = Math.max(0, clientHeight - 2 * trackInset)
  const thumbTravel = Math.max(0, trackHeight - thumbHeight)
  const thumbTop =
    trackInset +
    (maxScroll > 0 ? (clampedScrollTop / maxScroll) * thumbTravel : 0)

  const handleThumbMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const startY = e.clientY
      const startScrollTop = scrollRef.current?.scrollTop ?? 0
      setThumbActive(true)
      document.body.style.userSelect = 'none'

      const onMove = (ev: MouseEvent) => {
        const el = scrollRef.current
        if (!el) return
        const travel = Math.max(
          0,
          el.clientHeight - 2 * trackInset - thumbHeight,
        )
        if (travel === 0) return
        const maxS = Math.max(0, el.scrollHeight - el.clientHeight)
        const ratio = (ev.clientY - startY) / travel
        el.scrollTop = startScrollTop + ratio * maxS
      }

      const onUp = () => {
        setThumbActive(false)
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }

      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [thumbHeight, trackInset],
  )

  const thumbColor = thumbActive
    ? 'var(--colors-icon-neutral-main)'
    : thumbHover
    ? 'var(--colors-icon-neutral-medium)'
    : 'var(--colors-border-neutral-base-subtle)'

  // Edge fade — only when content actually overflows in that direction. We
  // build a multi-stop linear gradient that mirrors the eased fade used in
  // the home page; the stops switch out when the user reaches the top or
  // bottom so the absolute edges read crisp instead of fading into nothing.
  const atTop = clampedScrollTop <= 0
  const atBottom = maxScroll <= 0 || clampedScrollTop >= maxScroll - 1
  const fadeTop = edgeFade && !edgeFadeNoTop && scrollable && !atTop
  const fadeBottom = edgeFade && scrollable && !atBottom

  const fadeMask: string | undefined = (() => {
    if (!fadeTop && !fadeBottom) return undefined
    const s = edgeFadeSize

    if (edgeFadeSoft) {
      // Finer smoothstep curve (opacity = f²(3−2f)) — a gentle onset that ramps
      // in the middle and eases out, so the content melts into the edge instead
      // of stepping through a few hard stops. Positions scale with `s`.
      const SOFT: Array<[number, number]> = [
        [0, 0],
        [0.12, 0.04],
        [0.25, 0.16],
        [0.4, 0.35],
        [0.55, 0.57],
        [0.7, 0.78],
        [0.85, 0.94],
        [1, 1],
      ]
      const topStops = fadeTop
        ? SOFT.map(([f, o]) => `rgba(0,0,0,${o}) ${Math.round(f * s)}px`).join(', ')
        : 'black 0'
      const bottomStops = fadeBottom
        ? SOFT.map(
            ([f, o]) =>
              `rgba(0,0,0,${1 - o}) calc(100% - ${Math.round((1 - f) * s)}px)`,
          ).join(', ')
        : 'black 100%'
      return `linear-gradient(to bottom, ${topStops}, ${bottomStops})`
    }

    // Default 5-stop ramp. Stops scale proportionally with `edgeFadeSize` so a
    // smaller fade band (e.g. 24px) still gets the same eased easing curve.
    const s1 = Math.round(s * 0.21) // ~12px when s=56
    const s2 = Math.round(s * 0.43) // ~24px when s=56
    const s3 = Math.round(s * 0.71) // ~40px when s=56
    const topStops = fadeTop
      ? `transparent 0, rgba(0,0,0,0.15) ${s1}px, rgba(0,0,0,0.45) ${s2}px, rgba(0,0,0,0.8) ${s3}px, black ${s}px`
      : 'black 0'
    const bottomStops = fadeBottom
      ? `black calc(100% - ${s}px), rgba(0,0,0,0.8) calc(100% - ${s3}px), rgba(0,0,0,0.45) calc(100% - ${s2}px), rgba(0,0,0,0.15) calc(100% - ${s1}px), transparent 100%`
      : 'black 100%'
    return `linear-gradient(to bottom, ${topStops}, ${bottomStops})`
  })()

  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        // Flex column so the inner scroll element can fill either a flex-
        // sized parent (e.g. IntakeBodyLayout) or be clamped by `maxHeight`
        // on this wrapper (e.g. the recent conversations list). With
        // `height: 100%` on the inner, percentage heights would not resolve
        // when only `max-height` is set on this outer div and scrolling
        // would never engage.
        display: 'flex',
        flexDirection: 'column',
        ...(fadeMask
          ? { maskImage: fadeMask, WebkitMaskImage: fadeMask }
          : {}),
        ...style,
      }}
      className={className}
    >
      <div
        ref={setScrollNode}
        onScroll={handleScroll}
        className="hide-scrollbar"
        style={{
          width: '100%',
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          overflowX: 'hidden',
          scrollbarWidth: 'none',
          // Keep wheel/touch scroll inside this region — once it hits the top
          // or bottom edge it shouldn't chain into the parent (page) scroll.
          // `'none'` also removes the elastic rubber-band bounce at the edges.
          overscrollBehavior,
        }}
      >
        {children}
      </div>
      {scrollable && !hideThumb && (
        <div
          onMouseDown={handleThumbMouseDown}
          onMouseEnter={() => {
            setThumbHover(true)
            if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
            setVisible(true)
          }}
          onMouseLeave={() => {
            setThumbHover(false)
            showThumb()
          }}
          style={{
            position: 'absolute',
            top: thumbTop,
            right: rightInset,
            // Above scrolling content — incl. sticky headers (which create a
            // stacking context with a positive z-index) — so it stays grabbable.
            zIndex: 10,
            width: 14,
            height: thumbHeight,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            cursor: 'pointer',
            opacity: visible || thumbHover || thumbActive ? 1 : 0,
            pointerEvents: visible || thumbHover || thumbActive ? 'auto' : 'none',
            transition: 'opacity 0.25s ease',
          }}
        >
          <div
            style={{
              width: thumbHover || thumbActive ? 8 : 4,
              height: '100%',
              borderRadius: 999,
              backgroundColor: thumbColor,
              marginRight: 4,
              transition: 'background-color 0.2s ease, width 0.15s ease',
            }}
          />
        </div>
      )}
    </div>
  )
}

export default OverlayScrollbar
