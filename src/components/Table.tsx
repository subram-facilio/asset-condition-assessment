import React, { useEffect, useRef, useState } from "react";
import {
  FText,
  // FCheckbox,
  FEmptystate,
  FIcon,
} from "@facilio/dsm-react-wrapper";
import type { TableColumn, SortOrder } from "./tableTypes";
import Tooltip from "./Tooltip";
import { Shimmer } from "./Shimmer";

/** Placeholder rows shown while `loading`. Enough to fill a typical viewport. */
const SKELETON_ROWS = 10;

/**
 * Default body row height — tall enough for a two-line cell (a title with a secondary line under
 * it, e.g. asset name + model number). Single-line grids can pass a shorter `rowHeight`. The
 * header is independent of this: see HEADER_HEIGHT.
 */
const ROW_HEIGHT = "56px";
const HEADER_HEIGHT = "40px";

/**
 * Horizontal cell padding. The outer edges use the page gutter
 * (--spacing-container-xxlarge, 16px — the same value PageHeader and the footer pad with) so the
 * first column's text lines up under the page-header icon and the record count; interior columns
 * stay tighter, since there the padding only separates neighbours.
 */
const EDGE_PADDING = "var(--spacing-container-xxlarge)";
const CELL_PADDING = "12px";

/** Row separator, carried by the cells since the separate border model ignores borders on <tr>. */
const ROW_BORDER = "1px solid var(--colors-border-neutral-base-subtler)";

const paddingFor = (index: number, count: number) => ({
  paddingLeft: index === 0 ? EDGE_PADDING : CELL_PADDING,
  paddingRight: index === count - 1 ? EDGE_PADDING : CELL_PADDING,
});

/** Shared clipping style: one line, ellipsised at the cell's edge. */
const CLIP_STYLE: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
  width: "100%",
};

/**
 * True when `el` (or anything inside it — cells stack FText spans that clip themselves) is showing
 * an ellipsis. The 1px slack absorbs sub-pixel layout rounding, which would otherwise report a
 * fully visible cell as clipped.
 */
const isClipped = (el: HTMLElement): boolean =>
  el.scrollWidth > el.clientWidth + 1 ||
  Array.from(el.querySelectorAll<HTMLElement>("*")).some(
    (child) => child.scrollWidth > child.clientWidth + 1,
  );

/**
 * A cell whose tooltip only appears when the text is actually cut off. Hovering a cell that fits
 * shows nothing, so reading a grid of short values isn't a stream of redundant tooltips.
 *
 * Truncation is measured on mount, whenever the content changes, and on resize — not on hover —
 * so the tooltip is already armed (or disarmed) by the time the pointer arrives.
 */
const TruncatedCell = ({
  tooltip,
  children,
}: {
  tooltip: string;
  children: React.ReactNode;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setTruncated(isClipped(el));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [tooltip, children]);

  return (
    <Tooltip content={tooltip} placement="top" disabled={!truncated || !tooltip} fullWidth>
      <div ref={ref} style={CLIP_STYLE}>
        {children}
      </div>
    </Tooltip>
  );
};

interface TableProps<T = any> {
  columns: TableColumn<T>[];
  data: T[];
  loading?: boolean;
  rowKey?: string | ((record: T) => string);
  onRowClick?: (record: T, index: number) => void;
  mainFieldClick?: (record: T, index: number) => void;
  isMainColumnClickDisabled?: (record: T) => boolean;
  selectable?: boolean;
  selectedRows?: string[];
  onSelectionChange?: (selectedIds: string[]) => void;
  /**
   * Optional hard cap on the scroll area. Leave unset: the table then flexes to fill whatever the
   * parent column has left, which keeps the footer under it at the real bottom of the page and the
   * horizontal scrollbar at the table's own bottom edge. A viewport calc here only matches the
   * layout at one particular chrome height, and short of that it leaves dead space below the rows.
   */
  height?: string;
  /** Body row height. Defaults to ROW_HEIGHT (56px); pass a shorter value for single-line grids. */
  rowHeight?: string;
  /** Key of the currently sorted column — only meaningful alongside a `sortable` column. */
  sortBy?: string;
  sortOrder?: SortOrder;
  onSortChange?: (key: string, order: SortOrder) => void;
  renderRowActions?: (record: T, index: number) => React.ReactNode;
  /**
   * Size the columns to the container instead of to their content: the table lays out at 100%
   * width with no horizontal scrollbar, and each `column.width` is read as a share of that width
   * (pass percentages). Use for grids with few enough columns to fit the viewport.
   */
  fitToWidth?: boolean;
  /**
   * Pin the first column while the rest scroll under it, with an edge shadow that fades in once
   * the table is scrolled. Ignored under `fitToWidth`, where there is no horizontal scroll to pin
   * against.
   */
  stickyFirstColumn?: boolean;
}

/** Layering: the header band sits above the pinned column, which sits above ordinary cells. */
const Z_STICKY_HEADER_CELL = 2;
const Z_STICKY_BODY_CELL = 3;

/** scrollLeft under this counts as "at rest" — sub-pixel values shouldn't flicker the shadow. */
const SCROLL_EPSILON = 2;

function Table<T extends Record<string, any>>({
  columns,
  data,
  loading = false,
  rowKey = "id",
  onRowClick,
  mainFieldClick,
  isMainColumnClickDisabled,
  selectable: _selectable = true,
  selectedRows = [],
  onSelectionChange: _onSelectionChange,
  height,
  rowHeight = ROW_HEIGHT,
  sortBy,
  sortOrder = "asc",
  onSortChange,
  renderRowActions,
  fitToWidth = false,
  stickyFirstColumn = false,
}: TableProps<T>) {
  const [hoveredRowIndex, setHoveredRowIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isScrolled, setIsScrolled] = useState(false);

  // fitToWidth has no horizontal overflow, so there is nothing to pin against.
  const pinFirstColumn = stickyFirstColumn && !fitToWidth;

  // Tracks only the boolean, not the offset: re-rendering per scrolled pixel is what makes a
  // sticky column stutter. Setting the same value is a no-op in React, so scrolling within either
  // state costs nothing and the shadow's CSS transition is left to run uninterrupted.
  const handleScroll = () => {
    const next = (scrollRef.current?.scrollLeft ?? 0) > SCROLL_EPSILON;
    setIsScrolled((prev) => (prev === next ? prev : next));
  };

  /** Sticky-cell styles for the first column, shared by header, body, and skeleton rows. */
  const stickyCellStyle = (
    background: string,
    zIndex: number,
  ): React.CSSProperties => ({
    position: "sticky",
    left: 0,
    zIndex,
    // A pinned cell has content sliding under it, so it needs its own opaque fill — inheriting
    // the row's would leave it transparent and show the scrolling columns through the text.
    backgroundColor: background,
    // The edge strip below hangs past the cell's right edge; the cell's own text is still clipped,
    // by the inner CLIP_STYLE wrapper.
    overflow: "visible",
  });

  /**
   * The gradient edge that marks the pinned column while the rest scrolls under it. Sits just
   * outside the cell and fades on opacity — cheaper to animate than a shadow colour, and it
   * disappears completely at the origin.
   */
  const stickyEdge = (
    <span
      aria-hidden
      style={{
        position: "absolute",
        top: 0,
        right: "-10px",
        width: "10px",
        height: "100%",
        pointerEvents: "none",
        background: "var(--fm-sticky-col-gradient)",
        opacity: isScrolled ? 1 : 0,
        transition: "opacity 160ms ease",
      }}
    />
  );

  const getRowKey = (record: T, index: number): string => {
    if (typeof rowKey === "function") return rowKey(record);
    return String(record[rowKey] ?? index);
  };

  // const handleSelectAll = () => {
  //   if (!onSelectionChange) return;
  //   if (selectedRows.length === data.length) {
  //     onSelectionChange([]);
  //   } else {
  //     onSelectionChange(data.map((r, i) => getRowKey(r, i)));
  //   }
  // };

  // const handleSelectRow = (id: string) => {
  //   if (!onSelectionChange) return;
  //   if (selectedRows.includes(id)) {
  //     onSelectionChange(selectedRows.filter((r) => r !== id));
  //   } else {
  //     onSelectionChange([...selectedRows, id]);
  //   }
  // };

  // While loading, the real header + shimmer rows render in place of a spinner,
  // so switching tabs shows the table's shape settling rather than a blank
  // frame that then jumps to a full grid.
  if (!loading && (!data || data.length === 0)) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--spacing-section-large)",
          flex: 1,
          minHeight: 0,
        }}
      >
        <FEmptystate
          title="No Plans found"
          description="There are no plans to display at this moment."
          illustration="vendor-onboarding"
          size="M"
          vertical={true}
        />
      </div>
    );
  }

  // const isAllSelected = selectedRows.length === data.length;
  // const isIndeterminate =
  //   selectedRows.length > 0 && selectedRows.length < data.length;

  return (
    <div
      ref={scrollRef}
      onScroll={pinFirstColumn ? handleScroll : undefined}
      style={{
        overflowX: fitToWidth ? "hidden" : "auto",
        overflowY: "auto",
        // Kill the rubber-band overscroll: without this, flicking back from the last column drags
        // the grid past its own edge and shows empty canvas beside it. Also stops a horizontal
        // flick from chaining out to whatever scrolls behind the table.
        overscrollBehaviorX: "none",
        maxHeight: height,
        flex: 1,
        // Without this a flex child refuses to shrink below its content height, so the rows would
        // push the footer off-screen instead of scrolling inside this box.
        minHeight: 0,
        position: "relative",
      }}
    >
      <table
        style={{
          minWidth: "100%",
          width: fitToWidth ? "100%" : "max-content",
          // Fixed layout is what makes the percentage `column.width`s authoritative — with `auto`
          // the browser would re-widen columns to fit their content and reintroduce the scrollbar.
          tableLayout: fitToWidth ? "fixed" : "auto",
          // Separate (with zero spacing) rather than collapse: the collapsed border model splits
          // each shared border between its two cells, so a bordered header cell's padding box ends
          // half a pixel short of an unbordered body cell's. That half pixel is enough to misalign
          // the pinned column's edge between header and rows. Zero spacing keeps the visual
          // identical, and each cell now owns its own borders — see the per-cell borderBottom.
          borderCollapse: "separate",
          borderSpacing: 0,
          backgroundColor: "var(--colors-background-container)",
          fontFamily: "Roboto, sans-serif",
        }}
      >
        <thead
          style={{
            position: "sticky",
            top: 0,
            zIndex: 10,
          }}
        >
          <tr>
            {/* {selectable && (
              <th
                style={{
                  width: "52px",
                  minWidth: "52px",
                  maxWidth: "52px",
                  paddingLeft: "12px",
                  paddingRight: "0",
                  height: "40px",
                  backgroundColor: "var(--colors-background-midground-subtle)",
                  borderBottom:
                    "1px solid var(--colors-border-neutral-base-subtler)",
                  textAlign: "center",
                  verticalAlign: "middle",
                }}
              >
                <FCheckbox
                  checked={isAllSelected}
                  indeterminate={isIndeterminate}
                  onInput={handleSelectAll}
                  {...(!isAllSelected && {
                    style: {
                      ["--colors-icon-primary-pressed" as any]:
                        "var(--colors-border-neutral-base-light)",
                    },
                  })}
                />
              </th>
            )} */}
            {columns.map((column, columnIndex) => {
              const isSortable = Boolean(column.sortable && onSortChange);
              const isSorted = isSortable && sortBy === column.key;
              return (
              <th
                key={column.key}
                onClick={
                  isSortable
                    ? () =>
                        onSortChange!(
                          column.key,
                          // Re-clicking the active column flips it; a new column starts ascending.
                          isSorted && sortOrder === "asc" ? "desc" : "asc",
                        )
                    : undefined
                }
                style={{
                  width: column.width || "auto",
                  minWidth: fitToWidth ? 0 : column.width || "100px",
                  ...paddingFor(columnIndex, columns.length),
                  height: HEADER_HEIGHT,
                  backgroundColor: "var(--colors-background-container)",
                  borderBottom:
                    "1px solid var(--colors-border-neutral-base-subtler)",
                  textAlign: (column.align || "left") as any,
                  fontSize: "14px",
                  fontWeight: 500,
                  color: "var(--colors-text-main)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  // The rules separate columns, so the leading edge gets none — on the first cell
                  // it read as a stray vertical line against the table's outer boundary.
                  borderLeft:
                    columnIndex === 0
                      ? "none"
                      : "1px solid var(--colors-border-neutral-base-subtler)",
                  cursor: isSortable ? "pointer" : "default",
                  userSelect: isSortable ? "none" : "auto",
                  ...(pinFirstColumn &&
                    columnIndex === 0 &&
                    stickyCellStyle(
                      "var(--colors-background-container)",
                      Z_STICKY_HEADER_CELL,
                    )),
                }}
              >
                {isSortable ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--spacing-container-medium)",
                      minWidth: 0,
                      justifyContent:
                        column.align === "right" ? "flex-end" : undefined,
                    }}
                  >
                    <TruncatedCell tooltip={column.title}>
                      {column.title}
                    </TruncatedCell>
                    <span
                      style={{
                        display: "inline-flex",
                        flexShrink: 0,
                        // Caret points down for descending, up for ascending. Dimmed until the
                        // column is the active sort, so the affordance reads without shouting.
                        transform:
                          isSorted && sortOrder === "asc"
                            ? "rotate(180deg)"
                            : "none",
                        opacity: isSorted ? 1 : 0.4,
                      }}
                    >
                      <FIcon
                        group="16px-special-case"
                        name="chevron-down"
                        size={12}
                        color=""
                        pressable={false}
                      />
                    </span>
                  </div>
                ) : (
                  <TruncatedCell tooltip={column.title}>{column.title}</TruncatedCell>
                )}
                {pinFirstColumn && columnIndex === 0 && stickyEdge}
              </th>
              );
            })}
            {renderRowActions && (
              <th
                style={{
                  width: 0,
                  minWidth: 0,
                  padding: 0,
                  border: "none",
                  // Same surface as the header cells it sits beside, so the sticky header reads as
                  // one band even where this spacer takes over at the right edge.
                  backgroundColor: "var(--colors-background-container)",
                }}
              />
            )}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: SKELETON_ROWS }).map((_, rowIndex) => (
                <tr
                  key={`skeleton-${rowIndex}`}
                  style={{
                    backgroundColor: "var(--colors-background-container)",
                  }}
                >
                  {columns.map((column, columnIndex) => (
                    <td
                      key={column.key}
                      style={{
                        width: column.width || "auto",
                        maxWidth: fitToWidth ? undefined : column.width || "100px",
                        ...paddingFor(columnIndex, columns.length),
                        height: rowHeight,
                        verticalAlign: "middle",
                        // Row separators live on the cells, not the <tr>: the separate border model
                        // doesn't paint row borders at all.
                        borderBottom: ROW_BORDER,
                        ...(pinFirstColumn &&
                          columnIndex === 0 &&
                          stickyCellStyle(
                            "var(--colors-background-container)",
                            Z_STICKY_BODY_CELL,
                          )),
                      }}
                    >
                      {/* Mirrors the loaded cell's text width so the grid
                          doesn't reflow when real rows land. */}
                      <Shimmer height={14} width={column.mainColumn ? "70%" : "45%"} />
                      {pinFirstColumn && columnIndex === 0 && stickyEdge}
                    </td>
                  ))}
                  {renderRowActions && (
                    <td
                      style={{
                        padding: 0,
                        border: "none",
                        width: 0,
                        minWidth: 0,
                      }}
                    />
                  )}
                </tr>
              ))
            : data.map((record, index) => {
            const key = getRowKey(record, index);
            const isHovered = hoveredRowIndex === index;
            const isSelected = selectedRows.includes(key);
            // One value for both the row and its pinned cell: the pinned cell paints its own
            // background, so anything else would leave the hover/selection tint stopping at the
            // first column's edge.
            const rowBackground = isSelected
              ? "var(--colors-background-selection)"
              : isHovered
                ? "var(--colors-background-midground-subtle)"
                : "var(--colors-background-container)";

            return (
              <React.Fragment key={key}>
                <tr
                  style={{
                    cursor: onRowClick ? "pointer" : "default",
                    backgroundColor: rowBackground,
                  }}
                  onMouseEnter={() => setHoveredRowIndex(index)}
                  onMouseLeave={() => setHoveredRowIndex(null)}
                  onClick={
                    onRowClick ? () => onRowClick(record, index) : undefined
                  }
                >
                  {/* {selectable && (
                    <td
                      style={{
                        width: "52px",
                        minWidth: "52px",
                        maxWidth: "52px",
                        paddingLeft: "12px",
                        paddingRight: "0",
                        height: "40px",
                        textAlign: "center",
                        verticalAlign: "middle",
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <FCheckbox
                        checked={isSelected}
                        onInput={() => handleSelectRow(key)}
                        {...(!isSelected && {
                          style: {
                            ["--colors-icon-primary-pressed" as any]:
                              "var(--colors-border-neutral-base-light)",
                          },
                        })}
                      />
                    </td>
                  )} */}
                  {columns.map((column, columnIndex) => {
                    const isMainColumnDisabled =
                      column.mainColumn &&
                      isMainColumnClickDisabled?.(record);
                    const isMainColumnClickable =
                      column.mainColumn &&
                      mainFieldClick &&
                      !isMainColumnDisabled;
                    const cellContent = column.render ? (
                      column.render(record[column.key], record, index)
                    ) : (
                      <FText
                        appearance="bodyReg14"
                        styleProps={{ color: "textMain" }}
                      >
                        {record[column.key]}
                      </FText>
                    );
                    return (
                    <td
                      key={column.key}
                      onClick={
                        isMainColumnClickable
                          ? (e) => {
                              e.stopPropagation();
                              mainFieldClick(record, index);
                            }
                          : undefined
                      }
                      style={{
                        width: column.width || "auto",
                        maxWidth: fitToWidth ? undefined : column.width || "100px",
                        ...paddingFor(columnIndex, columns.length),
                        height: rowHeight,
                        textAlign: (column.align || "left") as any,
                        verticalAlign: "middle",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        cursor: isMainColumnClickable ? "pointer" : "default",
                        borderBottom: ROW_BORDER,
                        ...(pinFirstColumn &&
                          columnIndex === 0 &&
                          stickyCellStyle(rowBackground, Z_STICKY_BODY_CELL)),
                      }}
                    >
                      {column.disableTooltip ? (
                        <div style={CLIP_STYLE}>{cellContent}</div>
                      ) : (
                        <TruncatedCell tooltip={String(record[column.key] ?? "")}>
                          {cellContent}
                        </TruncatedCell>
                      )}
                      {pinFirstColumn && columnIndex === 0 && stickyEdge}
                    </td>
                  );
                  })}
                  {renderRowActions && (
                    <td
                      style={{
                        position: "sticky",
                        right: 0,
                        padding: 0,
                        border: "none",
                        width: 0,
                        minWidth: 0,
                        overflow: "visible",
                      }}
                    >
                      {isHovered && (
                        <div
                          style={{
                            position: "absolute",
                            right: 0,
                            top: 0,
                            // Matches ROW_HEIGHT so the hover panel covers the row exactly.
                            height: rowHeight,
                            display: "flex",
                            alignItems: "center",
                            padding: "8px",
                            backgroundColor:
                              "var(--colors-background-midground-subtle)",
                            borderLeft: "2px solid #384a62",
                            borderTopLeftRadius: "4px",
                            borderBottomLeftRadius: "4px",
                            gap: "4px",
                            zIndex: 5,
                          }}
                        >
                          {renderRowActions(record, index)}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              </React.Fragment>
            );
              })}
        </tbody>
      </table>
    </div>
  );
}

export default Table;
