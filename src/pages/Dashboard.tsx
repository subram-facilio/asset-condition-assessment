import { useEffect, useState } from "react";
import { fn, inr } from "../lib/vibe";
import type { Assessment } from "../lib/types";
import { Empty, Pill, gradeTone, pretty, recommendationTone, riskTone } from "../lib/ui";

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
    total_capex_exposure: number;
    total_repair_spend: number;
    avg_score: number;
  };
  register: Assessment[];
}

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

  const capexQueue = register
    .filter((r) => r.capex_priority !== "-")
    .sort((a, b) => a.capex_priority.localeCompare(b.capex_priority) || b.risk_score - a.risk_score);

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
          <div className="n" style={{ color: kpis.high_risk ? "var(--bad)" : undefined }}>
            {kpis.high_risk}
          </div>
          <div className="l">High risk assets</div>
        </div>
        <div className="kpi">
          <div className="n">{kpis.avg_score.toFixed(2)}</div>
          <div className="l">Average condition (1 best – 5 worst)</div>
        </div>
        <div className="kpi">
          <div className="n" style={{ color: kpis.p1_count ? "var(--crit)" : undefined }}>
            {kpis.p1_count}
          </div>
          <div className="l">P1 CAPEX priorities</div>
        </div>
        <div className="kpi">
          <div className="n">{inr(kpis.total_capex_exposure)}</div>
          <div className="l">Replace / refurbish exposure</div>
        </div>
      </div>

      <div className="grid g2" style={{ marginTop: 14 }}>
        <div className="card">
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
                  <td className="num" style={{ fontWeight: 650 }}>
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
            Derived by rule from condition, risk and remaining life — not by an LLM.
          </div>
        </div>

        <div className="card">
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
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-title">Assets by risk</div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Asset</th>
                <th>Category</th>
                <th className="num">Condition</th>
                <th>Grade</th>
                <th className="num">Risk</th>
                <th>Dominant issue</th>
                <th className="num">Recurrence</th>
                <th>Trend</th>
                <th className="num">RUL</th>
                <th>Recommendation</th>
              </tr>
            </thead>
            <tbody>
              {register.map((r) => (
                <tr key={r.asset_id}>
                  <td>
                    <a href={`#/asset/${r.asset_id}`}>{r.asset_name}</a>
                    <div className="muted small">{r.corrective_wo_count} corrective WOs</div>
                  </td>
                  <td className="small">{r.category}</td>
                  <td className="num">{r.score.toFixed(2)}</td>
                  <td>
                    <Pill tone={gradeTone(r.grade)}>{r.grade}</Pill>
                  </td>
                  <td className="num">
                    <Pill tone={riskTone(r.risk_level)}>{r.risk_score}</Pill>
                  </td>
                  <td className="small">{r.dominant_issue_label || "—"}</td>
                  <td className="num">{r.dominant_recurrence_pct}%</td>
                  <td className="small muted">{pretty(r.trend_direction)}</td>
                  <td className="num">{r.rul_years}y</td>
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
