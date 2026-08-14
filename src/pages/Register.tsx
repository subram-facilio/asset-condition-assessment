import { useEffect, useMemo, useState } from "react";
import { fn, inr } from "../lib/vibe";
import type { Assessment } from "../lib/types";
import { Empty, Pill, gradeTone, pretty, recommendationTone, riskTone } from "../lib/ui";

type SortKey = "risk_score" | "score" | "rul_years" | "asset_name" | "dominant_recurrence_pct";

export function Register() {
  const [rows, setRows] = useState<Assessment[] | null>(null);
  const [error, setError] = useState("");
  const [sort, setSort] = useState<SortKey>("risk_score");
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    fn<{ register: Assessment[] }>("register")
      .then((r) => setRows(r.register))
      .catch((e) => setError(String(e?.message || e)));
  }, []);

  const view = useMemo(() => {
    if (!rows) return [];
    const f =
      filter === "all"
        ? rows
        : filter === "photo"
        ? rows.filter((r) => r.visual_risk_level !== "unknown")
        : rows.filter((r) => r.recommendation === filter);
    return f.slice().sort((a: any, b: any) => {
      if (sort === "asset_name") return String(a.asset_name).localeCompare(String(b.asset_name));
      if (sort === "rul_years") return a.rul_years - b.rul_years;
      return b[sort] - a[sort];
    });
  }, [rows, sort, filter]);

  if (error) return <div className="banner bad">Could not load the register: {error}</div>;
  if (!rows) return <Empty>Loading the condition register…</Empty>;

  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Condition register</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        The continuously updated health record for every assessed asset. Re-running an assessment updates the row and
        appends to its history.
      </p>

      <div className="card">
        <div className="row spread" style={{ marginBottom: 12 }}>
          <div className="row">
            <span className="muted small">Show</span>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="all">All assets</option>
              <option value="REPLACE">Replace</option>
              <option value="REFURBISH">Refurbish</option>
              <option value="REPAIR">Repair</option>
              <option value="MONITOR">Monitor</option>
              <option value="photo">With photo-backed analysis</option>
            </select>
            <span className="muted small">Sort by</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
              <option value="risk_score">Risk (high first)</option>
              <option value="score">Condition (worst first)</option>
              <option value="rul_years">Remaining life (least first)</option>
              <option value="dominant_recurrence_pct">Recurrence (highest first)</option>
              <option value="asset_name">Asset name</option>
            </select>
          </div>
          <span className="muted small">
            {view.length} of {rows.length} assets
          </span>
        </div>

        {view.length === 0 ? (
          <div className="muted small">No asset matches this filter.</div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="num">Condition</th>
                  <th>Dominant issue</th>
                  <th className="num">Recurrence</th>
                  <th>Trend</th>
                  <th>Deterioration</th>
                  <th className="num">RUL</th>
                  <th>MTBF</th>
                  <th>Warranty</th>
                  <th className="num">Risk</th>
                  <th className="num">Repair spend</th>
                  <th className="num">Replacement</th>
                  <th>CAPEX</th>
                  <th>Recommendation</th>
                </tr>
              </thead>
              <tbody>
                {view.map((r) => (
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
                    <td className="small">{r.dominant_issue_label || "—"}</td>
                    <td className="num">{r.dominant_recurrence_pct}%</td>
                    <td className="small muted">{pretty(r.trend_direction)}</td>
                    <td className="small muted">{pretty(r.deterioration)}</td>
                    <td className="num">{r.rul?.available === false ? <span className="muted">n/a</span> : `${r.rul_years}y`}</td>
                    <td className="small">
                      {(() => {
                        const m = r.dominant_issue_mtbf?.mean_months ?? r.mtbf?.mean_months;
                        const v = r.dominant_issue_mtbf?.verdict ?? r.mtbf?.verdict;
                        if (!m?.available || m.value === null) return <span className="muted">—</span>;
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
                      })()}
                    </td>
                    <td className="small">
                      {r.warranty?.available ? (
                        <Pill tone={r.warranty.value === "active" ? "good" : "mute"}>{r.warranty.value}</Pill>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="num">
                      <Pill tone={riskTone(r.risk_level)}>{r.risk_score}</Pill>
                    </td>
                    <td className="num">{inr(r.repair_spend)}</td>
                    <td className="num">{inr(r.replacement_cost)}</td>
                    <td>
                      {r.capex_priority === "-" ? (
                        <span className="muted">—</span>
                      ) : (
                        <Pill tone={r.capex_priority === "P1" ? "crit" : r.capex_priority === "P2" ? "bad" : "warn"}>
                          {r.capex_priority}
                        </Pill>
                      )}
                    </td>
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
    </>
  );
}
