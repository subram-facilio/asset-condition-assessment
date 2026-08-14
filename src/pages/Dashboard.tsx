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
import { AgentBanner } from "../components/AgentBanner";
import { EmptyState } from "../components/EmptyState";
import { RailBlock, RailList, RailRow } from "../components/HomeRail";
import { StatusTag, gradeTone, priorityTone, recommendationTone, riskTone } from "../components/StatusTag";

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

/** Condition bands, worst last — the order they appear in the mix bar and its legend. */
const GRADES = [
  { key: "GOOD", label: "Good", color: "#2f9e5e" },
  { key: "FAIR", label: "Fair", color: "#7cb342" },
  { key: "AVERAGE", label: "Average", color: "#e0a127" },
  { key: "POOR", label: "Poor", color: "#e2723b" },
  { key: "CRITICAL", label: "Critical", color: "#cf4646" },
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
                style={{ width: `${s.widthPct}%`, backgroundColor: s.color }}
                title={`${s.label} — ${s.n} of ${rows.length}`}
              />
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px" }}>
          {slices.map((s) => (
            <span key={s.key} style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-medium)" }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  backgroundColor: s.color,
                  flexShrink: 0,
                }}
              />
              <FText appearance="captionReg12" styleProps={{ color: "textDescription" }}>
                {s.label} {s.pct}%
              </FText>
            </span>
          ))}
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
function RiskMatrix({ rows }: { rows: Assessment[] }) {
  const dotColor = (r: Assessment) =>
    String(r.risk_level).toUpperCase() === "HIGH"
      ? "var(--colors-icon-semantic-red, #d64545)"
      : String(r.risk_level).toUpperCase() === "MEDIUM"
      ? "var(--colors-icon-semantic-orange)"
      : "var(--colors-icon-semantic-green)";

  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
      <CardTitle icon={{ group: "alert", name: "triangle-warning-filled" }}>Risk against condition</CardTitle>

      <div
        style={{
          position: "relative",
          height: 220,
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
                style={{
                  position: "absolute",
                  left: `${x}%`,
                  bottom: `${y}%`,
                  width: 10,
                  height: 10,
                  marginLeft: -5,
                  borderRadius: "50%",
                  backgroundColor: dotColor(r),
                  border: "1.5px solid var(--colors-background-container)",
                }}
              />
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", paddingLeft: 28 }}>
        {["Good", "Fair", "Average", "Poor"].map((l) => (
          <FText key={l} appearance="captionReg12" styleProps={{ color: "textCaption" }}>
            {l}
          </FText>
        ))}
      </div>

      <CardNote>Risk (0–100) up, condition (1–5) across. Select a dot to open the asset.</CardNote>
    </Card>
  );
}

/** Condition ranking — the whole register, worst risk first, as a compact table. */
function ConditionRanking({ rows, onOpen }: { rows: Assessment[]; onOpen: (id: number) => void }) {
  const cell: React.CSSProperties = {
    padding: "var(--spacing-container-large) var(--spacing-container-xlarge)",
    borderBottom: "1px solid var(--colors-border-neutral-base-subtler)",
    font: "var(--text-body-reg-14)",
    color: "var(--colors-text-description)",
    whiteSpace: "nowrap",
  };
  const head: React.CSSProperties = {
    ...cell,
    font: "var(--text-heading-med-14)",
    color: "var(--colors-text-main)",
    textAlign: "left",
    backgroundColor: "var(--colors-background-midground-subtle)",
    position: "sticky",
    top: 0,
    zIndex: 1,
  };

  return (
    <Card tone="container" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ maxHeight: 420, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
          <thead>
            <tr>
              <th style={head}>Asset</th>
              <th style={head}>Condition</th>
              <th style={head}>Risk</th>
              <th style={head}>RUL</th>
              <th style={head}>Recommendation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.asset_id}>
                <td style={cell}>
                  <button
                    type="button"
                    onClick={() => onOpen(r.asset_id)}
                    style={{
                      border: "none",
                      background: "transparent",
                      padding: 0,
                      cursor: "pointer",
                      font: "var(--text-body-reg-14)",
                      color: "var(--colors-text-primary-default)",
                    }}
                  >
                    {r.asset_name}
                  </button>
                  <div style={{ font: "var(--text-caption-reg-12)", color: "var(--colors-text-caption)" }}>
                    {r.category} · {r.corrective_wo_count} corrective WOs
                  </div>
                </td>
                <td style={cell}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--spacing-container-large)" }}>
                    {r.score.toFixed(2)}
                    <StatusTag tone={gradeTone(r.grade)}>{r.grade}</StatusTag>
                  </span>
                </td>
                <td style={cell}>
                  <StatusTag tone={riskTone(r.risk_level)}>{r.risk_score}</StatusTag>
                </td>
                <td style={cell}>{r.rul?.available === false ? "n/a" : `${r.rul_years}y`}</td>
                <td style={cell}>
                  <StatusTag tone={recommendationTone(r.recommendation)}>{r.recommendation}</StatusTag>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

  const accelerating = useMemo(
    () => register.filter((r) => r.deterioration === "accelerating").length,
    [register]
  );

  /** Capital queue: anything with a CAPEX priority, most urgent then riskiest first. */
  const capexQueue = useMemo(
    () =>
      register
        .filter((r) => r.capex_priority !== "-")
        .sort((a, b) => a.capex_priority.localeCompare(b.capex_priority) || b.risk_score - a.risk_score),
    [register]
  );

  const worstFirst = useMemo(
    () => register.slice().sort((a, b) => b.risk_score - a.risk_score),
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
        description="Every assessment reads live corrective-maintenance history from Facilio — no questionnaires, no manual condition input. Pick an asset and watch the pipeline work through its work orders and before-maintenance photos."
        action={
          <FButton appearance="primary" size="medium" onButtonClick={() => navigate("/run")}>
            Run your first assessment
          </FButton>
        }
      />
    );
  }

  return (
    <div ref={stageRef} style={{ display: "flex", flex: 1, minHeight: 0, overflow: "hidden" }}>
      {/* ------------------------------------------------------- main column */}
      <OverlayScrollbar edgeFade style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-section-small)",
            padding: "var(--spacing-section-small) var(--spacing-section-medium) var(--spacing-section-medium)",
            maxWidth: 880,
            marginLeft: "auto",
            boxSizing: "border-box",
          }}
        >
          <div className="ca-si-item" style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-medium)" }}>
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
                : `${kpis?.assets_assessed ?? 0} asset${kpis?.assets_assessed === 1 ? "" : "s"} assessed from live Facilio corrective history.`}
            </FText>
          </div>

          <div className="ca-si-item">
            <AgentBanner onRun={() => navigate("/run")} />
          </div>

          <div className="ca-si-item">
            <Section title="Overview">
              {/* Fixed 2×2, as the design draws it. `auto-fit` reflowed to 3+1 at ordinary widths,
                  which reads as three tiles and an orphan rather than four equal figures. */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                  gap: "var(--spacing-container-xxlarge)",
                }}
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
                  value={String(accelerating)}
                  loading={loading}
                  emphasis={accelerating > 0}
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
                <Section title="Insights">
                  <ConditionMix rows={register} avgScore={kpis?.avg_score ?? 0} />
                </Section>
              </div>

              <div className="ca-si-item">
                <Section title="Portfolio">
                  <RiskMatrix rows={register} />
                </Section>
              </div>

              <div className="ca-si-item">
                <Section
                  title="Condition ranking"
                  action={
                    <button
                      type="button"
                      onClick={() => navigate("/register")}
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
                  <ConditionRanking rows={worstFirst} onOpen={(id) => navigate(`/asset/${id}`)} />
                </Section>
              </div>
            </>
          )}
        </div>
      </OverlayScrollbar>

      {/* --------------------------------------------------------- right rail */}
      <aside
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

            <div className="ca-si-item">
              <RailBlock
                title="Highest risk"
                onViewAll={worstFirst.length > 4 ? () => navigate("/register") : undefined}
              >
                <RailList
                  loading={loading}
                  empty={worstFirst.length === 0}
                  emptyText="Nothing assessed yet."
                >
                  {worstFirst.slice(0, 4).map((r) => (
                    <RailRow
                      key={r.asset_id}
                      href={`#/asset/${r.asset_id}`}
                      icon={{ group: "webtabs", name: "asset" }}
                      title={r.asset_name}
                      meta={
                        <>
                          <StatusTag tone={riskTone(r.risk_level)}>{r.risk_score}</StatusTag>
                          <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                            {r.dominant_issue_label || "no dominant issue"}
                          </FText>
                        </>
                      }
                    />
                  ))}
                </RailList>
              </RailBlock>
            </div>

            <div className="ca-si-item">
              <RailBlock title="Shortcuts">
                <RailRow
                  href="#/run"
                  icon={{ group: "webtabs", name: "inspection" }}
                  title="Run an assessment"
                  meta={
                    <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                      Pick an asset and watch the pipeline
                    </FText>
                  }
                />
                <RailRow
                  href="#/settings"
                  icon={{ group: "action", name: "settings" }}
                  title="Review baselines"
                  meta={
                    <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                      Expected life, criticality and cost
                    </FText>
                  }
                />
              </RailBlock>
            </div>
          </div>
        </OverlayScrollbar>
      </aside>
    </div>
  );
}
