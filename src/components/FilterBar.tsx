import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { FIcon } from '@facilio/dsm-react-wrapper'
import { useHoverPill } from './useHoverPill'
import SearchField from './SearchField'

export interface FilterOption {
  value: string
  label: string
}

export interface FilterDefinition {
  /** Field this filter narrows; used as the key into the selection map. */
  key: string
  label: string
  icon?: { group: string; name: string }
  /** First option is the reset ("All"); the rest are the values to filter by. */
  options: FilterOption[]
}

interface FilterBarProps {
  filters: FilterDefinition[]
  /** Selected value per filter key; a filter sitting on its first option isn't narrowing. */
  selected: Record<string, string>
  onChange: (key: string, value: string) => void
  onClearAll: () => void
  search: string
  onSearchChange: (value: string) => void
  searchPlaceholder?: string
}

/** The token set OpsVision's insight FilterChip uses, so the pill reads the same across products. */
const C = {
  chipBg: 'var(--colors-background-container)',
  border: 'var(--colors-border-neutral-base-subtler)',
  borderHover: 'var(--colors-border-neutral-base-medium)',
  heading: 'var(--colors-text-main)',
  muted: 'var(--colors-text-caption)',
  primaryText: 'var(--colors-text-primary-default)',
  primaryTint: 'var(--colors-background-accent-blue-subtle)',
  /* Ink and outline for anything sitting ON the blue tint — the chip once it's narrowing, and the
     selected row in its menu. Pinned to palette literals rather than the primary tokens: the tint
     stays light in dark mode while `text-primary-default` gets *lighter* there, which put the
     label at 2.5:1 on its own background. Blue-60 is what light mode already resolves to, so this
     changes nothing there and holds at 4.7:1 in dark. */
  activeInk: 'var(--color-blue-60)',
  activeBorder: 'var(--color-blue-60)',
  activeBorderHover: 'var(--color-blue-70)',
  icon: 'var(--colors-icon-neutral-main)',
} as const

/** Chips are compact; the search field beside them keeps the standard control height. */
const CHIP_HEIGHT = 28

/**
 * Dropdown filter chip mirroring OpsVision's: a rounded pill that opens a menu with a gliding hover
 * pill and a checkmark on the selected option. Hover and open shift the border; picking anything but
 * the reset option switches the pill to the primary treatment.
 *
 * The menu is positioned against the chip rather than portalled — DSM's FPopover puts its content
 * somewhere a click at an option's centre lands on the table underneath instead of the option.
 */
const FilterChip = ({
  filter,
  value,
  onChange,
}: {
  filter: FilterDefinition
  value: string
  onChange: (value: string) => void
}) => {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLSpanElement>(null)

  // Gliding hover pill inside the menu — the same effect the sidebar nav uses.
  const containerRef = useRef<HTMLDivElement>(null)
  const hoverPillRef = useRef<HTMLDivElement>(null)
  const [hoveredEl, setHoveredEl] = useState<HTMLElement | null>(null)
  useHoverPill({ containerRef, pillRef: hoverPillRef, hoveredEl })

  const handleMouseOver = (event: ReactMouseEvent<HTMLDivElement>) => {
    const hoverable = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-nav-hoverable="true"]',
    )
    if (!hoverable || !containerRef.current?.contains(hoverable)) return
    setHoveredEl((prev) => (prev === hoverable ? prev : hoverable))
  }

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (target && !wrapperRef.current?.contains(target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const resetValue = filter.options[0]?.value
  const active = value !== resetValue
  const selectedLabel = filter.options.find((option) => option.value === value)?.label ?? value

  const restBorder = active ? C.activeBorder : C.border
  const hoverBorder = active ? C.activeBorderHover : C.borderHover
  // Glyphs take the icon token at rest and the active ink once the chip is narrowing, so the whole
  // pill shifts together.
  const accent = active ? C.activeInk : C.icon

  return (
    <span ref={wrapperRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        onMouseEnter={(event) => {
          event.currentTarget.style.borderColor = hoverBorder
        }}
        onMouseLeave={(event) => {
          if (!open) event.currentTarget.style.borderColor = restBorder
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: CHIP_HEIGHT,
          padding: '0 10px',
          borderRadius: 999,
          fontSize: 12,
          border: `1px solid ${open ? hoverBorder : restBorder}`,
          background: active ? C.primaryTint : C.chipBg,
          cursor: 'pointer',
          font: '500 12px/18px Roboto, sans-serif',
          transition: 'border-color 0.15s ease, background-color 0.15s ease',
          whiteSpace: 'nowrap',
        }}
      >
        {filter.icon && (
          <FIcon
            group={filter.icon.group}
            name={filter.icon.name}
            size={12}
            color={accent}
            pressable={false}
          />
        )}
        {/* One label, either the field or the value it's narrowing to — never both. An unfiltered
            chip names the field ("Status"); once a value is picked the chip becomes that value
            ("Monthly"), since the field is what the value already implies. */}
        <span style={{ color: active ? C.activeInk : C.heading }}>
          {active ? selectedLabel : filter.label}
        </span>
        <FIcon
          group="dsm"
          name={open ? 'chevron-up' : 'chevron-down'}
          size={12}
          color={accent}
          pressable={false}
        />
      </button>

      {open && (
        <div
          ref={containerRef}
          onMouseOver={handleMouseOver}
          onMouseLeave={() => setHoveredEl(null)}
          role="listbox"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 30,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
            padding: 4,
            minWidth: 180,
            maxHeight: 280,
            overflowY: 'auto',
            backgroundColor: 'var(--colors-background-container)',
            border: `1px solid ${C.border}`,
            borderRadius: 'var(--border-medium)',
            boxShadow: '0px 2px 4px rgba(5, 16, 30, 0.14), 0px 8px 16px rgba(5, 16, 30, 0.14)',
          }}
        >
          {/* Gliding hover pill. */}
          <div
            ref={hoverPillRef}
            aria-hidden
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              height: 32,
              borderRadius: 6,
              backgroundColor: 'var(--colors-background-midground-dark)',
              opacity: 0,
              transformOrigin: 'top left',
              transition: 'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.12s ease',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
          {filter.options.map((option) => {
            const isSelected = option.value === value
            return (
              <div
                key={option.value}
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                data-nav-hoverable="true"
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    onChange(option.value)
                    setOpen(false)
                  }
                }}
                style={{
                  position: 'relative',
                  zIndex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '6px 12px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  backgroundColor: isSelected ? C.primaryTint : 'transparent',
                }}
              >
                <span
                  style={{
                    font: '400 14px/21px Roboto, sans-serif',
                    color: isSelected ? C.activeInk : 'var(--colors-text-description)',
                  }}
                >
                  {option.label}
                </span>
                {isSelected && (
                  <FIcon group="dsm" name="check" size={14} color={C.activeInk} pressable={false} />
                )}
              </div>
            )
          })}
        </div>
      )}
    </span>
  )
}

/**
 * Filter row above a data table: a chip per filterable field, and a search field on the trailing
 * edge.
 *
 * Presentational only — it reports selections and lets the page decide what to do with them, so the
 * same bar can drive a client-side narrow now and a server-side query later without changing here.
 */
export default function FilterBar({
  filters,
  selected,
  onChange,
  onClearAll,
  search,
  onSearchChange,
  searchPlaceholder = 'Search…',
}: FilterBarProps) {
  const anyActive =
    search.trim().length > 0 ||
    filters.some(
      (filter) =>
        (selected[filter.key] ?? filter.options[0]?.value) !== filter.options[0]?.value,
    )

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--spacing-container-large)',
        padding: 'var(--spacing-container-large) var(--spacing-container-xxlarge)',
        backgroundColor: 'var(--colors-background-container)',
        borderBottom: '1px solid var(--colors-border-neutral-base-subtler)',
        flexShrink: 0,
        // The dropdowns open over the grid, whose sticky header already claims z-index 10.
        position: 'relative',
        zIndex: 20,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-container-large)',
          flexWrap: 'wrap',
          minWidth: 0,
        }}
      >
        {filters.map((filter) => (
          <FilterChip
            key={filter.key}
            filter={filter}
            value={selected[filter.key] ?? filter.options[0]?.value}
            onChange={(next) => onChange(filter.key, next)}
          />
        ))}

        {anyActive && (
          <button
            type="button"
            onClick={onClearAll}
            style={{
              height: CHIP_HEIGHT,
              padding: '0 var(--spacing-container-large)',
              border: 'none',
              background: 'transparent',
              color: C.primaryText,
              font: '500 12px/18px Roboto, sans-serif',
              cursor: 'pointer',
            }}
          >
            Clear all
          </button>
        )}
      </div>

      <div style={{ marginLeft: 'auto', flexShrink: 0 }}>
        <SearchField value={search} onChange={onSearchChange} placeholder={searchPlaceholder} />
      </div>
    </div>
  )
}
