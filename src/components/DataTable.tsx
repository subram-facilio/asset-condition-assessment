import React, { useLayoutEffect, useRef, useState } from 'react'
import { FText } from '@facilio/dsm-react-wrapper'
import { useHoverPill } from './useHoverPill'
import { Shimmer, ShimmerCircle } from './Shimmer'
import OverlayScrollbar from './OverlayScrollbar'

// Outer horizontal inset (first / last cell) so the first column and the
// layout footer text line up on the same left edge. Inner cells use a smaller
// inset; adjacent cells therefore sit ~2x INNER_PAD_X apart.
const EDGE_PAD_X = '16px' // var(--spacing-container-xxlarge)
const INNER_PAD_X = '12px'
const CELL_PAD_Y = '12px'

const BORDER = '1px solid var(--colors-border-neutral-base-subtle)'
const ACTION_COL_WIDTH = '72px'
const HEADER_BG = 'var(--colors-background-midground-subtle)'

// Number of placeholder rows shown while `loading` (non-fill tables, whose
// height is driven by row count). In `fillHeight` mode the count is computed
// from the scroll viewport so the shimmer fills the table the same way the
// loaded list does — see `skeletonRows` below.
const SKELETON_ROWS = 9

// Height of a single row / skeleton row, in px. Used both for the row cells
// and to compute how many skeleton rows fill the `fillHeight` viewport.
const ROW_HEIGHT = 44

/**
 * Standard text for a table cell — the canonical row-text style (`bodyReg14`
 * / `textCaption`). Use it inside custom `render`s so every cell reads
 * consistently; it's also the default renderer for columns without a `render`.
 * Pass `ellipsis` for flexible columns whose content should clip on overflow.
 */
export const DataTableCellText: React.FC<{
  children: React.ReactNode
  ellipsis?: boolean
}> = ({ children, ellipsis = false }) => (
  <FText
    appearance="bodyReg14"
    styleProps={{ color: 'textDescription' }}
    style={
      ellipsis
        ? { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
        : undefined
    }
  >
    {children}
  </FText>
)

export interface DataTableColumn<T> {
  key: string
  title: string
  /** Fixed column width (e.g. "240px"). */
  width?: string
  /** Size the column to its widest cell's content (and stay aligned). */
  fit?: boolean
  /**
   * For flexible columns (neither `width` nor `fit`), the share of leftover
   * width relative to other flexible columns. Default 1.
   */
  grow?: number
  align?: 'left' | 'center' | 'right'
  /** Custom cell renderer. Falls back to `String(record[key])`. */
  render?: (record: T) => React.ReactNode
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  data: T[]
  rowKey: (record: T) => string | number
  /**
   * Optional right-aligned action cell per row (e.g. a delete button). Always
   * return the action; the table reserves its column and reveals it on row
   * hover (see `actionVisibility`) — so showing it never shifts the row text.
   */
  renderRowAction?: (record: T) => React.ReactNode
  /** When `'hover'` (default), the row action fades in only on row hover. */
  actionVisibility?: 'hover' | 'always'
  loading?: boolean
  emptyText?: string
  /** Row click handler — rows become pointer-cursor when set. */
  onRowClick?: (record: T) => void
  /** Wrap the table in a 1px box-shadow ring with a 12px radius (card look). */
  bordered?: boolean
  /** Footer content (e.g. pagination) rendered below the rows, with a divider. */
  footer?: React.ReactNode
  /** Fill the parent's height — the card stretches and the footer pins to the
   *  bottom. Use inside a flex/height-filled container. */
  fillHeight?: boolean
  /** Like `fillHeight`, but the card HUGS its rows and only grows up to the
   *  parent's height: a short page collapses to its rows, a long one caps and
   *  scrolls the rows internally. Header stays fixed, footer pinned. Use inside
   *  a flex/height-constrained container (same as `fillHeight`). */
  fitHeight?: boolean
  /** Optional section title rendered above the table card (headingMed14). When
   *  set (or `titleAction` is), the table is wrapped with a title row. */
  title?: React.ReactNode
  /** Optional right-aligned slot in the title row (e.g. a period filter). */
  titleAction?: React.ReactNode
  /**
   * Disable the on-update fade/slide + height morph that plays when the row
   * data changes (e.g. page/filter switches). Use for lists that refresh in
   * place and should swap data with no animation or flicker.
   */
  disableUpdateAnimation?: boolean
}

/**
 * Clean, card-friendly table built on a semantic `<table>` with
 * `table-layout: auto`:
 *   - `width`  columns take a fixed size.
 *   - `fit`    columns shrink to their widest content (and align across rows).
 *   - flexible columns absorb the leftover width by `grow` weight, clipping
 *     overflow with an ellipsis.
 * Pagination is intentionally NOT part of this component — drive it from the
 * surrounding layout's footer.
 */
function DataTable<T>({
  columns,
  data,
  rowKey,
  renderRowAction,
  actionVisibility = 'hover',
  loading = false,
  emptyText = 'No records found',
  onRowClick,
  bordered = false,
  footer,
  fillHeight = false,
  fitHeight = false,
  title,
  titleAction,
  disableUpdateAnimation = false,
}: DataTableProps<T>) {
  const [hoveredKey, setHoveredKey] = useState<string | number | null>(null)
  const [hoveredRow, setHoveredRow] = useState<HTMLElement | null>(null)
  // Both modes split the table into a fixed header + scroll body + pinned
  // footer; they differ only in whether the card fills (`height: 100%`) or
  // hugs up to (`max-height: 100%`) the parent height.
  const fill = fillHeight || fitHeight

  // Number of shimmer rows to render while loading. For non-fill tables this
  // stays at SKELETON_ROWS (the table is only as tall as its rows). For
  // fillHeight tables the body scrolls to fill the parent, so a fixed count
  // would leave the shimmer covering only part of the area while the real list
  // fills it — we measure the scroll viewport and render enough rows to fill it.
  const scrollViewportRef = useRef<HTMLDivElement>(null)
  const [skeletonRows, setSkeletonRows] = useState(SKELETON_ROWS)
  useLayoutEffect(() => {
    if (!fill || !loading) return
    const measure = () => {
      const h = scrollViewportRef.current?.clientHeight ?? 0
      if (h > 0) setSkeletonRows(Math.max(1, Math.ceil(h / ROW_HEIGHT)))
    }
    measure()
    const el = scrollViewportRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fill, loading])

  // Sliding "ghost" hover pill (same effect as the sidebar nav), driven by the
  // hovered <tr>. It sits behind the rows; cells stay transparent so it shows
  // through. See `useHoverPill`.
  const wrapperRef = useRef<HTMLDivElement>(null)
  // The pill lives inside `contentRef` (the scrollable content) so it tracks
  // the rows when the table scrolls internally (fillHeight).
  const contentRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  useHoverPill({ containerRef: contentRef, pillRef, hoveredEl: hoveredRow })

  // Page-to-page morph: when the rows change between pages, the body fades +
  // slides in and the table height eases between page sizes (e.g. a shorter
  // final page). Deliberately skipped on the FIRST data arrival — that's the
  // initial load, which is covered by the loading shimmer instead — and while
  // loading, so the morph plays only on genuine page switches.
  const tbodyRef = useRef<HTMLTableSectionElement>(null)
  const prevHeightRef = useRef<number | null>(null)
  const hadDataRef = useRef(false)
  useLayoutEffect(() => {
    const wrap = wrapperRef.current
    const tbody = tbodyRef.current
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const hasData = data.length > 0
    // Morph only on a page switch: data is present, we've shown data before,
    // not mid-load, motion is allowed, and the caller hasn't opted out.
    const shouldMorph =
      !disableUpdateAnimation &&
      hadDataRef.current &&
      hasData &&
      !loading &&
      !reduceMotion

    // The height morph only applies to natural-height (paged) tables. In
    // fill/fit mode the card height is driven by the parent (height/max-height),
    // so imperatively setting its height here (and resetting to `auto`) would
    // override that and make the table grow/shrink with the row count.
    if (wrap && !fill) {
      const newHeight = wrap.offsetHeight
      const prevHeight = prevHeightRef.current
      if (shouldMorph && prevHeight != null && prevHeight !== newHeight) {
        wrap.style.height = `${prevHeight}px`
        void wrap.offsetWidth // reflow before animating to the new height
        wrap.style.transition = 'height 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
        wrap.style.height = `${newHeight}px`
        const reset = () => {
          wrap.style.height = 'auto'
          wrap.style.transition = ''
          wrap.removeEventListener('transitionend', reset)
        }
        wrap.addEventListener('transitionend', reset)
      }
      prevHeightRef.current = newHeight
    }

    if (tbody && shouldMorph) {
      tbody.style.transition = 'none'
      tbody.style.opacity = '0'
      tbody.style.transform = 'translateY(6px)'
      void tbody.offsetWidth // reflow so the enter animates from this state
      tbody.style.transition =
        'opacity 0.16s ease, transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
      tbody.style.opacity = '1'
      tbody.style.transform = 'translateY(0)'
    }

    if (hasData) hadDataRef.current = true
  }, [data, loading, disableUpdateAnimation, fill])

  const isFlexible = (c: DataTableColumn<T>) => !c.width && !c.fit
  const totalGrow = columns
    .filter(isFlexible)
    .reduce((sum, c) => sum + (c.grow ?? 1), 0)
  const hasFit = columns.some((c) => c.fit)

  // When no column flexes (all are fixed `width` / `fit`), the table would
  // stretch the fixed columns to fill 100%. A trailing filler column absorbs
  // the leftover instead, so explicit widths are honoured. Placed BEFORE the
  // action column so the row action stays right-aligned.
  const showFiller = !columns.some(isFlexible)

  // Sum the explicit px widths (plus the action column) so a flexible column
  // can be sized as a share of the REMAINING width. Without this, the flexible
  // columns' percentages add up to 100% of the whole table and fight the fixed
  // columns, so the fixed widths get squeezed and aren't honoured. Only applied
  // when there are no `fit` columns (whose content width we can't sum here).
  const PX_RE = /^\s*(\d+(?:\.\d+)?)px\s*$/
  const fixedPxTotal =
    columns.reduce((sum, c) => {
      const m = c.width ? PX_RE.exec(c.width) : null
      return m ? sum + parseFloat(m[1]) : sum
    }, 0) + (renderRowAction ? parseFloat(ACTION_COL_WIDTH) : 0)
  const subtractFixed = !hasFit && fixedPxTotal > 0

  // Minimum table width so columns stay readable on narrow screens — the table
  // never crushes below this; instead it scrolls horizontally (see the
  // overflow-x on the body container). Flexible / fit columns get a sensible
  // floor since their natural widths aren't known here.
  const FLEX_MIN = 140
  const FIT_MIN = 96
  const minTableWidth =
    fixedPxTotal +
    columns.filter(isFlexible).length * FLEX_MIN +
    columns.filter((c) => c.fit).length * FIT_MIN

  // Resolve the <col> width per column:
  //   fixed → its width · fit → shrink-to-content (1%) · flexible → its share
  //   of the remaining width (after fixed columns), or % of the table.
  const colWidth = (c: DataTableColumn<T>): string => {
    if (c.width) return c.width
    if (c.fit) return '1%'
    const ratio = (c.grow ?? 1) / (totalGrow || 1)
    return subtractFixed
      ? `calc((100% - ${fixedPxTotal}px) * ${ratio})`
      : `${ratio * 100}%`
  }

  const padX = (index: number, isLast: boolean): React.CSSProperties => ({
    paddingLeft: index === 0 ? EDGE_PAD_X : INNER_PAD_X,
    paddingRight: isLast ? EDGE_PAD_X : INNER_PAD_X,
  })

  const lastCellIndex = columns.length - 1 + (renderRowAction ? 1 : 0)

  // Base <table> style. `position/zIndex` lifts the table above the hover pill
  // (which sits at zIndex 0 behind the rows).
  const TABLE_STYLE: React.CSSProperties = {
    position: 'relative',
    zIndex: 1,
    width: '100%',
    borderCollapse: 'collapse',
    // fillHeight splits the header & body into two separate tables. `fixed`
    // makes the shared <colgroup> widths authoritative so both tables size
    // their columns identically — otherwise auto-layout sizes each table to its
    // own content and the header text stops lining up over the cells. Non-fill
    // tables stay `auto` (so `fit` columns can shrink to content).
    tableLayout: fill ? 'fixed' : 'auto',
  }

  // Shared <colgroup> — rendered fresh for each table so the header and body
  // tables (split apart in fillHeight mode) keep identical column widths.
  const renderColgroup = () => (
    <colgroup>
      {columns.map((c) => (
        <col key={c.key} style={{ width: colWidth(c) }} />
      ))}
      {showFiller && <col style={{ width: '100%' }} />}
      {renderRowAction && <col style={{ width: ACTION_COL_WIDTH }} />}
    </colgroup>
  )

  // Ghost hover pill — slides behind the rows to follow the hovered row.
  const pillEl = (
    <div
      ref={pillRef}
      aria-hidden
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 0,
        height: 0,
        backgroundColor: 'var(--colors-background-midground-subtle)',
        opacity: 0,
        transformOrigin: 'top left',
        willChange: 'transform, width, height, opacity',
        transition:
          'transform 0.2s cubic-bezier(0.4, 0, 0.2, 1), width 0.2s cubic-bezier(0.4, 0, 0.2, 1), height 0.2s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.12s ease',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  )

  const headEl = (
    <thead>
      <tr>
        {columns.map((col, index) => (
          <th
            key={col.key}
            style={{
              ...padX(index, !renderRowAction && index === columns.length - 1),
              paddingTop: CELL_PAD_Y,
              paddingBottom: CELL_PAD_Y,
              textAlign: col.align ?? 'left',
              fontWeight: 400,
              whiteSpace: 'nowrap',
              backgroundColor: HEADER_BG,
              borderBottom: BORDER,
            }}
          >
            <FText appearance="captionMed12" styleProps={{ color: 'textMain' }}>
              {col.title}
            </FText>
          </th>
        ))}
        {showFiller && (
          <th aria-hidden style={{ backgroundColor: HEADER_BG, borderBottom: BORDER }} />
        )}
        {renderRowAction && (
          <th style={{ ...padX(lastCellIndex, true), backgroundColor: HEADER_BG, borderBottom: BORDER }} />
        )}
      </tr>
    </thead>
  )

  const bodyEl = (
      <tbody ref={tbodyRef}>
        {loading && data.length === 0 ? (
          // Initial-load shimmer skeleton — mirrors the row layout (cell
          // paddings, 44px row height, dividers) so the table doesn't jump when
          // real rows land. Page switches keep the current rows and morph (the
          // skeleton is only for the first load, when there's no data yet).
          Array.from({ length: skeletonRows }).map((_, rowIndex) => {
            const isLastRow = rowIndex === skeletonRows - 1
            return (
              <tr key={`skeleton-${rowIndex}`}>
                {columns.map((col, index) => (
                  <td
                    key={col.key}
                    style={{
                      ...padX(index, !renderRowAction && index === columns.length - 1),
                      height: `${ROW_HEIGHT}px`,
                      boxSizing: 'border-box',
                      verticalAlign: 'middle',
                      borderBottom: isLastRow ? 'none' : BORDER,
                    }}
                  >
                    {index === 0 ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <ShimmerCircle size={20} />
                        <Shimmer height={14} width="60%" />
                      </div>
                    ) : (
                      <Shimmer height={14} width={col.fit ? 64 : '70%'} />
                    )}
                  </td>
                ))}
                {showFiller && (
                  <td style={{ borderBottom: isLastRow ? 'none' : BORDER }} />
                )}
                {renderRowAction && (
                  <td
                    style={{
                      ...padX(lastCellIndex, true),
                      verticalAlign: 'middle',
                      textAlign: 'right',
                      borderBottom: isLastRow ? 'none' : BORDER,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <ShimmerCircle size={20} />
                    </div>
                  </td>
                )}
              </tr>
            )
          })
        ) : data.length === 0 ? (
          <tr>
            <td
              colSpan={columns.length + (showFiller ? 1 : 0) + (renderRowAction ? 1 : 0)}
              style={{ padding: 'var(--spacing-section-medium)', textAlign: 'center' }}
            >
              <FText appearance="bodyReg14" styleProps={{ color: 'textCaption' }}>
                {emptyText}
              </FText>
            </td>
          </tr>
        ) : (
          data.map((record, rowIndex) => {
            const key = rowKey(record)
            const isHovered = hoveredKey === key
            const isLastRow = rowIndex === data.length - 1
            return (
              <tr
                key={key}
                onMouseEnter={(e) => {
                  setHoveredKey(key)
                  setHoveredRow(e.currentTarget)
                }}
                onClick={onRowClick ? () => onRowClick(record) : undefined}
                style={{
                  cursor: onRowClick ? 'pointer' : 'default',
                }}
              >
                {columns.map((col, index) => {
                  const flexible = isFlexible(col)
                  const content = col.render ? (
                    col.render(record)
                  ) : (
                    <DataTableCellText ellipsis={flexible}>
                      {String((record as Record<string, unknown>)[col.key] ?? '')}
                    </DataTableCellText>
                  )
                  return (
                    <td
                      key={col.key}
                      style={{
                        ...padX(index, !renderRowAction && index === columns.length - 1),
                        height: `${ROW_HEIGHT}px`,
                        boxSizing: 'border-box',
                        textAlign: col.align ?? 'left',
                        verticalAlign: 'middle',
                        whiteSpace: 'nowrap',
                        borderBottom: isLastRow ? 'none' : BORDER,
                      }}
                    >
                      {/* Flexible cells clip with an ellipsis; the overflow:hidden
                          wrapper also lets the column shrink below its content. */}
                      {flexible ? (
                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {content}
                        </div>
                      ) : (
                        content
                      )}
                    </td>
                  )
                })}
                {showFiller && (
                  <td style={{ borderBottom: isLastRow ? 'none' : BORDER }} />
                )}
                {renderRowAction && (
                  <td
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      ...padX(lastCellIndex, true),
                      verticalAlign: 'middle',
                      textAlign: 'right',
                      whiteSpace: 'nowrap',
                      borderBottom: isLastRow ? 'none' : BORDER,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'flex-end',
                        // Space is always reserved by the column; only the
                        // action's visibility toggles, so row text never shifts.
                        opacity: actionVisibility === 'always' || isHovered ? 1 : 0,
                        pointerEvents:
                          actionVisibility === 'always' || isHovered ? 'auto' : 'none',
                        transition: 'opacity 0.12s ease',
                      }}
                    >
                      {renderRowAction(record)}
                    </div>
                  </td>
                )}
              </tr>
            )
          })
        )}
      </tbody>
  )

  const card = (
    <div
      ref={wrapperRef}
      onMouseLeave={() => {
        setHoveredRow(null)
        setHoveredKey(null)
      }}
      style={{
        width: '100%',
        ...(bordered
          ? {
              boxShadow: '0 0 0 1px var(--colors-border-neutral-base-subtle)',
              borderRadius: '12px',
              overflow: 'hidden',
            }
          : null),
        // fill/fit → the header stays fixed, only the rows scroll, and the
        // footer pins to the bottom. `fillHeight` fills the parent; `fitHeight`
        // hugs the rows up to the parent (short page collapses). Otherwise a
        // normal block.
        ...(fill
          ? {
              ...(fitHeight ? { maxHeight: '100%' } : { height: '100%' }),
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }
          : { position: 'relative' }),
      }}
    >
      {fill ? (
        <>
          {/* Fixed header — its own table, outside the scroll region, so it
              never scrolls and stays crisp (untouched by the body's fade). */}
          <table style={{ ...TABLE_STYLE, flexShrink: 0 }}>
            {renderColgroup()}
            {headEl}
          </table>

          {/* Scrollable body — the only scroll region. OverlayScrollbar gives
              the overlay thumb, a soft top/bottom edge-fade gradient, and
              `overscroll-behavior: none` (no rubber-band bounce). */}
          <OverlayScrollbar
            edgeFade
            edgeFadeSoft
            overscrollBehavior="none"
            scrollableRef={scrollViewportRef}
            style={{ flex: fitHeight ? '0 1 auto' : 1, minHeight: 0 }}
          >
            <div ref={contentRef} style={{ position: 'relative' }}>
              {pillEl}
              <table style={TABLE_STYLE}>
                {renderColgroup()}
                {bodyEl}
              </table>
            </div>
          </OverlayScrollbar>
        </>
      ) : (
        <div ref={contentRef} style={{ position: 'relative', overflowX: 'auto' }}>
          {pillEl}
          <table style={{ ...TABLE_STYLE, minWidth: `${minTableWidth}px` }}>
            {renderColgroup()}
            {headEl}
            {bodyEl}
          </table>
        </div>
      )}

      {footer && (
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            // Pinned below the scroll region in fill/fit mode.
            flexShrink: fill ? 0 : undefined,
            borderTop: BORDER,
            padding: `${CELL_PAD_Y} ${EDGE_PAD_X}`,
            boxSizing: 'border-box',
          }}
        >
          {footer}
        </div>
      )}
    </div>
  )

  // No title row requested → the card is the whole component.
  if (title == null && titleAction == null) return card

  // Title row above the card. In fill/fit mode the wrapper is a flex column so
  // the title stays fixed and the card fills (or hugs up to) the remaining
  // height.
  return (
    <div
      style={{
        width: '100%',
        ...(fill
          ? {
              ...(fitHeight ? { maxHeight: '100%' } : { height: '100%' }),
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }
          : null),
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--spacing-container-large)',
          flexShrink: 0,
          marginBottom: 'var(--spacing-container-xlarge)',
        }}
      >
        {title != null ? (
          <FText appearance="headingMed14" styleProps={{ color: 'textDescription' }}>
            {title}
          </FText>
        ) : (
          <span />
        )}
        {titleAction}
      </div>
      {fillHeight ? <div style={{ flex: 1, minHeight: 0 }}>{card}</div> : card}
    </div>
  )
}

export default DataTable
