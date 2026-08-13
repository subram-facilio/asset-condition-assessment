import type { ReactNode } from "react";
import type { Severity } from "./types";

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
