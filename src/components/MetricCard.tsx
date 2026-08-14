import type { ReactNode } from 'react'
import { FIcon } from '@facilio/dsm-react-wrapper'
import { Shimmer } from './Shimmer'

/**
 * Shared KPI tile. Lifted out of Home.tsx so the Home overview and the Plans stat row are one
 * component rather than two that drift.
 *
 * Home's original arrangement is `layout="stacked"` and remains the default, so extracting this
 * changed nothing there. `layout="badge"` is the Plans variant: a tinted icon square on the left
 * with the value over the label.
 */

/** Icon tints, limited to tokens that actually exist — several accent ramps do not. */
export type MetricTone = 'primary' | 'green' | 'orange' | 'neutral'

const TONE_ICON_COLOR: Record<MetricTone, string> = {
  primary: 'var(--colors-icon-primary-default)',
  green: 'var(--colors-icon-semantic-green)',
  orange: 'var(--colors-icon-semantic-orange)',
  neutral: 'var(--colors-icon-neutral-main)',
}

/** Mirrors Home.tsx's local `T.kpiLabel` / `T.kpiValue` exactly. */
const LABEL_STYLE: React.CSSProperties = {
  font: 'var(--text-body-reg-14)',
  lineHeight: '20px',
  color: 'var(--colors-text-description, #384A62)',
}

const VALUE_STYLE: React.CSSProperties = {
  font: 'var(--text-heading-smb-20)',
  lineHeight: '26px',
  color: 'var(--colors-text-main, #283648)',
}

export interface Metric {
  label: string
  value: string
  iconGroup: string
  iconName: string
}

/** Card chrome, matching Home.tsx's local `Card`. */
function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        border: '1px solid var(--colors-border-neutral-base-subtle, #DBDBDB)',
        borderRadius: 'var(--border-large)',
        backgroundColor: 'var(--colors-background-midground-subtle, #FAFAFA)',
        padding: 'var(--spacing-container-xxlarge)',
        boxSizing: 'border-box',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export default function MetricCard({
  metric,
  layout = 'stacked',
  tone = 'neutral',
  loading = false,
}: {
  metric: Metric
  layout?: 'stacked' | 'badge'
  tone?: MetricTone
  /** Shimmers the value while the figure is still in flight; the label stays put. */
  loading?: boolean
}) {
  if (layout === 'badge') {
    return (
      <Card
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-container-xlarge)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: 36,
            height: 36,
            flexShrink: 0,
            borderRadius: 'var(--border-medium)',
            backgroundColor: 'var(--colors-background-neutral-base-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <FIcon
            group={metric.iconGroup}
            name={metric.iconName}
            size={18}
            color={TONE_ICON_COLOR[tone]}
            pressable={false}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {loading ? (
            <Shimmer width={56} height={20} style={{ margin: '3px 0' }} />
          ) : (
            <span style={VALUE_STYLE}>{metric.value}</span>
          )}
          <span
            style={{
              ...LABEL_STYLE,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {metric.label}
          </span>
        </div>
      </Card>
    )
  }

  return (
    <Card
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 'var(--spacing-container-large)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-container-medium)',
          minHeight: 24,
        }}
      >
        <FIcon group={metric.iconGroup} name={metric.iconName} size={16} pressable={false} />
        <span
          style={{
            ...LABEL_STYLE,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {metric.label}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', minHeight: 28 }}>
        {loading ? (
          <Shimmer width={56} height={20} />
        ) : (
          <span style={VALUE_STYLE}>{metric.value}</span>
        )}
      </div>
    </Card>
  )
}
