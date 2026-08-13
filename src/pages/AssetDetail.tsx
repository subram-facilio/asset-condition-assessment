import { useEffect, useState } from "react";
import { fn, inr } from "../lib/vibe";
import type { AssetDetail as Detail } from "../lib/types";
import {
  Empty,
  Pill,
  Spark,
  gradeTone,
  pretty,
  recommendationTone,
  riskTone,
  severityTone,
  statusTone,
  trendTone,
} from "../lib/ui";

/**
 * Page order follows the agent spec's FINAL RESPONSE PRINCIPLE: the
 * consolidated asset-level analysis leads, individual photo findings are
 * secondary, and the lifecycle/financial engines sit in a clearly separate
 * section because the spec excludes them from the visual analysis.
 */
export function AssetDetail({ assetId }: { assetId: number }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setD(null);
    fn<Detail>("asset-detail", { assetId })
      .then(setD)
      .catch((e) => setError(String(e?.message || e)));
  }, [assetId]);

  if (error) return <div className="banner bad">Could not load this asset: {error}</div>;
  if (!d) return <Empty>Loading analysis…</Empty>;

  const a = d.assessment;
  const an = d.analysis;

  if (!a && !an) {
    return (
      <>
        <h1>Asset {assetId}</h1>
        <div className="card">
          <p style={{ marginTop: 0 }}>This asset has not been assessed yet.</p>
          <a className="btn primary" href={`#/run/${assetId}`}>
            Run its assessment
          </a>
        </div>
      </>
    );
  }

  const scope = an?.analysis_scope;
  const mismatches = d.engine_overrides?.count_mismatches || [];
  const photoFindings = d.findings.filter((f) => f.source === "photo");
  const textFindings = d.findings.filter((f) => f.source === "wo_text");

  return (
    <>
      <div className="row spread" style={{ marginBottom: 14 }}>
        <div>
          <div className="muted small">
            <a href="#/register">Condition register</a> / {a?.category || an?.asset?.asset_type}
          </div>
          <h1 style={{ marginBottom: 6 }}>{a?.asset_name || an?.asset?.asset_id}</h1>
          <div className="muted small">
            {[an?.asset?.manufacturer, an?.asset?.model, an?.asset?.location].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
        <a className="btn" href={`#/run/${assetId}`}>
          Re-assess
        </a>
      </div>

      {/* ---------- 1. Consolidated analysis (the primary result) ---------- */}
      {an && (
        <div className="card">
          <div className="card-title">Asset-level analysis</div>
          <p style={{ marginTop: 0, fontSize: 15.5, fontWeight: 550 }}>{an.overall_analysis.summary}</p>
          <table>
            <tbody>
              <tr>
                <td className="muted small" style={{ width: 190 }}>
                  Main recurring problem
                </td>
                <td>
                  <b>{pretty(an.overall_analysis.primary_recurring_issue)}</b> — occurred in{" "}
                  <b>{an.overall_analysis.primary_issue_occurrence_count}</b> of{" "}
                  {scope?.corrective_work_orders_analyzed} corrective work orders
                </td>
              </tr>
              <tr>
                <td className="muted small">Most affected component</td>
                <td>{pretty(an.overall_analysis.most_affected_component)}</td>
              </tr>
              <tr>
                <td className="muted small">Recurrence finding</td>
                <td>{an.overall_analysis.recurrence_finding}</td>
              </tr>
              <tr>
                <td className="muted small">Pattern</td>
                <td>{an.overall_analysis.asset_pattern}</td>
              </tr>
              <tr>
                <td className="muted small">Why this risk</td>
                <td>{an.overall_analysis.risk_reason}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ---------- 2. Visual / corrective-history risk ---------- */}
      {an && (
        <div className="card">
          <div className="row spread" style={{ alignItems: "flex-start" }}>
            <div>
              <div className="card-title">Corrective-history risk</div>
              <div className="row">
                <Pill tone={riskTone(an.asset_risk.risk_level)}>{String(an.asset_risk.risk_level).toUpperCase()}</Pill>
                <span className="muted small">score {an.asset_risk.risk_score.toFixed(2)} of 1.00</span>
              </div>
            </div>
            <div className="small muted" style={{ maxWidth: 330, textAlign: "right" }}>
              From visual and corrective evidence only — asset age, cost and criticality are deliberately excluded here
              and handled by the lifecycle engines below.
            </div>
          </div>
          {an.asset_risk.risk_drivers.length > 0 && (
            <table style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>Risk driver</th>
                  <th className="num">Occurrences</th>
                  <th>Severity</th>
                </tr>
              </thead>
              <tbody>
                {an.asset_risk.risk_drivers.map((r, i) => (
                  <tr key={i}>
                    <td>{r.driver}</td>
                    <td className="num">{r.occurrence_count}</td>
                    <td>
                      <Pill tone={severityTone(r.severity)}>{r.severity}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ---------- 3. Frequency vs severity, kept separate ---------- */}
      {an && (
        <div className="grid g2" style={{ marginTop: 14 }}>
          <div className="card" style={{ margin: 0 }}>
            <div className="card-title">Most frequent issue</div>
            <div style={{ fontSize: 18, fontWeight: 650 }}>{pretty(an.issue_summary.most_frequent_issue)}</div>
            <div className="muted small">
              {an.issue_summary.most_frequent_issue_count} corrective work orders
            </div>
          </div>
          <div className="card" style={{ margin: 0 }}>
            <div className="card-title">Highest severity issue</div>
            <div style={{ fontSize: 18, fontWeight: 650 }}>
              {pretty(an.issue_summary.highest_severity_issue || "—")}
            </div>
            <div className="muted small">
              observed at{" "}
              <Pill tone={severityTone(an.issue_summary.highest_severity_level || "unknown")}>
                {an.issue_summary.highest_severity_level || "unknown"}
              </Pill>{" "}
              severity — frequency and severity are separate dimensions
            </div>
          </div>
        </div>
      )}

      {/* ---------- 4. Recurring issues ---------- */}
      {an && an.recurring_issues.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-title">
            Recurring issues — the recurrence unit is the corrective work order, never the photo
          </div>
          {an.recurring_issues.map((i) => (
            <div className="issue" key={i.issue_id}>
              <div className="issue-head">
                <span className="issue-name">{i.display_name}</span>
                <Pill tone={statusTone(i.status)}>{pretty(i.status)}</Pill>
                <Pill tone={severityTone(i.severity.overall)}>{i.severity.overall} severity</Pill>
                <Pill tone={trendTone(i.trend)}>{pretty(i.trend)}</Pill>
                <span className="muted small" style={{ marginLeft: "auto" }}>
                  confidence {i.confidence.toFixed(2)}
                </span>
              </div>

              <div className="row" style={{ marginTop: 8, gap: 18 }}>
                <span>
                  <span className="occ" style={{ fontSize: 17 }}>
                    {i.occurrence_count}
                  </span>{" "}
                  <span className="muted small">
                    of {scope?.corrective_work_orders_analyzed} corrective WOs
                  </span>
                </span>
                <span>
                  <span className="occ">{(i.occurrence_rate * 100).toFixed(0)}%</span>{" "}
                  <span className="muted small">occurrence rate</span>
                </span>
                {i.first_occurrence && (
                  <span className="muted small">
                    first {i.first_occurrence.date} · last {i.last_occurrence?.date}
                  </span>
                )}
              </div>

              <div className="bar">
                <i style={{ width: `${Math.min(i.occurrence_rate * 100, 100)}%` }} />
              </div>

              <div className="row small" style={{ gap: 6 }}>
                <span className="muted">Components:</span>
                {i.affected_components.map((c) => (
                  <Pill tone="mute" key={c.component}>
                    {pretty(c.component)} ×{c.occurrence_count}
                  </Pill>
                ))}
              </div>

              {i.severity.observed_levels.length > 1 && (
                <div className="row small" style={{ gap: 6, marginTop: 6 }}>
                  <span className="muted">Observed severities:</span>
                  {i.severity.observed_levels.map((s) => (
                    <Pill tone={severityTone(s)} key={s}>
                      {s}
                    </Pill>
                  ))}
                </div>
              )}

              <ul className="ev">
                {i.evidence.map((e, k) => (
                  <li key={k}>{e}</li>
                ))}
              </ul>

              <div className="row small" style={{ marginTop: 8, gap: 6 }}>
                <span className="muted">Work orders:</span>
                <span className="wo-refs">
                  {i.work_order_references.map((w) => (
                    <span className="wo-ref" key={w}>
                      #{w}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ---------- 5. Component concentration ---------- */}
      {an && an.component_analysis.length > 0 && (
        <div className="card">
          <div className="card-title">Component concentration</div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Component</th>
                  <th className="num">Corrective WOs</th>
                  <th className="num">Distinct issues</th>
                  <th>Issues</th>
                  <th>Highest severity</th>
                </tr>
              </thead>
              <tbody>
                {an.component_analysis.map((c) => (
                  <tr key={c.component}>
                    <td style={{ fontWeight: 550 }}>{pretty(c.component)}</td>
                    <td className="num">{c.corrective_work_order_count}</td>
                    <td className="num">{c.issue_count}</td>
                    <td className="small">{c.issues.map((i) => pretty(i)).join(", ")}</td>
                    <td>
                      <Pill tone={severityTone(c.highest_severity)}>{c.highest_severity}</Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------- 6. Year-on-year evidence ---------- */}
      {d.issue_matrix.years.length > 0 && (
        <div className="card">
          <div className="card-title">Occurrences per year (distinct work orders)</div>
          <div className="tbl-wrap">
            <table className="matrix">
              <thead>
                <tr>
                  <th>Issue</th>
                  {d.issue_matrix.years.map((y) => (
                    <th key={y} style={{ textAlign: "center" }}>
                      {y}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.issue_matrix.rows.map((r) => (
                  <tr key={r.issue}>
                    <td style={{ fontWeight: 550 }}>{r.label}</td>
                    {r.counts.map((c, i) => (
                      <td className={`cell heat${Math.min(c, 3)}`} key={i}>
                        {c || "·"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {d.issue_matrix.years.length < 2 && (
            <div className="muted small" style={{ marginTop: 8 }}>
              Only one calendar year of evidence — a trend needs more chronological history, so trend is reported as
              insufficient evidence rather than guessed.
            </div>
          )}
        </div>
      )}

      {/* ---------- 7. Data quality, never hidden ---------- */}
      {an && (
        <div className="card">
          <div className="card-title">Evidence and data quality</div>
          {an.data_quality.assessment_limited && (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              <span>
                <b>This assessment is limited by its evidence.</b>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {an.data_quality.limitations.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </span>
            </div>
          )}
          <div className="grid g4">
            <div className="kpi">
              <div className="n">{scope?.corrective_work_orders_analyzed ?? 0}</div>
              <div className="l">Corrective work orders</div>
            </div>
            <div className="kpi">
              <div className="n">{scope?.photos_analyzed ?? 0}</div>
              <div className="l">Before photos analysed</div>
            </div>
            <div className="kpi">
              <div className="n">{scope?.work_orders_with_usable_photos ?? 0}</div>
              <div className="l">WOs with usable photos</div>
            </div>
            <div className="kpi">
              <div className="n">{scope?.work_orders_with_insufficient_photos ?? 0}</div>
              <div className="l">WOs without usable photos</div>
            </div>
          </div>
          <div className="row small muted" style={{ marginTop: 10, gap: 14 }}>
            <span>Photo-backed findings: {photoFindings.length}</span>
            <span>Text-derived findings: {textFindings.length}</span>
            <span>Photo evidence confidence: {an.data_quality.photo_evidence_confidence.toFixed(2)}</span>
            <span>Analysis source: {pretty(an.analysis_source || "engine_only")}</span>
          </div>
          {mismatches.length > 0 && (
            <div className="banner info" style={{ marginTop: 12 }}>
              <span>
                <b>Engine corrected the agent's counts.</b>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {mismatches.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </span>
            </div>
          )}
        </div>
      )}

      {/* ---------- 8. Per-photo traceability, secondary by design ---------- */}
      {d.findings.length > 0 && (
        <div className="card">
          <details className="sec">
            <summary>Photo and finding traceability ({d.findings.length} findings)</summary>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Work order</th>
                    <th>Issue</th>
                    <th>Component</th>
                    <th>Severity</th>
                    <th className="num">Conf.</th>
                    <th className="num">Extent</th>
                    <th>Source</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {d.findings.map((f, i) => (
                    <tr key={i}>
                      <td className="mono">#{f.wo_id}</td>
                      <td style={{ fontWeight: 550 }}>{f.issue_label}</td>
                      <td className="small">{pretty(f.component)}</td>
                      <td>
                        <Pill tone={severityTone(f.severity)}>{f.severity}</Pill>
                      </td>
                      <td className="num">{f.confidence.toFixed(2)}</td>
                      <td className="num">{f.extent_percent ? `${f.extent_percent}%` : "—"}</td>
                      <td>
                        <Pill tone={f.source === "photo" ? "info" : "mute"}>
                          {f.source === "photo" ? "photo" : "WO text"}
                        </Pill>
                      </td>
                      <td className="small muted">{f.evidence[0] || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}

      {/* ---------- 9. Lifecycle engines — separate by design ---------- */}
      {a && (
        <>
          <div className="sep" />
          <div className="section-label">
            Lifecycle and financial engines — deterministic, and deliberately outside the visual analysis
          </div>

          <div className="grid g4">
            <div className="kpi">
              <div className="n">{a.score.toFixed(2)}</div>
              <div className="l">
                Condition <Pill tone={gradeTone(a.grade)}>{a.grade}</Pill>
              </div>
            </div>
            <div className="kpi">
              <div className="n">{a.risk_score}</div>
              <div className="l">
                Lifecycle risk <Pill tone={riskTone(a.risk_level)}>{a.risk_level}</Pill>
              </div>
            </div>
            <div className="kpi">
              <div className="n">{a.rul_years}y</div>
              <div className="l">Remaining useful life</div>
            </div>
            <div className="kpi">
              <div className="n">
                <Pill tone={recommendationTone(a.recommendation)}>{a.recommendation}</Pill>
              </div>
              <div className="l">
                Recommendation · CAPEX {a.capex_priority}
              </div>
            </div>
          </div>

          <div className="grid g2" style={{ marginTop: 14 }}>
            <div className="card" style={{ margin: 0 }}>
              <div className="card-title">Cost basis</div>
              <table>
                <tbody>
                  <tr>
                    <td className="muted small">Corrective spend (3 years)</td>
                    <td className="num">{inr(a.repair_spend)}</td>
                  </tr>
                  <tr>
                    <td className="muted small">Estimated replacement</td>
                    <td className="num">{inr(a.replacement_cost)}</td>
                  </tr>
                  <tr>
                    <td className="muted small">Deterioration</td>
                    <td>{pretty(a.deterioration)}</td>
                  </tr>
                </tbody>
              </table>
              <div className="banner info" style={{ marginTop: 10 }}>
                <span>
                  This Facilio org holds no work-order cost fields, so spend is estimated from the configured rates in{" "}
                  <a href="#/settings">Settings</a> rather than invented.
                </span>
              </div>
            </div>

            <div className="card" style={{ margin: 0 }}>
              <div className="card-title">How these numbers were derived</div>
              {a.evidence ? (
                <>
                  <div className="tbl-wrap">
                    <table>
                      <tbody>
                        {Object.entries(a.evidence.inputs).map(([k, v]) => (
                          <tr key={k}>
                            <td className="muted small">{pretty(k)}</td>
                            <td className="num mono">{String(v)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="small muted" style={{ marginTop: 10 }}>
                    {Object.entries(a.evidence.formulas).map(([k, v]) => (
                      <div key={k} className="mono" style={{ marginTop: 4 }}>
                        {k}: {v}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="muted small">No derivation record stored for this assessment.</div>
              )}
            </div>
          </div>

          {d.history.length >= 2 && (
            <div className="card">
              <div className="card-title">Condition trajectory ({d.history.length} assessments)</div>
              <Spark values={d.history.map((h) => h.score)} tone="var(--bad)" />
              <div className="muted small">
                Condition score over successive assessments — the deterioration engine reads its velocity from this.
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
