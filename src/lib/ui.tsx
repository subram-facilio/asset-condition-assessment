import type { ReactNode } from "react";
import type { Metric, MtbfGap, Severity, Unavailable } from "./types";

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

export function Pill({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function severityTone(s: Severity | string): string {
  return s === "critical" ? "crit" : s === "high" ? "bad" : s === "medium" ? "warn" : s === "low" ? "good" : "mute";
}

export function riskTone(level: string): string {
  const l = String(level).toLowerCase();
  return l === "critical" ? "crit" : l === "high" ? "bad" : l === "medium" ? "warn" : l === "low" ? "good" : "mute";
}

export function gradeTone(grade: string): string {
  return grade === "CRITICAL" ? "crit" : grade === "POOR" ? "bad" : grade === "AVERAGE" ? "warn" : "good";
}

export function recommendationTone(r: string): string {
  return r === "REPLACE" ? "crit" : r === "REFURBISH" ? "bad" : r === "REPAIR" ? "warn" : "good";
}

export function statusTone(s: string): string {
  return s === "highly_recurring" ? "bad" : s === "recurring" ? "warn" : s === "isolated" ? "info" : "mute";
}

export function trendTone(t: string): string {
  return t === "increasing" ? "bad" : t === "decreasing" ? "good" : t === "insufficient_evidence" ? "mute" : "warn";
}

export function pretty(s: string): string {
  return String(s || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Small inline sparkline — avoids pulling in a charting dependency. */
export function Spark({ values, tone = "var(--accent)" }: { values: number[]; tone?: string }) {
  if (values.length < 2) return <div className="muted small">Not enough history to plot.</div>;
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
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="trend">
      <polyline points={pts.join(" ")} fill="none" stroke={tone} strokeWidth="2" strokeLinejoin="round" />
      {pts.map((p, i) => {
        const [x, y] = p.split(",");
        return <circle key={i} cx={x} cy={y} r="2.4" fill={tone} />;
      })}
    </svg>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="center">{children}</div>;
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
      <span className="muted" title={metric?.reason || ""}>
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
    <div className="gaps">
      <div className="gaps-title">{title}</div>
      {items.map((u, i) => (
        <div className="gap" key={i}>
          <span className="gap-metric">{u.metric}</span>
          <span className="gap-reason">{u.reason}</span>
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
      : "AI estimate";
  const low = typeof confidence === "number" && confidence > 0 && confidence < 0.6;
  return (
    <span className={`prov ${source === "actuals" ? "good" : low ? "warn" : "mute"}`} title={
      typeof confidence === "number" && confidence > 0 ? `confidence ${confidence.toFixed(2)}` : label
    }>
      {label}
      {typeof confidence === "number" && confidence > 0 ? ` ${confidence.toFixed(2)}` : ""}
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
  return (
    <div>
      {gaps.map((g, i) => (
        <div className="mtbf-row" key={i}>
          <span className="mtbf-dates">
            {g.from} → {g.to}
          </span>
          <span className="mtbf-bar">
            <i style={{ width: `${Math.max((g.months / max) * 100, 3)}%` }} />
          </span>
          <span className="mtbf-months">{g.months} mo</span>
        </div>
      ))}
      {verdict && (
        <div className={`mtbf-verdict ${verdict === "contracting" ? "bad" : verdict === "lengthening" ? "good" : "mute"}`}>
          {verdict === "contracting"
            ? "Contracting — corrective events are arriving faster"
            : verdict === "lengthening"
            ? "Lengthening — corrective events are arriving less often"
            : "Steady — no clear change in interval"}
        </div>
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
    return <div className="muted small">Age unavailable — {age?.reason || "no purchase date recorded"}.</div>;
  }
  const pct = clampPct((age.value / Math.max(expectedLife, 1)) * 100);
  const over = age.value > expectedLife;
  return (
    <div>
      <div className="life-bar">
        <i className={over ? "over" : ""} style={{ width: `${pct}%` }} />
      </div>
      <div className="row spread small muted">
        <span>{purchasedYear ? `in service ${purchasedYear}` : "in service"}</span>
        <span>
          {age.value}y of {expectedLife}y {over ? "· past expected life" : ""}
        </span>
      </div>
    </div>
  );
}

function clampPct(v: number): number {
  return v < 2 ? 2 : v > 100 ? 100 : v;
}
