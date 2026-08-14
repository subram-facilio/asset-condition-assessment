import { FText, FIcon } from '@facilio/dsm-react-wrapper'
import { Shimmer } from './Shimmer'

export interface StatCard {
  key: string
  /** The figure itself — already formatted, so a caller can pass "12" or "1.2k". */
  value: string
  label: string
  icon: { group: string; name: string }
  /** Tint family for the icon tile. */
  tone: 'blue' | 'green' | 'amber' | 'purple'
}

/**
 * Tile tints. Each pairs a subtle background with a dark ink of the same hue, pinned to a literal
 * rather than a semantic token: every "subtle" background stays a light tint in dark mode, while the
 * matching text/icon tokens get *lighter* there — which would leave the glyph at roughly 2:1.
 */
const TILE_SIZE = 32
const TILE_GAP = 12

const TONES: Record<StatCard['tone'], { background: string; ink: string }> = {
  blue: { background: 'var(--colors-background-accent-blue-subtle)', ink: 'var(--color-blue-60)' },
  green: {
    background: 'var(--colors-background-semantic-green-subtle)',
    ink: 'var(--color-green-60)',
  },
  amber: {
    background: 'var(--colors-background-semantic-orange-subtle)',
    ink: 'var(--color-orange-60)',
  },
  purple: {
    background: 'var(--colors-background-accent-purple-subtle)',
    ink: 'var(--color-purple-60)',
  },
}

/**
 * Row of summary tiles above a data table — the figures a reader wants before they start scanning
 * rows. Each is an icon tile, the number, and what it counts.
 */
export default function StatCards({
  cards,
  loading = false,
}: {
  cards: StatCard[]
  /** Shimmers each figure while it's still in flight; icons and labels stay put. */
  loading?: boolean
}) {
  if (cards.length === 0) return null

  return (
    <div
      style={{
        display: 'grid',
        // Wraps to fewer columns on a narrow viewport rather than squeezing every tile.
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap: 'var(--spacing-container-xlarge)',
        padding: 'var(--spacing-container-xlarge) var(--spacing-container-xxlarge)',
        backgroundColor: 'var(--colors-background-container)',
        // Closes the row off from the filter bar below, which carries the same rule.
        borderBottom: '1px solid var(--colors-border-neutral-base-subtler)',
        flexShrink: 0,
      }}
    >
      {cards.map((card) => {
        const tone = TONES[card.tone]
        return (
          <div
            key={card.key}
            style={{
              display: 'flex',
              flexDirection: 'column',
              // The figure and its label are one unit; 2px keeps them reading that way.
              gap: '2px',
              padding: 'var(--spacing-container-xlarge)',
              borderRadius: 'var(--border-medium)',
              backgroundColor: 'var(--colors-background-midground-subtle)',
              minWidth: 0,
            }}
          >
            {/* Tile and figure share the first line; the label sits under them. */}
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: `${TILE_GAP}px`,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: TILE_SIZE,
                  height: TILE_SIZE,
                  flexShrink: 0,
                  borderRadius: 'var(--border-medium)',
                  backgroundColor: tone.background,
                }}
              >
                <FIcon
                  group={card.icon.group}
                  name={card.icon.name}
                  size={16}
                  color={tone.ink}
                  pressable={false}
                />
              </span>
              {loading ? (
                <Shimmer width={64} height={22} />
              ) : (
                <FText appearance="headingMed20" styleProps={{ color: 'textMain' }}>
                  {card.value}
                </FText>
              )}
            </span>
            {/* Indent lives on a wrapper: FText passes colour and text properties through to its
                shadow DOM, but not box properties like padding. */}
            <div style={{ paddingLeft: `${TILE_SIZE + TILE_GAP}px`, minWidth: 0 }}>
              <FText
                appearance="bodyReg14"
                styleProps={{
                  color: 'textDescription',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  display: 'block',
                }}
              >
                {card.label}
              </FText>
            </div>
          </div>
        )
      })}
    </div>
  )
}
