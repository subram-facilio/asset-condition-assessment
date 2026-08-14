import { useState } from 'react'
import { FIcon } from '@facilio/dsm-react-wrapper'

export interface SearchFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Field width in px. Defaults to the list-view width. */
  width?: number
}

/**
 * The app's standard search input: a filled pill, no border at rest, with a
 * leading magnifier and a clear button once there's a query. Used by the list
 * views' filter bar and by the Agent Config pickers so search looks the same
 * everywhere.
 */
const SearchField = ({
  value,
  onChange,
  placeholder = 'Search…',
  width = 260,
}: SearchFieldProps) => {
  const [focused, setFocused] = useState(false)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--spacing-container-large)',
        height: 32,
        padding: '0 var(--spacing-container-xlarge)',
        borderRadius: 'var(--border-round, 40px)',
        // No percentage cap here: a % max-width would resolve against this pill's own wrapper,
        // which shrink-wraps to the pill — the two feed each other and settle far narrower.
        width,
        // Without this a filling flex sibling (chips row, toolbar heading) squeezes the field.
        flexShrink: 0,
        boxSizing: 'border-box',
        // Transparent at rest rather than none, so gaining the focus ring doesn't shift the field's
        // width by a pixel on each side.
        border: `1px solid ${focused ? 'var(--colors-border-primary-default)' : 'transparent'}`,
        // Fill stays put: the border carries the focus state. Darkening it as well washed the field
        // out in dark mode, where midground-dark is a *lighter* slate than the resting fill.
        backgroundColor: 'var(--colors-background-midground-medium)',
        transition: 'border-color 0.14s ease',
      }}
    >
      <FIcon name="search" group="action" size={16} pressable={false} />
      <input
        className="fm-search-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: 'var(--colors-text-main)',
          font: 'var(--text-body-reg-14)',
        }}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          style={{
            display: 'flex',
            border: 'none',
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
          }}
        >
          <FIcon
            group="dsm"
            name="close"
            size={12}
            color="var(--colors-text-caption)"
            pressable={false}
          />
        </button>
      )}
    </div>
  )
}

export default SearchField
