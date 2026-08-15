import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { FButton, FIcon, FText } from "@facilio/dsm-react-wrapper";
import { fn, usd } from "../lib/vibe";
import type { Assessment } from "../lib/types";
import { ErrorBanner, useRoute } from "../lib/ui";
import { useUser } from "../context/UserContext";
import OverlayScrollbar from "../components/OverlayScrollbar";
import { Card, CardTitle, CardNote } from "../components/Card";
import { Shimmer } from "../components/Shimmer";
import { EmptyState } from "../components/EmptyState";
import { RailBlock, RailList, RailRow } from "../components/HomeRail";
import { StatusTag, gradeTone, priorityTone, riskTone, toneVars } from "../components/StatusTag";
import { DarkButton } from "../components/Buttons";

/**
 * Portfolio home.
 *
 * Two columns rather than the single centred column the sibling planner app uses: this agent
 * produces both a portfolio picture *and* a standing queue of assets that need a decision, and the
 * queue belongs beside the analysis, not four screens below it.
 *
 * One fetch feeds the whole page — `register` returns the KPIs and every row, so each section is a
 * different reading of the same payload rather than its own request.
 */

interface RegisterData {
  kpis: {
    assets_assessed: number;
    high_risk: number;
    medium_risk: number;
    low_risk: number;
    replace_count: number;
    refurbish_count: number;
    repair_count: number;
    monitor_count: number;
    p1_count: number;
    accelerating_count?: number;
    total_capex_exposure: number;
    total_repair_spend: number;
    avg_score: number;
  };
  register: Assessment[];
}

/**
 * Condition bands, worst last — the order they appear in the mix bar.
 *
 * No colours here: they come from `gradeTone` + `toneVars`, the same source the grade
 * chips use. A private hex table drifted from those chips and had no dark counterpart.
 */
const GRADES = [
  { key: "GOOD", label: "Good" },
  { key: "FAIR", label: "Fair" },
  { key: "AVERAGE", label: "Average" },
  { key: "POOR", label: "Poor" },
  { key: "CRITICAL", label: "Critical" },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good Morning";
  if (h < 17) return "Good Afternoon";
  return "Good Evening";
}

/* ------------------------------------------------------------------ pieces */

/** Section title over a block of cards, with an optional right-pinned action. */
function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          minHeight: 26,
          gap: "var(--spacing-container-large)",
        }}
      >
        <FText appearance="headingMed16" styleProps={{ color: "textMain" }}>
          {title}
        </FText>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One Overview tile: what it counts, then the figure. */
function StatTile({
  icon,
  label,
  value,
  loading,
  emphasis,
}: {
  icon: { group: string; name: string };
  label: string;
  value: string;
  loading: boolean;
  /** Tint the figure when it is a number the reader should not skim past. */
  emphasis?: boolean;
}) {
  return (
    <Card
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: "var(--spacing-container-large)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-container-medium)",
          minHeight: 24,
        }}
      >
        <FIcon group={icon.group} name={icon.name} size={16} pressable={false} />
        <FText
          appearance="bodyReg14"
          styleProps={{
            color: "textDescription",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "block",
          }}
        >
          {label}
        </FText>
      </div>
      <div style={{ display: "flex", alignItems: "center", minHeight: 28 }}>
        {loading ? (
          <Shimmer width={64} height={20} />
        ) : (
          <span
            style={{
              font: "var(--text-heading-smb-20)",
              lineHeight: "26px",
              color: emphasis
                ? "var(--colors-icon-semantic-red, #d64545)"
                : "var(--colors-text-main)",
            }}
          >
            {value}
          </span>
        )}
      </div>
    </Card>
  );
}

/** Condition mix: one segmented bar over a dot legend. */
function ConditionMix({ rows, avgScore }: { rows: Assessment[]; avgScore: number }) {
  const total = rows.length || 1;
  const slices = GRADES.map((g) => {
    const n = rows.filter((r) => r.grade === g.key).length;
    return { ...g, n, pct: Math.round((n / total) * 100), widthPct: (n / total) * 100 };
  }).filter((s) => s.n > 0);

  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
      <CardTitle icon={{ group: "chart-data", name: "bar-graph" }}>Condition mix</CardTitle>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xlarge)" }}>
        <div style={{ display: "flex", alignItems: "center", height: 12, width: "100%" }}>
          <div
            style={{
              display: "flex",
              width: "100%",
              height: 8,
              borderRadius: "var(--border-xlarge)",
              overflow: "hidden",
              gap: 2,
            }}
          >
            {slices.map((s) => (
              <div
                key={s.key}
                className="ca-tone-fill"
                style={{ width: `${s.widthPct}%`, ...toneVars(gradeTone(s.key)) }}
                title={`${s.label} — ${s.n} of ${rows.length} (${s.pct}%)`}
              />
            ))}
          </div>
        </div>
      </div>

      <CardNote>
        Condition runs 1 (best) to 5 (worst); the portfolio averages {avgScore.toFixed(2)}.
      </CardNote>
    </Card>
  );
}

/**
 * Risk against condition. Both axes are computed, so a cluster in the top-right is the set of
 * assets that genuinely need capital planning — not an impression.
 */
function RiskMatrix({ rows, onOpenRegister }: { rows: Assessment[]; onOpenRegister: () => void }) {


  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
      <CardTitle
        icon={{ group: "alert", name: "triangle-warning-filled" }}
        action={
          <button
            type="button"
            onClick={onOpenRegister}
            style={{
              border: "none",
              background: "transparent",
              padding: 0,
              cursor: "pointer",
              font: "var(--text-body-reg-14)",
              color: "var(--colors-text-primary-default)",
            }}
          >
            Open register
          </button>
        }
      >
        Risk against condition
      </CardTitle>

      <div
        style={{
          position: "relative",
          height: 172,
          borderRadius: "var(--border-medium)",
          border: "1px solid var(--colors-border-neutral-base-subtler)",
          backgroundColor: "var(--colors-background-container)",
          // Room for the y-axis labels drawn inside the plot.
          padding: "8px 8px 8px 28px",
          boxSizing: "border-box",
        }}
      >
        {[0, 25, 50, 75, 100].map((y) => (
          <span key={y} style={{ position: "absolute", left: 4, bottom: `calc(${y}% - 6px)` }}>
            <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
              {y}
            </FText>
          </span>
        ))}

        <div style={{ position: "relative", width: "100%", height: "100%" }}>
          {[25, 50, 75].map((y) => (
            <span
              key={y}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: `${y}%`,
                height: 1,
                backgroundColor: "var(--colors-border-neutral-base-subtler)",
              }}
            />
          ))}

          {rows.map((r) => {
            // Condition 1..5 across, risk 0..100 up. Clamped so an extreme value stays inside.
            const x = Math.min(Math.max(((r.score - 1) / 4) * 100, 2), 98);
            const y = Math.min(r.risk_score, 96);
            return (
              <a
                key={r.asset_id}
                href={`#/asset/${r.asset_id}`}
                title={`${r.asset_name} — condition ${r.score}, risk ${r.risk_score}`}
                // Named for screen readers: this scatter is now the only on-page view of
                // the ranking, so a dot has to say what it is rather than just be red.
                aria-label={`${r.asset_name}: condition ${r.score}, risk ${r.risk_score}, ${r.risk_level} risk`}
                className="ca-tone-fill"
                style={{
                  position: "absolute",
                  left: `${x}%`,
                  bottom: `${y}%`,
                  width: 10,
                  height: 10,
                  marginLeft: -5,
                  borderRadius: "50%",
                  border: "1.5px solid var(--colors-background-container)",
                  ...toneVars(riskTone(r.risk_level)),
                }}
              />
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", paddingLeft: 28 }}>
        {["Good", "Fair", "Average", "Poor", "Critical"].map((l) => (
          <FText key={l} appearance="captionReg12" styleProps={{ color: "textCaption" }}>
            {l}
          </FText>
        ))}
      </div>

    </Card>
  );
}


/* -------------------------------------------------------------------- page */

export function Dashboard() {
  const { navigate } = useRoute();
  const { firstName } = useUser();
  const [data, setData] = useState<RegisterData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    fn<RegisterData>("register")
      .then((d) => active && setData(d))
      .catch((e) => active && setError(String(e?.message || e)));
    return () => {
      active = false;
    };
  }, []);

  // Staggered rise-and-fade intro. Delays are set here rather than in CSS so the order follows the
  // DOM — sections can be added or reordered without renumbering a stylesheet.
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = stageRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>(".ca-si-item").forEach((el, i) => {
      el.style.animationDelay = `${0.06 + i * 0.06}s`;
    });
    root.classList.remove("ca-si-play");
    void root.offsetWidth; // force reflow so the animation retriggers on revisit
    root.classList.add("ca-si-play");
  }, [data]);

  const register = data?.register ?? [];
  const kpis = data?.kpis;
  const loading = !data && !error;

  /** Capital queue: anything with a CAPEX priority, most urgent then riskiest first. */
  const capexQueue = useMemo(
    () =>
      register
        .filter((r) => r.capex_priority !== "-")
        .sort((a, b) => a.capex_priority.localeCompare(b.capex_priority) || b.risk_score - a.risk_score),
    [register]
  );

  if (error) {
    return (
      <div style={{ padding: "var(--spacing-section-small)" }}>
        <ErrorBanner>Could not load the condition register: {error}</ErrorBanner>
      </div>
    );
  }

  if (data && register.length === 0) {
    return (
      <EmptyState
        title="Nothing assessed yet"
        description="Every assessment reads live corrective-maintenance history from the CMMS — no questionnaires, no manual condition input. Pick an asset and watch the pipeline work through its work orders and before-maintenance photos."
        action={
          <FButton appearance="primary" size="medium" onButtonClick={() => navigate("/run")}>
            Run your first assessment
          </FButton>
        }
      />
    );
  }

  return (
    <div ref={stageRef} className="ca-dash-layout" style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
      {/* ------------------------------------------------------- main column */}
      <OverlayScrollbar edgeFade style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-section-small)",
            padding: "var(--spacing-section-small) var(--spacing-section-medium) var(--spacing-section-small)",
            maxWidth: 880,
            marginLeft: "auto",
            boxSizing: "border-box",
          }}
        >
          {/* Greeting and the page's one call to action share a row: the banner that used to
              carry the CTA was a pitch paragraph over a decorative curve, and the app is better
              at demonstrating the idea than narrating it. */}
          <div
            className="ca-si-item"
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: "var(--spacing-container-xxlarge)",
              flexWrap: "wrap",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-medium)", minWidth: 0 }}>
              <span
                style={{
                  font: "var(--text-heading-smb-20)",
                  fontFamily: "'Roboto Serif', Georgia, serif",
                  lineHeight: "26px",
                  color: "var(--colors-text-description)",
                }}
              >
                {greeting()}, {firstName} 👋
              </span>
              <FText appearance="bodyReg14" styleProps={{ color: "textDescription", display: "block" }}>
                {loading
                  ? "Reading the condition register…"
                  : `${kpis?.assets_assessed ?? 0} asset${kpis?.assets_assessed === 1 ? "" : "s"} assessed from live CMMS corrective history.`}
              </FText>
            </div>
            <DarkButton label="Run assessment" icon={{ group: "webtabs", name: "inspection" }} onClick={() => navigate("/run")} />
          </div>

          <div className="ca-si-item">
            <Section title="Overview">
              {/* One row of four. Pinned rather than `auto-fit`, which reflowed to 3+1 and read
                  as three tiles and an orphan. Stacks to two columns below 700px. */}
              <div
                className="ca-kpi-row"
                style={{ display: "grid", gap: "var(--spacing-container-xxlarge)" }}
              >
                <StatTile
                  icon={{ group: "webtabs", name: "asset" }}
                  label="Assets assessed"
                  value={String(kpis?.assets_assessed ?? 0)}
                  loading={loading}
                />
                <StatTile
                  icon={{ group: "alert", name: "triangle-warning-filled" }}
                  label="High risk"
                  value={String(kpis?.high_risk ?? 0)}
                  loading={loading}
                  emphasis={!!kpis?.high_risk}
                />
                <StatTile
                  icon={{ group: "chart-data", name: "bar-graph" }}
                  label="Accelerating decay"
                  value={String(kpis?.accelerating_count ?? 0)}
                  loading={loading}
                  emphasis={!!kpis?.accelerating_count}
                />
                <StatTile
                  icon={{ group: "files", name: "document" }}
                  label="CAPEX exposure"
                  value={usd(kpis?.total_capex_exposure ?? 0)}
                  loading={loading}
                />
              </div>
            </Section>
          </div>

          {!loading && (
            <>
              <div className="ca-si-item">
                <ConditionMix rows={register} avgScore={kpis?.avg_score ?? 0} />
              </div>

              <div className="ca-si-item">
                <RiskMatrix rows={register} onOpenRegister={() => navigate("/register")} />
              </div>
            </>
          )}
        </div>
      </OverlayScrollbar>

      {/* --------------------------------------------------------- right rail */}
      <aside
        className="ca-dash-rail"
        style={{
          width: 360,
          flexShrink: 0,
          borderLeft: "1px solid var(--colors-border-neutral-base-subtler)",
          minWidth: 0,
        }}
      >
        <OverlayScrollbar edgeFade style={{ height: "100%" }}>
          <div style={{ padding: "var(--spacing-section-small) var(--spacing-container-xxlarge)" }}>
            <div className="ca-si-item">
              <RailBlock
                title="Needs attention"
                onViewAll={capexQueue.length > 4 ? () => navigate("/register") : undefined}
              >
                <RailList
                  loading={loading}
                  empty={capexQueue.length === 0}
                  emptyText="No asset currently warrants capital planning."
                >
                  {capexQueue.slice(0, 4).map((r) => (
                    <RailRow
                      key={r.asset_id}
                      href={`#/asset/${r.asset_id}`}
                      icon={{ group: "alert", name: "triangle-warning-filled" }}
                      title={r.asset_name}
                      meta={
                        <>
                          <StatusTag tone={priorityTone(r.capex_priority)}>{r.capex_priority}</StatusTag>
                          <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                            {usd(r.replacement_cost)}
                          </FText>
                        </>
                      }
                    />
                  ))}
                </RailList>
              </RailBlock>
            </div>

          </div>
        </OverlayScrollbar>
      </aside>
    </div>
  );
}
