import type { ReactNode } from "react";
import { FText } from "@facilio/dsm-react-wrapper";
import type { Metric, MtbfGap, Unavailable } from "./types";

/** Hash-based routing so deep links survive a refresh on static hosting. */
export function useRoute(): { path: string; navigate: (to: string) => void } {
  const path = window.location.hash.replace(/^#/, "") || "/";
  return {
    path,
    navigate: (to: string) => {
      window.location.hash = to;
    },
  };
}

export function pretty(s: string): string {
  return String(s || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Small inline sparkline — avoids pulling in a charting dependency. */
export function Spark({
  values,
  tone = "var(--colors-icon-primary-default)",
}: {
  values: number[];
  tone?: string;
}) {
  if (values.length < 2) {
    return (
      <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
        Not enough history to plot.
      </FText>
    );
  }
  const w = 240;
  const h = 46;
  const pad = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = pad + (i * (w - pad * 2)) / (values.length - 1);
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="trend"
      style={{ width: "100%", height: 46, display: "block" }}
    >
      <polyline points={pts.join(" ")} fill="none" stroke={tone} strokeWidth="2" strokeLinejoin="round" />
      {pts.map((p, i) => {
        const [x, y] = p.split(",");
        return <circle key={i} cx={x} cy={y} r="2.4" fill={tone} />;
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Honesty widgets. A metric that could not be computed is shown as a stated gap,
 * never as a blank or a zero — the gap is part of the assessment.
 * ------------------------------------------------------------------ */

/** Render a metric, or the reason it is unavailable. */
export function Val({
  metric,
  suffix = "",
  fallbackLabel = "not available",
}: {
  metric?: Metric<number | string> | null;
  suffix?: string;
  fallbackLabel?: string;
}) {
  if (!metric || !metric.available || metric.value === null) {
    return (
      <span style={{ color: "var(--colors-text-caption)" }} title={metric?.reason || ""}>
        {fallbackLabel}
      </span>
    );
  }
  return (
    <>
      {metric.value}
      {suffix}
    </>
  );
}

/** The unavailable-metrics panel — what the evidence could not support, and why. */
export function GapList({ items, title = "Not available" }: { items?: Unavailable[]; title?: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-container-large)",
        padding: "var(--spacing-container-xlarge)",
        borderRadius: "var(--border-medium)",
        border: "1px dashed var(--colors-border-neutral-base-subtle)",
        backgroundColor: "var(--colors-background-midground-subtle)",
      }}
    >
      <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
        {title}
      </FText>
      {items.map((u, i) => (
        <div
          key={i}
          style={{ display: "flex", gap: "var(--spacing-container-large)", flexWrap: "wrap", minWidth: 0 }}
        >
          <FText appearance="bodyReg14" styleProps={{ color: "textMain" }}>
            {u.metric}
          </FText>
          <FText appearance="bodyReg14" styleProps={{ color: "textCaption" }}>
            {u.reason}
          </FText>
        </div>
      ))}
    </div>
  );
}

/** Provenance badge — says whether a number was measured, overridden or estimated. */
export function Provenance({ source, confidence }: { source?: string; confidence?: number }) {
  const label =
    source === "actuals"
      ? "actual"
      : source === "override"
      ? "override"
      : source === "configured"
      ? "configured"
      : source === "fallback"
      ? "fallback"
      : source === "asset_sample"
      ? "AI estimate, this asset"
      : "AI estimate";
  const low = typeof confidence === "number" && confidence > 0 && confidence < 0.6;
  const ink =
    source === "actuals"
      ? "var(--colors-icon-semantic-green)"
      : low
      ? "var(--colors-icon-semantic-orange)"
      : "var(--colors-text-caption)";

  return (
    <span
      title={
        typeof confidence === "number" && confidence > 0 ? `confidence ${confidence.toFixed(2)}` : label
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 6px",
        borderRadius: "var(--border-small)",
        border: "1px solid var(--colors-border-neutral-base-subtler)",
        backgroundColor: "var(--colors-background-container)",
        font: "var(--text-caption-reg-12)",
        color: ink,
        whiteSpace: "nowrap",
      }}
    >
      {label}
      {low ? " ⚠" : ""}
    </span>
  );
}

/**
 * MTBF interval bars. Bar length is inverse to the gap, so a shortening interval
 * reads as an intensifying signal rather than a shrinking one.
 */
export function MtbfBars({ gaps, verdict }: { gaps: MtbfGap[]; verdict?: string | null }) {
  if (!gaps.length) return null;
  const max = Math.max(...gaps.map((g) => g.months), 1);
  const verdictInk =
    verdict === "contracting"
      ? "var(--colors-icon-semantic-red, #d64545)"
      : verdict === "lengthening"
      ? "var(--colors-icon-semantic-green)"
      : "var(--colors-text-caption)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-large)" }}>
      {gaps.map((g, i) => (
        <div
          key={i}
          style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-xlarge)" }}
        >
          <span
            style={{
              width: 140,
              flexShrink: 0,
              font: "var(--text-caption-reg-12)",
              color: "var(--colors-text-caption)",
              whiteSpace: "nowrap",
            }}
          >
            {g.from} → {g.to}
          </span>
          <span
            style={{
              flex: 1,
              height: 8,
              minWidth: 40,
              borderRadius: 999,
              backgroundColor: "var(--colors-background-midground-dark)",
              overflow: "hidden",
            }}
          >
            <i
              style={{
                display: "block",
                height: "100%",
                width: `${Math.max((g.months / max) * 100, 3)}%`,
                borderRadius: 999,
                backgroundColor: "var(--colors-icon-primary-default)",
              }}
            />
          </span>
          <span
            style={{
              width: 56,
              flexShrink: 0,
              textAlign: "right",
              font: "var(--text-caption-reg-12)",
              color: "var(--colors-text-description)",
            }}
          >
            {g.months} mo
          </span>
        </div>
      ))}
      {verdict && (
        <span style={{ font: "var(--text-caption-reg-12)", color: verdictInk }}>
          {/* Words, not arrows: an arrow here means "interval down", which reads as
              improvement while meaning the opposite. Red always means bad. */}
          {verdict === "contracting"
            ? "Failing faster — the gap between corrective events is shrinking"
            : verdict === "lengthening"
            ? "Failing slower — the gap between corrective events is growing"
            : "Steady — no clear change in interval"}
        </span>
      )}
    </div>
  );
}

/** Age against expected life, so remaining life is visible rather than asserted. */
export function LifecycleBar({
  age,
  expectedLife,
  purchasedYear,
}: {
  age?: Metric<number> | null;
  expectedLife: number;
  purchasedYear?: string;
}) {
  if (!age || !age.available || age.value === null) {
    return (
      <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
        Age unavailable — {age?.reason || "no purchase date recorded"}.
      </FText>
    );
  }
  // The bar is age AGAINST expected life, so with no expected life there is nothing to
  // measure against. It used to default to 15 years, which drew a full, confident bar
  // out of a figure nobody had supplied.
  if (!expectedLife) {
    return (
      <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
        {age.value}y in service. Expected service life is unknown for this category, so
        there is nothing to measure it against — estimate it on the Baselines page.
      </FText>
    );
  }
  const pct = clampPct((age.value / Math.max(expectedLife, 1)) * 100);
  const over = age.value > expectedLife;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-large)" }}>
      <span
        style={{
          display: "block",
          height: 10,
          borderRadius: 999,
          backgroundColor: "var(--colors-background-midground-dark)",
          overflow: "hidden",
        }}
      >
        <i
          style={{
            display: "block",
            height: "100%",
            width: `${pct}%`,
            borderRadius: 999,
            backgroundColor: over
              ? "var(--colors-icon-semantic-red, #d64545)"
              : "var(--colors-icon-primary-default)",
          }}
        />
      </span>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--spacing-container-large)" }}>
        <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
          {purchasedYear ? `in service ${purchasedYear}` : "in service"}
        </FText>
        <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
          {age.value}y of {expectedLife}y {over ? "· past expected life" : ""}
        </FText>
      </div>
    </div>
  );
}

function clampPct(v: number): number {
  return v < 2 ? 2 : v > 100 ? 100 : v;
}

/** Centred single-line state, used while a page's only fetch is in flight. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--spacing-section-medium)",
      }}
    >
      <FText appearance="bodyReg14" styleProps={{ color: "textCaption" }}>
        {children}
      </FText>
    </div>
  );
}

/** Inline error strip. Full-bleed inside whatever band it is dropped into. */
export function ErrorBanner({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--spacing-container-large)",
        padding: "var(--spacing-container-xlarge)",
        borderRadius: "var(--border-medium)",
        border: "1px solid var(--colors-border-neutral-base-subtle)",
        backgroundColor: "var(--colors-background-midground-subtle)",
      }}
    >
      <FText appearance="bodyReg14" styleProps={{ color: "textMain", display: "block" }}>
        {children}
      </FText>
    </div>
  );
}
