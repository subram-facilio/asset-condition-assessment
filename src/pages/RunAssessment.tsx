import { useEffect, useMemo, useRef, useState } from "react";
import { FButton, FIcon, FSpinner, FText } from "@facilio/dsm-react-wrapper";
import { fn } from "../lib/vibe";
import {
  estimateSeconds,
  initialStages,
  runBatch,
  type AssetRun,
  type AssetRunState,
  type PipelineResult,
  type Stage,
  type StageState,
} from "../lib/pipeline";
import type { AssetRow } from "../lib/types";
import { Empty, ErrorBanner } from "../lib/ui";
import { PageShell } from "../components/PageShell";
import { Card, CardTitle, CardNote } from "../components/Card";
import SegmentedProgressBar from "../components/SegmentedProgressBar";
import { StatusTag, gradeTone, recommendationTone, riskTone } from "../components/StatusTag";
import { DarkButton, OutlineButton } from "../components/Buttons";
import Table from "../components/Table";
import type { TableColumn } from "../components/tableTypes";

/**
 * Run assessments on one asset or many.
 *
 * A task flow, not a list — so it uses the focused single-column shell rather than the register's
 * full-bleed archetype. Three ordered steps down one column, each a card, so at any moment there is
 * exactly one thing to look at: the assets you are choosing, the pipeline working, then the verdict.
 *
 * One selection scales to both modes rather than splitting into two screens: with a single asset
 * chosen this reads exactly as it always has, nine stages and one result card. With two or more the
 * middle card becomes a queue and the last becomes a table, but the asset currently running still
 * shows its nine stages — the detail is scoped to what is moving, never discarded.
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

/** The same vocabulary one level up: a whole asset's outcome inside a batch. */
const RUN_LOOK: Record<Exclude<AssetRunState, "running" | "queued">, { icon: string; group: string; ink: string }> = {
  done: STAGE_LOOK.done,
  failed: STAGE_LOOK.failed,
  cancelled: STAGE_LOOK.skipped,
};

function StateRing({ state }: { state: AssetRunState | StageState }) {
  const running = state === "running";
  const done = state === "done";
  const look =
    state === "running" || state === "pending" || state === "queued"
      ? null
      : (STAGE_LOOK as Record<string, { icon: string; group: string; ink: string }>)[state] ||
        (RUN_LOOK as Record<string, { icon: string; group: string; ink: string }>)[state];

  return (
    <span
      style={{
        width: 24,
        height: 24,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 999,
        flexShrink: 0,
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
  );
}

function StageRow({ stage, last }: { stage: Stage; last: boolean }) {
  const running = stage.state === "running";

  return (
    <div style={{ display: "flex", gap: "var(--spacing-container-xlarge)", minWidth: 0 }}>
      {/* Marker column: the glyph plus the connector down to the next step, so the list reads as
          one sequence rather than nine unrelated rows. */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 }}>
        <StateRing state={stage.state} />
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

/** One row in the asset picker. The whole row is the toggle, so the checkbox is a cue, not a target. */
function AssetOption({
  asset,
  selected,
  disabled,
  onToggle,
}: {
  asset: AssetRow;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
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
      <span
        aria-hidden
        style={{
          width: 16,
          height: 16,
          flexShrink: 0,
          borderRadius: "var(--border-small, 3px)",
          border: `1px solid ${
            selected ? "var(--colors-border-primary-default)" : "var(--colors-border-neutral-base-medium)"
          }`,
          backgroundColor: selected ? "var(--colors-icon-primary-default)" : "transparent",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {selected && <FIcon group="action" name="tick" size={10} color="#ffffff" pressable={false} />}
      </span>

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

/** A small text button for the selection shortcuts, which are links in spirit rather than actions. */
function LinkAction({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        border: "none",
        background: "none",
        padding: 0,
        font: "var(--text-caption-reg-12)",
        color: disabled ? "var(--colors-text-caption)" : "var(--colors-text-primary-default)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

/** One asset's row inside the batch queue. Expands to its stages while it is the one running. */
function QueueRow({ run, expanded }: { run: AssetRun; expanded: boolean }) {
  const currentStage = run.stages.find((s) => s.state === "running");
  const done = run.state === "done" && run.result;

  return (
    <div
      style={{
        borderBottom: "1px solid var(--colors-border-neutral-base-subtler)",
        padding: "var(--spacing-container-large) 0",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-container-xlarge)", minWidth: 0 }}>
        <StateRing state={run.state} />
        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: 1 }}>
          <FText
            appearance={run.state === "running" ? "headingMed14" : "bodyReg14"}
            styleProps={{
              color: run.state === "queued" ? "textCaption" : "textMain",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              display: "block",
            }}
          >
            {run.assetName}
          </FText>
          <FText appearance="captionReg12" styleProps={{ color: "textCaption", display: "block" }}>
            {run.state === "queued"
              ? "Queued"
              : run.state === "running"
              ? currentStage?.label || "Starting…"
              : run.state === "cancelled"
              ? "Not started — batch stopped"
              : run.state === "failed"
              ? run.error || "Failed"
              : run.attempts > 1
              ? "Assessed after a retry"
              : "Assessed"}
          </FText>
        </span>

        {done && (
          <span style={{ display: "flex", gap: "var(--spacing-container-large)", flexShrink: 0, flexWrap: "wrap" }}>
            <StatusTag tone={gradeTone(run.result!.assessment.grade)}>{run.result!.assessment.grade}</StatusTag>
            <StatusTag tone={riskTone(run.result!.assessment.risk_level)}>
              {run.result!.assessment.risk_score}
            </StatusTag>
            <StatusTag tone={recommendationTone(run.result!.assessment.recommendation)}>
              {run.result!.assessment.recommendation}
            </StatusTag>
          </span>
        )}
      </div>

      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", marginTop: "var(--spacing-container-xlarge)", paddingLeft: 36 }}>
          {run.stages.map((s, i) => (
            <StageRow key={s.key} stage={s} last={i === run.stages.length - 1} />
          ))}
          {run.note && (
            <div style={{ marginTop: "var(--spacing-container-large)" }}>
              <CardNote>{run.note}</CardNote>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function formatEstimate(low: number, high: number): string {
  const fmt = (s: number) => (s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)} min`);
  return low === high ? fmt(low) : `${fmt(low)}–${fmt(high)}`;
}

export function RunAssessment({ presetAssetId }: { presetAssetId?: number }) {
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  // Insertion-ordered, so the queue runs in the order the user picked.
  const [selected, setSelected] = useState<number[]>(presetAssetId ? [presetAssetId] : []);
  const [query, setQuery] = useState("");
  const [runs, setRuns] = useState<AssetRun[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);

  // A ref, not state: `runBatch` closes over this and must see the latest value
  // between assets without the loop being re-created.
  const cancelRef = useRef(false);
  const startedRef = useRef(0);

  useEffect(() => {
    fn<{ assets: AssetRow[] }>("assets", { pageSize: 200 })
      .then((r) => setAssets(r.assets))
      .catch((e) => setError(String(e?.message || e)));
  }, []);

  // Tick the elapsed clock only while a batch is in flight.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setElapsed(Date.now() - startedRef.current), 1000);
    return () => clearInterval(id);
  }, [running]);

  const filtered = useMemo(() => {
    if (!assets) return [];
    const q = query.trim().toLowerCase();
    const list = q
      ? assets.filter((a) => `${a.name} ${a.category} ${a.manufacturer} ${a.model}`.toLowerCase().includes(q))
      : assets;
    return list.slice(0, 60);
  }, [assets, query]);

  const chosen = useMemo(
    () => selected.map((id) => assets?.find((a) => a.asset_id === id)).filter(Boolean) as AssetRow[],
    [selected, assets]
  );

  const single = selected.length === 1;
  const estimate = useMemo(
    () => estimateSeconds(chosen.map(() => 2)),
    [chosen]
  );

  function toggle(id: number) {
    setSelected((prev) => (prev.indexOf(id) >= 0 ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function selectAllFiltered() {
    setSelected(filtered.map((a) => a.asset_id));
  }

  function selectUnassessed() {
    setSelected((assets || []).filter((a) => !a.assessed).map((a) => a.asset_id));
  }

  function selectAssessed() {
    setSelected((assets || []).filter((a) => a.assessed).map((a) => a.asset_id));
  }

  async function start(targets: AssetRow[]) {
    if (targets.length === 0) return;
    cancelRef.current = false;
    startedRef.current = Date.now();
    setElapsed(0);
    setRunning(true);
    setError("");
    try {
      const finished = await runBatch(
        targets.map((a) => ({ asset_id: a.asset_id, name: a.name })),
        setRuns,
        () => cancelRef.current
      );
      setRuns(finished);
      // Refresh the picker so grades and "not assessed" reflect what just ran.
      fn<{ assets: AssetRow[] }>("assets", { pageSize: 200 })
        .then((r) => setAssets(r.assets))
        .catch(() => {});
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setRunning(false);
      setElapsed(Date.now() - startedRef.current);
    }
  }

  function retryFailed() {
    const failedIds = runs.filter((r) => r.state === "failed" || r.state === "cancelled").map((r) => r.assetId);
    const targets = (assets || []).filter((a) => failedIds.indexOf(a.asset_id) >= 0);
    start(targets);
  }

  if (error && !assets) {
    return (
      <PageShell title="Run assessment">
        <ErrorBanner>Could not load assets: {error}</ErrorBanner>
      </PageShell>
    );
  }
  if (!assets) return <Empty>Loading assets from Facilio…</Empty>;

  const finishedCount = runs.filter((r) => r.state === "done").length;
  const failedCount = runs.filter((r) => r.state === "failed").length;
  const cancelledCount = runs.filter((r) => r.state === "cancelled").length;
  const results = runs.filter((r) => r.state === "done" && r.result).map((r) => r.result!);

  // Single-asset mode keeps the original view: one stage list, no queue wrapper.
  const singleRun = runs.length === 1 ? runs[0] : null;
  // The idle list has to be the fresh-run one, so the steps shown before the button is
  // pressed are the steps that will actually run.
  const singleStages = singleRun ? singleRun.stages : initialStages();
  const stagesComplete = singleStages.filter((s) => s.state === "done" || s.state === "skipped").length;

  return (
    <PageShell
      title="Run assessment"
      subtitle="The agent reads each asset's corrective work orders and before-maintenance photos from Facilio and produces one consolidated condition assessment. Every run re-reads that evidence from Facilio rather than reusing stored findings, so an edited or deleted work order is reflected the next time you run it. Nothing is entered by hand."
    >
      {/* ---------------------------------------------------------- 1 · assets */}
      <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
        <CardTitle
          icon={{ group: "webtabs", name: "asset" }}
          action={
            <div style={{ display: "flex", gap: "var(--spacing-container-xxlarge)", flexShrink: 0 }}>
              <LinkAction label="Not assessed" onClick={selectUnassessed} disabled={running} />
              <LinkAction label="All assessed" onClick={selectAssessed} disabled={running} />
              <LinkAction
                label={`Select all ${filtered.length}`}
                onClick={selectAllFiltered}
                disabled={running || filtered.length === 0}
              />
              <LinkAction label="Clear" onClick={() => setSelected([])} disabled={running || selected.length === 0} />
            </div>
          }
        >
          1 · Choose assets
        </CardTitle>

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
                selected={selected.indexOf(a.asset_id) >= 0}
                disabled={running}
                onToggle={() => toggle(a.asset_id)}
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
            {selected.length === 0
              ? "Nothing selected yet"
              : single
              ? `Selected: ${chosen[0]?.name ?? selected[0]} · photos are analyzed again on every run`
              : `${selected.length} assets selected · about ${formatEstimate(
                  estimate.low,
                  estimate.high
                )}, run one at a time · photos are analyzed again on every run`}
          </FText>
          <div style={{ display: "flex", gap: "var(--spacing-container-large)", flexShrink: 0 }}>
            {running && (
              <OutlineButton
                label={cancelRef.current ? "Stopping…" : "Stop after current"}
                onClick={() => {
                  cancelRef.current = true;
                  setRuns((prev) => prev.map((r) => ({ ...r })));
                }}
              />
            )}
            <DarkButton
              label={
                running
                  ? "Assessing…"
                  : selected.length > 1
                  ? `Assess ${selected.length} assets`
                  : "Start assessment"
              }
              icon={{ group: "16px-special-case", name: "plus" }}
              onClick={() => start(chosen)}
              disabled={selected.length === 0 || running}
              loading={running}
            />
          </div>
        </div>
      </Card>

      {/* ------------------------------------------------------- 2 · pipeline */}
      <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
        <CardTitle
          icon={{ group: "time-date", name: "date-tick" }}
          action={
            <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
              {runs.length > 1
                ? `${finishedCount} of ${runs.length}${failedCount ? ` · ${failedCount} failed` : ""}${
                    cancelledCount ? ` · ${cancelledCount} stopped` : ""
                  }${running || elapsed ? ` · ${formatElapsed(elapsed)}` : ""}`
                : `${stagesComplete} of ${singleStages.length}`}
            </FText>
          }
        >
          2 · Pipeline
        </CardTitle>

        {runs.length > 1 ? (
          <>
            {/* One tick per asset here, mirroring the single-asset bar's one-tick-per-stage. */}
            <SegmentedProgressBar
              value={finishedCount + failedCount + cancelledCount}
              max={runs.length}
              segments={runs.length}
              height={8}
              filledColor="var(--colors-icon-primary-default)"
              trackColor="var(--colors-background-midground-dark)"
            />
            <div style={{ display: "flex", flexDirection: "column" }}>
              {runs.map((r) => (
                <QueueRow key={r.assetId} run={r} expanded={r.state === "running"} />
              ))}
            </div>
          </>
        ) : (
          <>
            {/* One tick per stage, not the component's 96-tick default: at this height a fine tick
                comb reads as a texture, whereas nine ticks read as nine steps — which is what the
                list underneath is about to enumerate. */}
            <SegmentedProgressBar
              value={stagesComplete}
              max={singleStages.length}
              segments={singleStages.length}
              height={8}
              filledColor="var(--colors-icon-primary-default)"
              trackColor="var(--colors-background-midground-dark)"
            />
            <div style={{ display: "flex", flexDirection: "column" }}>
              {singleStages.map((s, i) => (
                <StageRow key={s.key} stage={s} last={i === singleStages.length - 1} />
              ))}
            </div>
            {singleRun?.note && <CardNote>{singleRun.note}</CardNote>}
          </>
        )}

        {error && <ErrorBanner>{error}</ErrorBanner>}

        {!running && (failedCount > 0 || cancelledCount > 0) && (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <OutlineButton
              label={`Retry ${failedCount + cancelledCount} asset${failedCount + cancelledCount === 1 ? "" : "s"}`}
              onClick={retryFailed}
            />
          </div>
        )}
      </Card>

      {/* --------------------------------------------------------- 3 · result */}
      {results.length > 0 && <Results runs={runs} results={results} />}
    </PageShell>
  );
}

/* ------------------------------------------------------------------ *
 * Results. One asset keeps the original verdict card; several become a table,
 * with the batch's warnings aggregated rather than repeated per asset.
 * ------------------------------------------------------------------ */

function Results({ runs, results }: { runs: AssetRun[]; results: PipelineResult[] }) {
  const unreadable = results.filter((r) => r.photoMode === "unavailable").length;
  const rejected = results.filter((r) => !r.narrativeAccepted && r.narrativeRejectedFigures.length > 0);
  const corrected = results.filter((r) => r.countMismatches.length > 0);
  const failed = runs.filter((r) => r.state === "failed");

  const warnings = (
    <>
      {unreadable > 0 && (
        <ErrorBanner>
          <b>
            Photos exist in Facilio but could not be read for {unreadable} asset{unreadable === 1 ? "" : "s"}.
          </b>{" "}
          Facilio mints a download URL for each attachment, but its storage host does not permit a browser to
          read the file, so the bytes never reach the app and no visual evidence could be analysed. Those
          assessments rest on work-order text alone.
        </ErrorBanner>
      )}
      {rejected.length > 0 && (
        <ErrorBanner>
          <b>
            The written explanation was rejected for {rejected.length} asset{rejected.length === 1 ? "" : "s"}.
          </b>{" "}
          The agent introduced figures that were not in the computed values it was given, so the prose was
          discarded. Every number is unaffected.
        </ErrorBanner>
      )}
      {failed.length > 0 && (
        <ErrorBanner>
          <b>
            {failed.length} asset{failed.length === 1 ? "" : "s"} could not be assessed.
          </b>
          <ul style={{ margin: "var(--spacing-container-large) 0 0", paddingLeft: 18 }}>
            {failed.map((f) => (
              <li key={f.assetId}>
                {f.assetName} — {f.error}
              </li>
            ))}
          </ul>
        </ErrorBanner>
      )}
      {corrected.length > 0 && (
        <Card>
          <CardTitle icon={{ group: "alert", name: "triangle-warning-filled" }}>
            Agent counts corrected by the engine
          </CardTitle>
          <div style={{ marginTop: "var(--spacing-container-xlarge)" }}>
            <CardNote>
              The recurrence unit is the corrective work order, never the photo, so every count was recomputed
              from distinct work orders:
            </CardNote>
            <ul
              style={{
                margin: "var(--spacing-container-large) 0 0",
                paddingLeft: 18,
                font: "var(--text-caption-reg-12)",
                color: "var(--colors-text-description)",
              }}
            >
              {corrected.flatMap((r) =>
                r.countMismatches.map((m, i) => <li key={`${r.assessment.asset_id}-${i}`}>{r.assessment.asset_name}: {m}</li>)
              )}
            </ul>
          </div>
        </Card>
      )}
    </>
  );

  if (results.length === 1) {
    const a = results[0].assessment;
    return (
      <>
        {warnings}
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
                {a.asset_name}
              </FText>
            </div>
            <FButton
              appearance="primary"
              size="medium"
              onButtonClick={() => {
                window.location.hash = `/asset/${a.asset_id}`;
              }}
            >
              Open full analysis
            </FButton>
          </div>

          <div style={{ display: "flex", gap: "var(--spacing-container-large)", flexWrap: "wrap" }}>
            <StatusTag tone={gradeTone(a.grade)}>
              Condition {a.score} / 5 · {a.grade}
            </StatusTag>
            <StatusTag tone={riskTone(a.risk_level)}>Risk {a.risk_score} / 100</StatusTag>
            <StatusTag tone="mute">
              RUL {a.rul?.available === false ? "not available" : `${a.rul_years} years`}
            </StatusTag>
            {a.dominant_issue_mtbf?.verdict?.available && (
              <StatusTag tone={a.dominant_issue_mtbf.verdict.value === "contracting" ? "bad" : "mute"}>
                MTBF {a.dominant_issue_mtbf.verdict.value}
              </StatusTag>
            )}
            <StatusTag tone={recommendationTone(a.recommendation)}>{a.recommendation}</StatusTag>
          </div>

          {a.unavailable && a.unavailable.length > 0 && (
            <CardNote>
              {a.unavailable.length} metric{a.unavailable.length === 1 ? "" : "s"} could not be computed — see the
              asset page for what and why.
            </CardNote>
          )}
        </Card>
      </>
    );
  }

  // Worst first: the assets that need attention should not be below the fold.
  const rows = results.map((r) => r.assessment).slice().sort((a, b) => b.risk_score - a.risk_score);
  const highRisk = rows.filter((r) => r.risk_level === "HIGH").length;
  const replace = rows.filter((r) => r.recommendation === "REPLACE").length;

  const columns: TableColumn<(typeof rows)[number]>[] = [
    {
      key: "asset_name",
      title: "Asset",
      width: "220px",
      mainColumn: true,
      render: (_v, row) => (
        <span style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <FText appearance="bodyReg14" styleProps={{ color: "textPrimaryDefault" }}>
            {row.asset_name}
          </FText>
          <FText appearance="captionReg12" styleProps={{ color: "textCaption", display: "block" }}>
            {row.category}
          </FText>
        </span>
      ),
    },
    {
      key: "score",
      title: "Condition",
      width: "150px",
      render: (_v, row) => (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--spacing-container-large)" }}>
          {row.score.toFixed(2)}
          <StatusTag tone={gradeTone(row.grade)}>{row.grade}</StatusTag>
        </span>
      ),
    },
    {
      key: "risk_score",
      title: "Risk",
      width: "100px",
      render: (_v, row) => <StatusTag tone={riskTone(row.risk_level)}>{row.risk_score}</StatusTag>,
    },
    {
      key: "rul_years",
      title: "RUL",
      width: "90px",
      render: (_v, row) => (row.rul?.available === false ? "—" : `${row.rul_years}y`),
    },
    {
      key: "mtbf",
      title: "MTBF",
      width: "130px",
      render: (_v, row) => {
        const v = row.dominant_issue_mtbf?.verdict;
        if (!v?.available) return "—";
        return (
          <StatusTag tone={v.value === "contracting" ? "bad" : "mute"}>{String(v.value)}</StatusTag>
        );
      },
    },
    {
      key: "recommendation",
      title: "Recommendation",
      width: "150px",
      render: (_v, row) => <StatusTag tone={recommendationTone(row.recommendation)}>{row.recommendation}</StatusTag>,
    },
  ];

  return (
    <>
      {warnings}
      <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
        <CardTitle
          icon={{ group: "chart-data", name: "bar-graph" }}
          action={
            <FText appearance="captionReg12" styleProps={{ color: "textCaption" }}>
              {rows.length} assessed
              {highRisk ? ` · ${highRisk} high risk` : ""}
              {replace ? ` · ${replace} to replace` : ""}
            </FText>
          }
        >
          3 · Results
        </CardTitle>
        <Table
          columns={columns}
          data={rows}
          rowKey="asset_id"
          rowHeight="60px"
          mainFieldClick={(row) => {
            window.location.hash = `/asset/${row.asset_id}`;
          }}
        />
      </Card>
    </>
  );
}
