import type React from "react";

/**
 * Column + sort types for {@link ./Table}. Their own file because Table is ported verbatim from
 * fm-planner, where these live in a domain types module this app has no equivalent of.
 */

export type SortOrder = "asc" | "desc";

export interface TableColumn<T = any> {
  key: string;
  title: string;
  width?: string;
  align?: "left" | "center" | "right";
  render?: (value: any, record: T, index: number) => React.ReactNode;
  mainColumn?: boolean;
  /** Suppress the per-cell hover tooltip (e.g. boolean columns that stringify to "true"/"false"). */
  disableTooltip?: boolean;
  /**
   * Let this cell wrap onto several lines instead of being clamped to one ellipsised row. Pair with
   * the table's `rowHeight` so the taller content has somewhere to go.
   */
  multiline?: boolean;
  /** Render a sort caret in the header and report clicks via the table's `onSortChange`. */
  sortable?: boolean;
}
