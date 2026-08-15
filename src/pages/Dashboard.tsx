import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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
import { StatusTag, gradeTone, priorityTone, riskTone, toneCellVars, toneVars } from "../components/StatusTag";
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
 * Risk-band rows of the matrix, worst first — top-right is the "act now" corner, the
 * convention every EAM risk register follows. Ranges mirror the engine's banding
 * (`riskScore < 40 → LOW, < 70 → MEDIUM, else HIGH` in condition-engine.ts).
 */
const RISK_BANDS = [
  { key: "HIGH", label: "High", range: "70–100" },
  { key: "MEDIUM", label: "Medium", range: "40–69" },
  { key: "LOW", label: "Low", range: "0–39" },
];

/** Severity order of the tones, for picking a cell's colour. */
const TONE_RANK: Record<string, number> = { good: 0, warn: 1, bad: 2, crit: 3 };

/**
 * A cell wears the worse of its two band tones, so it can never look calmer than
 * either the grade chip or the risk chip its assets wear in the register.
 */
function cellTone(gradeKey: string, riskKey: string): string {
  const g = gradeTone(gradeKey);
  const r = riskTone(riskKey);
  return (TONE_RANK[g] ?? 0) >= (TONE_RANK[r] ?? 0) ? g : r;
}

/**
 * Risk against condition, as a 3×5 matrix heatmap: each cell counts the assets in one
 * condition-band × risk-band bucket and links to the register pre-filtered to that bucket.
 *
 * This replaced a scatter of one dot per asset. The dots piled up on the band centres,
 * carried no identity at 34+ assets, and their colour repeated what the x-position already
 * said; a count in a bucket stays readable at any portfolio size, and the empty top-left /
 * bottom-right corners say "no surprises" at a glance.
 */
function RiskMatrix({ rows, onOpenRegister }: { rows: Assessment[]; onOpenRegister: () => void }) {
  const counts = new Map<string, number>();
  rows.forEach((r) => {
    const key = `${r.grade}|${String(r.risk_level).toUpperCase()}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });

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
        role="table"
        aria-label="Assets bucketed by condition band and risk band. Each occupied cell links to the register filtered to that bucket."
        style={{
          display: "grid",
          gridTemplateColumns: "88px repeat(5, minmax(0, 1fr))",
          gap: 4,
          alignItems: "stretch",
        }}
      >
        <span />
        {GRADES.map((g) => (
          <div key={g.key} style={{ textAlign: "center", paddingBottom: 2 }}>
            <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
              {g.label}
            </FText>
          </div>
        ))}

        {RISK_BANDS.map((band) => (
          <Fragment key={band.key}>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "flex-end",
                paddingRight: 10,
              }}
            >
              <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
                {band.label}
              </FText>
              <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                risk {band.range}
              </FText>
            </div>

            {GRADES.map((g) => {
              const n = counts.get(`${g.key}|${band.key}`) ?? 0;
              if (n === 0) {
                return (
                  <div
                    key={g.key}
                    className="ca-matrix-cell"
                    aria-label={`No assets in ${g.label} condition at ${band.label.toLowerCase()} risk`}
                    style={{
                      background: "var(--colors-background-midground-subtle)",
                      border: "1px solid transparent",
                      color: "var(--colors-text-caption)",
                      font: "var(--text-caption-reg-12)",
                    }}
                  >
                    –
                  </div>
                );
              }
              return (
                <a
                  key={g.key}
                  href={`#/register?grade=${g.key}&risk=${band.key}`}
                  className="ca-matrix-cell"
                  title={`${n} asset${n === 1 ? "" : "s"} — ${g.label} condition, ${band.label.toLowerCase()} risk`}
                  aria-label={`${n} asset${n === 1 ? "" : "s"} in ${g.label} condition at ${band.label.toLowerCase()} risk. Opens the register filtered to this bucket.`}
                  style={{ ...toneCellVars(cellTone(g.key, band.key)), font: "var(--text-heading-smb-20)" }}
                >
                  {n}
                </a>
              );
            })}
          </Fragment>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-container-xlarge)",
          flexWrap: "wrap",
        }}
      >
        <StatusTag tone="good">Healthy</StatusTag>
        <StatusTag tone="warn">Monitor</StatusTag>
        <StatusTag tone="bad">Plan action</StatusTag>
        <StatusTag tone="crit">Critical</StatusTag>
      </div>

      <CardNote>Click a cell to open the register filtered to that bucket.</CardNote>
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
                onViewAll={capexQueue.length > 10 ? () => navigate("/register") : undefined}
              >
                <RailList
                  loading={loading}
                  empty={capexQueue.length === 0}
                  emptyText="No asset currently warrants capital planning."
                >
                  {capexQueue.slice(0, 10).map((r) => (
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
