import { useEffect, useState } from "react";
import { fn } from "../lib/vibe";
import { Empty } from "../lib/ui";

interface Cfg {
  category: string;
  expected_life_years: number;
  avg_repair_cost: number;
  replacement_cost: number;
  criticality: string;
}

/**
 * The approved cost database. Remaining-life and CAPEX read these values
 * instead of inventing costs, so they are the customer's numbers to own.
 */
export function Settings() {
  const [rows, setRows] = useState<Cfg[] | null>(null);
  const [saving, setSaving] = useState("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    load();
  }, []);

  function load() {
    fn<{ config: Cfg[] }>("cost-config")
      .then((r) => setRows(r.config))
      .catch((e) => setError(String(e?.message || e)));
  }

  function edit(i: number, patch: Partial<Cfg>) {
    setRows((prev) => (prev ? prev.map((r, k) => (k === i ? { ...r, ...patch } : r)) : prev));
  }

  async function save(row: Cfg) {
    setSaving(row.category);
    setSaved("");
    setError("");
    try {
      await fn("set-cost-config", {
        category: row.category,
        expectedLifeYears: row.expected_life_years,
        avgRepairCost: row.avg_repair_cost,
        replacementCost: row.replacement_cost,
        criticality: row.criticality,
      });
      setSaved(row.category);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setSaving("");
    }
  }

  if (error && !rows) return <div className="banner bad">Could not load settings: {error}</div>;
  if (!rows) return <Empty>Loading cost configuration…</Empty>;

  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Settings</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Expected life, repair and replacement costs per asset category. These are the only cost inputs in the system.
      </p>

      <div className="banner info" style={{ marginBottom: 14 }}>
        <span>
          This Facilio org exposes no cost fields on work orders and no criticality field on assets, so rather than
          fabricate figures the engines read these configured values — and every cost shown in the app is labelled as
          estimated from them. Changes apply on the next assessment.
        </span>
      </div>

      <div className="card">
        <div className="card-title">Cost and lifecycle configuration</div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Expected life (years)</th>
                <th className="num">Avg repair cost (₹)</th>
                <th className="num">Replacement cost (₹)</th>
                <th>Criticality</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.category}>
                  <td style={{ fontWeight: 600 }}>
                    {r.category}
                    {r.category === "DEFAULT" && <div className="muted small">used when a category has no row</div>}
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      value={r.expected_life_years}
                      onChange={(e) => edit(i, { expected_life_years: Number(e.target.value) })}
                      style={{ width: 80, textAlign: "right" }}
                    />
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      value={r.avg_repair_cost}
                      onChange={(e) => edit(i, { avg_repair_cost: Number(e.target.value) })}
                      style={{ width: 110, textAlign: "right" }}
                    />
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      value={r.replacement_cost}
                      onChange={(e) => edit(i, { replacement_cost: Number(e.target.value) })}
                      style={{ width: 130, textAlign: "right" }}
                    />
                  </td>
                  <td>
                    <select value={r.criticality} onChange={(e) => edit(i, { criticality: e.target.value })}>
                      <option value="low">low</option>
                      <option value="medium">medium</option>
                      <option value="high">high</option>
                    </select>
                  </td>
                  <td>
                    <button className="btn sm" disabled={saving === r.category} onClick={() => save(r)}>
                      {saving === r.category ? "Saving…" : saved === r.category ? "Saved ✓" : "Save"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error && (
          <div className="banner bad" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">How the engines use these</div>
        <div className="small muted mono" style={{ lineHeight: 1.9 }}>
          <div>baseline RUL = max(expected_life − asset age from purchase date, 0)</div>
          <div>RUL = baseline × condition factor × (deterioration accelerating ? 0.7 : 1)</div>
          <div>repair spend = corrective WOs in last 3 years × avg repair cost</div>
          <div>risk = 30×(condition/5) + 20×criticality + 15×recurrence + 15×trend + 20×remaining-life factor</div>
        </div>
      </div>
    </>
  );
}
