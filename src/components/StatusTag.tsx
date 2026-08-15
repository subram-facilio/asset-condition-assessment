import type { CSSProperties, ReactNode } from "react";

/**
 * The app's one status chip, replacing the old `.pill` class.
 *
 * Tones are pinned to literal palette steps rather than semantic tokens. Every DSM "subtle"
 * background stays a light tint in dark mode while the matching text token gets *lighter*, which
 * would leave the label at roughly 2:1 — the same reason `StatCards` pins its tile tints.
 */

export type Tone = "good" | "warn" | "bad" | "crit" | "info" | "mute";

const TONES: Record<Tone, { bg: string; ink: string; border: string }> = {
  good: { bg: "#e8f6ec", ink: "#1a7f3c", border: "#bfe5cb" },
  warn: { bg: "#fdf3dc", ink: "#8a5a00", border: "#f0dcae" },
  bad: { bg: "#fdeaea", ink: "#b02525", border: "#f3c9c9" },
  crit: { bg: "#f3e8fb", ink: "#7a1fa2", border: "#e0c8ee" },
  info: { bg: "#e8f0fe", ink: "#1a56c4", border: "#c6d9f8" },
  mute: { bg: "#f0f1f3", ink: "#5b6470", border: "#dcdee2" },
};

/** Dark mode inverts the pair: a deep translucent wash under a light ink. */
const DARK_TONES: Record<Tone, { bg: string; ink: string; border: string }> = {
  good: { bg: "rgba(78,207,164,0.14)", ink: "#6fdcb4", border: "rgba(78,207,164,0.32)" },
  warn: { bg: "rgba(232,182,76,0.14)", ink: "#e8bc5c", border: "rgba(232,182,76,0.32)" },
  bad: { bg: "rgba(255,122,122,0.14)", ink: "#ff9494", border: "rgba(255,122,122,0.32)" },
  crit: { bg: "rgba(208,155,240,0.14)", ink: "#d5a8f2", border: "rgba(208,155,240,0.32)" },
  info: { bg: "rgba(107,157,255,0.14)", ink: "#8fb5ff", border: "rgba(107,157,255,0.32)" },
  mute: { bg: "rgba(148,163,184,0.14)", ink: "#a3adba", border: "rgba(148,163,184,0.3)" },
};

export function StatusTag({ tone, children }: { tone: Tone | string; children: ReactNode }) {
  const key = (tone in TONES ? tone : "mute") as Tone;
  const light = TONES[key];
  const dark = DARK_TONES[key];

  return (
    <span
      // Both palettes are set as custom properties so the dark override is a
      // stylesheet rule (see index.css) rather than a JS media query.
      className="ca-status-tag"
      style={
        {
          "--tag-bg": light.bg,
          "--tag-ink": light.ink,
          "--tag-border": light.border,
          "--tag-bg-dark": dark.bg,
          "--tag-ink-dark": dark.ink,
          "--tag-border-dark": dark.border,
        } as React.CSSProperties
      }
    >
      {children}
    </span>
  );
}

/**
 * The tone ink as inline custom properties, for chart marks that cannot wear the
 * `.ca-status-tag` pill — mix-bar segments, scatter dots.
 *
 * Charts used to carry their own hex table, which drifted from the chips beside them
 * and only in one theme, because the literals had no dark counterpart. Pair this with
 * `.ca-tone-fill` (CSS background) or `.ca-tone-mark` (SVG fill) in index.css.
 */
export function toneVars(tone: Tone | string): CSSProperties {
  const key = (tone in TONES ? tone : "mute") as Tone;
  return {
    "--ca-ink": TONES[key].ink,
    "--ca-ink-dark": DARK_TONES[key].ink,
  } as CSSProperties;
}

/* ------------------------------------------------------- tone mapping helpers */

export function severityTone(s: string): Tone {
  return s === "critical" ? "crit" : s === "high" ? "bad" : s === "medium" ? "warn" : s === "low" ? "good" : "mute";
}

export function riskTone(level: string): Tone {
  const l = String(level).toLowerCase();
  return l === "critical" ? "crit" : l === "high" ? "bad" : l === "medium" ? "warn" : l === "low" ? "good" : "mute";
}

export function gradeTone(grade: string): Tone {
  return grade === "CRITICAL" ? "crit" : grade === "POOR" ? "bad" : grade === "AVERAGE" ? "warn" : "good";
}

export function recommendationTone(r: string): Tone {
  return r === "REPLACE" ? "crit" : r === "REFURBISH" ? "bad" : r === "REPAIR" ? "warn" : "good";
}

export function statusTone(s: string): Tone {
  return s === "highly_recurring" ? "bad" : s === "recurring" ? "warn" : s === "isolated" ? "info" : "mute";
}

export function trendTone(t: string): Tone {
  return t === "increasing" ? "bad" : t === "decreasing" ? "good" : t === "insufficient_evidence" ? "mute" : "warn";
}

export function priorityTone(p: string): Tone {
  return p === "P1" ? "crit" : p === "P2" ? "bad" : p === "P3" ? "warn" : "mute";
}
