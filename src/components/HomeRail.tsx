import type { ReactNode } from "react";
import { FIcon, FText } from "@facilio/dsm-react-wrapper";
import { Shimmer } from "./Shimmer";

/**
 * The Home page's right rail: short, scannable lists that sit beside the main column rather than
 * below it. Deliberately not cards — the rail reads as a column of headings, so the eye treats it
 * as secondary to the bordered cards on the left.
 */

export function RailBlock({
  title,
  onViewAll,
  children,
}: {
  title: string;
  onViewAll?: () => void;
  children: ReactNode;
}) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-container-xxlarge)",
        padding: "var(--spacing-container-xxlarge) var(--spacing-container-large)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
          {title}
        </FText>
        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            style={{
              border: "none",
              background: "transparent",
              padding: 0,
              cursor: "pointer",
              font: "var(--text-body-reg-14)",
              color: "var(--colors-text-primary-default)",
            }}
          >
            View all
          </button>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
        {children}
      </div>
    </section>
  );
}

/** Skeleton mirroring {@link RailRow}'s 32px chip + title line, so nothing shifts when data lands. */
function RailSkeleton({ rows = 3 }: { rows?: number }) {
  const widths = ["70%", "55%", "64%", "48%"];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-xlarge)" }}>
          <Shimmer width={32} height={32} borderRadius={8} />
          <Shimmer width={widths[i % widths.length]} height={14} />
        </div>
      ))}
    </div>
  );
}

export function RailList({
  loading,
  empty,
  emptyText,
  skeletonRows,
  children,
}: {
  loading: boolean;
  empty: boolean;
  emptyText: string;
  skeletonRows?: number;
  children: ReactNode;
}) {
  if (loading) return <RailSkeleton rows={skeletonRows} />;
  if (empty) {
    return (
      <FText appearance="captionReg12" styleProps={{ color: "textCaption", display: "block" }}>
        {emptyText}
      </FText>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
      {children}
    </div>
  );
}

export function RailRow({
  icon,
  title,
  meta,
  trailing,
  href,
}: {
  icon: { group: string; name: string };
  title: string;
  /** Second line — the reason this row is in the list (priority, cost, date). */
  meta?: ReactNode;
  trailing?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <span
        style={{
          width: 32,
          height: 32,
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--border-medium)",
          backgroundColor: "var(--colors-background-midground-subtle)",
          border: "1px solid var(--colors-border-neutral-base-subtler)",
        }}
      >
        <FIcon group={icon.group} name={icon.name} size={16} pressable={false} />
      </span>

      <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1, gap: 2 }}>
        <FText
          appearance="bodyReg14"
          styleProps={{
            color: "textMain",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "block",
          }}
        >
          {title}
        </FText>
        {meta && (
          <span style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-medium)" }}>
            {meta}
          </span>
        )}
      </span>

      {trailing}
    </>
  );

  const style: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing-container-xlarge)",
    minWidth: 0,
    textDecoration: "none",
    color: "inherit",
  };

  return href ? (
    <a href={href} style={style}>
      {body}
    </a>
  ) : (
    <div style={style}>{body}</div>
  );
}
