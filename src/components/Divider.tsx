interface DividerProps {
  /**
   * Figma's Divider component is `Type=Horizontal|Vertical, Size=0.5|1`. Horizontal
   * is the default because that's what the asset-detail content sections use.
   */
  orientation?: 'horizontal' | 'vertical'
  /**
   * Stroke thickness in px, matching the Figma `Size` variant. The design uses 1
   * for the header's cluster separators and 0.5 for the ones inside the credits
   * chip — that difference is deliberate, not something to normalize.
   */
  thickness?: number
  /** Cross-axis length. Vertical dividers in the design are 12 or 20 tall; horizontal ones span their container. */
  length?: number | string
  color?: string
  marginTop?: string
  marginBottom?: string
}

const Divider = ({
  orientation = 'horizontal',
  thickness = 0.5,
  length,
  color = 'var(--colors-border-neutral-base-subtler)',
  marginTop = 'var(--spacing-container-xlarge)',
  marginBottom = 'var(--spacing-container-xlarge)',
}: DividerProps) => {
  const vertical = orientation === 'vertical'

  return (
    <div
      aria-hidden
      style={{
        width: vertical ? thickness : (length ?? '100%'),
        height: vertical ? (length ?? '100%') : thickness,
        backgroundColor: color,
        // Vertical dividers sit in flex rows whose gap already supplies the
        // spacing, so the horizontal margins would double it up.
        ...(vertical ? {} : { marginTop, marginBottom }),
        flexShrink: 0,
      }}
    />
  )
}

export default Divider
