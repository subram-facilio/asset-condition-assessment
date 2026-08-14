import { useEffect, useState } from "react";
import { fn, inr, runAgent } from "../lib/vibe";
import type { BaselineRow } from "../lib/types";
import { Empty, Pill, Provenance } from "../lib/ui";

/**
 * Baselines review — not data entry.
 *
 * Facilio holds no field for expected life, criticality, repair cost or replacement
 * cost, so the asset-baseline agent estimates them per category. This page shows what
 * it produced, on what basis, and how confident it is, and lets a human override any
 * field. Real costs from Facilio supersede both automatically.
 */
export function Settings() {
  const [rows, setRows] = useState<BaselineRow[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<BaselineRow>>({});

  useEffect(() => {
    load();
  }, []);

  function load() {
    fn<{ baselines: BaselineRow[] }>("baselines")
      .then((r) => setRows(r.baselines))
      .catch((e) => setError(String(e?.message || e)));
    fn<{ assets: Array<{ category: string }> }>("assets", { pageSize: 200 })
      .then((r) => {
        const seen: string[] = [];
        for (const a of r.assets) if (a.category && seen.indexOf(a.category) === -1) seen.push(a.category);
        setCategories(seen.sort());
      })
      .catch(() => {});
  }

  /** Ask the agent for one category's baselines. Cached results are reused. */
  async function estimate(category: string, force = false) {
    setBusy(category);
    setError("");
    try {
      const prep = await fn<{ cached: boolean; input: string }>("baseline-input", {
        category,
        force: force ? 1 : 0,
      });
      if (prep.cached && !force) {
        setBusy("");
        return;
      }
      const reply = await runAgent<unknown>(prep.input, undefined, "asset-baseline");
      await fn("save-baselines", { category, reply: JSON.stringify(reply) });
      load();
    } catch (e: any) {
      setError(`Could not estimate ${category}: ${String(e?.message || e)}`);
    } finally {
      setBusy("");
    }
  }

  async function estimateMissing() {
    const have = (rows || []).map((r) => r.category);
    for (const c of categories) {
      if (have.indexOf(c) === -1) await estimate(c);
    }
  }

  async function saveOverride(category: string) {
    setBusy(category);
    try {
      await fn("set-baseline-override", {
        category,
        expectedLifeYears: Number(draft.expected_life_years),
        avgRepairCost: Number(draft.avg_repair_cost),
        replacementCost: Number(draft.replacement_cost),
        criticality: String(draft.criticality || "medium"),
      });
      setEditing(null);
      setDraft({});
      load();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy("");
    }
  }

  if (error && !rows) return <div className="banner bad">Could not load settings: {error}</div>;
  if (!rows) return <Empty>Loading baselines…</Empty>;

  const missing = categories.filter((c) => rows.every((r) => r.category !== c));

  return (
    <>
      <div className="row spread" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>Baselines</h1>
          <div className="muted small">
            Expected life, criticality and cost per asset category — the four values Facilio has no field for.
          </div>
        </div>
        {missing.length > 0 && (
          <button className="btn primary" disabled={!!busy} onClick={estimateMissing}>
            {busy ? `Estimating ${busy}…` : `Estimate ${missing.length} missing`}
          </button>
        )}
      </div>

      <div className="banner info" style={{ marginBottom: 14 }}>
        <span>
          Nothing here needs filling in. These are AI-estimated reference values, each with its basis and a confidence
          score. Cost figures are deliberately low-confidence because no rate card is available — real costs logged in
          Facilio replace them automatically, and a manual override beats both.
        </span>
      </div>

      {error && (
        <div className="banner bad" style={{ marginBottom: 14 }}>
          {error}
        </div>
      )}

      {rows.length === 0 && (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            No baselines estimated yet. {missing.length > 0 ? "Use the button above to generate them." : ""}
          </p>
        </div>
      )}

      {rows.map((r) => {
        const lowCost = r.confidence.repair < 0.6 || r.confidence.replacement < 0.6;
        const isEditing = editing === r.category;
        return (
          <div className="card" key={r.category}>
            <div className="row spread" style={{ marginBottom: 10 }}>
              <div className="row">
                <span style={{ fontSize: 16, fontWeight: 650 }}>{r.category}</span>
                <Provenance source={r.source} />
                {r.source === "override" && <Pill tone="good">manually set</Pill>}
                {lowCost && r.source === "ai_estimate" && <Pill tone="warn">cost figures are indicative</Pill>}
              </div>
              <div className="row">
                {!isEditing && (
                  <>
                    <button
                      className="btn sm"
                      onClick={() => {
                        setEditing(r.category);
                        setDraft(r);
                      }}
                    >
                      Override
                    </button>
                    <button className="btn sm" disabled={!!busy} onClick={() => estimate(r.category, true)}>
                      {busy === r.category ? "Estimating…" : "Re-estimate"}
                    </button>
                  </>
                )}
                {isEditing && (
                  <>
                    <button className="btn sm primary" disabled={!!busy} onClick={() => saveOverride(r.category)}>
                      {busy === r.category ? "Saving…" : "Save override"}
                    </button>
                    <button
                      className="btn sm"
                      onClick={() => {
                        setEditing(null);
                        setDraft({});
                      }}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="tbl-wrap">
              <table>
                <tbody>
                  <Field
                    label="Expected service life"
                    value={`${r.expected_life_years} years`}
                    confidence={r.confidence.life}
                    source={r.source}
                    basis={r.basis.expected_life_years}
                    assumptions={r.assumptions.expected_life_years}
                    editing={isEditing}
                    input={
                      <input
                        type="number"
                        value={String(draft.expected_life_years ?? r.expected_life_years)}
                        onChange={(e) => setDraft({ ...draft, expected_life_years: Number(e.target.value) })}
                        style={{ width: 90, textAlign: "right" }}
                      />
                    }
                  />
                  <Field
                    label="Criticality"
                    value={r.criticality}
                    confidence={r.confidence.criticality}
                    source={r.source}
                    basis={r.basis.criticality}
                    assumptions={r.assumptions.criticality}
                    editing={isEditing}
                    input={
                      <select
                        value={String(draft.criticality ?? r.criticality)}
                        onChange={(e) => setDraft({ ...draft, criticality: e.target.value })}
                      >
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                      </select>
                    }
                  />
                  <Field
                    label="Average repair cost"
                    value={inr(r.avg_repair_cost)}
                    confidence={r.confidence.repair}
                    source={r.source}
                    basis={r.basis.avg_repair_cost}
                    assumptions={r.assumptions.avg_repair_cost}
                    editing={isEditing}
                    input={
                      <input
                        type="number"
                        value={String(draft.avg_repair_cost ?? r.avg_repair_cost)}
                        onChange={(e) => setDraft({ ...draft, avg_repair_cost: Number(e.target.value) })}
                        style={{ width: 130, textAlign: "right" }}
                      />
                    }
                  />
                  <Field
                    label="Replacement cost"
                    value={inr(r.replacement_cost)}
                    confidence={r.confidence.replacement}
                    source={r.source}
                    basis={r.basis.replacement_cost}
                    assumptions={r.assumptions.replacement_cost}
                    extra={
                      typeof r.basis.capacity_inferred === "string" && r.basis.capacity_inferred
                        ? `capacity inferred from the model: ${r.basis.capacity_inferred}`
                        : ""
                    }
                    editing={isEditing}
                    input={
                      <input
                        type="number"
                        value={String(draft.replacement_cost ?? r.replacement_cost)}
                        onChange={(e) => setDraft({ ...draft, replacement_cost: Number(e.target.value) })}
                        style={{ width: 150, textAlign: "right" }}
                      />
                    }
                  />
                </tbody>
              </table>
            </div>
            {r.estimated_at && (
              <div className="muted small" style={{ marginTop: 8 }}>
                {r.source === "override" ? "Overridden" : "Estimated"} {r.estimated_at.slice(0, 10)}. Changes apply on
                the next assessment.
              </div>
            )}
          </div>
        );
      })}

      <div className="card">
        <div className="card-title">How these are used</div>
        <div className="small muted mono" style={{ lineHeight: 1.9 }}>
          <div>RUL = max(expected_life − age, 0) × condition factor × (accelerating ? 0.7 : 1)</div>
          <div>risk includes 20 parts criticality, reweighted when a term is unavailable</div>
          <div>repair spend = corrective WOs in the last 3 years × average repair cost</div>
          <div>an in-warranty asset is never recommended for replacement</div>
        </div>
      </div>
    </>
  );
}

function Field({
  label,
  value,
  confidence,
  source,
  basis,
  assumptions,
  extra,
  editing,
  input,
}: {
  label: string;
  value: string;
  confidence: number;
  source: string;
  basis?: string[] | string;
  assumptions?: string[];
  extra?: string;
  editing?: boolean;
  input?: React.ReactNode;
}) {
  const basisList = Array.isArray(basis) ? basis : basis ? [basis] : [];
  return (
    <tr>
      <td style={{ width: 190 }}>
        <div style={{ fontWeight: 550 }}>{label}</div>
        {basisList.length > 0 && (
          <div className="muted small" style={{ marginTop: 3 }}>
            {basisList.join(" · ")}
          </div>
        )}
        {assumptions && assumptions.length > 0 && (
          <div className="muted small" style={{ marginTop: 2, fontStyle: "italic" }}>
            assumes {assumptions.join("; ")}
          </div>
        )}
        {extra && (
          <div className="muted small" style={{ marginTop: 2 }}>
            {extra}
          </div>
        )}
      </td>
      <td className="num" style={{ verticalAlign: "top", whiteSpace: "nowrap" }}>
        {editing && input ? input : <span style={{ fontWeight: 650 }}>{value}</span>}
      </td>
      <td style={{ verticalAlign: "top", width: 1 }}>
        <Provenance source={source} confidence={confidence} />
      </td>
    </tr>
  );
}
