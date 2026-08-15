import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { FButton, FText } from "@facilio/dsm-react-wrapper";
import { fn, usd } from "../lib/vibe";
import type { AssetDetail as Detail, Metric, MtbfGap, Narrative } from "../lib/types";
import { Empty, ErrorBanner, GapList, LifecycleBar, MtbfBars, Provenance, Spark, Val, pretty } from "../lib/ui";
import { DetailShell, RailFact, type DetailTab } from "../components/DetailShell";
import { Card, CardTitle, CardNote } from "../components/Card";
import { Disclosure } from "../components/Disclosure";
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

type TabKey = "overview" | "findings" | "evidence";

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

/** "Show all N" — the release valve on a capped evidence list. */
function ShowAll({ n, onClick }: { n: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        alignSelf: "flex-start",
        border: "none",
        background: "transparent",
        padding: 0,
        cursor: "pointer",
        font: "var(--text-body-reg-14)",
        color: "var(--colors-text-primary-default)",
      }}
    >
      Show all {n}
    </button>
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

/**
 * Where a finding's evidence came from. This was a two-way ternary that called
 * everything-but-`photo` "WO text", which mislabelled operator-supplied photos and
 * would have reported an inspector's words as work-order wording.
 */
const SOURCE_LABEL: Record<string, string> = {
  photo: "photo",
  photo_manual: "photo (supplied)",
  photo_unusable: "photo (unusable)",
  wo_text: "WO text",
  inspection: "inspection",
};

const SOURCE_TONE: Record<string, "info" | "mute" | "warn"> = {
  photo: "info",
  photo_manual: "info",
  photo_unusable: "warn",
  wo_text: "mute",
  inspection: "info",
};

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
  // Long evidence lists are capped rather than paginated: the first few rows answer
  // "is there evidence?", and the rest is for someone auditing a specific claim.
  const [showAllFindings, setShowAllFindings] = useState(false);
  const [showAllObs, setShowAllObs] = useState(false);

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
  const crossStream = ev?.cross_stream;
  const inspectionEvidence = ev?.inspection_observations;
  const quoteLock = ev?.quote_lock;
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
      {
        key: "evidence",
        label: "Evidence",
        icon: { group: "webtabs", name: "workorder" },
        badge: findings.length,
      },
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

          {narrative && narrative.source === "condition_core_agent" && (
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
                    {usd(a.replacement_cost)}
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
                Written by the condition-core agent from the computed values, and verified to contain no
                figure absent from them.
              </CardNote>
            </Card>
          )}

          {crossStream &&
            (crossStream.corroborations?.length > 0 ||
              crossStream.conflicts?.length > 0 ||
              crossStream.repair_effectiveness_note) && (
              <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
                <CardTitle
                  icon={{ group: "webtabs", name: "inspection" }}
                  action={
                    <StatusTag
                      tone={
                        crossStream.confidence_in_recommendation === "high"
                          ? "success"
                          : crossStream.confidence_in_recommendation === "low"
                          ? "warn"
                          : "info"
                      }
                    >
                      {crossStream.confidence_in_recommendation} confidence
                    </StatusTag>
                  }
                >
                  Across the evidence
                </CardTitle>

                {crossStream.corroborations?.length > 0 && (
                  <Qa q="Where the evidence agrees" a={crossStream.corroborations.join(" ")} />
                )}
                {crossStream.conflicts?.length > 0 && (
                  <Qa q="Where it disagrees" a={crossStream.conflicts.join(" ")} />
                )}
                {crossStream.repair_effectiveness_note && (
                  <Qa q="Are past repairs holding" a={crossStream.repair_effectiveness_note} />
                )}
                {crossStream.what_would_change_this?.length > 0 && (
                  <Qa q="What would change this" a={crossStream.what_would_change_this.join(" ")} />
                )}

                <CardNote>
                  The condition score is a weighted mean, so it can report what the streams average to but
                  never whether they tell the same story. This is that judgment.
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
              expectedLife={Number(inputs.expected_life_years) || 0}
              purchasedYear={String(an?.asset?.purchasedDate || "").slice(0, 4) || undefined}
            />
          </Card>

          {/* Cost sits on the verdict page because it is half the repair-or-replace question.
              The old "Risk & cost" tab paired it with a Risk card that restated the KPIs above
              field for field, so only the cost half survived the merge. */}
          {a && (
            <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-large)" }}>
              <CardTitle icon={{ group: "files", name: "document" }}>Cost basis</CardTitle>
              <Row label="Corrective spend, last 3 years">{usd(a.repair_spend)}</Row>
              <Row label="Estimated replacement">{usd(a.replacement_cost)}</Row>
              <Row label="CAPEX priority" last>
                {a.capex_priority === "-" ? (
                  <FText appearance="bodyReg14" styleProps={{ color: "textCaption" }}>
                    none
                  </FText>
                ) : (
                  <StatusTag tone={priorityTone(a.capex_priority)}>{a.capex_priority}</StatusTag>
                )}
              </Row>
            </Card>
          )}

          {/* Everything that proves the verdict rather than stating it. Collapsed by default:
              these are the app's engineering guarantees, and on the surface they read as noise
              to the person who just wants to know whether to replace a chiller. */}
          <Disclosure
            title="How this was computed"
            subtitle="formulas, risk weights, and what the engine corrected"
          >
            {Array.isArray(inputs.streams_used) && inputs.streams_used.length > 0 && (
              <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-large)" }}>
                <CardTitle icon={{ group: "chart-data", name: "bar-graph" }}>Evidence streams</CardTitle>
                <CardNote>
                  The condition score is a weighted mean of the streams that had evidence; absent streams
                  are not zero-filled, their weight is redistributed across the rest.
                </CardNote>
                {(inputs.streams_used as Array<{ name: string; weight: number; value: number }>).map((st) => (
                  <Row key={st.name} label={pretty(st.name)}>
                    {st.value} of 5 · weight {st.weight}
                  </Row>
                ))}
              </Card>
            )}

            {ev?.risk_terms && ev.risk_terms.length > 0 && a && (
              <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
                <CardTitle icon={{ group: "alert", name: "triangle-warning-filled" }}>
                  How the risk score is built
                </CardTitle>
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
                </DataGrid>
                {ev.risk_terms_excluded && ev.risk_terms_excluded.length > 0 && (
                  <CardNote>
                    Excluded and reweighted so the remaining terms still total 100:{" "}
                    {ev.risk_terms_excluded.join("; ")}.
                  </CardNote>
                )}
                {ev.cost_basis && <CardNote>{ev.cost_basis}.</CardNote>}
              </Card>
            )}

            {mismatches.length > 0 && (
              <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xlarge)" }}>
                <CardTitle icon={{ group: "alert", name: "triangle-warning-filled" }}>
                  The engine corrected the photo agent's counts
                </CardTitle>
                <CardNote>
                  Every count is recomputed from distinct work orders, so the agent's own arithmetic never
                  reaches the record.
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

            {quoteLock && quoteLock.unquoted.length > 0 && (
              <ErrorBanner>
                {quoteLock.unquoted.length} inspection claim
                {quoteLock.unquoted.length === 1 ? " was" : "s were"} discarded because the quoted wording
                could not be found in the inspector's answer: {quoteLock.unquoted.join("; ")}.
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
                      {k}: {String(v)}
                    </span>
                  ))}
                </div>
                <CardNote>
                  The agents read photographs and inspector prose and write the explanation. Every figure
                  above is computed in TypeScript against SQL, and overwrites whatever an agent returned.
                </CardNote>
              </Card>
            )}
          </Disclosure>
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
                <Disclosure
                  title="Component concentration"
                  subtitle="which component carries the most corrective work"
                  defaultOpen
                >
                {/* Short headers and a narrower floor: "Corrective WOs" / "Worst severity"
                    are nowrap, and at this column width they forced the grid past its
                    minWidth, scrolling the component names out of view. */}
                <DataGrid
                  minWidth={340}
                  head={
                    <>
                      <th style={TABLE_HEAD}>Component</th>
                      <th style={TABLE_HEAD}>WOs</th>
                      <th style={TABLE_HEAD}>Issues</th>
                      <th style={TABLE_HEAD}>Severity</th>
                    </>
                  }
                >
                  {an.component_analysis.map((c) => (
                    <tr key={c.component}>
                      <td style={{ ...TABLE_CELL, color: "var(--colors-text-main)" }}>{pretty(c.component)}</td>
                      <td style={TABLE_CELL}>{c.corrective_work_order_count}</td>
                      <td style={TABLE_CELL}>{c.issue_count}</td>
                      <td style={TABLE_CELL}>
                        {/* "unknown" is not a missing value — it means no evidence source
                            graded this component. Saying so beats a grey chip that reads
                            like the pipeline dropped something. */}
                        {c.highest_severity === "unknown" ? (
                          <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                            not graded
                          </FText>
                        ) : (
                          <StatusTag tone={severityTone(c.highest_severity)}>{c.highest_severity}</StatusTag>
                        )}
                      </td>
                    </tr>
                  ))}
                </DataGrid>
                <CardNote>
                  Severity comes from photographs and inspections. Work-order wording identifies which
                  issue occurred but never how bad it was, so a component evidenced only by text reads
                  "not graded" rather than being assigned a severity nobody measured.
                </CardNote>
                </Disclosure>
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
      {/* ══════════════════════════════════════════════════════════ evidence */}
      {tab === "evidence" && (
        <>
          <PhotoEvidence assetId={assetId} onDone={load} />

          {inspectionEvidence && inspectionEvidence.observations?.length > 0 && (
            <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
              <CardTitle
                icon={{ group: "webtabs", name: "inspection" }}
                action={
                  <StatusTag tone={inspectionEvidence.operability?.value === "operational" ? "success" : "info"}>
                    {(inspectionEvidence.operability?.value || "unknown").replace(/_/g, " ")}
                  </StatusTag>
                }
              >
                What the inspector wrote
              </CardTitle>

              <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
                {inspectionEvidence.observations.slice(0, showAllObs ? inspectionEvidence.observations.length : 3).map((o, i) => (
                  <div key={`${o.answer_id}-${o.type}-${i}`} style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-small)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-large)", flexWrap: "wrap" }}>
                      <StatusTag tone={severityTone(o.severity)}>{o.severity}</StatusTag>
                      <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
                        {o.type.replace(/_/g, " ")}
                      </FText>
                      <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                        {o.component.replace(/_/g, " ")}
                        {o.location ? ` · ${o.location}` : ""}
                      </FText>
                    </div>
                    <FText appearance="captionReg12" styleProps={{ color: "textDescription", display: "block" }}>
                      “{o.quote}”
                    </FText>
                  </div>
                ))}
              </div>

              {!showAllObs && inspectionEvidence.observations.length > 3 && (
                <ShowAll n={inspectionEvidence.observations.length} onClick={() => setShowAllObs(true)} />
              )}

              {inspectionEvidence.repair_effectiveness?.length > 0 && (
                <Qa
                  q="Did the last repair hold"
                  a={inspectionEvidence.repair_effectiveness
                    .map((r) => `${r.issue.replace(/_/g, " ")}: ${r.verdict.replace(/_/g, " ")}`)
                    .join(" · ")}
                />
              )}

              <CardNote>
                Read from {inspectionEvidence.inspections_reviewed} closed inspection
                {inspectionEvidence.inspections_reviewed === 1 ? "" : "s"}. Every claim is quoted verbatim from
                the inspector's own answer — one that cannot be found in the source text is discarded rather
                than shown. These observations reach the condition score on the next assessment.
              </CardNote>
            </Card>
          )}
          <FText appearance="captionReg12" styleProps={{ color: "textCaption", display: "block" }}>
            {findings.length} finding{findings.length === 1 ? "" : "s"} from{" "}
            {scope?.corrective_work_orders_analyzed ?? a?.corrective_wo_count ?? 0} corrective work orders ·{" "}
            {photoFindings.length} photo-backed · {textFindings.length} text-derived
            {inspectionEvidence?.kept ? ` · ${inspectionEvidence.kept} inspector-observed` : ""}
          </FText>

          {a?.unavailable && a.unavailable.length > 0 && (
            <GapList items={a.unavailable} title="What this assessment couldn't see" />
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
                {findings.slice(0, showAllFindings ? findings.length : 10).map((f, i) => (
                  <tr key={i}>
                    <td style={{ ...TABLE_CELL, fontFamily: "var(--mono)", fontSize: 12 }}>#{f.wo_id}</td>
                    <td style={{ ...TABLE_CELL, color: "var(--colors-text-main)" }}>{f.issue_label}</td>
                    <td style={TABLE_CELL}>{pretty(f.component)}</td>
                    <td style={TABLE_CELL}>
                      <StatusTag tone={severityTone(f.severity)}>{f.severity}</StatusTag>
                    </td>
                    <td style={TABLE_CELL}>{f.confidence.toFixed(2)}</td>
                    <td style={TABLE_CELL}>
                      <StatusTag tone={SOURCE_TONE[f.source] || "mute"}>
                        {SOURCE_LABEL[f.source] || f.source}
                      </StatusTag>
                    </td>
                    <td style={{ ...TABLE_CELL, font: "var(--text-caption-reg-12)" }}>{f.evidence[0] || "—"}</td>
                  </tr>
                ))}
              </DataGrid>
            )}
            {!showAllFindings && findings.length > 10 && (
              <ShowAll n={findings.length} onClick={() => setShowAllFindings(true)} />
            )}
          </Card>
        </>
      )}
    </DetailShell>
  );
}
