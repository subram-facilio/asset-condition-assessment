import { useEffect, useState } from "react";
import { fn, inr } from "../lib/vibe";
import type { Assessment } from "../lib/types";
import { Empty, Pill, gradeTone, recommendationTone, riskTone } from "../lib/ui";

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

const GRADES = [
  { key: "GOOD", label: "Good", color: "var(--good)" },
  { key: "FAIR", label: "Fair", color: "var(--warn)" },
  { key: "AVERAGE", label: "Average", color: "#d98324" },
  { key: "POOR", label: "Poor", color: "var(--bad)" },
  { key: "CRITICAL", label: "Critical", color: "var(--crit)" },
];

/** The portfolio view: how many need attention, how badly, and which first. */
export function Dashboard() {
  const [data, setData] = useState<RegisterData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fn<RegisterData>("register")
      .then(setData)
      .catch((e) => setError(String(e?.message || e)));
  }, []);

  if (error) return <div className="banner bad">Could not load the condition register: {error}</div>;
  if (!data) return <Empty>Loading the condition register…</Empty>;

  const { kpis, register } = data;

  if (register.length === 0) {
    return (
      <>
        <h1 style={{ marginBottom: 6 }}>Condition Assessment</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Nothing assessed yet. Every assessment reads live corrective-maintenance history from Facilio — no
          questionnaires, no manual condition input.
        </p>
        <div className="card">
          <div className="card-title">Get started</div>
          <p style={{ marginTop: 0 }}>
            Open <a href="#/run">Run assessment</a>, pick an asset, and watch the pipeline work through its corrective
            work orders and before-maintenance photos.
          </p>
        </div>
      </>
    );
  }

  const accelerating = register.filter((r) => r.deterioration === "accelerating").length;
  const capexQueue = register
    .filter((r) => r.capex_priority !== "-")
    .sort((a, b) => a.capex_priority.localeCompare(b.capex_priority) || b.risk_score - a.risk_score);
  const gradeCounts = GRADES.map((g) => ({ ...g, n: register.filter((r) => r.grade === g.key).length }));
  const maxGrade = Math.max(...gradeCounts.map((g) => g.n), 1);

  return (
    <>
      <div className="row spread" style={{ marginBottom: 16 }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>Portfolio condition</h1>
          <div className="muted small">
            {kpis.assets_assessed} asset{kpis.assets_assessed === 1 ? "" : "s"} assessed from live Facilio corrective
            history
          </div>
        </div>
        <a className="btn primary" href="#/run">
          Run assessment
        </a>
      </div>

      <div className="grid g4">
        <div className="kpi">
          <div className="n">{kpis.assets_assessed}</div>
          <div className="l">Assets analysed</div>
        </div>
        <div className="kpi">
          <div className="n" style={{ color: kpis.high_risk ? "var(--bad)" : undefined }}>
            {kpis.high_risk}
          </div>
          <div className="l">High risk</div>
        </div>
        <div className="kpi">
          <div className="n" style={{ color: accelerating ? "var(--bad)" : undefined }}>
            {accelerating}
          </div>
          <div className="l">Accelerating decay</div>
        </div>
        <div className="kpi">
          <div className="n" style={{ color: kpis.replace_count ? "var(--crit)" : undefined }}>
            {kpis.replace_count}
          </div>
          <div className="l">Replace</div>
        </div>
      </div>

      <div className="grid g2" style={{ marginTop: 14 }}>
        <div className="card" style={{ margin: 0 }}>
          <div className="card-title">Asset health overview</div>
          {gradeCounts.map((g) => (
            <div className="dist-row" key={g.key}>
              <span className="small" style={{ color: g.color, fontWeight: 600 }}>
                {g.label}
              </span>
              <span className="dist-bar">
                <i style={{ width: `${(g.n / maxGrade) * 100}%`, background: g.color }} />
              </span>
              <span className="dist-n">{g.n}</span>
            </div>
          ))}
          <div className="muted small" style={{ marginTop: 8 }}>
            Condition runs 1 (best) to 5 (worst); portfolio average {kpis.avg_score.toFixed(2)}.
          </div>
        </div>

        <div className="card" style={{ margin: 0 }}>
          <div className="card-title">Risk against condition</div>
          <RiskMatrix rows={register} />
        </div>
      </div>

      <div className="grid g2" style={{ marginTop: 14 }}>
        <div className="card" style={{ margin: 0 }}>
          <div className="card-title">Recommendations</div>
          <table>
            <tbody>
              {[
                ["REPLACE", kpis.replace_count],
                ["REFURBISH", kpis.refurbish_count],
                ["REPAIR", kpis.repair_count],
                ["MONITOR", kpis.monitor_count],
              ].map(([label, count]) => (
                <tr key={String(label)}>
                  <td>
                    <Pill tone={recommendationTone(String(label))}>{String(label)}</Pill>
                  </td>
                  <td className="num" style={{ fontWeight: 650, width: 40 }}>
                    {count as number}
                  </td>
                  <td>
                    <div className="bar" style={{ margin: 0, minWidth: 80 }}>
                      <i
                        style={{
                          width: `${kpis.assets_assessed ? ((count as number) / kpis.assets_assessed) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted small" style={{ marginTop: 10 }}>
            Decided by rule from condition, risk and remaining life — not by a language model.
          </div>
        </div>

        <div className="card" style={{ margin: 0 }}>
          <div className="card-title">CAPEX queue</div>
          {capexQueue.length === 0 ? (
            <div className="muted small">No asset currently warrants capital planning.</div>
          ) : (
            <div className="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Priority</th>
                    <th>Asset</th>
                    <th className="num">Replacement</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {capexQueue.slice(0, 6).map((r) => (
                    <tr key={r.asset_id}>
                      <td>
                        <Pill tone={r.capex_priority === "P1" ? "crit" : r.capex_priority === "P2" ? "bad" : "warn"}>
                          {r.capex_priority}
                        </Pill>
                      </td>
                      <td>
                        <a href={`#/asset/${r.asset_id}`}>{r.asset_name}</a>
                      </td>
                      <td className="num">{inr(r.replacement_cost)}</td>
                      <td>
                        <Pill tone={recommendationTone(r.recommendation)}>{r.recommendation}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="muted small" style={{ marginTop: 10 }}>
            Cost figures are AI-estimated reference rates — see <a href="#/settings">Settings</a>.
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-title">Condition ranking</div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th className="num">Condition</th>
                <th className="num">Risk</th>
                <th className="num">RUL</th>
                <th>MTBF</th>
                <th>Deterioration</th>
                <th>Dominant issue</th>
                <th>Recommendation</th>
              </tr>
            </thead>
            <tbody>
              {register.map((r) => (
                <tr key={r.asset_id}>
                  <td>
                    <a href={`#/asset/${r.asset_id}`}>{r.asset_name}</a>
                    <div className="muted small">
                      {r.category} · {r.corrective_wo_count} corrective WOs
                    </div>
                  </td>
                  <td className="num">
                    {r.score.toFixed(2)} <Pill tone={gradeTone(r.grade)}>{r.grade}</Pill>
                  </td>
                  <td className="num">
                    <Pill tone={riskTone(r.risk_level)}>{r.risk_score}</Pill>
                  </td>
                  <td className="num">{r.rul_years}y</td>
                  <td className="small">
                    <MtbfCell row={r} />
                  </td>
                  <td className="small">
                    {r.deterioration === "accelerating" ? (
                      <span style={{ color: "var(--bad)", fontWeight: 600 }}>↑ accelerating</span>
                    ) : r.deterioration === "improving" ? (
                      <span style={{ color: "var(--good)" }}>↓ improving</span>
                    ) : (
                      <span className="muted">→ steady</span>
                    )}
                  </td>
                  <td className="small">
                    {r.dominant_issue_label || "—"}
                    {r.dominant_recurrence_pct ? (
                      <span className="muted"> {r.dominant_recurrence_pct}%</span>
                    ) : null}
                  </td>
                  <td>
                    <Pill tone={recommendationTone(r.recommendation)}>{r.recommendation}</Pill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/** MTBF summary for the ranking table, honest when it cannot be computed. */
function MtbfCell({ row }: { row: Assessment }) {
  const m = row.dominant_issue_mtbf?.mean_months ?? row.mtbf?.mean_months;
  const v = row.dominant_issue_mtbf?.verdict ?? row.mtbf?.verdict;
  if (!m?.available || m.value === null) {
    return <span className="muted">—</span>;
  }
  return (
    <>
      {m.value}mo{" "}
      {v?.available && v.value === "contracting" ? (
        <span style={{ color: "var(--bad)", fontWeight: 700 }}>↓</span>
      ) : v?.available && v.value === "lengthening" ? (
        <span style={{ color: "var(--good)" }}>↑</span>
      ) : (
        <span className="muted">→</span>
      )}
    </>
  );
}

/**
 * Risk against condition. Both axes are computed, so clusters in the top-right are
 * the assets that genuinely need capital planning.
 */
function RiskMatrix({ rows }: { rows: Assessment[] }) {
  if (rows.length === 0) return <div className="muted small">Nothing to plot yet.</div>;
  const tone = (r: Assessment) =>
    r.risk_level === "HIGH" ? "var(--bad)" : r.risk_level === "MEDIUM" ? "var(--warn)" : "var(--good)";
  return (
    <>
      <div className="matrix-plot">
        {[100, 75, 50, 25, 0].map((y) => (
          <span className="matrix-ylab" key={y} style={{ bottom: `${y}%` }}>
            {y}
          </span>
        ))}
        {rows.map((r) => {
          // Condition 1..5 across, risk 0..100 up.
          const x = ((r.score - 1) / 4) * 100;
          const y = r.risk_score;
          return (
            <a
              className="matrix-dot"
              key={r.asset_id}
              href={`#/asset/${r.asset_id}`}
              title={`${r.asset_name} — condition ${r.score}, risk ${r.risk_score}`}
              style={{ left: `${Math.min(Math.max(x, 2), 98)}%`, bottom: `${Math.min(y, 97)}%`, background: tone(r) }}
            >
              {r.risk_level === "HIGH" && <span>{r.asset_name}</span>}
            </a>
          );
        })}
      </div>
      <div className="matrix-xaxis">
        <span>Good</span>
        <span>Fair</span>
        <span>Average</span>
        <span>Poor</span>
      </div>
      <div className="muted small" style={{ marginTop: 8 }}>
        Risk (0–100) against condition (1–5). High-risk assets are labelled.
      </div>
    </>
  );
}
