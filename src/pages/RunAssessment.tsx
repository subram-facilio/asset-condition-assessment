import { useEffect, useMemo, useState } from "react";
import { FButton, FIcon, FSpinner, FText } from "@facilio/dsm-react-wrapper";
import { fn } from "../lib/vibe";
import { INITIAL_STAGES, runPipeline, type PipelineResult, type Stage, type StageState } from "../lib/pipeline";
import type { AssetRow } from "../lib/types";
import { Empty, ErrorBanner } from "../lib/ui";
import { PageShell } from "../components/PageShell";
import { Card, CardTitle, CardNote } from "../components/Card";
import SegmentedProgressBar from "../components/SegmentedProgressBar";
import { StatusTag, gradeTone, recommendationTone, riskTone } from "../components/StatusTag";
import { DarkButton } from "../components/Buttons";

/**
 * Run an assessment on one asset.
 *
 * A task flow, not a list — so it uses the focused single-column shell rather than the register's
 * full-bleed archetype. Three ordered steps down one column, each a card, so at any moment there is
 * exactly one thing to look at: the asset you are choosing, the pipeline working, then the verdict.
 */

/**
 * Per-state glyph and ink for a pipeline step. `running` renders a spinner instead, and `pending`
 * renders nothing at all — the empty ring already reads as "not started", and the icon library has
 * no neutral circle to put inside it (`16px-special-case/circle` and `/dot` both 404).
 */
const STAGE_LOOK: Record<Exclude<StageState, "running" | "pending">, { icon: string; group: string; ink: string }> = {
  done: { icon: "tick", group: "action", ink: "var(--colors-icon-semantic-green)" },
  skipped: { icon: "minus", group: "16px-special-case", ink: "var(--colors-icon-neutral-light)" },
  failed: { icon: "close", group: "16px-special-case", ink: "var(--colors-icon-semantic-red, #d64545)" },
};

function StageRow({ stage, last }: { stage: Stage; last: boolean }) {
  const running = stage.state === "running";
  const done = stage.state === "done";
  const look =
    stage.state === "running" || stage.state === "pending" ? null : STAGE_LOOK[stage.state];

  return (
    <div style={{ display: "flex", gap: "var(--spacing-container-xlarge)", minWidth: 0 }}>
      {/* Marker column: the glyph plus the connector down to the next step, so the list reads as
          one sequence rather than nine unrelated rows. */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
        <span
          style={{
            width: 24,
            height: 24,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 999,
            border: `1px solid ${
              running
                ? "var(--colors-border-primary-default)"
                : done
                ? "var(--colors-icon-semantic-green)"
                : "var(--colors-border-neutral-base-subtle)"
            }`,
            backgroundColor: "var(--colors-background-container)",
          }}
        >
          {running ? (
            <FSpinner size={12} />
          ) : look ? (
            <FIcon group={look.group} name={look.icon} size={12} color={look.ink} pressable={false} />
          ) : null}
        </span>
        {!last && (
          <span
            style={{
              flex: 1,
              width: 1,
              minHeight: 12,
              backgroundColor: "var(--colors-border-neutral-base-subtler)",
            }}
          />
        )}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          minWidth: 0,
          paddingBottom: last ? 0 : "var(--spacing-container-xlarge)",
        }}
      >
        <FText
          appearance={running ? "headingMed14" : "bodyReg14"}
          styleProps={{ color: stage.state === "pending" ? "textCaption" : "textMain" }}
        >
          {stage.label}
        </FText>
        <FText appearance="captionReg12" styleProps={{ color: "textCaption", display: "block" }}>
          {stage.detail}
        </FText>
      </div>
    </div>
  );
}

/** One row in the asset picker. */
function AssetOption({
  asset,
  selected,
  disabled,
  onSelect,
}: {
  asset: AssetRow;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--spacing-container-xlarge)",
        width: "100%",
        textAlign: "left",
        padding: "var(--spacing-container-large) var(--spacing-container-xlarge)",
        border: "none",
        borderBottom: "1px solid var(--colors-border-neutral-base-subtler)",
        backgroundColor: selected
          ? "var(--colors-background-accent-blue-subtle)"
          : "var(--colors-background-container)",
        cursor: disabled ? "default" : "pointer",
        font: "inherit",
      }}
    >
      <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
        <FText
          appearance={selected ? "headingMed14" : "bodyReg14"}
          styleProps={{
            color: "textMain",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "block",
          }}
        >
          {asset.name}
        </FText>
        <FText appearance="captionReg12" styleProps={{ color: "textCaption", display: "block" }}>
          {asset.category}
          {asset.manufacturer ? ` · ${asset.manufacturer}` : ""}
          {asset.purchasedDate ? ` · in service ${asset.purchasedDate.slice(0, 4)}` : ""}
        </FText>
      </span>

      <span style={{ flexShrink: 0 }}>
        {asset.assessed ? (
          <StatusTag tone={riskTone(asset.risk_level || "")}>{asset.grade}</StatusTag>
        ) : (
          <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
            not assessed
          </FText>
        )}
      </span>
    </button>
  );
}

export function RunAssessment({ presetAssetId }: { presetAssetId?: number }) {
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [selected, setSelected] = useState<number | null>(presetAssetId ?? null);
  const [query, setQuery] = useState("");
  const [stages, setStages] = useState<Stage[]>(INITIAL_STAGES);
  const [note, setNote] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fn<{ assets: AssetRow[] }>("assets", { pageSize: 200 })
      .then((r) => setAssets(r.assets))
      .catch((e) => setError(String(e?.message || e)));
  }, []);

  const filtered = useMemo(() => {
    if (!assets) return [];
    const q = query.trim().toLowerCase();
    const list = q
      ? assets.filter((a) => `${a.name} ${a.category} ${a.manufacturer} ${a.model}`.toLowerCase().includes(q))
      : assets;
    return list.slice(0, 60);
  }, [assets, query]);

  const chosen = assets?.find((a) => a.asset_id === selected) || null;
  const completed = stages.filter((s) => s.state === "done" || s.state === "skipped").length;

  async function start() {
    if (!selected) return;
    setRunning(true);
    setError("");
    setResult(null);
    setNote("");
    setStages(INITIAL_STAGES.map((s) => ({ ...s })));
    try {
      const res = await runPipeline(selected, (next, n) => {
        setStages(next);
        if (n !== undefined) setNote(n);
      });
      setResult(res);
    } catch (e: any) {
      setError(String(e?.message || e));
      setStages((prev) => prev.map((s) => (s.state === "running" ? { ...s, state: "failed" } : s)));
    } finally {
      setRunning(false);
    }
  }

  if (error && !assets) {
    return (
      <PageShell title="Run assessment">
        <ErrorBanner>Could not load assets: {error}</ErrorBanner>
      </PageShell>
    );
  }
  if (!assets) return <Empty>Loading assets from Facilio…</Empty>;

  return (
    <PageShell
      title="Run assessment"
      subtitle="The agent reads the asset's corrective work orders and before-maintenance photos from Facilio and produces one consolidated condition assessment. Nothing is entered by hand."
    >
      {/* ---------------------------------------------------------- 1 · asset */}
      <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
        <CardTitle icon={{ group: "webtabs", name: "asset" }}>1 · Choose an asset</CardTitle>

        <input
          className="ca-input"
          type="text"
          placeholder="Search by name, category, manufacturer…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={running}
          style={{
            height: 32,
            width: "100%",
            padding: "0 var(--spacing-container-xlarge)",
            borderRadius: "var(--border-medium)",
            border: "1px solid var(--colors-border-neutral-base-subtle)",
            backgroundColor: "var(--colors-background-container)",
            color: "var(--colors-text-main)",
            font: "var(--text-body-reg-14)",
          }}
        />

        <div
          style={{
            maxHeight: 320,
            overflowY: "auto",
            borderRadius: "var(--border-medium)",
            border: "1px solid var(--colors-border-neutral-base-subtler)",
            backgroundColor: "var(--colors-background-container)",
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: "var(--spacing-container-xxlarge)", textAlign: "center" }}>
              <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                No asset matches “{query}”.
              </FText>
            </div>
          ) : (
            filtered.map((a) => (
              <AssetOption
                key={a.asset_id}
                asset={a}
                selected={a.asset_id === selected}
                disabled={running}
                onSelect={() => setSelected(a.asset_id)}
              />
            ))
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "var(--spacing-container-xlarge)",
            flexWrap: "wrap",
          }}
        >
          <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
            {chosen ? `Selected: ${chosen.name}` : "Nothing selected yet"}
          </FText>
          <DarkButton
            label={running ? "Assessing…" : "Start assessment"}
            icon={{ group: "16px-special-case", name: "plus" }}
            onClick={start}
            disabled={!selected}
            loading={running}
          />
        </div>
      </Card>

      {/* ------------------------------------------------------- 2 · pipeline */}
      <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
        <CardTitle
          icon={{ group: "time-date", name: "date-tick" }}
          action={
            <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
              {completed} of {stages.length}
            </FText>
          }
        >
          2 · Pipeline
        </CardTitle>

        {/* One tick per stage, not the component's 96-tick default: at this height a fine tick
            comb reads as a texture, whereas nine ticks read as nine steps — which is what the
            list underneath is about to enumerate. */}
        <SegmentedProgressBar
          value={completed}
          max={stages.length}
          segments={stages.length}
          height={8}
          filledColor="var(--colors-icon-primary-default)"
          trackColor="var(--colors-background-midground-dark)"
        />

        <div style={{ display: "flex", flexDirection: "column" }}>
          {stages.map((s, i) => (
            <StageRow key={s.key} stage={s} last={i === stages.length - 1} />
          ))}
        </div>

        {note && <CardNote>{note}</CardNote>}
        {error && <ErrorBanner>{error}</ErrorBanner>}
      </Card>

      {/* --------------------------------------------------------- 3 · result */}
      {result && (
        <>
          {result.photoMode === "bundled_fallback" && (
            <ErrorBanner>
              <b>Photo bytes came from bundled copies.</b> Facilio returns a pre-signed URL for each
              attachment, but that storage host sends no CORS header, so the browser cannot read the bytes
              directly. The app fell back to its bundled copy of the same file. Allowing cross-origin reads
              on that bucket would make this step fully live.
            </ErrorBanner>
          )}
          {result.photoMode === "unavailable" && (
            <ErrorBanner>
              <b>Photos exist but could not be read.</b> Facilio's pre-signed attachment URLs are not
              readable cross-origin, so no visual evidence could be analysed. Everything below rests on
              work-order text only.
            </ErrorBanner>
          )}
          {!result.narrativeAccepted && result.narrativeRejectedFigures.length > 0 && (
            <ErrorBanner>
              <b>The written explanation was rejected.</b> The agent introduced figures that were not in the
              computed values it was given ({result.narrativeRejectedFigures.join(", ")}), so the prose was
              discarded. Every number below is unaffected.
            </ErrorBanner>
          )}
          {result.countMismatches.length > 0 && (
            <Card>
              <CardTitle icon={{ group: "alert", name: "triangle-warning-filled" }}>
                Agent counts corrected by the engine
              </CardTitle>
              <div style={{ marginTop: "var(--spacing-container-xlarge)" }}>
                <CardNote>
                  The recurrence unit is the corrective work order, never the photo, so every count was
                  recomputed from distinct work orders:
                </CardNote>
                <ul
                  style={{
                    margin: "var(--spacing-container-large) 0 0",
                    paddingLeft: 18,
                    font: "var(--text-caption-reg-12)",
                    color: "var(--colors-text-description)",
                  }}
                >
                  {result.countMismatches.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            </Card>
          )}

          <Card
            tone="container"
            style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "space-between",
                gap: "var(--spacing-container-xxlarge)",
                flexWrap: "wrap",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-large)", minWidth: 0 }}>
                <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
                  3 · Result
                </FText>
                <FText appearance="headingMed16" styleProps={{ color: "textMain" }}>
                  {result.assessment.asset_name}
                </FText>
              </div>
              <FButton
                appearance="primary"
                size="medium"
                onButtonClick={() => {
                  window.location.hash = `/asset/${result.assessment.asset_id}`;
                }}
              >
                Open full analysis
              </FButton>
            </div>

            <div style={{ display: "flex", gap: "var(--spacing-container-large)", flexWrap: "wrap" }}>
              <StatusTag tone={gradeTone(result.assessment.grade)}>
                Condition {result.assessment.score} / 5 · {result.assessment.grade}
              </StatusTag>
              <StatusTag tone={riskTone(result.assessment.risk_level)}>
                Risk {result.assessment.risk_score} / 100
              </StatusTag>
              <StatusTag tone="mute">
                RUL{" "}
                {result.assessment.rul?.available === false
                  ? "not available"
                  : `${result.assessment.rul_years} years`}
              </StatusTag>
              {result.assessment.dominant_issue_mtbf?.verdict?.available && (
                <StatusTag
                  tone={
                    result.assessment.dominant_issue_mtbf.verdict.value === "contracting" ? "bad" : "mute"
                  }
                >
                  MTBF {result.assessment.dominant_issue_mtbf.verdict.value}
                </StatusTag>
              )}
              <StatusTag tone={recommendationTone(result.assessment.recommendation)}>
                {result.assessment.recommendation}
              </StatusTag>
            </div>

            {result.assessment.unavailable && result.assessment.unavailable.length > 0 && (
              <CardNote>
                {result.assessment.unavailable.length} metric
                {result.assessment.unavailable.length === 1 ? "" : "s"} could not be computed — see the asset
                page for what and why.
              </CardNote>
            )}
          </Card>
        </>
      )}
    </PageShell>
  );
}
