import { useState } from "react";
import type { ReactNode } from "react";
import { FText } from "@facilio/dsm-react-wrapper";

/**
 * A collapsed-by-default section — the app's one affordance for detail that proves a
 * conclusion without competing with it.
 *
 * The pages lead with the verdict and its reasoning; formulas, risk-term weights,
 * count corrections and lock results are how the verdict is *defensible*, not what it
 * says. Kept on the surface they read as noise; deleted, the app loses its audit trail.
 * One click is the right price.
 *
 * State is deliberately local and unpersisted: a disclosure that remembered itself open
 * would reintroduce the wall of internals on the next asset the reader opened.
 */
export function Disclosure({
  title,
  subtitle,
  defaultOpen = false,
  children,
}: {
  title: string;
  /** Optional one-liner shown beside the title while collapsed — a reason to open it. */
  subtitle?: string;
  /** Start open. For sections that are evidence rather than diagnostics. */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-large)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-container-medium)",
          padding: 0,
          background: "none",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          font: "inherit",
        }}
      >
        {/* A CSS caret rather than an FIcon: the DSM set has no chevron under a group
            name this app already uses, and a missing glyph fails silently as an empty
            <f-icon>, leaving a disclosure with no visible affordance. */}
        <span
          aria-hidden
          style={{
            width: 0,
            height: 0,
            flexShrink: 0,
            borderTop: "4px solid transparent",
            borderBottom: "4px solid transparent",
            borderLeft: "6px solid var(--colors-icon-neutral-light, #94a3b8)",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            transformOrigin: "35% 50%",
            transition: "transform 140ms ease",
          }}
        />
        <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
          {title}
        </FText>
        {subtitle && !open && (
          <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
            {subtitle}
          </FText>
        )}
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
          {children}
        </div>
      )}
    </div>
  );
}
