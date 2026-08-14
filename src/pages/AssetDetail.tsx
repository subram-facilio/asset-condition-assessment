import { useEffect, useState } from "react";
import { fn, inr } from "../lib/vibe";
import type { AssetDetail as Detail, Metric, MtbfGap, Narrative } from "../lib/types";
import {
  Empty,
  GapList,
  LifecycleBar,
  MtbfBars,
  Pill,
  Provenance,
  Spark,
  Val,
  gradeTone,
  pretty,
  recommendationTone,
  riskTone,
  severityTone,
  statusTone,
  trendTone,
} from "../lib/ui";

/**
 * The page follows one narrative: what condition is this asset in, why, how fast is
 * it changing, and therefore what should be done. Evidence sits beside each claim,
 * and anything that could not be computed says so rather than showing a zero.
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

  const ev = a?.evidence;
  const inputs: any = ev?.inputs || {};
  const narrative: Narrative | undefined = ev?.narrative;
  const lock = ev?.narrative_number_lock;
  const baselines = ev?.baselines;
  const scope = an?.analysis_scope;
  const mismatches = d.engine_overrides?.count_mismatches || [];
  const photoFindings = d.findings.filter((f) => f.source === "photo");
  const textFindings = d.findings.filter((f) => f.source === "wo_text");

  // Prefer the dominant issue's own interval series — it answers whether that
  // specific problem is accelerating, rather than how busy the asset is overall.
  const domMtbf = (a?.dominant_issue_mtbf?.series?.value ||
    inputs.dominant_mtbf_series ||
    null) as MtbfGap[] | null;
  const domVerdict =
    a?.dominant_issue_mtbf?.verdict?.value || inputs.dominant_mtbf_verdict || inputs.mtbf_verdict || null;
  const ageMetric: Metric<number> = {
    value: inputs.age_years ?? null,
    available: inputs.age_years !== null && inputs.age_years !== undefined,
    reason: "no purchase date recorded on the asset",
  };

  return (
    <>
      {/* ---------- identity + verdict up front ---------- */}
      <div className="row spread" style={{ marginBottom: 14 }}>
        <div>
          <div className="muted small">
            <a href="#/register">Condition register</a> / {a?.category || an?.asset?.asset_type}
          </div>
          <h1 style={{ marginBottom: 6 }}>{a?.asset_name || `Asset ${assetId}`}</h1>
          <div className="muted small">
            {[an?.asset?.manufacturer, an?.asset?.model, an?.asset?.location].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="row" style={{ justifyContent: "flex-end", marginBottom: 8 }}>
            {a && <Pill tone={riskTone(a.risk_level)}>{a.risk_level} RISK</Pill>}
            {a && <Pill tone={recommendationTone(a.recommendation)}>{a.recommendation}</Pill>}
          </div>
          <a className="btn" href={`#/run/${assetId}`}>
            Re-assess
          </a>
        </div>
      </div>

      {/* ---------- 1. the four headline numbers ---------- */}
      {a && (
        <div className="grid g4">
          <div className="kpi">
            <div className="n">{a.score.toFixed(2)}</div>
            <div className="l">
              Condition of 5 · <Pill tone={gradeTone(a.grade)}>{a.grade}</Pill>
            </div>
          </div>
          <div className="kpi">
            <div className="n">{a.risk_score}</div>
            <div className="l">
              Risk of 100 · <Pill tone={riskTone(a.risk_level)}>{a.risk_level}</Pill>
            </div>
          </div>
          <div className="kpi">
            <div className="n">
              <Val metric={ageMetric} suffix="y" fallbackLabel="unknown" />
            </div>
            <div className="l">Age in service</div>
          </div>
          <div className="kpi">
            <div className="n">
              <Val metric={a.rul} suffix="y" fallbackLabel="unavailable" />
            </div>
            <div className="l">
              Remaining life{" "}
              {baselines && <Provenance source={baselines.source} confidence={baselines.confidence?.life} />}
            </div>
          </div>
        </div>
      )}

      {/* ---------- 2. the explanation ---------- */}
      {narrative && narrative.source === "condition_assessment_agent" && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-title">Assessment</div>
          <p className="narr-lead" style={{ marginTop: 0 }}>
            {narrative.summary}
          </p>
          <div className="grid g2" style={{ marginTop: 4 }}>
            <div>
              <div className="narr-q">Why this condition</div>
              <div className="narr-a">{narrative.why_condition}</div>
              <div className="narr-q">The main problem</div>
              <div className="narr-a">{narrative.why_main_problem}</div>
            </div>
            <div>
              <div className="narr-q">How fast it is changing</div>
              <div className="narr-a">{narrative.why_deterioration}</div>
              <div className="narr-q">Remaining life</div>
              <div className="narr-a">{narrative.why_rul}</div>
            </div>
          </div>
          <div className={`reco ${recommendationTone(a?.recommendation || "")}`}>
            <div className="reco-head">
              <span className="reco-verb">{a?.recommendation}</span>
              {a?.capex_priority !== "-" && <Pill tone="crit">CAPEX {a?.capex_priority}</Pill>}
              <span className="muted small">
                {inr(a?.replacement_cost || 0)}{" "}
                {baselines && <Provenance source={baselines.source} confidence={baselines.confidence?.replacement} />}
              </span>
            </div>
            <div className="reco-why">{narrative.why_recommendation}</div>
            {a?.warranty_gate_applied && (
              <div className="small" style={{ marginTop: 8, fontWeight: 600 }}>
                The rule produced {a.rule_recommendation}, but this asset is still under warranty, so it was
                downgraded — replacing an asset the manufacturer is liable for wastes the remaining cover.
              </div>
            )}
          </div>
          {narrative.caveats?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="narr-q">What this assessment could not see</div>
              <ul className="ev">
                {narrative.caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="muted small" style={{ marginTop: 10 }}>
            Written by the condition-assessment agent from the computed values, and verified to contain no figure
            absent from them.
          </div>
        </div>
      )}

      {narrative && narrative.source === "rejected_agent_reply" && (
        <div className="banner warn" style={{ marginTop: 14 }}>
          <span>
            <b>The written explanation was rejected.</b> {narrative.rejected_because}. The computed results below are
            unaffected — only the prose was discarded.
          </span>
        </div>
      )}

      {a && !narrative && (
        <div className="banner info" style={{ marginTop: 14 }}>
          <span>
            No written explanation stored yet. <a href={`#/run/${assetId}`}>Re-assess</a> to generate one — the numbers
            below stand on their own regardless.
          </span>
        </div>
      )}

      {/* ---------- 3. how fast it is changing ---------- */}
      {a && (
        <div className="grid g2" style={{ marginTop: 14 }}>
          <div className="card" style={{ margin: 0 }}>
            <div className="card-title">Deterioration</div>
            <div className="row" style={{ marginBottom: 8 }}>
              <Pill
                tone={
                  a.deterioration === "accelerating" ? "bad" : a.deterioration === "improving" ? "good" : "mute"
                }
              >
                {pretty(a.deterioration)}
              </Pill>
              {a.deterioration_velocity?.available ? (
                <span className="small">
                  <b>{a.deterioration_velocity.value}</b> grade per year
                </span>
              ) : (
                <span className="muted small">velocity not measurable yet</span>
              )}
            </div>
            {d.history.length >= 2 ? (
              <Spark values={d.history.map((h) => h.score)} tone="var(--bad)" />
            ) : (
              <div className="muted small">
                One assessment on record, so there is no measured trajectory yet. Re-assess over time to build one.
              </div>
            )}
            {inputs.deterioration_basis && (
              <div className="muted small" style={{ marginTop: 8 }}>
                Basis: {inputs.deterioration_basis}.
              </div>
            )}
          </div>

          <div className="card" style={{ margin: 0 }}>
            <div className="card-title">
              Time between corrective events
              {a.dominant_issue_mtbf ? ` — ${a.dominant_issue_mtbf.issue_label}` : ""}
            </div>
            {domMtbf && domMtbf.length > 0 ? (
              <MtbfBars gaps={domMtbf} verdict={domVerdict} />
            ) : (
              <div className="muted small">
                Not enough dated corrective events to measure an interval.
              </div>
            )}
            <div className="row spread small muted" style={{ marginTop: 10 }}>
              <span>
                Mean <Val metric={a.mtbf?.mean_months} suffix=" months" fallbackLabel="n/a" /> across all corrective
                events
              </span>
              <span>
                MTTR <Val metric={a.mttr_hours} suffix=" h" fallbackLabel="not recorded" />
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ---------- 4. why: the recurring issues ---------- */}
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
                  <span className="muted small">of {scope?.corrective_work_orders_analyzed} corrective WOs</span>
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

      {/* ---------- 5. where: component concentration + per-year matrix ---------- */}
      <div className="grid g2" style={{ marginTop: 14 }}>
        {an && an.component_analysis.length > 0 && (
          <div className="card" style={{ margin: 0 }}>
            <div className="card-title">Component concentration</div>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Component</th>
                    <th className="num">Corrective WOs</th>
                    <th className="num">Issues</th>
                    <th>Worst severity</th>
                  </tr>
                </thead>
                <tbody>
                  {an.component_analysis.map((c) => (
                    <tr key={c.component}>
                      <td style={{ fontWeight: 550 }}>{pretty(c.component)}</td>
                      <td className="num">{c.corrective_work_order_count}</td>
                      <td className="num">{c.issue_count}</td>
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

        {d.issue_matrix.years.length > 0 && (
          <div className="card" style={{ margin: 0 }}>
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
                Only one calendar year of evidence, so no trend is claimed.
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---------- 6. lifecycle and cost ---------- */}
      {a && (
        <div className="grid g2" style={{ marginTop: 14 }}>
          <div className="card" style={{ margin: 0 }}>
            <div className="card-title">Lifecycle</div>
            <LifecycleBar
              age={ageMetric}
              expectedLife={Number(inputs.expected_life_years) || 15}
              purchasedYear={String(an?.asset?.purchasedDate || "").slice(0, 4) || undefined}
            />
            <table style={{ marginTop: 10 }}>
              <tbody>
                <tr>
                  <td className="muted small">Expected service life</td>
                  <td className="num">
                    {inputs.expected_life_years}y{" "}
                    {baselines && <Provenance source={baselines.source} confidence={baselines.confidence?.life} />}
                  </td>
                </tr>
                <tr>
                  <td className="muted small">Criticality</td>
                  <td className="num">
                    {inputs.criticality}{" "}
                    {baselines && (
                      <Provenance source={baselines.source} confidence={baselines.confidence?.criticality} />
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="muted small">Warranty</td>
                  <td className="num">
                    {a.warranty?.available ? (
                      <Pill tone={a.warranty.value === "active" ? "good" : "mute"}>
                        {a.warranty.value}
                        {inputs.warranty_expiry ? ` ${inputs.warranty_expiry}` : ""}
                      </Pill>
                    ) : (
                      <span className="muted">not recorded</span>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="card" style={{ margin: 0 }}>
            <div className="card-title">Cost basis</div>
            <table>
              <tbody>
                <tr>
                  <td className="muted small">Corrective spend, last 3 years</td>
                  <td className="num">{inr(a.repair_spend)}</td>
                </tr>
                <tr>
                  <td className="muted small">Estimated replacement</td>
                  <td className="num">
                    {inr(a.replacement_cost)}{" "}
                    {baselines && (
                      <Provenance source={baselines.source} confidence={baselines.confidence?.replacement} />
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="muted small">CAPEX priority</td>
                  <td className="num">
                    {a.capex_priority === "-" ? (
                      <span className="muted">none</span>
                    ) : (
                      <Pill tone={a.capex_priority === "P1" ? "crit" : "bad"}>{a.capex_priority}</Pill>
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="banner info" style={{ marginTop: 10 }}>
              <span>
                {ev?.cost_basis}. This Facilio org holds no work-order cost fields, so figures come from{" "}
                <a href="#/settings">Settings</a> and improve automatically once costs are logged in Facilio.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ---------- 7. why: every number traceable ---------- */}
      {a && ev && (
        <div className="card" style={{ marginTop: 14 }}>
          <div className="card-title">Why — how each number was derived</div>
          {ev.risk_terms && ev.risk_terms.length > 0 && (
            <div className="tbl-wrap" style={{ marginBottom: 12 }}>
              <table>
                <thead>
                  <tr>
                    <th>Risk term</th>
                    <th className="num">Weight</th>
                    <th className="num">Factor</th>
                    <th className="num">Contribution</th>
                  </tr>
                </thead>
                <tbody>
                  {ev.risk_terms.map((t) => (
                    <tr key={t.name}>
                      <td>{pretty(t.name)}</td>
                      <td className="num">{t.weight}</td>
                      <td className="num">{t.factor}</td>
                      <td className="num" style={{ fontWeight: 650 }}>
                        {t.contribution}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} style={{ fontWeight: 650 }}>
                      Risk score
                    </td>
                    <td className="num" style={{ fontWeight: 700 }}>
                      {a.risk_score}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {ev.risk_terms_excluded && ev.risk_terms_excluded.length > 0 && (
            <div className="muted small" style={{ marginBottom: 10 }}>
              Excluded and reweighted so the remaining terms still total 100:{" "}
              {ev.risk_terms_excluded.join("; ")}.
            </div>
          )}
          <div className="small muted mono" style={{ lineHeight: 1.9 }}>
            {Object.entries(ev.formulas || {}).map(([k, v]) => (
              <div key={k}>
                {k}: {v}
              </div>
            ))}
          </div>

          <details className="sec" style={{ marginTop: 12 }}>
            <summary>Work orders behind this assessment ({d.findings.length} findings)</summary>
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Work order</th>
                    <th>Issue</th>
                    <th>Component</th>
                    <th>Severity</th>
                    <th className="num">Conf.</th>
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

      {/* ---------- 8. evidence quality and gaps ---------- */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-title">Evidence and data quality</div>
        <div className="grid g4">
          <div className="kpi">
            <div className="n">{scope?.corrective_work_orders_analyzed ?? a?.corrective_wo_count ?? 0}</div>
            <div className="l">Corrective work orders</div>
          </div>
          <div className="kpi">
            <div className="n">{scope?.photos_analyzed ?? 0}</div>
            <div className="l">Before photos analysed</div>
          </div>
          <div className="kpi">
            <div className="n">{photoFindings.length}</div>
            <div className="l">Photo-backed findings</div>
          </div>
          <div className="kpi">
            <div className="n">{textFindings.length}</div>
            <div className="l">Text-derived findings</div>
          </div>
        </div>

        {a?.unavailable && a.unavailable.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <GapList items={a.unavailable} title="Could not be computed" />
          </div>
        )}

        {mismatches.length > 0 && (
          <div className="banner info" style={{ marginTop: 12 }}>
            <span>
              <b>The engine corrected the photo agent's counts.</b>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {mismatches.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </span>
          </div>
        )}

        {lock && !lock.accepted && (
          <div className="banner warn" style={{ marginTop: 12 }}>
            <span>
              The written explanation was rejected because it contained figures absent from its input:{" "}
              {lock.unseen_figures.join(", ")}.
            </span>
          </div>
        )}
      </div>
    </>
  );
}
