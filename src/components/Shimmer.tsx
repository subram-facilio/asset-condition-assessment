import React from 'react'

/**
 * Lightweight, theme-aware skeleton primitives. The animation and palette are
 * defined globally in `index.css` (`.va-shimmer` + `@keyframes va-shimmer`) so
 * every instance shares the same sweep timing and follows the active DSM theme
 * automatically.
 *
 * Compose these to mirror the shape of the real content while it loads —
 * structure matches the final layout, but everything reads as a moving
 * placeholder. Honours `prefers-reduced-motion` (animation stops, base fill
 * stays).
 */

export interface ShimmerProps {
  /** CSS width. Strings ("100%") or numbers (px). Default `100%`. */
  width?: number | string
  /** CSS height. Default `14px`. */
  height?: number | string
  /** CSS border-radius. Defaults to DSM `--border-medium`. */
  borderRadius?: number | string
  /** Extra inline styles merged onto the host. */
  style?: React.CSSProperties
  /** Extra class names appended after `va-shimmer`. */
  className?: string
}

const toCss = (v: number | string | undefined): string | number | undefined =>
  typeof v === 'number' ? `${v}px` : v

export const Shimmer: React.FC<ShimmerProps> = ({
  width = '100%',
  height = 14,
  borderRadius = 'var(--border-medium)',
  style,
  className,
}) => (
  <div
    aria-hidden
    className={className ? `va-shimmer ${className}` : 'va-shimmer'}
    style={{
      width: toCss(width),
      height: toCss(height),
      borderRadius: toCss(borderRadius),
      flexShrink: 0,
      ...style,
    }}
  />
)

export interface ShimmerCircleProps {
  /** Diameter of the circle. */
  size: number | string
  style?: React.CSSProperties
  className?: string
}

export const ShimmerCircle: React.FC<ShimmerCircleProps> = ({
  size,
  style,
  className,
}) => (
  <Shimmer
    width={size}
    height={size}
    borderRadius="999px"
    style={style}
    className={className}
  />
)

export interface ShimmerTextProps {
  /** Width of each line. Default `100%`. */
  width?: number | string
  /** Height of each line. Default `12px` (caption sized). */
  height?: number | string
  /** Number of stacked lines. When `> 1`, the last line is rendered at 70%
   *  width to mimic prose. Default `1`. */
  lines?: number
  /** Vertical gap between lines. Default `8px`. */
  gap?: number | string
  style?: React.CSSProperties
}

export const ShimmerText: React.FC<ShimmerTextProps> = ({
  width = '100%',
  height = 12,
  lines = 1,
  gap = 8,
  style,
}) => {
  if (lines <= 1) {
    return <Shimmer width={width} height={height} style={style} />
  }
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: toCss(gap),
        ...style,
      }}
    >
      {Array.from({ length: lines }).map((_, i) => (
        <Shimmer
          key={i}
          width={i === lines - 1 ? '70%' : width}
          height={height}
        />
      ))}
    </div>
  )
}

export default Shimmer
