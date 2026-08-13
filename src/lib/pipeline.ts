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
import { fn, runAgent, vibe } from "./vibe";
import type { Analysis, Bundle, GatheredWo } from "./types";

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
  assessment: any;
  photoMode: PhotoMode;
  photosAnalyzed: number;
  countMismatches: string[];
}

/** Where the analysed image bytes came from — surfaced in the UI, never hidden. */
export type PhotoMode =
  | "none" // asset has no before photos at all
  | "cmms_direct" // bytes read straight from the CMMS signed URL
  | "bundled_fallback" // signed URL not readable cross-origin; used the bundled copy
  | "unavailable"; // photos exist but no route to their bytes

const AGENT_FILE_CAP = 10; // platform limit: max files per agent run
const SINGLE_RUN_PHOTO_LIMIT = 6; // above this, batch per work order then consolidate

export const INITIAL_STAGES: Stage[] = [
  { key: "gather", label: "Fetch corrective history", detail: "Corrective work orders and BEFORE photos from Facilio", state: "pending" },
  { key: "text", label: "Normalize work-order text", detail: "Derive issue codes from work-order wording", state: "pending" },
  { key: "photos", label: "Load photo evidence", detail: "Fetch before-photo bytes for analysis", state: "pending" },
  { key: "agent", label: "Analyze photos", detail: "photo-validation agent, batched one run per work order", state: "pending" },
  { key: "findings", label: "Store findings", detail: "Validate and persist, deduped per attachment", state: "pending" },
  { key: "analysis", label: "Count occurrences and consolidate", detail: "Engine recomputes every count; agent keeps judgment", state: "pending" },
  { key: "assess", label: "Run lifecycle engines", detail: "Condition, deterioration, RUL, risk, CAPEX, recommendation", state: "pending" },
];

type Emit = (stages: Stage[], note?: string) => void;

/** Bundled copies of the demo evidence, keyed by the attachment filename. */
const BUNDLED_EVIDENCE = new Set([
  "corrosion_a1.jpg",
  "corrosion_a2.jpg",
  "corrosion_a3.jpg",
  "insulation_a1.jpg",
  "crack_a1.jpg",
]);

export async function runPipeline(assetId: number, emit: Emit): Promise<PipelineResult> {
  const stages = INITIAL_STAGES.map((s) => ({ ...s }));
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

  /* -------- 2. Work-order text stream -------- */
  set("text", "running");
  const text = await fn<{ inserted: number; work_orders_scanned: number; unmatched: number }>("normalize-wo-text", {
    assetId,
  });
  set("text", "done", `${text.inserted} issues from ${text.work_orders_scanned} work orders (${text.unmatched} no match)`);

  /* -------- 3. Photo bytes -------- */
  const alreadyDone = new Set(bundle.analyzed_attachment_ids || []);
  const wosWithPhotos = bundle.work_orders.filter((w) => w.photos.length > 0);
  const pending = wosWithPhotos.filter((w) => w.photos.some((p) => !alreadyDone.has(p.attachment_id)));

  let photoMode: PhotoMode = "none";
  let uploads: Array<{ wo: GatheredWo; files: Array<{ attachmentId: number; fileId: number; filename: string }> }> = [];

  if (wosWithPhotos.length === 0) {
    set("photos", "skipped", "No BEFORE photos on this asset's corrective work orders");
    set("agent", "skipped", "Nothing to analyze visually — work-order text stream only");
  } else if (pending.length === 0) {
    set("photos", "skipped", `All ${bundle.photos_available} photos already analyzed (cached)`);
    set("agent", "skipped", "Reusing cached photo findings");
    photoMode = "cmms_direct";
  } else {
    set("photos", "running");
    const outcome = await loadPhotos(pending, alreadyDone, (msg) => set("photos", "running", msg));
    uploads = outcome.uploads;
    photoMode = outcome.mode;
    const total = outcome.uploads.reduce((a, u) => a + u.files.length, 0);
    if (total === 0) {
      set("photos", "failed", outcome.reason || "Could not read any photo bytes");
      set("agent", "skipped", "No readable photo evidence");
    } else {
      set(
        "photos",
        "done",
        photoMode === "bundled_fallback"
          ? `${total} photos loaded from bundled evidence (Facilio signed URLs are not readable cross-origin)`
          : `${total} photos loaded from Facilio`
      );
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
      set("agent", "done", `1 agent run over ${totalPhotos} photos`);
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
      set("agent", "done", `${perWo.length} work-order runs + 1 consolidation run over ${photosAnalyzed} photos`);
    }

    /* -------- 5. Persist findings -------- */
    set("findings", "running");
    const findings = toFindingRows(analysis, uploads);
    const saved = await fn<{ inserted: number; skipped_duplicates: number; rejected: string[] }>("save-findings", {
      assetId,
      payload: JSON.stringify({ findings }),
    });
    set(
      "findings",
      "done",
      `${saved.inserted} stored, ${saved.skipped_duplicates} already present${
        saved.rejected.length ? `, ${saved.rejected.length} rejected` : ""
      }`
    );
  } else {
    set("findings", "skipped", "No photo findings to store");
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
  const assessment = await fn("assess", { assetId });
  set("assess", "done", `${assessment.recommendation} · risk ${assessment.risk_score}/100 · RUL ${assessment.rul_years}y`);

  return {
    bundle,
    analysis: savedAnalysis.analysis,
    assessment,
    photoMode,
    photosAnalyzed,
    countMismatches: mismatches,
  };
}

/* ------------------------------------------------------------------ */

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
 * Attempt order, most faithful first:
 *   1. the CMMS pre-signed URL (fails today: the S3 bucket sends no CORS header)
 *   2. a bundled copy of the same file, served same-origin by this app
 * Whichever succeeds is reported to the UI so the source of the evidence is
 * always visible.
 */
async function loadPhotos(
  wos: GatheredWo[],
  alreadyDone: Set<number>,
  progress: (msg: string) => void
): Promise<{
  uploads: Array<{ wo: GatheredWo; files: Array<{ attachmentId: number; fileId: number; filename: string }> }>;
  mode: PhotoMode;
  reason?: string;
}> {
  const uploads: Array<{ wo: GatheredWo; files: Array<{ attachmentId: number; fileId: number; filename: string }> }> = [];
  let direct = 0;
  let bundled = 0;
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
      let via: "cmms" | "bundled" | null = null;

      if (p.signed_url) {
        try {
          const r = await fetch(p.signed_url);
          if (r.ok) {
            blob = await r.blob();
            via = "cmms";
          }
        } catch {
          // Cross-origin read blocked — expected until the bucket allows it.
        }
      }

      if (!blob && BUNDLED_EVIDENCE.has(p.filename)) {
        try {
          const r = await fetch(`${import.meta.env.BASE_URL}evidence/${p.filename}`);
          if (r.ok) {
            blob = await r.blob();
            via = "bundled";
          }
        } catch {
          /* fall through */
        }
      }

      if (!blob) {
        failed++;
        lastReason =
          lastReason ||
          "Facilio's pre-signed photo URLs are not readable cross-origin, and no bundled copy exists for this file";
        continue;
      }

      const stored: any = await vibe.uploadFile(new File([blob], p.filename, { type: p.content_type || "image/jpeg" }));
      files.push({ attachmentId: p.attachment_id, fileId: stored.fileId ?? stored.id, filename: p.filename });
      if (via === "cmms") direct++;
      else bundled++;
    }

    if (files.length > 0) uploads.push({ wo, files });
  }

  const mode: PhotoMode =
    direct > 0 && bundled === 0
      ? "cmms_direct"
      : bundled > 0
      ? "bundled_fallback"
      : failed > 0
      ? "unavailable"
      : "none";

  return { uploads, mode, reason: lastReason };
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
