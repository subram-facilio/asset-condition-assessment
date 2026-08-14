import { FText } from "@facilio/dsm-react-wrapper";
import { DarkButton } from "./Buttons";

/**
 * Home's agent banner — what this agent does, and the one action that starts it.
 *
 * The artwork is built rather than photographic. Its sibling apps use a 2.7 MB skyline JPEG, which
 * is wrong here on three counts: a skyline says "property portfolio", not "this chiller is
 * corroding"; it is a lot of static bundle for decoration; and a baked light-mode photo cannot
 * respond to `[data-theme='dark']`. This draws the thing the agent actually computes — condition
 * falling as corrective work orders accumulate — in a few hundred bytes of SVG, entirely in design
 * tokens, so it re-tints with the theme.
 */

/** Condition declining left-to-right, with work-order markers thickening toward the present. */
function ConditionCurve() {
  // 12 evenly-spaced events on a decaying curve. Fixed rather than derived: this is illustration,
  // not data, and a banner that redrew itself per portfolio would imply otherwise.
  const points = [8, 14, 19, 27, 31, 40, 46, 55, 62, 72, 80, 88].map((x, i, all) => {
    const t = i / (all.length - 1);
    // Ease-in decay: gentle at first, steeper as events crowd together.
    const y = 22 + Math.pow(t, 1.7) * 52;
    return { x, y, r: 1.6 + t * 2.2 };
  });
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y.toFixed(1)}`).join(" ");

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
    >
      {/* Grid — the reference the curve falls away from. */}
      {[25, 50, 75].map((y) => (
        <line
          key={y}
          x1="0"
          y1={y}
          x2="100"
          y2={y}
          stroke="var(--colors-border-neutral-base-subtler)"
          strokeWidth="0.4"
        />
      ))}
      <path
        d={`${path} L88 100 L8 100 Z`}
        fill="var(--colors-background-accent-blue-subtle)"
        opacity="0.55"
      />
      <path
        d={path}
        fill="none"
        stroke="var(--colors-icon-primary-default)"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={p.r}
          fill={
            i >= points.length - 3
              ? "var(--colors-icon-semantic-orange)"
              : "var(--colors-icon-primary-default)"
          }
        />
      ))}
    </svg>
  );
}

export function AgentBanner({ onRun }: { onRun: () => void }) {
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        gap: "var(--spacing-container-xxlarge)",
        padding: "var(--spacing-container-xxlarge)",
        borderRadius: "var(--border-xlarge)",
        border: "1px solid var(--colors-border-neutral-base-subtle)",
        backgroundColor: "var(--colors-background-container)",
      }}
    >
      {/* Artwork sits in the right 45%, under a left-to-right wash so the copy stays legible over
          it at any width. */}
      <div
        aria-hidden
        style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: "52%", pointerEvents: "none" }}
      >
        <ConditionCurve />
        {/* The wash only has to protect the copy, so it clears well before the curve's steep end.
            Pulled back from 55% — at that stop it was covering the part of the curve that carries
            the meaning, leaving the artwork reading as a smudge. */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "linear-gradient(90deg, var(--colors-background-container) 0%, color-mix(in srgb, var(--colors-background-container) 40%, transparent) 32%, transparent 62%)",
          }}
        />
      </div>

      {/* Percentage, not a px cap: the copy has to stay clear of the artwork at every banner
          width, and a fixed 620px ran the text under the curve once the column got wide. */}
      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: "var(--spacing-container-medium)",
          maxWidth: "56%",
          minWidth: 260,
        }}
      >
        <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
          From Work Order History To Condition, Automatically
        </FText>
        <FText appearance="captionReg12" styleProps={{ color: "textMain", display: "block" }}>
          Every assessment reads live corrective work orders and their before-maintenance photos from
          Facilio — no questionnaires, no manual condition entry. The agent reads the photographs and
          writes the explanation; the engine owns every number.
        </FText>
      </div>

      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: "var(--spacing-container-xxlarge)", flexWrap: "wrap" }}>
        <DarkButton
          label="Run assessment"
          icon={{ group: "16px-special-case", name: "plus" }}
          onClick={onRun}
        />
      </div>
    </div>
  );
}
