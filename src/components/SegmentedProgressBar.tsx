import React from 'react'

export interface SegmentedProgressBarProps {
  /** Amount consumed so far. */
  value: number
  /** Total capacity. */
  max: number
  /** How many ticks span the track. Defaults to 96. */
  segments?: number
  /** Track height in px. Defaults to 21. */
  height?: number
  /** Colour of a filled tick. */
  filledColor?: string
  /** Colour of an empty tick. */
  trackColor?: string
}

/**
 * A segmented (tick-style) progress bar — a row of thin rounded bars where the
 * leading `value / max` fraction is filled and the remainder is muted. Each
 * tick is a constant 2px with a fixed 2px gap; the track clips any overflow,
 * so it fills its container at any width. Used by the credit-usage card; kept
 * generic so other meters can reuse it.
 */
const SegmentedProgressBar: React.FC<SegmentedProgressBarProps> = ({
  value,
  max,
  segments = 96,
  height = 21,
  filledColor = '#7285e3',
  trackColor = 'rgba(114, 133, 227, 0.2)',
}) => {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  const filled = Math.round(ratio * segments)

  return (
    <div
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '2px',
        width: '100%',
        height,
        overflow: 'hidden',
      }}
    >
      {Array.from({ length: segments }).map((_, i) => (
        <span
          key={i}
          style={{
            width: 2,
            height: '100%',
            flexShrink: 0,
            borderRadius: 'var(--border-xsmall, 2px)',
            backgroundColor: i < filled ? filledColor : trackColor,
          }}
        />
      ))}
    </div>
  )
}

export default SegmentedProgressBar
