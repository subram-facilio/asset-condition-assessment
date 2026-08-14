import React from 'react'
import { FIcon } from '@facilio/dsm-react-wrapper'

// fm-planner's DSM build has no FDivider export, so draw the divider line
// directly. Color matches the subtler DSM neutral border used elsewhere.
const DIVIDER_COLOR = 'var(--colors-border-neutral-base-subtle)'

export const HorizontalDivider: React.FC = () => (
  <div
    style={{ width: '100%', height: 1, backgroundColor: DIVIDER_COLOR }}
    aria-hidden
  />
)

export const ChevronDown: React.FC<{ open: boolean }> = ({ open }) => (
  <div
    style={{
      display: 'flex',
      flexShrink: 0,
      transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
      transition: 'transform 0.22s cubic-bezier(0.4, 0, 0.2, 1)',
    }}
  >
    <FIcon
      name="chevron-down"
      group="16px-special-case"
      size={16}
      pressable={false}
      color="var(--colors-icon-neutral-light)"
    />
  </div>
)
