import type { CSSProperties, ReactNode } from "react";
import { FIcon, FText } from "@facilio/dsm-react-wrapper";

/**
 * The surface every page block sits on: 1px hairline, large radius, subtle midground fill.
 *
 * `tone="container"` swaps the fill for the plain container colour — used when a card holds a table,
 * so the header row's midground tint has something to contrast against.
 */
export function Card({
  children,
  style,
  tone = "midground",
}: {
  children: ReactNode;
  style?: CSSProperties;
  tone?: "midground" | "container";
}) {
  return (
    <div
      style={{
        border: "1px solid var(--colors-border-neutral-base-subtle)",
        borderRadius: "var(--border-large)",
        backgroundColor:
          tone === "container"
            ? "var(--colors-background-container)"
            : "var(--colors-background-midground-subtle)",
        padding: "var(--spacing-container-xxlarge)",
        boxSizing: "border-box",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Card heading: an optional 16px glyph, the title, and an optional right-pinned action. */
export function CardTitle({
  icon,
  action,
  children,
}: {
  icon?: { group: string; name: string };
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--spacing-container-large)",
        minHeight: 24,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-container-medium)",
          minWidth: 0,
        }}
      >
        {icon && <FIcon group={icon.group} name={icon.name} size={16} pressable={false} />}
        <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
          {children}
        </FText>
      </div>
      {action}
    </div>
  );
}

/** Explanatory line under a card's content — the "how this number was reached" note. */
export function CardNote({ children }: { children: ReactNode }) {
  return (
    <FText appearance="captionReg12" styleProps={{ color: "textCaption", display: "block" }}>
      {children}
    </FText>
  );
}
