import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { FButton, FText } from "@facilio/dsm-react-wrapper";
import { fn, inr, runAgent } from "../lib/vibe";
import type { BaselineRow } from "../lib/types";
import { Empty, ErrorBanner, Provenance } from "../lib/ui";
import { PageShell } from "../components/PageShell";
import { Card, CardTitle } from "../components/Card";
import { StatusTag } from "../components/StatusTag";
import { EmptyState } from "../components/EmptyState";

/**
 * Baselines review — not data entry.
 *
 * Facilio holds no field for expected life, criticality, repair cost or replacement cost, so the
 * asset-baseline agent estimates them per category. This page shows what it produced, on what
 * basis, and how confident it is, and lets a human override any field. Real costs from Facilio
 * supersede both automatically.
 *
 * Laid out on {@link PageShell} rather than the list archetype: there are only ever a handful of
 * categories, and each one is a block of prose-plus-numbers to read, not a row to scan.
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

  if (error && !rows) {
    return (
      <PageShell title="Baselines">
        <ErrorBanner>Could not load baselines: {error}</ErrorBanner>
      </PageShell>
    );
  }
  if (!rows) return <Empty>Loading baselines…</Empty>;

  const missing = categories.filter((c) => rows.every((r) => r.category !== c));

  return (
    <PageShell
      title="Baselines"
      subtitle="Expected life, criticality and cost per asset category — the four values Facilio has no field for."
      action={
        missing.length > 0 ? (
          <FButton appearance="primary" size="medium" disabled={!!busy} onButtonClick={estimateMissing}>
            {busy ? `Estimating ${busy}…` : `Estimate ${missing.length} missing`}
          </FButton>
        ) : undefined
      }
    >
      <Card>
        <FText appearance="bodyReg14" styleProps={{ color: "textDescription", display: "block" }}>
          Nothing here needs filling in. These are AI-estimated reference values, each with its basis
          and a confidence score. Cost figures are deliberately low-confidence because no rate card is
          available — real costs logged in Facilio replace them automatically, and a manual override
          beats both.
        </FText>
      </Card>

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {rows.length === 0 ? (
        <EmptyState
          icon={{ group: "setup", name: "customisation" }}
          title="No baselines estimated yet"
          description={
            missing.length > 0
              ? `${missing.length} asset ${missing.length === 1 ? "category" : "categories"} are waiting for an estimate.`
              : "Assess an asset first — categories appear here once there is something to baseline."
          }
        />
      ) : (
        rows.map((r) => {
          const lowCost = r.confidence.repair < 0.6 || r.confidence.replacement < 0.6;
          const isEditing = editing === r.category;

          return (
            <Card key={r.category} style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
              <CardTitle
                action={
                  <div style={{ display: "flex", gap: "var(--spacing-container-large)", flexShrink: 0 }}>
                    {isEditing ? (
                      <>
                        <FButton
                          appearance="primary"
                          size="medium"
                          disabled={!!busy}
                          onButtonClick={() => saveOverride(r.category)}
                        >
                          {busy === r.category ? "Saving…" : "Save override"}
                        </FButton>
                        <FButton
                          appearance="secondary"
                          size="medium"
                          onButtonClick={() => {
                            setEditing(null);
                            setDraft({});
                          }}
                        >
                          Cancel
                        </FButton>
                      </>
                    ) : (
                      <>
                        <FButton
                          appearance="secondary"
                          size="medium"
                          onButtonClick={() => {
                            setEditing(r.category);
                            setDraft(r);
                          }}
                        >
                          Override
                        </FButton>
                        <FButton
                          appearance="secondary"
                          size="medium"
                          disabled={!!busy}
                          onButtonClick={() => estimate(r.category, true)}
                        >
                          {busy === r.category ? "Estimating…" : "Re-estimate"}
                        </FButton>
                      </>
                    )}
                  </div>
                }
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "var(--spacing-container-large)",
                    flexWrap: "wrap",
                  }}
                >
                  {r.category}
                  <Provenance source={r.source} />
                  {r.source === "override" && <StatusTag tone="good">manually set</StatusTag>}
                  {lowCost && r.source === "ai_estimate" && (
                    <StatusTag tone="warn">cost figures are indicative</StatusTag>
                  )}
                </span>
              </CardTitle>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  borderRadius: "var(--border-medium)",
                  border: "1px solid var(--colors-border-neutral-base-subtler)",
                  backgroundColor: "var(--colors-background-container)",
                  overflow: "hidden",
                }}
              >
                <Field
                  label="Expected service life"
                  value={`${r.expected_life_years} years`}
                  confidence={r.confidence.life}
                  source={r.source}
                  basis={r.basis.expected_life_years}
                  assumptions={r.assumptions.expected_life_years}
                  editing={isEditing}
                  input={
                    <NumberInput
                      value={draft.expected_life_years ?? r.expected_life_years}
                      width={90}
                      onChange={(v) => setDraft({ ...draft, expected_life_years: v })}
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
                      className="ca-input"
                      value={String(draft.criticality ?? r.criticality)}
                      onChange={(e) => setDraft({ ...draft, criticality: e.target.value })}
                      style={FIELD_INPUT_STYLE}
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
                    <NumberInput
                      value={draft.avg_repair_cost ?? r.avg_repair_cost}
                      width={130}
                      onChange={(v) => setDraft({ ...draft, avg_repair_cost: v })}
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
                  last
                  input={
                    <NumberInput
                      value={draft.replacement_cost ?? r.replacement_cost}
                      width={150}
                      onChange={(v) => setDraft({ ...draft, replacement_cost: v })}
                    />
                  }
                />
              </div>

              {r.estimated_at && (
                <FText appearance="captionReg12" styleProps={{ color: "textCaption", display: "block" }}>
                  {r.source === "override" ? "Overridden" : "Estimated"} {r.estimated_at.slice(0, 10)}. Changes
                  apply on the next assessment.
                </FText>
              )}
            </Card>
          );
        })
      )}

      <Card>
        <CardTitle icon={{ group: "chart-data", name: "bar-graph" }}>How these are used</CardTitle>
        <div
          style={{
            marginTop: "var(--spacing-container-xlarge)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--spacing-container-large)",
            fontFamily: "var(--mono)",
            fontSize: 12,
            lineHeight: 1.6,
            color: "var(--colors-text-caption)",
          }}
        >
          <span>RUL = max(expected_life − age, 0) × condition factor × (accelerating ? 0.7 : 1)</span>
          <span>risk includes 20 parts criticality, reweighted when a term is unavailable</span>
          <span>repair spend = corrective WOs in the last 3 years × average repair cost</span>
          <span>an in-warranty asset is never recommended for replacement</span>
        </div>
      </Card>
    </PageShell>
  );
}

const FIELD_INPUT_STYLE: React.CSSProperties = {
  height: 32,
  padding: "0 var(--spacing-container-large)",
  borderRadius: "var(--border-medium)",
  border: "1px solid var(--colors-border-neutral-base-subtle)",
  backgroundColor: "var(--colors-background-container)",
  color: "var(--colors-text-main)",
  font: "var(--text-body-reg-14)",
  textAlign: "right",
  minWidth: 0,
};

function NumberInput({
  value,
  width,
  onChange,
}: {
  value: number;
  width: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      className="ca-input"
      type="number"
      value={String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ ...FIELD_INPUT_STYLE, width }}
    />
  );
}

/**
 * One baseline value: what it is and what it was reasoned from on the left, the figure on the
 * right, and how it was arrived at beside it. Rows are divided rather than spaced, so four of them
 * read as one table without needing a `<table>`.
 */
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
  last = false,
}: {
  label: string;
  value: string;
  confidence: number;
  source: string;
  basis?: string[] | string;
  assumptions?: string[];
  extra?: string;
  editing?: boolean;
  input?: ReactNode;
  last?: boolean;
}) {
  const basisList = Array.isArray(basis) ? basis : basis ? [basis] : [];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "var(--spacing-container-xlarge)",
        padding: "var(--spacing-container-xlarge)",
        borderBottom: last ? "none" : "1px solid var(--colors-border-neutral-base-subtler)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
        <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
          {label}
        </FText>
        {basisList.length > 0 && (
          <FText appearance="captionReg12" styleProps={{ color: "textCaption", display: "block" }}>
            {basisList.join(" · ")}
          </FText>
        )}
        {assumptions && assumptions.length > 0 && (
          <span
            style={{
              font: "var(--text-caption-reg-12)",
              color: "var(--colors-text-caption)",
              fontStyle: "italic",
            }}
          >
            assumes {assumptions.join("; ")}
          </span>
        )}
        {extra && (
          <FText appearance="captionReg12" styleProps={{ color: "textCaption", display: "block" }}>
            {extra}
          </FText>
        )}
      </div>

      <div style={{ flexShrink: 0, textAlign: "right" }}>
        {editing && input ? (
          input
        ) : (
          <FText appearance="headingMed14" styleProps={{ color: "textMain" }}>
            {value}
          </FText>
        )}
      </div>

      <div style={{ flexShrink: 0, paddingTop: 2 }}>
        <Provenance source={source} confidence={confidence} />
      </div>
    </div>
  );
}
