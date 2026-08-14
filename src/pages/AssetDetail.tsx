import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { FButton, FText } from "@facilio/dsm-react-wrapper";
import { fn, inr } from "../lib/vibe";
import type { AssetDetail as Detail, Metric, MtbfGap, Narrative } from "../lib/types";
import { Empty, ErrorBanner, GapList, LifecycleBar, MtbfBars, Provenance, Spark, Val, pretty } from "../lib/ui";
import { DetailShell, RailFact, type DetailTab } from "../components/DetailShell";
import { Card, CardTitle, CardNote } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { PhotoEvidence } from "../components/PhotoEvidence";
import {
  StatusTag,
  gradeTone,
  priorityTone,
  recommendationTone,
  riskTone,
  severityTone,
  statusTone,
  trendTone,
} from "../components/StatusTag";

/**
 * One asset's full analysis.
 *
 * The page answers four questions in order — what condition is this in, why, how fast is it
 * changing, and therefore what should be done — but that is a long read, so the answers are split
 * across tabs instead of stacked in one column. Overview carries the verdict; the rest is the
 * working. Evidence sits beside each claim, and anything that could not be computed says so rather
 * than showing a zero.
 *
 * The facts rail is deliberately outside the tabs: category, criticality and expected life are true
 * on every tab, so switching should never cost the reader the asset's identity.
 */

type TabKey = "overview" | "findings" | "risk" | "evidence" | "why";

/** Two-column grid that collapses to one on a narrow content column. */
function Split({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        gap: "var(--spacing-section-small)",
        alignItems: "start",
      }}
    >
      {children}
    </div>
  );
}

/** Label/value row inside a card — the shape most of this page's detail takes. */
function Row({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--spacing-container-xlarge)",
        padding: "var(--spacing-container-large) 0",
        borderBottom: last ? "none" : "1px solid var(--colors-border-neutral-base-subtler)",
      }}
    >
      <FText appearance="bodyReg14" styleProps={{ color: "textCaption" }}>
        {label}
      </FText>
      <span
        style={{
          font: "var(--text-heading-med-14)",
          color: "var(--colors-text-main)",
          textAlign: "right",
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--spacing-container-large)",
          flexWrap: "wrap",
          justifyContent: "flex-end",
        }}
      >
        {children}
      </span>
    </div>
  );
}

/** Headline figure tile — the four numbers the whole page resolves to. */
function Kpi({ value, label }: { value: ReactNode; label: ReactNode }) {
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-large)" }}>
      <span style={{ font: "var(--text-heading-smb-20)", lineHeight: "26px", color: "var(--colors-text-main)" }}>
        {value}
      </span>
      <span
        style={{
          font: "var(--text-caption-reg-12)",
          color: "var(--colors-text-caption)",
          display: "inline-flex",
          alignItems: "center",
          gap: "var(--spacing-container-medium)",
          flexWrap: "wrap",
        }}
      >
        {label}
      </span>
    </Card>
  );
}

/** A question the narrative answers, and its answer. */
function Qa({ q, a }: { q: string; a?: string }) {
  if (!a) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-medium)" }}>
      <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
        {q}
      </FText>
      <FText appearance="bodyReg14" styleProps={{ color: "textDescription", display: "block" }}>
        {a}
      </FText>
    </div>
  );
}

const TABLE_CELL: React.CSSProperties = {
  padding: "var(--spacing-container-large) var(--spacing-container-xlarge)",
  borderBottom: "1px solid var(--colors-border-neutral-base-subtler)",
  font: "var(--text-body-reg-14)",
  color: "var(--colors-text-description)",
  textAlign: "left",
};

const TABLE_HEAD: React.CSSProperties = {
  ...TABLE_CELL,
  font: "var(--text-heading-med-14)",
  color: "var(--colors-text-main)",
  backgroundColor: "var(--colors-background-midground-subtle)",
  whiteSpace: "nowrap",
};

/** Bordered table inside a card, scrolling horizontally rather than widening the page. */
function DataGrid({ head, children, minWidth = 520 }: { head: ReactNode; children: ReactNode; minWidth?: number }) {
  return (
    <div
      style={{
        overflowX: "auto",
        borderRadius: "var(--border-medium)",
        border: "1px solid var(--colors-border-neutral-base-subtler)",
        backgroundColor: "var(--colors-background-container)",
      }}
    >
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth }}>
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function AssetDetail({ assetId }: { assetId: number }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabKey>("overview");

  /** Reload without resetting the tab, so supplying photo evidence keeps you in place. */
  function load() {
    fn<Detail>("asset-detail", { assetId })
      .then(setD)
      .catch((e) => setError(String(e?.message || e)));
  }

  useEffect(() => {
    setD(null);
    setError("");
    setTab("overview");
    load();
  }, [assetId]);

  const a = d?.assessment;
  const an = d?.analysis;
  const ev = a?.evidence;
  const inputs: any = ev?.inputs || {};
  const narrative: Narrative | undefined = ev?.narrative;
  const lock = ev?.narrative_number_lock;
  const baselines = ev?.baselines;
  const scope = an?.analysis_scope;
  const mismatches = d?.engine_overrides?.count_mismatches || [];
  const findings = d?.findings ?? [];
  const photoFindings = findings.filter((f) => f.source === "photo" || f.source === "photo_manual");
  const textFindings = findings.filter((f) => f.source === "wo_text");

  // Prefer the dominant issue's own interval series — it answers whether that specific problem is
  // accelerating, rather than how busy the asset is overall.
  const domMtbf = (a?.dominant_issue_mtbf?.series?.value || inputs.dominant_mtbf_series || null) as
    | MtbfGap[]
    | null;
  const domVerdict =
    a?.dominant_issue_mtbf?.verdict?.value || inputs.dominant_mtbf_verdict || inputs.mtbf_verdict || null;

  const ageMetric: Metric<number> = {
    value: inputs.age_years ?? null,
    available: inputs.age_years !== null && inputs.age_years !== undefined,
    reason: "no purchase date recorded on the asset",
  };

  const tabs: DetailTab[] = useMemo(
    () => [
      { key: "overview", label: "Overview", icon: { group: "form builder", name: "selectall" } },
      {
        key: "findings",
        label: "Findings",
        icon: { group: "webtabs", name: "inspection" },
        badge: an?.recurring_issues.length ?? 0,
      },
      { key: "risk", label: "Risk & cost", icon: { group: "alert", name: "triangle-warning-filled" } },
      {
        key: "evidence",
        label: "Evidence",
        icon: { group: "webtabs", name: "workorder" },
        badge: findings.length,
      },
      { key: "why", label: "Why", icon: { group: "action", name: "info" } },
    ],
    [an?.recurring_issues.length, findings.length]
  );

  if (error) {
    return (
      <div style={{ padding: "var(--spacing-section-small)" }}>
        <ErrorBanner>Could not load this asset: {error}</ErrorBanner>
      </div>
    );
  }
  if (!d) return <Empty>Loading analysis…</Empty>;

  if (!a && !an) {
    return (
      <EmptyState
        title={`Asset ${assetId} has not been assessed`}
        description="Run its assessment and the agent will read every corrective work order and before-maintenance photo Facilio holds for it."
        action={
          <FButton
            appearance="primary"
            size="medium"
            onButtonClick={() => {
              window.location.hash = `/run/${assetId}`;
            }}
          >
            Run its assessment
          </FButton>
        }
      />
    );
  }

  return (
    <DetailShell
      backHref="#/register"
      backLabel="Condition register"
      title={a?.asset_name || `Asset ${assetId}`}
      titleMeta={
        [an?.asset?.manufacturer, an?.asset?.model, an?.asset?.location].filter(Boolean).join(" · ") || undefined
      }
      status={
        a && (
          <>
            <StatusTag tone={riskTone(a.risk_level)}>{a.risk_level} RISK</StatusTag>
            <StatusTag tone={recommendationTone(a.recommendation)}>{a.recommendation}</StatusTag>
          </>
        )
      }
      actions={
        <FButton
          appearance="secondary"
          size="medium"
          onButtonClick={() => {
            window.location.hash = `/run/${assetId}`;
          }}
        >
          Re-assess
        </FButton>
      }
      tabs={tabs}
      activeTab={tab}
      onTabChange={(k) => setTab(k as TabKey)}
      railLabel="Asset"
      rail={
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
          <RailFact label="Category">{a?.category || an?.asset?.asset_type || "—"}</RailFact>
          <RailFact label="Manufacturer">{an?.asset?.manufacturer || "—"}</RailFact>
          <RailFact label="Model">{an?.asset?.model || "—"}</RailFact>
          <RailFact label="Location">{an?.asset?.location || "—"}</RailFact>
          <RailFact label="In service">
            {String(an?.asset?.purchasedDate || "").slice(0, 10) || "not recorded"}
          </RailFact>
          <RailFact label="Expected service life">
            {inputs.expected_life_years ? `${inputs.expected_life_years} years` : "—"}
          </RailFact>
          <RailFact label="Criticality">{inputs.criticality || "—"}</RailFact>
          <RailFact label="Warranty">
            {a?.warranty?.available ? (
              <StatusTag tone={a.warranty.value === "active" ? "good" : "mute"}>
                {a.warranty.value}
                {inputs.warranty_expiry ? ` ${inputs.warranty_expiry}` : ""}
              </StatusTag>
            ) : (
              "not recorded"
            )}
          </RailFact>
          <RailFact label="Corrective work orders">
            {scope?.corrective_work_orders_analyzed ?? a?.corrective_wo_count ?? 0}
          </RailFact>
          {baselines && (
            <RailFact label="Baselines">
              <Provenance source={baselines.source} confidence={baselines.confidence?.life} />
            </RailFact>
          )}
        </div>
      }
    >
      {/* ══════════════════════════════════════════════════════════ overview */}
      {tab === "overview" && a && (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "var(--spacing-container-xxlarge)",
            }}
          >
            <Kpi
              value={a.score.toFixed(2)}
              label={
                <>
                  Condition of 5 <StatusTag tone={gradeTone(a.grade)}>{a.grade}</StatusTag>
                </>
              }
            />
            <Kpi
              value={a.risk_score}
              label={
                <>
                  Risk of 100 <StatusTag tone={riskTone(a.risk_level)}>{a.risk_level}</StatusTag>
                </>
              }
            />
            <Kpi value={<Val metric={ageMetric} suffix="y" fallbackLabel="unknown" />} label="Age in service" />
            <Kpi
              value={<Val metric={a.rul} suffix="y" fallbackLabel="unavailable" />}
              label={
                <>
                  Remaining life
                  {baselines && <Provenance source={baselines.source} confidence={baselines.confidence?.life} />}
                </>
              }
            />
          </div>

          {narrative && narrative.source === "condition_assessment_agent" && (
            <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
              <CardTitle icon={{ group: "form builder", name: "selectall" }}>Assessment</CardTitle>

              <FText appearance="bodyReg14" styleProps={{ color: "textMain", display: "block" }}>
                {narrative.summary}
              </FText>

              <Split>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
                  <Qa q="Why this condition" a={narrative.why_condition} />
                  <Qa q="The main problem" a={narrative.why_main_problem} />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
                  <Qa q="How fast it is changing" a={narrative.why_deterioration} />
                  <Qa q="Remaining life" a={narrative.why_rul} />
                </div>
              </Split>

              {/* The verdict, called out rather than buried: this is what the page is for. */}
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--spacing-container-large)",
                  padding: "var(--spacing-container-xlarge)",
                  borderRadius: "var(--border-medium)",
                  border: "1px solid var(--colors-border-neutral-base-subtle)",
                  backgroundColor: "var(--colors-background-container)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--spacing-container-large)",
                    flexWrap: "wrap",
                  }}
                >
                  <StatusTag tone={recommendationTone(a.recommendation)}>{a.recommendation}</StatusTag>
                  {a.capex_priority !== "-" && (
                    <StatusTag tone={priorityTone(a.capex_priority)}>CAPEX {a.capex_priority}</StatusTag>
                  )}
                  <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                    {inr(a.replacement_cost)}
                  </FText>
                  {baselines && (
                    <Provenance source={baselines.source} confidence={baselines.confidence?.replacement} />
                  )}
                </div>
                <FText appearance="bodyReg14" styleProps={{ color: "textDescription", display: "block" }}>
                  {narrative.why_recommendation}
                </FText>
                {a.warranty_gate_applied && (
                  <FText appearance="captionReg12" styleProps={{ color: "textMain", display: "block" }}>
                    The rule produced {a.rule_recommendation}, but this asset is still under warranty, so it was
                    downgraded — replacing an asset the manufacturer is liable for wastes the remaining cover.
                  </FText>
                )}
              </div>

              {narrative.caveats?.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-medium)" }}>
                  <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
                    What this assessment could not see
                  </FText>
                  <ul style={{ margin: 0, paddingLeft: 18, font: "var(--text-body-reg-14)", color: "var(--colors-text-description)" }}>
                    {narrative.caveats.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}

              <CardNote>
                Written by the condition-assessment agent from the computed values, and verified to contain no
                figure absent from them.
              </CardNote>
            </Card>
          )}

          {narrative && narrative.source === "rejected_agent_reply" && (
            <ErrorBanner>
              <b>The written explanation was rejected.</b> {narrative.rejected_because}. The computed results are
              unaffected — only the prose was discarded.
            </ErrorBanner>
          )}

          {!narrative && (
            <ErrorBanner>
              No written explanation stored yet. Re-assess to generate one — the numbers stand on their own
              regardless.
            </ErrorBanner>
          )}

          <Split>
            <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
              <CardTitle icon={{ group: "chart-data", name: "bar-graph" }}>Deterioration</CardTitle>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-large)", flexWrap: "wrap" }}>
                <StatusTag
                  tone={a.deterioration === "accelerating" ? "bad" : a.deterioration === "improving" ? "good" : "mute"}
                >
                  {pretty(a.deterioration)}
                </StatusTag>
                {a.deterioration_velocity?.available ? (
                  <FText appearance="bodyReg14" styleProps={{ color: "textDescription" }}>
                    {a.deterioration_velocity.value} grade per year
                  </FText>
                ) : (
                  <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                    velocity not measurable yet
                  </FText>
                )}
              </div>
              {d.history.length >= 2 ? (
                <Spark
                  values={d.history.map((h) => h.score)}
                  tone="var(--colors-icon-semantic-red, #d64545)"
                />
              ) : (
                <CardNote>
                  One assessment on record, so there is no measured trajectory yet. Re-assess over time to build
                  one.
                </CardNote>
              )}
              {inputs.deterioration_basis && <CardNote>Basis: {inputs.deterioration_basis}.</CardNote>}
            </Card>

            <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
              <CardTitle icon={{ group: "time-date", name: "time" }}>
                Time between corrective events
                {a.dominant_issue_mtbf ? ` — ${a.dominant_issue_mtbf.issue_label}` : ""}
              </CardTitle>
              {domMtbf && domMtbf.length > 0 ? (
                <MtbfBars gaps={domMtbf} verdict={domVerdict} />
              ) : (
                <CardNote>Not enough dated corrective events to measure an interval.</CardNote>
              )}
              <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--spacing-container-xlarge)", flexWrap: "wrap" }}>
                <CardNote>
                  Mean <Val metric={a.mtbf?.mean_months} suffix=" months" fallbackLabel="n/a" /> across all
                  corrective events
                </CardNote>
                <CardNote>
                  MTTR <Val metric={a.mttr_hours} suffix=" h" fallbackLabel="not recorded" />
                </CardNote>
              </div>
            </Card>
          </Split>

          <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
            <CardTitle icon={{ group: "time-date", name: "date-tick" }}>Lifecycle</CardTitle>
            <LifecycleBar
              age={ageMetric}
              expectedLife={Number(inputs.expected_life_years) || 15}
              purchasedYear={String(an?.asset?.purchasedDate || "").slice(0, 4) || undefined}
            />
          </Card>
        </>
      )}

      {/* ══════════════════════════════════════════════════════════ findings */}
      {tab === "findings" && (
        <>
          {an && an.recurring_issues.length > 0 ? (
            <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
              <CardTitle icon={{ group: "webtabs", name: "inspection" }}>Recurring issues</CardTitle>
              <CardNote>The recurrence unit is the corrective work order, never the photo.</CardNote>

              {an.recurring_issues.map((i) => (
                <div
                  key={i.issue_id}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--spacing-container-xlarge)",
                    padding: "var(--spacing-container-xlarge)",
                    borderRadius: "var(--border-medium)",
                    border: "1px solid var(--colors-border-neutral-base-subtler)",
                    backgroundColor: "var(--colors-background-container)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-large)", flexWrap: "wrap" }}>
                    <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
                      {i.display_name}
                    </FText>
                    <StatusTag tone={statusTone(i.status)}>{pretty(i.status)}</StatusTag>
                    <StatusTag tone={severityTone(i.severity.overall)}>{i.severity.overall} severity</StatusTag>
                    <StatusTag tone={trendTone(i.trend)}>{pretty(i.trend)}</StatusTag>
                    <span style={{ marginLeft: "auto" }}>
                      <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                        confidence {i.confidence.toFixed(2)}
                      </FText>
                    </span>
                  </div>

                  <div style={{ display: "flex", alignItems: "baseline", gap: "var(--spacing-section-small)", flexWrap: "wrap" }}>
                    <span style={{ display: "inline-flex", alignItems: "baseline", gap: "var(--spacing-container-medium)" }}>
                      <span style={{ font: "var(--text-heading-smb-20)", color: "var(--colors-text-main)" }}>
                        {i.occurrence_count}
                      </span>
                      <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                        of {scope?.corrective_work_orders_analyzed} corrective WOs
                      </FText>
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "baseline", gap: "var(--spacing-container-medium)" }}>
                      <span style={{ font: "var(--text-heading-med-16)", color: "var(--colors-text-main)" }}>
                        {(i.occurrence_rate * 100).toFixed(0)}%
                      </span>
                      <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                        occurrence rate
                      </FText>
                    </span>
                    {i.first_occurrence && (
                      <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                        first {i.first_occurrence.date} · last {i.last_occurrence?.date}
                      </FText>
                    )}
                  </div>

                  <span
                    style={{
                      display: "block",
                      height: 8,
                      borderRadius: 999,
                      backgroundColor: "var(--colors-background-midground-dark)",
                      overflow: "hidden",
                    }}
                  >
                    <i
                      style={{
                        display: "block",
                        height: "100%",
                        width: `${Math.min(i.occurrence_rate * 100, 100)}%`,
                        borderRadius: 999,
                        backgroundColor: "var(--colors-icon-primary-default)",
                      }}
                    />
                  </span>

                  <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-medium)", flexWrap: "wrap" }}>
                    <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                      Components:
                    </FText>
                    {i.affected_components.map((c) => (
                      <StatusTag tone="mute" key={c.component}>
                        {pretty(c.component)} ×{c.occurrence_count}
                      </StatusTag>
                    ))}
                  </div>

                  <ul style={{ margin: 0, paddingLeft: 18, font: "var(--text-caption-reg-12)", color: "var(--colors-text-description)" }}>
                    {i.evidence.map((e, k) => (
                      <li key={k}>{e}</li>
                    ))}
                  </ul>

                  <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-medium)", flexWrap: "wrap" }}>
                    <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                      Work orders:
                    </FText>
                    {i.work_order_references.map((w) => (
                      <span
                        key={w}
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 11,
                          padding: "1px 6px",
                          borderRadius: "var(--border-small)",
                          border: "1px solid var(--colors-border-neutral-base-subtler)",
                          color: "var(--colors-text-description)",
                        }}
                      >
                        #{w}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </Card>
          ) : (
            <EmptyState
              icon={{ group: "webtabs", name: "inspection" }}
              title="No recurring issue identified"
              description="Nothing repeated often enough across this asset's corrective work orders to be called recurring."
            />
          )}

          <Split>
            {an && an.component_analysis.length > 0 && (
              <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
                <CardTitle icon={{ group: "setup", name: "customisation" }}>Component concentration</CardTitle>
                <DataGrid
                  head={
                    <>
                      <th style={TABLE_HEAD}>Component</th>
                      <th style={TABLE_HEAD}>Corrective WOs</th>
                      <th style={TABLE_HEAD}>Issues</th>
                      <th style={TABLE_HEAD}>Worst severity</th>
                    </>
                  }
                >
                  {an.component_analysis.map((c) => (
                    <tr key={c.component}>
                      <td style={{ ...TABLE_CELL, color: "var(--colors-text-main)" }}>{pretty(c.component)}</td>
                      <td style={TABLE_CELL}>{c.corrective_work_order_count}</td>
                      <td style={TABLE_CELL}>{c.issue_count}</td>
                      <td style={TABLE_CELL}>
                        <StatusTag tone={severityTone(c.highest_severity)}>{c.highest_severity}</StatusTag>
                      </td>
                    </tr>
                  ))}
                </DataGrid>
              </Card>
            )}

            {d.issue_matrix.years.length > 0 && (
              <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
                <CardTitle icon={{ group: "time-date", name: "date-tick" }}>Occurrences per year</CardTitle>
                <DataGrid
                  minWidth={320}
                  head={
                    <>
                      <th style={TABLE_HEAD}>Issue</th>
                      {d.issue_matrix.years.map((y) => (
                        <th key={y} style={{ ...TABLE_HEAD, textAlign: "center" }}>
                          {y}
                        </th>
                      ))}
                    </>
                  }
                >
                  {d.issue_matrix.rows.map((r) => (
                    <tr key={r.issue}>
                      <td style={{ ...TABLE_CELL, color: "var(--colors-text-main)" }}>{r.label}</td>
                      {r.counts.map((c, i) => (
                        <td
                          key={i}
                          style={{
                            ...TABLE_CELL,
                            textAlign: "center",
                            // Heat by count, capped at 3 — beyond that the shade stops carrying
                            // information and only the number does.
                            backgroundColor: c
                              ? `color-mix(in srgb, var(--colors-icon-semantic-orange) ${Math.min(c, 3) * 14}%, transparent)`
                              : undefined,
                            color: c ? "var(--colors-text-main)" : "var(--colors-text-caption)",
                          }}
                        >
                          {c || "·"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </DataGrid>
                {d.issue_matrix.years.length < 2 && (
                  <CardNote>Only one calendar year of evidence, so no trend is claimed.</CardNote>
                )}
              </Card>
            )}
          </Split>
        </>
      )}

      {/* ═════════════════════════════════════════════════════════ risk & cost */}
      {tab === "risk" && a && (
        <>
          <Split>
            <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-large)" }}>
              <CardTitle icon={{ group: "alert", name: "triangle-warning-filled" }}>Risk</CardTitle>
              <Row label="Risk score">
                <StatusTag tone={riskTone(a.risk_level)}>
                  {a.risk_score} / 100 · {a.risk_level}
                </StatusTag>
              </Row>
              <Row label="Condition">
                <>
                  {a.score.toFixed(2)} / 5 <StatusTag tone={gradeTone(a.grade)}>{a.grade}</StatusTag>
                </>
              </Row>
              <Row label="Remaining life">
                <Val metric={a.rul} suffix=" years" fallbackLabel="unavailable" />
              </Row>
              <Row label="Deterioration" last>
                <StatusTag
                  tone={a.deterioration === "accelerating" ? "bad" : a.deterioration === "improving" ? "good" : "mute"}
                >
                  {pretty(a.deterioration)}
                </StatusTag>
              </Row>
            </Card>

            <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-large)" }}>
              <CardTitle icon={{ group: "files", name: "document" }}>Cost basis</CardTitle>
              <Row label="Corrective spend, last 3 years">{inr(a.repair_spend)}</Row>
              <Row label="Estimated replacement">
                <>
                  {inr(a.replacement_cost)}
                  {baselines && (
                    <Provenance source={baselines.source} confidence={baselines.confidence?.replacement} />
                  )}
                </>
              </Row>
              <Row label="CAPEX priority" last>
                {a.capex_priority === "-" ? (
                  <FText appearance="bodyReg14" styleProps={{ color: "textCaption" }}>
                    none
                  </FText>
                ) : (
                  <StatusTag tone={priorityTone(a.capex_priority)}>{a.capex_priority}</StatusTag>
                )}
              </Row>
              <CardNote>
                {ev?.cost_basis}. This Facilio org holds no work-order cost fields, so figures come from the
                Baselines page and improve automatically once costs are logged in Facilio.
              </CardNote>
            </Card>
          </Split>

          {ev?.risk_terms && ev.risk_terms.length > 0 && (
            <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
              <CardTitle icon={{ group: "chart-data", name: "bar-graph" }}>How the risk score is built</CardTitle>
              <DataGrid
                head={
                  <>
                    <th style={TABLE_HEAD}>Risk term</th>
                    <th style={TABLE_HEAD}>Weight</th>
                    <th style={TABLE_HEAD}>Factor</th>
                    <th style={TABLE_HEAD}>Contribution</th>
                  </>
                }
              >
                {ev.risk_terms.map((t) => (
                  <tr key={t.name}>
                    <td style={{ ...TABLE_CELL, color: "var(--colors-text-main)" }}>{pretty(t.name)}</td>
                    <td style={TABLE_CELL}>{t.weight}</td>
                    <td style={TABLE_CELL}>{t.factor}</td>
                    <td style={{ ...TABLE_CELL, font: "var(--text-heading-med-14)", color: "var(--colors-text-main)" }}>
                      {t.contribution}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={3} style={{ ...TABLE_CELL, font: "var(--text-heading-med-14)", color: "var(--colors-text-main)", borderBottom: "none" }}>
                    Risk score
                  </td>
                  <td style={{ ...TABLE_CELL, font: "var(--text-heading-med-14)", color: "var(--colors-text-main)", borderBottom: "none" }}>
                    {a.risk_score}
                  </td>
                </tr>
              </DataGrid>
              {ev.risk_terms_excluded && ev.risk_terms_excluded.length > 0 && (
                <CardNote>
                  Excluded and reweighted so the remaining terms still total 100: {ev.risk_terms_excluded.join("; ")}.
                </CardNote>
              )}
            </Card>
          )}
        </>
      )}

      {/* ══════════════════════════════════════════════════════════ evidence */}
      {tab === "evidence" && (
        <>
          <PhotoEvidence assetId={assetId} onDone={load} />
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: "var(--spacing-container-xxlarge)",
            }}
          >
            <Kpi
              value={scope?.corrective_work_orders_analyzed ?? a?.corrective_wo_count ?? 0}
              label="Corrective work orders"
            />
            <Kpi value={scope?.photos_analyzed ?? 0} label="Before photos analysed" />
            <Kpi value={photoFindings.length} label="Photo-backed findings" />
            <Kpi value={textFindings.length} label="Text-derived findings" />
          </div>

          {a?.unavailable && a.unavailable.length > 0 && (
            <GapList items={a.unavailable} title="Could not be computed" />
          )}

          <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
            <CardTitle icon={{ group: "webtabs", name: "workorder" }}>
              Work orders behind this assessment
            </CardTitle>
            {findings.length === 0 ? (
              <CardNote>No findings recorded.</CardNote>
            ) : (
              <DataGrid
                minWidth={720}
                head={
                  <>
                    <th style={TABLE_HEAD}>Work order</th>
                    <th style={TABLE_HEAD}>Issue</th>
                    <th style={TABLE_HEAD}>Component</th>
                    <th style={TABLE_HEAD}>Severity</th>
                    <th style={TABLE_HEAD}>Conf.</th>
                    <th style={TABLE_HEAD}>Source</th>
                    <th style={TABLE_HEAD}>Evidence</th>
                  </>
                }
              >
                {findings.map((f, i) => (
                  <tr key={i}>
                    <td style={{ ...TABLE_CELL, fontFamily: "var(--mono)", fontSize: 12 }}>#{f.wo_id}</td>
                    <td style={{ ...TABLE_CELL, color: "var(--colors-text-main)" }}>{f.issue_label}</td>
                    <td style={TABLE_CELL}>{pretty(f.component)}</td>
                    <td style={TABLE_CELL}>
                      <StatusTag tone={severityTone(f.severity)}>{f.severity}</StatusTag>
                    </td>
                    <td style={TABLE_CELL}>{f.confidence.toFixed(2)}</td>
                    <td style={TABLE_CELL}>
                      <StatusTag tone={f.source === "photo" ? "info" : "mute"}>
                        {f.source === "photo" ? "photo" : "WO text"}
                      </StatusTag>
                    </td>
                    <td style={{ ...TABLE_CELL, font: "var(--text-caption-reg-12)" }}>{f.evidence[0] || "—"}</td>
                  </tr>
                ))}
              </DataGrid>
            )}
          </Card>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════ why */}
      {tab === "why" && (
        <>
          {mismatches.length > 0 && (
            <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xlarge)" }}>
              <CardTitle icon={{ group: "alert", name: "triangle-warning-filled" }}>
                The engine corrected the photo agent's counts
              </CardTitle>
              <CardNote>
                Every count is recomputed from distinct work orders, so the agent's own arithmetic never reaches
                the record.
              </CardNote>
              <ul style={{ margin: 0, paddingLeft: 18, font: "var(--text-body-reg-14)", color: "var(--colors-text-description)" }}>
                {mismatches.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </Card>
          )}

          {lock && !lock.accepted && (
            <ErrorBanner>
              The written explanation was rejected because it contained figures absent from its input:{" "}
              {lock.unseen_figures.join(", ")}.
            </ErrorBanner>
          )}

          {ev?.formulas && Object.keys(ev.formulas).length > 0 && (
            <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
              <CardTitle icon={{ group: "action", name: "info" }}>How each number was derived</CardTitle>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "var(--spacing-container-large)",
                  padding: "var(--spacing-container-xlarge)",
                  borderRadius: "var(--border-medium)",
                  border: "1px solid var(--colors-border-neutral-base-subtler)",
                  backgroundColor: "var(--colors-background-container)",
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  lineHeight: 1.7,
                  color: "var(--colors-text-description)",
                  overflowX: "auto",
                }}
              >
                {Object.entries(ev.formulas).map(([k, v]) => (
                  <span key={k}>
                    {k}: {v}
                  </span>
                ))}
              </div>
              <CardNote>
                The agent reads photographs, judges severity and writes the prose. Every figure above is computed
                in TypeScript against SQL, and overwrites whatever the agent returned.
              </CardNote>
            </Card>
          )}

          {a?.unavailable && a.unavailable.length > 0 && (
            <GapList items={a.unavailable} title="What the evidence could not support" />
          )}
        </>
      )}
    </DetailShell>
  );
}
