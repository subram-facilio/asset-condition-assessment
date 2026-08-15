/**
 * The Condition Assessment orchestrator.
 *
 * Runs in the browser because `uploadFile` and `executeAgent` are browser-only
 * SDK surfaces. Everything countable happens server-side in condition-engine;
 * this file only sequences the stages and gets image bytes to the agent.
 *
 * Photo batching is the structural half of the agent spec's CRITICAL COUNTING
 * RULE: all of one work order's before photos go into ONE agent run, so three
 * photos of the same leak in one work order cannot become three occurrences.
 */
import { fileAction, fn, runAgent, vibe } from "./vibe";
import type { Analysis, Assessment, Bundle, GatheredWo } from "./types";

export type StageState = "pending" | "running" | "done" | "skipped" | "failed";

export interface Stage {
  key: string;
  label: string;
  detail: string;
  state: StageState;
}

export interface PipelineResult {
  bundle: Bundle;
  analysis: Analysis | null;
  assessment: Assessment;
  photoMode: PhotoMode;
  photosAnalyzed: number;
  countMismatches: string[];
  /** Whether the explanation survived the number lock, and what tripped it. */
  narrativeAccepted: boolean;
  narrativeRejectedFigures: string[];
  /**
   * Inspector observations that survived the quote lock, and how many closed
   * inspections they came from. They reach the condition score on the NEXT assess.
   */
  observationsKept: number;
  inspectionCount: number;
}

/**
 * What a run may reuse. An absent option means a full fresh check — the normal path,
 * because Facilio's work orders and photos change under us and stored evidence goes
 * stale silently.
 */
export interface RunOptions {
  /**
   * Keep the findings already on record instead of re-deriving them.
   *
   * Nothing sets this today: it drove the manual photo-upload flow, which was removed
   * once photo bytes could be read live from the CMMS. The reuse machinery it toggles
   * still works and is kept as an escape hatch.
   */
  reuseStoredEvidence?: boolean;
}

/** Where the analysed image bytes came from — surfaced in the UI, never hidden. */
export type PhotoMode =
  | "none" // asset has no before photos at all
  | "cmms_direct" // bytes read live from Facilio, the only accepted source
  | "unavailable"; // photos exist in Facilio but their bytes could not be read

const AGENT_FILE_CAP = 10; // platform limit: max files per agent run
const SINGLE_RUN_PHOTO_LIMIT = 6; // above this, batch per work order then consolidate

export const INITIAL_STAGES: Stage[] = [
  { key: "gather", label: "Fetch corrective history", detail: "Corrective work orders and BEFORE photos from the CMMS", state: "pending" },
  { key: "text", label: "Read work-order evidence", detail: "wo-evidence agent — issue, component and severity from each work order's wording", state: "pending" },
  { key: "photos", label: "Load photo evidence", detail: "Fetch before-photo bytes for analysis", state: "pending" },
  { key: "agent", label: "Consolidate the analysis", detail: "photo-validation agent — photographs when there are any, the work-order findings when there are not", state: "pending" },
  { key: "findings", label: "Store findings", detail: "Validate and persist, deduped per attachment", state: "pending" },
  { key: "analysis", label: "Count occurrences and consolidate", detail: "Engine recomputes every count; agent keeps judgment", state: "pending" },
  { key: "assess", label: "Run lifecycle engines", detail: "Condition, MTBF, deterioration, RUL, risk, CAPEX, recommendation", state: "pending" },
  { key: "core", label: "Analyse and explain", detail: "condition-core agent — explanation, cross-stream judgment, inspections, baselines", state: "pending" },
];

/**
 * The step list for one run.
 *
 * Three details are only true in one mode, so the mode decides them: a fresh run
 * rebuilds the text stream rather than topping it up, re-reads photos it has already
 * seen, and replaces their findings rather than deduping against them.
 */
export function initialStages(fresh = true): Stage[] {
  return INITIAL_STAGES.map((s) => {
    if (!fresh) return { ...s };
    if (s.key === "text") return { ...s, detail: "Re-read every work order's current wording" };
    if (s.key === "photos") return { ...s, detail: "Re-read every before photo from the CMMS" };
    if (s.key === "findings") return { ...s, detail: "Replace each re-analyzed photo's findings" };
    return { ...s };
  });
}

type Emit = (stages: Stage[], note?: string) => void;

/* ------------------------------------------------------------------ *
 * Batch execution.
 *
 * `runBatch` wraps `runPipeline` rather than replacing it, so selecting a single
 * asset still walks exactly the path that was verified end to end.
 * ------------------------------------------------------------------ */

export type AssetRunState = "queued" | "running" | "done" | "failed" | "cancelled";

/** One asset's slot in a batch: its own stages, its own outcome. */
export interface AssetRun {
  assetId: number;
  assetName: string;
  state: AssetRunState;
  stages: Stage[];
  note?: string;
  result?: PipelineResult;
  error?: string;
  attempts: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface BatchTarget {
  asset_id: number;
  name: string;
}

const RETRY_PAUSE_MS = 1500;
const BETWEEN_ASSETS_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Assess several assets, one at a time.
 *
 * Sequential on purpose. Each asset issues an agent call per photo-bearing work
 * order plus consolidation, baseline and narrative calls; running many at once
 * produced transient failures, whereas serial-with-one-retry completed every asset.
 *
 * A failing asset is isolated — it is marked `failed` with its reason and the batch
 * carries on, because one bad asset must not abandon the rest.
 *
 * `shouldCancel` is checked between assets only. The SDK's HTTP layer ignores
 * AbortSignal, so an in-flight agent call cannot truly be stopped; pretending
 * otherwise would leave a half-written assessment. Remaining assets are marked
 * `cancelled` rather than `failed` so the distinction survives into the UI.
 */
export async function runBatch(
  targets: BatchTarget[],
  emit: (runs: AssetRun[]) => void,
  shouldCancel: () => boolean = () => false,
  opts: RunOptions = {}
): Promise<AssetRun[]> {
  const fresh = opts.reuseStoredEvidence !== true;
  const runs: AssetRun[] = targets.map((t) => ({
    assetId: t.asset_id,
    assetName: t.name,
    state: "queued",
    stages: initialStages(fresh),
    attempts: 0,
  }));

  // Emit a fresh array each time so React sees a new reference and re-renders.
  const publish = () => emit(runs.map((r) => ({ ...r, stages: r.stages.map((s) => ({ ...s })) })));
  publish();

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];

    if (shouldCancel()) {
      for (let j = i; j < runs.length; j++) {
        if (runs[j].state === "queued") runs[j].state = "cancelled";
      }
      publish();
      break;
    }

    run.state = "running";
    run.startedAt = Date.now();
    run.stages = initialStages(fresh);
    publish();

    // One retry: the failures seen in practice were transient, not deterministic.
    //
    // Both attempts carry the same `opts`. If attempt 1 died after replacing three of
    // five attachments, a reusing attempt 2 would see those three as already analyzed,
    // skip them, and leave the asset with a half-old, half-new evidence set.
    for (let attempt = 1; attempt <= 2; attempt++) {
      run.attempts = attempt;
      try {
        const result = await runPipeline(run.assetId, (stages, note) => {
          run.stages = stages;
          if (note !== undefined) run.note = note;
          publish();
        }, opts);
        run.result = result;
        run.state = "done";
        run.error = undefined;
        break;
      } catch (e: any) {
        const message = String(e?.message || e);
        if (attempt === 2) {
          run.state = "failed";
          run.error = message;
          // Leave the stage that threw marked as failed so the row explains itself.
          run.stages = run.stages.map((s) => (s.state === "running" ? { ...s, state: "failed" } : s));

          // A fresh run deletes the evidence it is about to replace. Failing inside
          // those two stages is the one case where the asset is left holding fewer
          // findings than before, so the row has to say so rather than let a stale
          // register entry look intact.
          const cleared = run.stages.find((s) => s.state === "failed" && (s.key === "text" || s.key === "findings"));
          if (fresh && cleared) {
            run.note = `Superseded findings were cleared before this step failed — this asset now holds fewer findings than before. Re-running restores them.`;
          }
        } else {
          run.note = `Attempt 1 failed — retrying. ${message.slice(0, 120)}`;
          publish();
          await sleep(RETRY_PAUSE_MS);
          run.stages = initialStages(fresh);
        }
      }
    }

    run.finishedAt = Date.now();
    publish();

    if (i < runs.length - 1) await sleep(BETWEEN_ASSETS_MS);
  }

  return runs;
}

/** Rough wall-clock estimate, from what the pipeline actually took in practice. */
export function estimateSeconds(photoCounts: number[]): { low: number; high: number } {
  // The base is no longer a cheap regex pass: every asset now makes at least one
  // wo-evidence call before any photo work, so a photo-less asset costs an agent run
  // rather than a database write. Photo analysis still adds 6-12s per work order with
  // photos, since each is its own run.
  let low = 0;
  let high = 0;
  for (const photos of photoCounts) {
    low += 16 + photos * 4;
    high += 30 + photos * 10;
  }
  return { low: Math.round(low), high: Math.round(high) };
}

export async function runPipeline(assetId: number, emit: Emit, opts: RunOptions = {}): Promise<PipelineResult> {
  const fresh = opts.reuseStoredEvidence !== true;
  const stages = initialStages(fresh);
  const set = (key: string, state: StageState, detail?: string, note?: string) => {
    const st = stages.find((s) => s.key === key);
    if (st) {
      st.state = state;
      if (detail) st.detail = detail;
    }
    emit(stages.map((s) => ({ ...s })), note);
  };

  /* -------- 1. Gather corrective history -------- */
  set("gather", "running");
  const bundle = await fn<Bundle>("gather", { assetId, maxWos: 40 });
  set(
    "gather",
    "done",
    `${bundle.total_corrective_work_orders} corrective work orders, ${bundle.photos_available} BEFORE photos`
  );

  /* -------- 2. Work-order evidence stream -------- *
   * The wo-evidence agent reads each work order's own wording and reports the issue,
   * component, severity and confidence. It replaced a keyword table that wrote severity
   * "unknown" and confidence 0.55 into every row it produced, which made 45% of the
   * condition score a constant for any asset without readable photos.
   *
   * No try/catch, on purpose. A failed agent must fail the asset — `runBatch` retries
   * once and then flags it — because storing nothing quietly would leave `assess` to
   * compute a perfectly plausible score with no severity evidence behind it. The delete
   * is folded into `save-wo-evidence`, so a failure here leaves the previous stream
   * standing instead of emptying the asset.                                           */
  set("text", "running");
  const prep = await fn<{ work_orders: number; wos_json: string; chunks: Array<{ input: string }> }>(
    "wo-evidence-input",
    { assetId }
  );

  const woFindings: unknown[] = [];
  for (let i = 0; i < prep.chunks.length; i++) {
    if (prep.chunks.length > 1) {
      set("text", "running", `Reading work orders — batch ${i + 1} of ${prep.chunks.length}`);
    }
    const reply = await runAgent<{ findings?: unknown[] }>(prep.chunks[i].input, undefined, "wo-evidence");
    woFindings.push(...(reply?.findings || []));
  }

  const text = await fn<{
    inserted: number;
    replaced: number;
    duplicates: number;
    rejected: string[];
    unquoted: string[];
  }>("save-wo-evidence", {
    assetId,
    payload: JSON.stringify({ findings: woFindings }),
    wos: prep.wos_json,
    // Stringified: handler parameters accept only numbers and strings.
    replace: fresh ? "true" : "false",
  });

  // Discarded claims are named, not swallowed. A quote the engine could not find in the
  // work order is the lock doing its job, and someone comparing finding counts between
  // two runs needs to see that rather than wonder where the rows went.
  const discarded = (text.unquoted?.length || 0) + (text.rejected?.length || 0);
  set(
    "text",
    "done",
    `${text.inserted} issue${text.inserted === 1 ? "" : "s"} read from ${prep.work_orders} work order${
      prep.work_orders === 1 ? "" : "s"
    }` +
      (fresh && text.replaced ? `, ${text.replaced} replaced` : "") +
      (discarded ? `, ${discarded} unverifiable claim${discarded === 1 ? "" : "s"} discarded` : "")
  );

  /* -------- 3. Photo bytes -------- */
  // Two different questions, and a fresh run needs them to differ. `onRecord` is what
  // earlier runs actually analysed — true either way, and what the "we tried and could
  // not" message below has to name. `alreadyDone` is only what THIS run may skip, and
  // is empty when fresh, because the whole point is to look again.
  const onRecord = new Set(bundle.analyzed_attachment_ids || []);
  const alreadyDone = fresh ? new Set<number>() : onRecord;
  const wosWithPhotos = bundle.work_orders.filter((w) => w.photos.length > 0);
  const pending = wosWithPhotos.filter((w) => w.photos.some((p) => !alreadyDone.has(p.attachment_id)));

  let photoMode: PhotoMode = "none";
  let uploads: Array<{ wo: GatheredWo; files: Array<{ attachmentId: number; fileId: number; filename: string }> }> = [];

  // How many of this asset's photos already carry findings from an earlier run.
  // This is what separates "this asset has no visual evidence" from "there was
  // nothing new to fetch" — the two used to report identically, so an asset with
  // ten analysed photos and one unreadable new one looked like a total failure.
  const cachedCount = wosWithPhotos.reduce(
    (n, w) => n + w.photos.filter((p) => onRecord.has(p.attachment_id)).length,
    0
  );

  if (wosWithPhotos.length === 0) {
    set("photos", "skipped", "No BEFORE photos on this asset's corrective work orders");
    set("agent", "skipped", "Nothing to analyze visually — work-order evidence only");
  } else if (pending.length === 0) {
    set("photos", "skipped", `All ${cachedCount} photos already analyzed (cached)`);
    set("agent", "skipped", "Reusing cached photo findings");
    photoMode = "cmms_direct";
  } else {
    set("photos", "running");
    const outcome = await loadPhotos(pending, alreadyDone, (msg) => set("photos", "running", msg));
    uploads = outcome.uploads;
    photoMode = outcome.mode;
    const loaded = outcome.uploads.reduce((a, u) => a + u.files.length, 0);

    if (loaded > 0) {
      set("photos", "done", `${loaded} photo${loaded === 1 ? "" : "s"} ${fresh ? "re-read" : "read"} live from the CMMS`);
    } else if (cachedCount > 0) {
      // Nothing new could be read, but earlier runs already analysed most of the
      // asset. The assessment is not degraded, so this is not a failure.
      //
      // The wording has to split by mode. A skipped agent stage means "there was
      // nothing new" on a reusing run, but on a fresh run it means "we went to look
      // again and the bytes would not come" — reporting that as reuse would claim a
      // choice the run never made.
      const unreadable = outcome.unreadable;
      set(
        "photos",
        "done",
        fresh
          ? `Could not re-read ${unreadable} photo${unreadable === 1 ? "" : "s"} — the ${cachedCount} finding${
              cachedCount === 1 ? "" : "s"
            } already on record stand`
          : `${cachedCount} photo${cachedCount === 1 ? "" : "s"} already analyzed; ${unreadable} new photo${
              unreadable === 1 ? "" : "s"
            } could not be read`
      );
      set(
        "agent",
        "skipped",
        fresh
          ? "Photos could not be re-read from the CMMS — existing findings kept"
          : `Reusing ${cachedCount} cached photo findings`
      );
    } else {
      set("photos", "failed", outcome.reason || "Could not read any photo bytes");
      set("agent", "skipped", "No readable photo evidence");
    }
  }

  /* -------- 4. The agent -------- */
  let analysis: Analysis | null = null;
  let photosAnalyzed = 0;

  const totalPhotos = uploads.reduce((a, u) => a + u.files.length, 0);
  if (totalPhotos > 0) {
    set("agent", "running");
    const assetCtx = describeAsset(bundle);

    if (totalPhotos <= SINGLE_RUN_PHOTO_LIMIT && uploads.length <= 3) {
      // Small asset: one run, exactly as the spec describes.
      const input = [
        "MODE: FULL ANALYSIS",
        assetCtx,
        `Total corrective work orders for this asset: ${bundle.total_corrective_work_orders}`,
        "",
        "Corrective work orders and their BEFORE photos (attached images, in this order):",
        ...uploads.map((u) => describeWo(u.wo, u.files.map((f) => f.filename))),
      ].join("\n");
      analysis = await runAgent<Analysis>(input, uploads.flatMap((u) => u.files.map((f) => f.fileId)));
      photosAnalyzed = totalPhotos;
      set("agent", "done", `1 agent run over ${totalPhotos} photos${fresh ? " (re-analyzed)" : ""}`);
    } else {
      // Larger asset: one run per work order, then a consolidation run.
      const perWo: Analysis[] = [];
      for (let i = 0; i < uploads.length; i++) {
        const u = uploads[i];
        const files = u.files.slice(0, AGENT_FILE_CAP);
        const input = [
          "MODE: SINGLE WORK ORDER",
          assetCtx,
          "",
          "This is ONE corrective work order. Every attached image is a BEFORE photo of this same work order,",
          "so each distinct issue you find here has occurrence_count 1 regardless of how many photos show it.",
          describeWo(u.wo, files.map((f) => f.filename)),
        ].join("\n");
        set("agent", "running", `Work order ${u.wo.wo_id} — ${i + 1} of ${uploads.length} (${files.length} photos)`);
        const res = await runAgent<Analysis>(input, files.map((f) => f.fileId));
        perWo.push(res);
        photosAnalyzed += files.length;
      }

      set("agent", "running", `Consolidating ${perWo.length} work-order analyses`);
      const consolidationInput = [
        "MODE: CONSOLIDATION",
        assetCtx,
        `Total corrective work orders for this asset: ${bundle.total_corrective_work_orders}`,
        "",
        "Per-work-order analyses to merge. Count each work order once per issue.",
        JSON.stringify(perWo),
      ].join("\n");
      analysis = await runAgent<Analysis>(consolidationInput);
      set(
        "agent",
        "done",
        `${perWo.length} work-order runs + 1 consolidation run over ${photosAnalyzed} photos${
          fresh ? " (re-analyzed)" : ""
        }`
      );
    }

    /* -------- 5. Persist findings -------- */
    set("findings", "running");
    const findings = toFindingRows(analysis, uploads);

    let superseded = 0;
    if (fresh) {
      // Replace, never append. `assess` weights every finding ROW into the condition
      // score, so a photo the agent judged `corrosion` last run and `crack` this run
      // would leave two rows past save-findings' (attachment_id, issue_code) guard and
      // vote twice — the grade would move on data that never changed.
      //
      // The list comes from the rows just produced, never from the photos this run set
      // out to read. A photo whose bytes were unreadable, or that the agent left out of
      // its reply, is absent from it and so keeps the finding it already had rather
      // than losing it to a delete nothing refills. That makes the whole path
      // self-limiting: it can only delete evidence it has already replaced.
      const replacing: number[] = [];
      for (const r of findings) {
        const id = Number(r.attachment_id);
        if (id > 0 && replacing.indexOf(id) === -1) replacing.push(id);
      }
      if (replacing.length > 0) {
        const cleared = await fn<{ deleted: number }>("clear-attachment-findings", {
          assetId,
          attachmentIds: replacing.join(","),
        });
        superseded = cleared.deleted;
      }
    }

    const saved = await fn<{ inserted: number; skipped_duplicates: number; rejected: string[] }>("save-findings", {
      assetId,
      payload: JSON.stringify({ findings }),
    });
    set(
      "findings",
      "done",
      (fresh
        ? `${saved.inserted} stored, ${superseded} superseded`
        : `${saved.inserted} stored, ${saved.skipped_duplicates} already present`) +
        (saved.rejected.length ? `, ${saved.rejected.length} rejected` : "")
    );
  } else {
    set("findings", "skipped", "No photo findings to store");

    /* -------- 4b. The same agent, over work-order evidence -------- *
     * Without this the asset-level analysis simply does not happen on a photo-less asset:
     * `analysis` stays null, `save-analysis` receives "{}", and every card falls back to
     * engine defaults — even though `wo-evidence` has already graded each finding under
     * them. The agent is given those stored findings rather than the work-order text so
     * that only one agent ever reads the wording; see `consolidation-input`.           */
    const prep = await fn<{ work_orders: number; findings: number; input: string }>("consolidation-input", {
      assetId,
      totalCorrective: bundle.total_corrective_work_orders,
    });

    if (prep.findings > 0) {
      set("agent", "running", `Consolidating work-order evidence from ${prep.work_orders} work orders`);
      analysis = await runAgent<Analysis>(prep.input, undefined, "photo-validation");
      set(
        "agent",
        "done",
        `1 consolidation run over ${prep.findings} work-order finding${prep.findings === 1 ? "" : "s"} — no photographs`
      );
    } else {
      set("agent", "skipped", "No corrective findings to consolidate");
    }
  }

  /* -------- 6. Consolidate with engine-owned arithmetic -------- */
  set("analysis", "running");
  const savedAnalysis = await fn<{ analysis: Analysis; count_mismatches: string[] }>("save-analysis", {
    assetId,
    totalCorrective: bundle.total_corrective_work_orders,
    analysis: JSON.stringify(analysis ?? {}),
  });
  const mismatches = savedAnalysis.count_mismatches || [];
  set(
    "analysis",
    "done",
    mismatches.length
      ? `${savedAnalysis.analysis.recurring_issues.length} issues counted — ${mismatches.length} agent count(s) corrected`
      : `${savedAnalysis.analysis.recurring_issues.length} issues counted from distinct work orders`
  );

  /* -------- 7. Lifecycle engines -------- */
  set("assess", "running");
  const assessment = await fn<Assessment>("assess", { assetId });
  const mtbfNote =
    assessment.dominant_issue_mtbf?.verdict?.available && assessment.dominant_issue_mtbf.mean_months.available
      ? ` · ${assessment.dominant_issue_mtbf.issue_label} MTBF ${assessment.dominant_issue_mtbf.mean_months.value}mo ${assessment.dominant_issue_mtbf.verdict.value}`
      : "";
  set(
    "assess",
    "done",
    `${assessment.recommendation} · risk ${assessment.risk_score}/100 · RUL ${assessment.rul_years}y${mtbfNote}`
  );

  /* -------- 8. The core agent: one call, four jobs -------- *
   * It explains THIS run's numbers, and its inspection observations and baseline
   * constants are stored for the NEXT one. That lag is deliberate: the numbers it is
   * asked to explain must already be final, so evidence it contributes cannot move
   * the score it is describing.                                                    */
  set("core", "running");
  let narrativeAccepted = false;
  let narrativeRejectedFigures: string[] = [];
  let observationsKept = 0;
  let inspectionCount = 0;
  try {
    const prep = await fn<{ input: string; block: string; answers: unknown[]; inspection_count: number }>(
      "core-input",
      { assetId }
    );
    inspectionCount = prep.inspection_count || 0;
    set(
      "core",
      "running",
      inspectionCount > 0
        ? `Reading ${inspectionCount} closed inspection(s) and explaining the result`
        : "Explaining the result — no closed inspection on this asset"
    );

    const reply = await runAgent<unknown>(prep.input, undefined, "condition-core");
    const saved = await fn<{
      accepted: boolean;
      unseen_figures: string[];
      observations_kept: number;
      observations_unquoted: string[];
      inspection_findings_inserted: number;
    }>("save-core", {
      assetId,
      block: prep.block,
      answers: JSON.stringify(prep.answers || []),
      reply: JSON.stringify(reply),
    });

    narrativeAccepted = saved.accepted;
    narrativeRejectedFigures = saved.unseen_figures || [];
    observationsKept = saved.observations_kept || 0;

    const obsNote =
      inspectionCount > 0
        ? ` · ${observationsKept} inspector observation(s) recorded${
            saved.observations_unquoted?.length ? `, ${saved.observations_unquoted.length} unquoted claim(s) discarded` : ""
          }`
        : "";
    set(
      "core",
      saved.accepted ? "done" : "failed",
      saved.accepted
        ? `Explanation verified against the computed values${obsNote}`
        : `Explanation rejected — it contained figures not in the input: ${narrativeRejectedFigures.join(", ")}${obsNote}`
    );
  } catch (e: any) {
    set("core", "failed", "Could not run the core analysis — the computed results stand on their own");
  }

  return {
    bundle,
    analysis: savedAnalysis.analysis,
    assessment,
    photoMode,
    photosAnalyzed,
    countMismatches: mismatches,
    narrativeAccepted,
    narrativeRejectedFigures,
    observationsKept,
    inspectionCount,
  };
}

function describeAsset(bundle: Bundle): string {
  const a = bundle.asset;
  return [
    "Asset information:",
    `asset_id: ${a.asset_id}`,
    `asset_name: ${a.asset_name}`,
    `asset_type: ${a.asset_type}`,
    `manufacturer: ${a.manufacturer || "unknown"}`,
    `model: ${a.model || "unknown"}`,
    `location: ${a.location || "unknown"}`,
  ].join("\n");
}

function describeWo(wo: GatheredWo, photoNames: string[]): string {
  return [
    "",
    `work_order_id: ${wo.wo_id}`,
    `work_order_type: CORRECTIVE (${wo.type})`,
    `created_date: ${wo.event_date.slice(0, 10)}`,
    `priority: ${wo.priority}`,
    `problem_description: ${wo.subject}`,
    `issue_description: ${wo.description}`,
    `before_photos: ${photoNames.map((n, i) => `photo_id=P${i + 1} (${n})`).join(", ") || "none"}`,
  ].join("\n");
}

/**
 * Get before-photo bytes into the app file store.
 *
 * There is exactly one source: the live pre-signed URL Facilio mints for the
 * attachment. No local copy, no substitute — a photo the app cannot fetch from
 * Facilio is reported unreadable rather than filled in from somewhere else.
 *
 * That currently means no photo can be analysed at all, because the storage host
 * sends no `Access-Control-Allow-Origin` header: the browser receives 200 OK with
 * the body withheld, and `fetch` rejects with a bare TypeError carrying no status.
 * The failure is indistinguishable from a dead network from inside the page, which
 * is why the reason below names the likely cause without asserting it.
 */
async function loadPhotos(
  wos: GatheredWo[],
  alreadyDone: Set<number>,
  progress: (msg: string) => void
): Promise<{
  uploads: Array<{ wo: GatheredWo; files: Array<{ attachmentId: number; fileId: number; filename: string }> }>;
  mode: PhotoMode;
  unreadable: number;
  reason?: string;
}> {
  const uploads: Array<{ wo: GatheredWo; files: Array<{ attachmentId: number; fileId: number; filename: string }> }> = [];
  let direct = 0;
  let failed = 0;
  let lastReason = "";

  for (const wo of wos) {
    progress(`Work order ${wo.wo_id}…`);
    let signed: Array<{ attachment_id: number; filename: string; signed_url: string; content_type: string }> = [];
    try {
      const res = await fn<{ photos: typeof signed }>("photo-urls", { woId: wo.wo_id });
      signed = res.photos || [];
    } catch (e) {
      lastReason = `photo-urls failed for work order ${wo.wo_id}`;
    }

    const files: Array<{ attachmentId: number; fileId: number; filename: string }> = [];
    for (const p of signed) {
      if (alreadyDone.has(p.attachment_id)) continue;

      let blob: Blob | null = null;
      let inlineErr = "";

      // Primary: the facilio-cmms-files companion action returns the photo
      // base64-encoded inside JSON, via the app's own origin — no cross-origin
      // read ever happens, so this works where the signed-URL fetch below
      // usually cannot.
      try {
        const res = await fileAction<{ file_base64?: string; content_type?: string }>(
          "download-work-order-attachment",
          { work_order_id: wo.wo_id, attachment_id: p.attachment_id }
        );
        if (res?.file_base64) {
          const bin = atob(res.file_base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          blob = new Blob([bytes], { type: res.content_type || p.content_type || "image/jpeg" });
        } else {
          // 2xx but no file channel — the platform reports action errors this way too.
          inlineErr = `no file_base64 in response: ${JSON.stringify(res ?? null).slice(0, 200)}`;
        }
      } catch (e) {
        // VibeError carries the runtime's status + body — keep it for the step detail.
        inlineErr = e instanceof Error ? e.message : String(e);
      }

      // Fallback: fetch the pre-signed URL directly. Fails in browsers unless
      // the storage host starts sending CORS headers; kept so the app heals
      // itself the day that policy lands.
      if (!blob && p.signed_url) {
        try {
          const r = await fetch(p.signed_url);
          if (r.ok) blob = await r.blob();
        } catch {
          // Cross-origin read refused. Nothing to inspect: no status, no headers.
        }
      }

      if (!blob) {
        failed++;
        lastReason = inlineErr
          ? `inline download failed — ${inlineErr}`
          : lastReason ||
            "Photo bytes unreachable: the inline download failed and the pre-signed URL is not readable from a browser (no cross-origin permission)";
        continue;
      }

      const stored: any = await vibe.uploadFile(new File([blob], p.filename, { type: p.content_type || "image/jpeg" }));
      files.push({ attachmentId: p.attachment_id, fileId: stored.fileId ?? stored.id, filename: p.filename });
      direct++;
    }

    if (files.length > 0) uploads.push({ wo, files });
  }

  const mode: PhotoMode = direct > 0 ? "cmms_direct" : failed > 0 ? "unavailable" : "none";

  return { uploads, mode, unreadable: failed, reason: lastReason };
}

/**
 * Flatten the agent's per-photo defects into finding rows.
 * The photo_id the agent used is positional (P1, P2…), so it is mapped back to
 * the real attachment id here — that mapping is what keeps every finding
 * traceable to its work order and photo (spec STEP 4).
 */
function toFindingRows(
  analysis: Analysis | null,
  uploads: Array<{ wo: GatheredWo; files: Array<{ attachmentId: number; fileId: number; filename: string }> }>
) {
  if (!analysis?.photo_analysis?.length) return [];

  const byWo = new Map<string, { wo: GatheredWo; files: Array<{ attachmentId: number; fileId: number; filename: string }> }>();
  for (const u of uploads) byWo.set(String(u.wo.wo_id), u);

  const rows: any[] = [];
  for (const pa of analysis.photo_analysis) {
    const u = byWo.get(String(pa.work_order_id));
    if (!u) continue;

    // "P2" → index 1; otherwise match on filename.
    const idxMatch = /^P(\d+)$/i.exec(String(pa.photo_id).trim());
    let file = idxMatch ? u.files[Number(idxMatch[1]) - 1] : undefined;
    if (!file) file = u.files.find((f) => f.filename === pa.photo_id);
    if (!file) file = u.files[0];
    if (!file) continue;

    if (!pa.usable || pa.defects.length === 0) {
      // Record the unusable photo itself so data quality can report it honestly.
      rows.push({
        wo_id: u.wo.wo_id,
        attachment_id: file.attachmentId,
        issue_code: "other_visible_abnormality",
        component: "unspecified",
        location: "",
        severity: "unknown",
        confidence: 0,
        extent_percent: 0,
        evidence: pa.quality_issues.length
          ? [`Photo not usable as evidence: ${pa.quality_issues.join(", ")}.`]
          : ["Photo produced no visible defect evidence."],
        photo_file_id: file.fileId,
        photo_usable: false,
        photo_quality_score: pa.quality_score,
        asset_type_match: pa.asset_type_match,
        component_match: pa.component_match,
        event_date: u.wo.event_date,
        unusable_marker: true,
      });
      continue;
    }

    for (const d of pa.defects) {
      rows.push({
        wo_id: u.wo.wo_id,
        attachment_id: file.attachmentId,
        issue_code: d.type,
        component: d.component,
        location: d.location,
        severity: d.severity,
        confidence: d.confidence,
        extent_percent: d.extent_percent,
        evidence: d.evidence,
        photo_file_id: file.fileId,
        photo_usable: true,
        photo_quality_score: pa.quality_score,
        asset_type_match: pa.asset_type_match,
        component_match: pa.component_match,
        event_date: u.wo.event_date,
      });
    }
  }
  return rows;
}
