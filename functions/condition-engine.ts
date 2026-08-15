/**
 * condition-engine — server-side brain of the Condition Assessment Agent.
 *
 * Owns everything deterministic: fetching corrective work orders and their
 * BEFORE photos from Facilio CMMS, verifying what the agents report about them,
 * counting occurrences (STEP 5/6/8 of the agent spec), and the
 * downstream lifecycle engines (condition, deterioration, RUL, risk, CAPEX,
 * recommendation).
 *
 * The LLM never does arithmetic here. `save-analysis` takes the photo-validation
 * agent's reply and overwrites every count/rate/reference with values recomputed
 * from the findings table, so an agent miscount can't reach the register.
 */
import StudioFunctions, { StudioDatabase, VibeEvents } from "@facilio/studio-functions";

const server = new StudioFunctions({ name: "condition-engine" });
const events = new VibeEvents();

/* ------------------------------------------------------------------ *
 * Infrastructure helpers
 * ------------------------------------------------------------------ */

function conn() {
  return new StudioDatabase({
    userName: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    schema: process.env.SCHEMA,
  });
}

/** Call a facilio-cmms connection action. The host attaches the service token. */
async function cmms(action: string, input: Record<string, unknown>): Promise<any> {
  const base = (process as any).system.CONNECTIONS_URL;
  const res = await fetch(`${base}/api/v1/connections/facilio-cmms/actions/${action}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  if (!res.ok) throw new Error(`cmms ${action} failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json && json.success === false) {
    const msg = json.error ? JSON.stringify(json.error) : "unknown error";
    throw new Error(`cmms ${action} error: ${msg}`);
  }
  return json;
}

/** `numeric` columns come back as strings from Postgres — always coerce. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "0"));
  return isNaN(n) ? 0 : n;
}

function nextId(db: any, table: string): number {
  const { rows } = db.query(`select coalesce(max(id), 0) + 1 as nid from ${table}`);
  return num(rows[0]?.nid) || 1;
}

function nowIso(): string {
  // Date is unavailable for "now" in some sandboxes; derive from a fetchless source.
  return new Date().toISOString();
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round(v: number, dp: number): number {
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

/* ------------------------------------------------------------------ *
 * Issue taxonomy — MUST stay identical to the photo-validation agent's
 * output-schema enum, otherwise normalization leaks synonyms.
 * ------------------------------------------------------------------ */

const ISSUE_CODES = [
  "corrosion",
  "leakage",
  "oil_leakage",
  "crack_fracture",
  "dent_deformation",
  "broken_component",
  "missing_component",
  "insulation_damage",
  "coating_deterioration",
  "fouling",
  "scaling",
  "thermal_damage",
  "loose_component",
  "physical_wear",
  "surface_deterioration",
  "other_visible_abnormality",
];

const ISSUE_LABELS: Record<string, string> = {
  corrosion: "Corrosion",
  leakage: "Leakage",
  oil_leakage: "Oil Leakage",
  crack_fracture: "Crack / Fracture",
  dent_deformation: "Dent / Deformation",
  broken_component: "Broken Component",
  missing_component: "Missing Component",
  insulation_damage: "Insulation Damage",
  coating_deterioration: "Coating Deterioration",
  fouling: "Fouling",
  scaling: "Scaling",
  thermal_damage: "Thermal Damage",
  loose_component: "Loose Component",
  physical_wear: "Physical Wear",
  surface_deterioration: "Surface Deterioration",
  other_visible_abnormality: "Other Visible Abnormality",
};

/**
 * Component vocabulary for work-order findings.
 *
 * The wo-evidence agent picks from this list and `save-wo-evidence` rejects anything
 * outside it. It is the same set the regex table that preceded the agent produced, kept
 * deliberately: components are grouped and counted across findings, so rows written
 * before and after the agent took the job over have to speak the same words.
 */
const COMPONENT_CODES = [
  "compressor",
  "impeller",
  "coil",
  "strainer",
  "bearing",
  "seal",
  "motor",
  "piping",
  "electrical_panel",
  "fan",
  "pump_body",
  "valve",
  "housing",
  "duct",
  "belt",
  "unspecified",
];

/* ------------------------------------------------------------------ *
 * Severity handling — spec STEP 9 keeps severity independent of frequency.
 * ------------------------------------------------------------------ */

const SEV_ORDER = ["unknown", "low", "medium", "high", "critical"];
const SEV_VALUE: Record<string, number> = {
  unknown: 2.5,
  low: 2,
  medium: 3,
  high: 4,
  critical: 5,
};

/**
 * What the wo-evidence agent may answer, mapped to what the table stores.
 *
 * The agent says `not_graded` because that is what it means — it read the wording and
 * found no severity in it. The table stores `unknown`, which is the token SEV_ORDER,
 * SEV_VALUE and worstSeverity() already speak and which rows written before this agent
 * existed already carry. Renaming the stored token would mean migrating those rows and
 * touching three helpers to gain nothing: the word a reader sees is set by the UI label.
 *
 * `unknown` is NOT scored at SEV_VALUE's 2.5 midpoint any more — the severity stream
 * filters these rows out entirely. See the query in `assess`.
 */
const AGENT_SEVERITY: Record<string, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical",
  not_graded: "unknown",
};

/* ------------------------------------------------------------------ *
 * The quote lock.
 *
 * An LLM judging a photograph cannot be checked — the engine never sees the image. An
 * LLM judging TEXT can be: the engine holds the same sentence the model read, so every
 * claim must cite a span that is genuinely in it. A claim whose quote is absent is
 * discarded rather than stored as something the source said.
 *
 * Whitespace is collapsed and case ignored because models re-wrap and re-case what they
 * copy. The 12-character floor is what stops the check from being decorative: a quote of
 * "rust" would match half the corpus and certify a fabricated finding.
 * ------------------------------------------------------------------ */

const MIN_QUOTE_CHARS = 12;

const flattenForQuote = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

function quoteFoundIn(sourceText: string, quote: string): boolean {
  const q = flattenForQuote(String(quote || ""));
  if (q.length < MIN_QUOTE_CHARS) return false;
  const src = flattenForQuote(String(sourceText || ""));
  return src.length > 0 && src.indexOf(q) >= 0;
}

/**
 * One spelling per component.
 *
 * The two agents write this field under different conventions. `wo-evidence` is held to
 * COMPONENT_CODES and writes `compressor_housing`; `photo-validation` has no enum on its
 * `component` and writes what it reads, including `compressor housing`. Everything
 * downstream groups on the exact string, so those became two rows that `pretty()` then
 * rendered as the same chip twice — "Compressor Housing ×2" beside "Compressor Housing ×1".
 *
 * Underscore is the joiner, not space: COMPONENT_CODES itself holds `electrical_panel` and
 * `pump_body`, so canonicalising toward spaces would push those out of their own enum.
 */
const canonicalComponent = (s: string) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unspecified";

/* ------------------------------------------------------------------ *
 * Findings provenance.
 *
 * One table holds three kinds of row and they must never be mixed:
 *
 *   corrective evidence  photo / photo_manual / wo_text — a failure happened
 *   evidence about it    photo_unusable — a photo that could not be read
 *   inspection evidence  inspection — a scheduled walkthrough, no failure implied
 *
 * Inspection rows reuse `wo_id` for the inspection id and `attachment_id` for the
 * answer id, because the app database allows no DDL. So every query that means
 * "corrective work order" must say so: counting an inspection id as a distinct work
 * order invents an occurrence, and letting an inspection severity into the 0.45
 * severity stream lets one defect vote twice, since it already carries the 0.35
 * inspection stream.
 * ------------------------------------------------------------------ */

const isCorrectiveEvidence = (source: string) =>
  source === "photo" || source === "photo_manual" || source === "wo_text";

/** SQL list for queries keyed on `attachment_id`, where an answer id could collide. */
const PHOTO_SOURCES_SQL = "('photo','photo_manual','photo_unusable')";

function worstSeverity(levels: string[]): string {
  let best = "unknown";
  let bestRank = -1;
  for (const l of levels) {
    const r = SEV_ORDER.indexOf(l);
    if (r > bestRank) {
      bestRank = r;
      best = l;
    }
  }
  return best;
}

function sortSeverities(levels: string[]): string[] {
  return levels.slice().sort((a, b) => SEV_ORDER.indexOf(a) - SEV_ORDER.indexOf(b));
}

/* ------------------------------------------------------------------ *
 * Attachment URL extraction — the CMMS attachment record shape varies, so
 * probe the common key names rather than assuming one.
 * ------------------------------------------------------------------ */

const URL_KEYS = [
  "downloadUrl",
  "url",
  "previewUrl",
  "contentUrl",
  "filePath",
  "fileUrl",
  "signedUrl",
  "publicUrl",
];

function pickUrl(att: Record<string, any>): string {
  for (const k of URL_KEYS) {
    const v = att[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "";
}

/* ------------------------------------------------------------------ *
 * Metric envelopes.
 *
 * Fields are routinely empty in a real CMMS, and the dangerous failure is silent
 * coercion: a mean over null durations yields MTTR = 0, which reads as "every
 * repair is instant" and makes a failing asset look healthy. Zero and unknown must
 * never be the same value, so every derived metric is an envelope and callers have
 * to check `available` before reading `value`.
 * ------------------------------------------------------------------ */

interface Metric<T> {
  value: T | null;
  available: boolean;
  reason?: string;
  basis?: number;
}

function have<T>(value: T, basis?: number): Metric<T> {
  return basis === undefined ? { value, available: true } : { value, available: true, basis };
}

function missing<T>(reason: string, basis?: number): Metric<T> {
  return { value: null, available: false, reason, basis };
}

/** Asset facts, read only from fields verified to be populated in this org. */
function assetFacts(assetId: number, asset: any) {
  // `space` is populated where `siteId` is empty on assets; `category` where `type`
  // is empty; `purchasedDate` where `commissionedTime` is empty.
  const location =
    asset?.space?.name || asset?.space?.displayName || asset?.siteId?.name || "";
  const category = asset?.category?.displayName || asset?.category?.name || asset?.category || "";
  return {
    asset_id: assetId,
    asset_name: asset?.name || "",
    asset_type: String(category || asset?.type?.displayName || asset?.type || ""),
    manufacturer: asset?.manufacturer || "",
    model: asset?.model || "",
    serial_number: asset?.serialNumber || "",
    description: asset?.description || "",
    location: String(location),
    purchasedDate: asset?.purchasedDate || "",
    warrantyExpiryDate: asset?.warrantyExpiryDate || "",
    // `decommission` is empty in this org, so absence means unknown, not "live".
    decommissioned: asset?.decommission === true,
    retirement_known: asset?.decommission === true || asset?.decommission === false,
  };
}

const MONTH_MS = 30.44 * 24 * 60 * 60 * 1000;

/** Milliseconds for an ISO date string, or null when unparseable. */
function ms(iso: string): number | null {
  if (!iso || iso.length < 10) return null;
  const t = Date.parse(iso);
  return isNaN(t) ? null : t;
}

/**
 * Reliability metrics — MTBF, MTTR and repeat-failure — from the corrective
 * work-order series. MTBF is the strongest deterioration evidence available and
 * costs nothing: it is the gaps between events, which we already fetch.
 */
function computeReliability(
  events: Array<{ wo_id: number; date: string; issue?: string; start?: string; end?: string; duration?: number }>
) {
  const dated = events
    .map((e) => ({ ...e, t: ms(e.date) }))
    .filter((e) => e.t !== null)
    .sort((a, b) => (a.t as number) - (b.t as number));

  /* ---- MTBF ---- */
  let mtbfSeries: Metric<Array<{ from: string; to: string; months: number }>>;
  let mtbfMean: Metric<number>;
  let mtbfVerdict: Metric<string>;

  if (dated.length < 2) {
    const why = `only ${dated.length} dated corrective event${dated.length === 1 ? "" : "s"} — at least 2 are needed for an interval`;
    mtbfSeries = missing(why, dated.length);
    mtbfMean = missing(why, dated.length);
    mtbfVerdict = missing(why, dated.length);
  } else {
    const gaps: Array<{ from: string; to: string; months: number }> = [];
    for (let i = 1; i < dated.length; i++) {
      const months = round(((dated[i].t as number) - (dated[i - 1].t as number)) / MONTH_MS, 1);
      gaps.push({ from: dated[i - 1].date.slice(0, 10), to: dated[i].date.slice(0, 10), months });
    }
    mtbfSeries = have(gaps, gaps.length);
    mtbfMean = have(round(gaps.reduce((a, g) => a + g.months, 0) / gaps.length, 1), gaps.length);

    if (gaps.length < 3) {
      mtbfVerdict = missing("at least 3 intervals are needed to call a direction", gaps.length);
    } else {
      // Compare the mean of the first half against the last half: a contracting
      // series means failures are arriving faster.
      const half = Math.floor(gaps.length / 2);
      const early = gaps.slice(0, half);
      const late = gaps.slice(gaps.length - half);
      const em = early.reduce((a, g) => a + g.months, 0) / early.length;
      const lm = late.reduce((a, g) => a + g.months, 0) / late.length;
      const ratio = em > 0 ? lm / em : 1;
      mtbfVerdict = have(ratio <= 0.7 ? "contracting" : ratio >= 1.4 ? "lengthening" : "steady", gaps.length);
    }
  }

  /* ---- MTTR: only from work orders that actually carry a duration ---- */
  const durations: number[] = [];
  for (const e of events) {
    if (e.duration && e.duration > 0) {
      durations.push(e.duration);
      continue;
    }
    const s = ms(e.start || "");
    const f = ms(e.end || "");
    if (s !== null && f !== null && f > s) durations.push((f - s) / 3600000);
  }
  const mttr: Metric<number> =
    durations.length > 0
      ? have(round(durations.reduce((a, d) => a + d, 0) / durations.length, 1), durations.length)
      : missing("no work-order duration recorded in the CMMS", 0);

  /* ---- Repeat failures: the same issue recurring soon after a previous one ---- */
  const REPEAT_DAYS = 90;
  const byIssue: Record<string, number[]> = {};
  for (const e of dated) {
    if (!e.issue) continue;
    if (!byIssue[e.issue]) byIssue[e.issue] = [];
    byIssue[e.issue].push(e.t as number);
  }
  const repeats: Array<{ issue: string; gap_days: number }> = [];
  for (const issue of Object.keys(byIssue)) {
    const ts = byIssue[issue].slice().sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i++) {
      const days = (ts[i] - ts[i - 1]) / 86400000;
      if (days <= REPEAT_DAYS) repeats.push({ issue, gap_days: Math.round(days) });
    }
  }
  const repeatFailures: Metric<Array<{ issue: string; gap_days: number }>> =
    Object.keys(byIssue).length === 0
      ? missing("no dated issue evidence to compare", 0)
      : have(repeats, dated.length);

  return {
    mtbf_series: mtbfSeries,
    mtbf_mean_months: mtbfMean,
    mtbf_verdict: mtbfVerdict,
    mttr_hours: mttr,
    repeat_failures: repeatFailures,
    dated_events: dated.length,
  };
}

/** Priority weighting — High-priority corrective events weigh above Low. */
const PRIORITY_WEIGHT: Record<string, number> = { high: 1.3, medium: 1, low: 0.75 };

function priorityWeight(priority: string): number {
  const w = PRIORITY_WEIGHT[String(priority || "").toLowerCase()];
  return w === undefined ? 1 : w;
}

/* ------------------------------------------------------------------ *
 * gather — spec STEP 1: pull only CORRECTIVE work orders and only their
 * BEFORE photos, so downstream stages can never see out-of-scope evidence.
 * ------------------------------------------------------------------ */

server.addHandler({
  name: "gather",
  description:
    "Fetch an asset, its corrective work orders and their BEFORE photos. Returns the evidence bundle plus which attachments already have cached findings.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
    maxWos: { description: "Max work orders to pull photos for (default 40)", type: "number" },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");
    const cap = num(args.maxWos) || 40;

    const assetRes = await cmms("get-asset", { id: assetId });
    const asset = assetRes.data || assetRes.asset || assetRes;

    // Field list verified by live `select`: every name here was accepted by the API.
    // `noOfAttachments` is the important one — it lets us skip work orders that have
    // no photos instead of calling list-workorder-attachments for every one, which
    // takes a 20-WO asset from ~33 calls to ~13.
    const woRes = await cmms("list-work-orders", {
      filters: `resource=${assetId}&type=Corrective,Breakdown`,
      select:
        "id,serialNumber,subject,description,type,sourceType,priority,resource," +
        "createdTime,dueDate,scheduledStart,actualWorkStart,actualWorkEnd," +
        "actualWorkDuration,moduleState,noOfAttachments,noOfNotes,noOfTasks",
      sort_by: "createdTime",
      sort_order: "asc",
      page_size: 200,
      include_count: true,
    });
    const rawWos: any[] = woRes.data || [];
    const totalCorrective = rawWos.length;

    // Newest-first so a cap keeps the most relevant history.
    const ordered = rawWos.slice().sort((a, b) => {
      const da = String(a.scheduledStart || a.createdTime || "");
      const db2 = String(b.scheduledStart || b.createdTime || "");
      return da < db2 ? 1 : da > db2 ? -1 : 0;
    });
    const selected = ordered.slice(0, cap);

    const db = conn();
    const { rows: cachedRows } = db.query(
      "select distinct attachment_id from findings where asset_id = $1 and source in ('photo','photo_manual') and attachment_id <> 0",
      [assetId]
    );
    const cached: number[] = cachedRows.map((r: any) => num(r.attachment_id));

    let photosTotal = 0;
    let attachmentCallsSkipped = 0;
    const wos: any[] = [];
    for (const wo of selected) {
      let photos: any[] = [];
      let attachmentError = "";
      // Only ask for attachments when the work order says it has some. The count is
      // populated in this org, so this is a real saving rather than an optimism.
      const declared = num(wo.noOfAttachments);
      if (declared > 0) {
        try {
          const attRes = await cmms("list-workorder-attachments", {
            work_order_id: num(wo.id),
            attachment_type: "before",
          });
          const atts: any[] = attRes.data || [];
          photos = atts.map((a) => ({
            attachment_id: num(a.id || a.attachmentId || a.recordId),
            filename: a.fileName || a.filename || a.name || "photo",
            content_type: a.contentType || a.content_type || "image/jpeg",
            size: num(a.fileSize),
            url: pickUrl(a),
            raw: a,
          }));
        } catch (e) {
          attachmentError = String(e);
        }
      } else {
        attachmentCallsSkipped++;
      }
      photosTotal += photos.length;
      wos.push({
        wo_id: num(wo.id),
        subject: wo.subject || "",
        description: wo.description || "",
        type: wo.type || "",
        status: String(wo.moduleState?.displayName || wo.moduleState?.status || wo.status || ""),
        priority: String(wo.priority?.displayName || wo.priority?.name || wo.priority || ""),
        source_type: String(wo.sourceType || ""),
        event_date: String(wo.scheduledStart || wo.createdTime || ""),
        created_time: String(wo.createdTime || ""),
        // Duration fields are empty in this org; kept so the metric activates the
        // moment anyone starts recording them.
        work_start: String(wo.actualWorkStart || ""),
        work_end: String(wo.actualWorkEnd || ""),
        work_duration: num(wo.actualWorkDuration),
        declared_attachments: declared,
        notes_count: num(wo.noOfNotes),
        tasks_count: num(wo.noOfTasks),
        photos,
        attachmentError,
      });
    }

    // wo_meta records the full denominator, including work orders that yield no
    // finding, so the register can answer "which 20 work orders?" without a re-fetch.
    const now = nowIso();
    for (const w of wos) {
      const { rows: hit } = db.query("select 1 as h from wo_meta where wo_id = $1 limit 1", [w.wo_id]);
      if (hit.length > 0) {
        db.query(
          "update wo_meta set subject = $1, event_date = $2, priority = $3, status = $4, no_of_attachments = $5, ingested_at = $6 where wo_id = $7",
          [w.subject, w.event_date, w.priority, w.status, w.declared_attachments, now, w.wo_id]
        );
      } else {
        db.query(
          `insert into wo_meta
             (wo_id, asset_id, subject, description, event_date, priority, status,
              source_type, no_of_attachments, ingested_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            w.wo_id,
            assetId,
            w.subject,
            String(w.description || "").slice(0, 900),
            w.event_date,
            w.priority,
            w.status,
            w.source_type,
            w.declared_attachments,
            now,
          ]
        );
      }
    }

    return {
      asset: assetFacts(assetId, asset),
      work_order_type_filter: "Corrective,Breakdown",
      total_corrective_work_orders: totalCorrective,
      work_orders_pulled: wos.length,
      capped: totalCorrective > cap,
      photos_available: photosTotal,
      attachment_calls_skipped: attachmentCallsSkipped,
      analyzed_attachment_ids: cached,
      work_orders: wos,
    };
  },
});

/* ------------------------------------------------------------------ *
 * photo-urls — mint pre-signed download URLs for one work order's BEFORE
 * photos. Kept separate from `gather` so the browser only pays for the
 * work orders whose photos it still needs to analyse.
 *
 * Note the platform constraint this exists to work around: the attachment
 * record itself carries no URL, and the pre-signed S3 URL it yields is not
 * CORS-readable, so the browser may not be able to read the bytes even with
 * a valid link. The caller must handle that and say so rather than pretend.
 * ------------------------------------------------------------------ */

server.addHandler({
  name: "photo-urls",
  description:
    "Return pre-signed download URLs for the BEFORE photos of one work order, so the browser can display or fetch them.",
  parameters: {
    woId: { description: "Work order id", type: "number" },
  },
  execute: async (args) => {
    const woId = num(args.woId);
    if (!woId) throw new Error("woId is required");

    const attRes = await cmms("list-workorder-attachments", {
      work_order_id: woId,
      attachment_type: "before",
    });
    const atts: any[] = attRes.data || [];

    const photos: any[] = [];
    for (const a of atts) {
      const attachmentId = num(a.id);
      let signedUrl = "";
      let fileId = 0;
      let error = "";
      try {
        const dl = await cmms("download-work-order-attachment", {
          work_order_id: woId,
          attachment_id: attachmentId,
        });
        signedUrl = String(dl.file_signed_url || "");
        // If the runtime materialises the action output into the app's own
        // file store, this id lets the browser skip the download entirely.
        fileId = num(dl.file_id);
      } catch (e) {
        error = String(e);
      }
      photos.push({
        attachment_id: attachmentId,
        filename: a.fileName || a.filename || "photo.jpg",
        content_type: a.contentType || "image/jpeg",
        size: num(a.fileSize),
        signed_url: signedUrl,
        action_file_id: fileId,
        error,
      });
    }

    return { wo_id: woId, photos };
  },
});

/* ------------------------------------------------------------------ *
 * save-findings — validate and persist the agent's per-photo defects.
 * Dedupe is a WHERE NOT EXISTS guard because the app DB role cannot
 * create the unique index ON CONFLICT would need.
 * ------------------------------------------------------------------ */

server.addHandler({
  name: "save-findings",
  description:
    "Persist validated photo findings from the photo-validation agent. Deduped on attachment_id so re-running an assessment never double-counts.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
    payload: {
      description:
        'JSON string: {"findings":[{wo_id,attachment_id,issue_code,component,location,severity,confidence,extent_percent,evidence:[],photo_file_id,photo_usable,photo_quality_score,asset_type_match,component_match,event_date}]}',
      type: "string",
    },
    provenance: {
      description: "How the image bytes reached the app: 'api' (read live from Facilio) or 'upload' (operator supplied)",
      type: "string",
    },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");
    const provenance = String(args.provenance || "api") === "upload" ? "upload" : "api";
    let parsed: any;
    try {
      parsed = JSON.parse(String(args.payload || "{}"));
    } catch (e) {
      throw new Error("payload must be valid JSON");
    }
    const incoming: any[] = parsed.findings || [];
    const db = conn();
    const now = nowIso();

    let inserted = 0;
    let skipped = 0;
    const rejected: string[] = [];
    let id = nextId(db, "findings");

    for (const f of incoming) {
      // An unusable photo is recorded for data-quality honesty but must never
      // become an issue occurrence, so it is stored under its own source and
      // excluded from every count.
      const unusable = f.photo_usable === false;
      const issue = unusable ? "none" : String(f.issue_code || "");
      if (!unusable && ISSUE_CODES.indexOf(issue) === -1) {
        rejected.push(`unknown issue_code "${issue}"`);
        continue;
      }
      // Photo evidence is tagged by how the bytes reached the app, not just that it
      // is photo evidence. `photo` means read live from Facilio; `photo_manual` means
      // an operator supplied the file because Facilio's URL is unreadable from a
      // browser. Both are analyses of the same attachment id, but the register should
      // never blur where the image came from.
      const source = unusable ? "photo_unusable" : provenance === "upload" ? "photo_manual" : "photo";
      const attachmentId = num(f.attachment_id);
      const woId = num(f.wo_id);
      if (!woId) {
        rejected.push("missing wo_id");
        continue;
      }
      let severity = String(f.severity || "unknown");
      if (SEV_ORDER.indexOf(severity) === -1) severity = "unknown";
      const confidence = clamp(num(f.confidence), 0, 1);
      const extent = clamp(num(f.extent_percent), 0, 100);
      // The spec requires evidence to always be an array of strings.
      const evidenceArr = Array.isArray(f.evidence)
        ? f.evidence.filter((x: unknown) => typeof x === "string")
        : typeof f.evidence === "string"
        ? [f.evidence]
        : [];

      if (attachmentId) {
        const { rows } = db.query(
          `select 1 as hit from findings where attachment_id = $1 and issue_code = $2
             and attachment_id <> 0 and source in ${PHOTO_SOURCES_SQL} limit 1`,
          [attachmentId, issue]
        );
        if (rows.length > 0) {
          skipped++;
          continue;
        }
      }

      db.query(
        `insert into findings
           (id, asset_id, wo_id, attachment_id, source, issue_code, component, location,
            severity, confidence, extent_percent, evidence, photo_file_id, photo_usable,
            photo_quality_score, asset_type_match, component_match, event_date, created_at)
         values ($1,$2,$3,$4,$19,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          id++,
          assetId,
          woId,
          attachmentId,
          issue,
          // photo-validation's `component` is free text — no enum on that field — so it is
          // canonicalised here rather than stored in whatever casing the model chose.
          canonicalComponent(String(f.component || "unspecified")),
          String(f.location || ""),
          severity,
          confidence,
          extent,
          JSON.stringify(evidenceArr),
          num(f.photo_file_id),
          f.photo_usable === false ? 0 : 1,
          clamp(num(f.photo_quality_score), 0, 1),
          String(f.asset_type_match ?? "uncertain"),
          String(f.component_match ?? "uncertain"),
          String(f.event_date || ""),
          now,
          source,
        ]
      );
      inserted++;
    }

    return { ok: true, inserted, skipped_duplicates: skipped, rejected };
  },
});

/* ------------------------------------------------------------------ *
 * The work-order evidence stream.
 *
 * This replaced a regex table that matched keywords in the work-order subject and then
 * wrote severity "unknown" and confidence 0.55 into every row it produced. Those two
 * literals were never judgments — the regex was only ever asked for an issue code and a
 * work order id, which is all recurrence counting needs — but the findings table is
 * shared with the photo path, where severity and confidence are real, so the text path
 * had to fill columns it had no answer for. The placeholders then reached the condition
 * score through the 0.45 severity stream, where identical values on every row made
 * sevIndex collapse to a constant 2.5 for any asset without readable photos.
 *
 * Now an agent reads the same wording and answers properly, and `save-wo-evidence`
 * refuses anything it cannot verify against the source text.
 *
 * Two handlers, not one, because the function sandbox has AGENTS_TOKEN but no
 * AGENTS_URL: server code cannot call an agent, so the browser sits in the middle.
 * `wo-evidence-input` prepares, the browser runs the agent, `save-wo-evidence` verifies
 * and persists — the same split `core-input`/`save-core` already use.
 * ------------------------------------------------------------------ */

/** Work orders per agent call. Keeps one asset's history inside a comfortable context. */
const WO_EVIDENCE_CHUNK = 25;

server.addHandler({
  name: "wo-evidence-input",
  description:
    "Build the wo-evidence agent's input for one asset: its corrective work orders chunked into agent-sized batches, plus the exact source text save-wo-evidence must verify quotes against.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");

    const assetRes = await cmms("get-asset", { id: assetId });
    const asset = assetRes.data || assetRes.asset || assetRes;

    // Same query the regex handler used, page size included: the photo path caps at 40
    // work orders because each one costs an attachment call, but text is cheap and
    // recurrence gets better the further back it can see.
    const woRes = await cmms("list-work-orders", {
      filters: `resource=${assetId}&type=Corrective,Breakdown`,
      select: "id,subject,description,type,priority,createdTime,scheduledStart",
      page_size: 200,
    });
    const rawWos: any[] = woRes.data || [];

    const wos = rawWos.map((wo) => ({
      wo_id: num(wo.id),
      subject: String(wo.subject || ""),
      description: String(wo.description || ""),
      event_date: String(wo.scheduledStart || wo.createdTime || ""),
    }));

    // `assetFacts` is the one place that knows which of this org's asset fields are
    // actually populated — category standing in for type, and so on. Reading the raw
    // fields here instead gave the agent "asset_type: unknown" on an asset that has one.
    const facts = assetFacts(assetId, asset);
    const assetHeader = [
      "Asset information:",
      `asset_id: ${facts.asset_id}`,
      `asset_name: ${facts.asset_name}`,
      `asset_type: ${facts.asset_type || "unknown"}`,
      `manufacturer: ${facts.manufacturer || "unknown"}`,
      `model: ${facts.model || "unknown"}`,
    ].join("\n");

    const chunks: Array<{ input: string; work_orders: number }> = [];
    for (let i = 0; i < wos.length; i += WO_EVIDENCE_CHUNK) {
      const batch = wos.slice(i, i + WO_EVIDENCE_CHUNK);
      chunks.push({
        work_orders: batch.length,
        input: [
          assetHeader,
          "",
          "Corrective work orders. Read each one's wording and report only what it states.",
          ...batch.map((w) =>
            [
              "",
              `work_order_id: ${w.wo_id}`,
              `date: ${w.event_date.slice(0, 10)}`,
              `subject: ${w.subject}`,
              `description: ${w.description}`,
            ].join("\n")
          ),
        ].join("\n"),
      });
    }

    return {
      ok: true,
      asset_id: assetId,
      work_orders: wos.length,
      chunks,
      // Returned so the browser can hand it straight back: the quote lock has to check
      // against the text the agent actually saw, not a re-fetch that may have changed.
      wos_json: JSON.stringify(wos),
    };
  },
});

/* ------------------------------------------------------------------ *
 * consolidation-input — the photo-less half of the asset-level analysis.
 *
 * `photo-validation` consolidates many corrective events into one asset-level reading.
 * On an asset with photos it consolidates its own per-work-order photo analyses. On an
 * asset without, there is nothing to consolidate unless someone hands it the findings
 * `wo-evidence` already read out of the wording — which is what this builds.
 *
 * It deliberately ships the STORED findings rather than the raw work-order text. Two
 * agents reading the same sentence can grade it differently, and the card would then be
 * free to print "high" over a findings row that says "medium" with no way to tell which
 * is right. One agent reads the wording; this one only merges what survived the quote
 * lock.
 * ------------------------------------------------------------------ */

server.addHandler({
  name: "consolidation-input",
  description:
    "Build photo-validation's MODE: CONSOLIDATION input for an asset with no usable before photos, from the corrective findings already stored for it.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
    totalCorrective: {
      description: "Total corrective work orders for the asset; 0 to derive from the findings themselves",
      type: "number",
    },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");

    const assetRes = await cmms("get-asset", { id: assetId });
    const facts = assetFacts(assetId, assetRes.data || assetRes.asset || assetRes);

    const db = conn();
    const { rows } = db.query(
      `select wo_id, issue_code, component, location, severity, confidence, evidence, event_date, source
         from findings
        where asset_id = $1 and asset_id <> 0`,
      [assetId]
    );

    // Same scoping rule as computeStats: an inspection row's wo_id is an inspection id,
    // so letting one through here would present a work order that never existed.
    const findings = rows
      .map((r: any) => {
        // `evidence` is a JSON array in a text column; same read as asset-detail does.
        let ev: string[] = [];
        try {
          const parsed = JSON.parse(String(r.evidence || "[]"));
          if (Array.isArray(parsed)) ev = parsed.filter((x: unknown) => typeof x === "string");
        } catch (e) {
          ev = [];
        }
        return {
          wo_id: num(r.wo_id),
          issue_code: String(r.issue_code),
          component: canonicalComponent(String(r.component || "unspecified")),
          location: String(r.location || ""),
          severity: String(r.severity || "unknown"),
          confidence: num(r.confidence),
          evidence: ev,
          event_date: String(r.event_date || "").slice(0, 10),
          source: String(r.source),
        };
      })
      .filter((f) => isCorrectiveEvidence(f.source));

    const byWo: Record<string, any[]> = {};
    const woIds: number[] = [];
    for (const f of findings) {
      const k = String(f.wo_id);
      if (!byWo[k]) {
        byWo[k] = [];
        woIds.push(f.wo_id);
      }
      byWo[k].push(f);
    }

    // Nothing to merge. Returned rather than thrown so the caller can skip the stage
    // honestly instead of asking the agent to consolidate an empty list.
    if (woIds.length === 0) {
      return { ok: true, asset_id: assetId, work_orders: 0, findings: 0, input: "" };
    }

    const total = num(args.totalCorrective) > 0 ? num(args.totalCorrective) : woIds.length;
    const perWo = woIds.map((id) => ({
      work_order_id: String(id),
      event_date: byWo[String(id)][0].event_date,
      findings: byWo[String(id)].map((f) => ({
        issue: f.issue_code,
        component: f.component,
        location: f.location,
        severity: f.severity,
        confidence: f.confidence,
        // Named per finding rather than declared once for the asset. This handler also
        // runs when every photo was already analysed on an earlier pass and so nothing
        // was re-read this time — the rows are there, the images are not. Announcing
        // "no photographs" over a set that contains photo readings would be a lie the
        // agent then repeats in its evidence.
        read_from: f.source === "wo_text" ? "work_order_text" : "photograph",
        evidence: f.evidence,
      })),
    }));

    const photoBacked = findings.filter((f) => f.source !== "wo_text").length;
    const woPhotoIds: number[] = [];
    for (const f of findings) {
      if (f.source !== "wo_text" && woPhotoIds.indexOf(f.wo_id) === -1) woPhotoIds.push(f.wo_id);
    }

    const input = [
      "MODE: CONSOLIDATION",
      "Asset information:",
      `asset_id: ${facts.asset_id}`,
      `asset_name: ${facts.asset_name}`,
      `asset_type: ${facts.asset_type || "unknown"}`,
      `manufacturer: ${facts.manufacturer || "unknown"}`,
      `model: ${facts.model || "unknown"}`,
      "",
      `Total corrective work orders for this asset: ${total}`,
      "",
      photoBacked > 0
        ? `The findings below are this asset's stored evidence: ${findings.length - photoBacked} read from corrective work-order wording and ${photoBacked} from before-maintenance photographs. Each carries read_from saying which.`
        : "No photographs were available for this asset. Every finding below was read from a corrective work order's own wording.",
      "Each one is already verified against its source. Merge them into one consolidated",
      "asset-level analysis. Count each work order once per issue. Do not invent a defect,",
      "a component or a severity that is not below.",
      `Return photo_analysis as an empty array; report photos_analyzed 0 and work_orders_with_usable_photos ${woPhotoIds.length}.`,
      "",
      JSON.stringify(perWo),
    ].join("\n");

    return { ok: true, asset_id: assetId, work_orders: woIds.length, findings: findings.length, input };
  },
});

server.addHandler({
  name: "save-wo-evidence",
  description:
    "Verify and store the wo-evidence agent's findings for one asset. Every finding must quote its work order verbatim or it is discarded. With replace=true the delete and the insert happen here together, so a failed agent leaves the previous stream intact.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
    payload: {
      description: 'JSON string: {"findings":[{wo_id,issue_code,component,severity,confidence,quote,evidence:[]}]}',
      type: "string",
    },
    wos: {
      description: "The work orders wo-evidence-input returned, stringified — the text quotes are checked against",
      type: "string",
    },
    replace: {
      // Declared as a string because the handler runtime accepts only "number" and
      // "string" parameter types — a boolean here fails the build outright.
      description: '"true" to rebuild the stream from scratch: deletes this asset\'s existing wo_text rows first',
      type: "string",
    },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");

    let parsed: any;
    try {
      parsed = JSON.parse(String(args.payload || "{}"));
    } catch (e) {
      throw new Error("payload must be valid JSON");
    }
    const incoming: any[] = parsed.findings || [];

    // The source text, keyed by work order. A finding naming a work order that was not
    // in the input is rejected outright — the agent has no other way to know of it, so
    // an unrecognised id means the reply drifted from the question.
    const sourceByWo: Record<string, string> = {};
    const dateByWo: Record<string, string> = {};
    try {
      for (const w of JSON.parse(String(args.wos || "[]"))) {
        sourceByWo[String(w.wo_id)] = `${w.subject || ""} ${w.description || ""}`;
        dateByWo[String(w.wo_id)] = String(w.event_date || "");
      }
    } catch (e) {
      throw new Error("wos must be valid JSON");
    }

    const db = conn();
    const now = nowIso();

    // Delete and insert in one handler call. The previous design cleared the stream from
    // the browser before the work that refills it, so anything failing in between left
    // the asset holding fewer findings than it started with and nothing to restore them.
    let replaced = 0;
    if (String(args.replace) === "true") {
      const cleared = db.query("delete from findings where asset_id = $1 and asset_id <> 0 and source = 'wo_text'", [
        assetId,
      ]);
      replaced = num(cleared.rowCount);
    }

    let id = nextId(db, "findings");
    let inserted = 0;
    let duplicates = 0;
    const rejected: string[] = [];
    const unquoted: string[] = [];

    for (const f of incoming) {
      const woId = num(f.wo_id);
      const sourceText = sourceByWo[String(woId)];
      if (!woId || sourceText === undefined) {
        rejected.push(`work order ${f.wo_id} was not in the input`);
        continue;
      }

      const issue = String(f.issue_code || "");
      if (ISSUE_CODES.indexOf(issue) === -1) {
        rejected.push(`unknown issue_code "${issue}" on work order ${woId}`);
        continue;
      }

      // Canonicalised before the enum check, not after: an agent reply of "electrical panel"
      // is the enum's `electrical_panel` and should be kept, not silently downgraded.
      let component = canonicalComponent(String(f.component || "unspecified"));
      if (COMPONENT_CODES.indexOf(component) === -1) component = "unspecified";

      const severity = AGENT_SEVERITY[String(f.severity || "")];
      if (severity === undefined) {
        rejected.push(`unknown severity "${f.severity}" on work order ${woId}`);
        continue;
      }

      // The lock. An unverifiable claim is dropped rather than stored as the work
      // order's own words — this is the whole reason the agent can be trusted with
      // severity, which now feeds the score.
      const quote = String(f.quote || "");
      if (!quoteFoundIn(sourceText, quote)) {
        unquoted.push(`${issue}: quote not found in work order ${woId}`);
        continue;
      }

      // The agent's own sentences, stored as it wrote them, with the verified quote as
      // the last element. Nothing is composed here: the row that preceded this one held
      // an engine-built sentence, which is how a template ended up in the evidence
      // column in the first place. Presentation belongs to the UI.
      const evidenceArr: string[] = Array.isArray(f.evidence)
        ? f.evidence.filter((x: unknown) => typeof x === "string" && x.trim().length > 0)
        : [];
      if (evidenceArr.length === 0) {
        rejected.push(`no evidence text on work order ${woId} (${issue})`);
        continue;
      }
      evidenceArr.push(quote);

      // Absent means absent. The agent returns -1 when it has no basis for a figure —
      // the platform's schema model rejects a nullable type, so a negative sentinel is
      // how "not calculated" travels. It lands as 0, which is already this table's
      // no-confidence value (unusable photos carry it) and which the UI prints as a
      // dash. Nothing is defaulted: a fabricated 0.55 on every row is what this replaced.
      const stated = typeof f.confidence === "number" && f.confidence >= 0;
      const confidence = stated ? clamp(num(f.confidence), 0, 1) : 0;

      // Keyed on the component too. Without it a work order stating corrosion on both the
      // compressor and the coil stored the first and counted the second as a duplicate,
      // so the component chips understated the work order — the same defect the regex had.
      // Safe for every count on the page: `occurrence_count` is the number of DISTINCT
      // wo_ids per issue, so a second row for a work order already in that list cannot
      // move it. Only the per-component grouping gains an entry, which is the point.
      const { rows: dup } = db.query(
        `select 1 as hit from findings
          where asset_id = $1 and wo_id = $2 and issue_code = $3 and component = $4
            and source = 'wo_text' limit 1`,
        [assetId, woId, issue, component]
      );
      if (dup.length > 0) {
        duplicates++;
        continue;
      }

      db.query(
        `insert into findings
           (id, asset_id, wo_id, attachment_id, source, issue_code, component, location,
            severity, confidence, extent_percent, evidence, photo_file_id, photo_usable,
            photo_quality_score, asset_type_match, component_match, event_date, created_at)
         values ($1,$2,$3,0,'wo_text',$4,$5,'',$6,$7,0,$8,0,0,0,'uncertain','uncertain',$9,$10)`,
        [
          id++,
          assetId,
          woId,
          issue,
          component,
          severity,
          confidence,
          JSON.stringify(evidenceArr),
          dateByWo[String(woId)] || "",
          now,
        ]
      );
      inserted++;
    }

    return { ok: true, asset_id: assetId, inserted, replaced, duplicates, rejected, unquoted };
  },
});

/* ------------------------------------------------------------------ *
 * computeStats — spec STEPS 5, 6, 8 in deterministic SQL.
 * The recurrence unit is the WORK ORDER, never the photo.
 * ------------------------------------------------------------------ */

function computeStats(db: any, assetId: number, totalCorrective: number) {
  const { rows } = db.query(
    `select wo_id, issue_code, component, severity, confidence, source,
            event_date, attachment_id, photo_usable, photo_quality_score
       from findings
      where asset_id = $1 and asset_id <> 0`,
    [assetId]
  );

  const allRows = rows.map((r: any) => ({
    wo_id: num(r.wo_id),
    issue_code: String(r.issue_code),
    // Canonicalised on read, not only on write: rows already stored carry both spellings,
    // and this is the grouping key behind the issue chips and the component table.
    component: canonicalComponent(String(r.component || "unspecified")),
    severity: String(r.severity || "unknown"),
    confidence: num(r.confidence),
    source: String(r.source),
    event_date: String(r.event_date || ""),
    attachment_id: num(r.attachment_id),
    photo_usable: num(r.photo_usable),
    photo_quality_score: num(r.photo_quality_score),
  }));

  // Unusable photos are evidence about the evidence: they belong in the photo
  // tallies and in the limitations, but they must never create an occurrence.
  // Inspection rows are excluded for a different reason — their wo_id is an
  // inspection id, so counting them here would report work orders that never existed.
  const findings = allRows.filter((f) => isCorrectiveEvidence(f.source));
  const unusableRows = allRows.filter((f) => f.source === "photo_unusable");

  const woIds: number[] = [];
  for (const f of findings) if (woIds.indexOf(f.wo_id) === -1) woIds.push(f.wo_id);
  const total = totalCorrective > 0 ? totalCorrective : woIds.length;

  /* ---- per-issue aggregation: COUNT(DISTINCT wo_id) ---- */
  const byIssue: Record<string, any> = {};
  for (const f of findings) {
    const k = f.issue_code;
    if (!byIssue[k]) {
      byIssue[k] = {
        issue: k,
        display_name: ISSUE_LABELS[k] || k,
        wos: [] as number[],
        components: {} as Record<string, number[]>,
        severities: [] as string[],
        confidences: [] as number[],
        dates: [] as Array<{ wo: number; date: string }>,
        sources: [] as string[],
      };
    }
    const rec = byIssue[k];
    if (rec.wos.indexOf(f.wo_id) === -1) rec.wos.push(f.wo_id);
    if (!rec.components[f.component]) rec.components[f.component] = [];
    if (rec.components[f.component].indexOf(f.wo_id) === -1) rec.components[f.component].push(f.wo_id);
    if (rec.severities.indexOf(f.severity) === -1) rec.severities.push(f.severity);
    rec.confidences.push(f.confidence);
    if (f.event_date) rec.dates.push({ wo: f.wo_id, date: f.event_date });
    if (rec.sources.indexOf(f.source) === -1) rec.sources.push(f.source);
  }

  const issues = Object.keys(byIssue).map((k, idx) => {
    const rec = byIssue[k];
    const count = rec.wos.length;
    const rate = total > 0 ? round(count / total, 2) : 0;

    const sortedDates = rec.dates.slice().sort((a: any, b: any) => (a.date < b.date ? -1 : 1));
    const first = sortedDates[0] || null;
    const last = sortedDates[sortedDates.length - 1] || null;

    // Distinct calendar years across occurrences — a trend needs at least two.
    const years: string[] = [];
    for (const d of sortedDates) {
      const y = d.date.slice(0, 4);
      if (y && years.indexOf(y) === -1) years.push(y);
    }
    let trend = "insufficient_evidence";
    if (years.length >= 2) {
      const perYear = years.map((y) => {
        const wosInYear: number[] = [];
        for (const d of sortedDates) {
          if (d.date.slice(0, 4) === y && wosInYear.indexOf(d.wo) === -1) wosInYear.push(d.wo);
        }
        return wosInYear.length;
      });
      // Least-squares slope over per-year occurrence counts.
      const n = perYear.length;
      const meanX = (n - 1) / 2;
      const meanY = perYear.reduce((a, b) => a + b, 0) / n;
      let numr = 0;
      let den = 0;
      for (let i = 0; i < n; i++) {
        numr += (i - meanX) * (perYear[i] - meanY);
        den += (i - meanX) * (i - meanX);
      }
      const slope = den === 0 ? 0 : numr / den;
      trend = slope > 0.5 ? "increasing" : slope < -0.5 ? "decreasing" : count > 1 ? "recurring" : "stable";
    }

    const status =
      count <= 1
        ? "isolated"
        : rate >= 0.4 || count >= 4
        ? "highly_recurring"
        : "recurring";

    const avgConf =
      rec.confidences.length > 0
        ? rec.confidences.reduce((a: number, b: number) => a + b, 0) / rec.confidences.length
        : 0;

    const affected = Object.keys(rec.components).map((c) => ({
      component: c,
      occurrence_count: rec.components[c].length,
    }));
    affected.sort((a, b) => b.occurrence_count - a.occurrence_count);

    return {
      issue_id: `ISS-${String(idx + 1).padStart(3, "0")}`,
      issue: rec.issue,
      display_name: rec.display_name,
      occurrence_count: count,
      occurrence_rate: rate,
      status,
      affected_components: affected,
      severity: {
        overall: worstSeverity(rec.severities),
        observed_levels: sortSeverities(rec.severities),
      },
      first_occurrence: first ? { work_order_id: String(first.wo), date: first.date.slice(0, 10) } : null,
      last_occurrence: last ? { work_order_id: String(last.wo), date: last.date.slice(0, 10) } : null,
      trend,
      work_order_references: rec.wos.map((w: number) => String(w)),
      confidence: round(avgConf, 2),
      evidence_sources: rec.sources,
      years_observed: years,
    };
  });

  issues.sort((a, b) => b.occurrence_count - a.occurrence_count);

  /* ---- per-component aggregation (STEP 8) ---- */
  const byComponent: Record<string, any> = {};
  for (const f of findings) {
    const k = f.component;
    if (!byComponent[k]) {
      byComponent[k] = { component: k, wos: [] as number[], issues: [] as string[], severities: [] as string[] };
    }
    const rec = byComponent[k];
    if (rec.wos.indexOf(f.wo_id) === -1) rec.wos.push(f.wo_id);
    if (rec.issues.indexOf(f.issue_code) === -1) rec.issues.push(f.issue_code);
    if (rec.severities.indexOf(f.severity) === -1) rec.severities.push(f.severity);
  }
  const components = Object.keys(byComponent).map((k) => {
    const rec = byComponent[k];
    const worst = worstSeverity(rec.severities);
    return {
      component: rec.component,
      corrective_work_order_count: rec.wos.length,
      issue_count: rec.issues.length,
      issues: rec.issues,
      highest_severity: worst,
      risk_level: worst === "critical" ? "critical" : worst === "high" ? "high" : rec.wos.length >= 3 ? "medium" : "low",
    };
  });
  components.sort((a, b) => b.corrective_work_order_count - a.corrective_work_order_count);

  /* ---- data quality (spec DATA QUALITY section) ---- */
  const photoFindings = findings.filter((f) => f.source === "photo" || f.source === "photo_manual");
  const photoWos: number[] = [];
  for (const f of photoFindings) if (photoWos.indexOf(f.wo_id) === -1) photoWos.push(f.wo_id);
  const usableAtt: number[] = [];
  for (const f of photoFindings) {
    if (f.attachment_id && usableAtt.indexOf(f.attachment_id) === -1) usableAtt.push(f.attachment_id);
  }
  const unusableAtt: number[] = [];
  for (const f of unusableRows) {
    if (f.attachment_id && unusableAtt.indexOf(f.attachment_id) === -1) unusableAtt.push(f.attachment_id);
  }
  const attachments = usableAtt.concat(unusableAtt.filter((a) => usableAtt.indexOf(a) === -1));
  const qualityScores = allRows.filter((f) => f.photo_quality_score > 0).map((f) => f.photo_quality_score);
  const photoConfidence =
    qualityScores.length > 0 ? round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length, 2) : 0;

  // Most frequent issue and highest severity issue are deliberately separate (STEP 11).
  const mostFrequent = issues[0] || null;
  let highestSeverityIssue: any = null;
  for (const i of issues) {
    if (
      !highestSeverityIssue ||
      SEV_ORDER.indexOf(i.severity.overall) > SEV_ORDER.indexOf(highestSeverityIssue.severity.overall)
    ) {
      highestSeverityIssue = i;
    }
  }

  const limitations: string[] = [];
  if (photoFindings.length === 0) {
    limitations.push(
      "No before-maintenance photo evidence was available; analysis is based on work-order text only."
    );
  }
  if (unusableAtt.length > 0) {
    limitations.push(
      `${unusableAtt.length} before photo(s) were not usable as evidence and were excluded from all counts.`
    );
  }
  if (total > 0 && photoWos.length < total) {
    limitations.push(
      `${total - photoWos.length} of ${total} corrective work orders had no usable before photos.`
    );
  }
  const distinctYears: string[] = [];
  for (const f of findings) {
    const y = f.event_date.slice(0, 4);
    if (y && distinctYears.indexOf(y) === -1) distinctYears.push(y);
  }
  if (distinctYears.length < 2) {
    limitations.push(
      "All corrective events fall within a single calendar year, so historical trend cannot be established."
    );
  }

  return {
    analysis_scope: {
      work_order_type: "CORRECTIVE",
      corrective_work_orders_analyzed: total,
      photos_analyzed: attachments.length,
      before_photos_only: true,
      work_orders_with_usable_photos: photoWos.length,
      work_orders_with_insufficient_photos: Math.max(total - photoWos.length, 0),
      usable_photos: usableAtt.length,
      unusable_photos: Math.max(attachments.length - usableAtt.length, 0),
    },
    recurring_issues: issues,
    component_analysis: components,
    issue_summary: {
      distinct_recurring_issues: issues.filter((i) => i.occurrence_count > 1).length,
      distinct_issues: issues.length,
      most_frequent_issue: mostFrequent ? mostFrequent.issue : "none",
      most_frequent_issue_count: mostFrequent ? mostFrequent.occurrence_count : 0,
      highest_severity_issue: highestSeverityIssue ? highestSeverityIssue.issue : "none",
      highest_severity_level: highestSeverityIssue ? highestSeverityIssue.severity.overall : "unknown",
      most_affected_component: components[0] ? components[0].component : "none",
      most_affected_component_count: components[0] ? components[0].corrective_work_order_count : 0,
    },
    data_quality: {
      photo_evidence_confidence: photoConfidence,
      assessment_limited: limitations.length > 0,
      limitations,
      photo_backed_findings: photoFindings.length,
      text_derived_findings: findings.length - photoFindings.length,
      distinct_years_observed: distinctYears.sort(),
    },
  };
}

server.addHandler({
  name: "stats",
  description:
    "Deterministic recurrence/component/data-quality statistics for one asset (spec STEPS 5, 6, 8). No LLM involved.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
    totalCorrective: {
      description: "Total corrective work orders analyzed; 0 to derive from findings",
      type: "number",
    },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");
    let total = num(args.totalCorrective);
    if (!total) {
      const woRes = await cmms("list-work-orders", {
        filters: `resource=${assetId}&type=Corrective,Breakdown`,
        select: "id",
        page_size: 200,
      });
      total = (woRes.data || []).length;
    }
    const db = conn();
    return computeStats(db, assetId, total);
  },
});

/* ------------------------------------------------------------------ *
 * save-analysis — merge the agent's judgment with engine arithmetic.
 * Numbers always come from computeStats; the agent keeps normalization,
 * severity, recurrence status, trend, risk level and narrative.
 * ------------------------------------------------------------------ */

server.addHandler({
  name: "save-analysis",
  description:
    "Store the photo-validation agent's asset-level analysis after overwriting every count, rate and reference with engine-computed values.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
    totalCorrective: { description: "Total corrective work orders analyzed", type: "number" },
    analysis: { description: "The agent's JSON reply (already JSON.parsed then re-stringified)", type: "string" },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");
    let agent: any = {};
    try {
      agent = JSON.parse(String(args.analysis || "{}"));
    } catch (e) {
      throw new Error("analysis must be valid JSON");
    }

    const db = conn();
    const stats = computeStats(db, assetId, num(args.totalCorrective));

    const agentIssues: any[] = Array.isArray(agent.recurring_issues) ? agent.recurring_issues : [];
    const mismatches: string[] = [];

    // Engine issues are authoritative; agent judgment is grafted on where it exists.
    const merged = stats.recurring_issues.map((eng: any) => {
      const match = agentIssues.filter((a) => String(a.issue) === eng.issue)[0];
      if (match && num(match.occurrence_count) !== eng.occurrence_count) {
        mismatches.push(
          `${eng.issue}: agent said ${num(match.occurrence_count)} occurrences, engine counted ${eng.occurrence_count} distinct corrective work orders`
        );
      }
      const status =
        match && ["isolated", "recurring", "highly_recurring", "insufficient_evidence"].indexOf(String(match.status)) >= 0
          ? String(match.status)
          : eng.status;
      const trend =
        match &&
        ["increasing", "decreasing", "stable", "recurring", "insufficient_evidence"].indexOf(String(match.trend)) >= 0 &&
        eng.trend !== "insufficient_evidence"
          ? String(match.trend)
          : eng.trend;
      const sevOverall =
        match && match.severity && SEV_ORDER.indexOf(String(match.severity.overall)) >= 0
          ? String(match.severity.overall)
          : eng.severity.overall;
      const evidence =
        match && Array.isArray(match.evidence) && match.evidence.length > 0
          ? match.evidence.filter((x: unknown) => typeof x === "string")
          : [
              `${eng.display_name} is supported in ${eng.occurrence_count} of ${stats.analysis_scope.corrective_work_orders_analyzed} corrective work orders for this asset.`,
              eng.evidence_sources.indexOf("photo") >= 0
                ? "Visual evidence was identified in before-maintenance photos attached to those work orders."
                : "Evidence is derived from corrective work-order wording; no usable before photos were available.",
            ];

      return {
        issue_id: eng.issue_id,
        issue: eng.issue,
        display_name: eng.display_name,
        occurrence_count: eng.occurrence_count, // engine-owned
        occurrence_rate: eng.occurrence_rate, // engine-owned
        status,
        affected_components: eng.affected_components, // engine-owned
        severity: { overall: sevOverall, observed_levels: eng.severity.observed_levels },
        first_occurrence: eng.first_occurrence, // engine-owned
        last_occurrence: eng.last_occurrence, // engine-owned
        trend,
        work_order_references: eng.work_order_references, // engine-owned
        evidence,
        // Every figure here is an agent's, so the fallback is now worth taking: `eng.confidence`
        // averages the per-finding confidences, and since `wo-evidence` replaced the regex table
        // those are graded readings rather than the old 0.55 constant. Only a genuinely absent
        // one becomes null. 0 means absent — the same convention `save-wo-evidence` stores one
        // layer down and the findings table already prints as a dash.
        confidence:
          match && typeof match.confidence === "number"
            ? clamp(num(match.confidence), 0, 1)
            : eng.confidence > 0
            ? eng.confidence
            : null,
        evidence_sources: eng.evidence_sources,
      };
    });

    const riskLevel =
      agent.asset_risk && ["low", "medium", "high", "critical", "unknown"].indexOf(String(agent.asset_risk.risk_level)) >= 0
        ? String(agent.asset_risk.risk_level)
        : deriveVisualRisk(stats).level;
    const riskScore =
      agent.asset_risk && num(agent.asset_risk.risk_score) > 0
        ? clamp(num(agent.asset_risk.risk_score), 0, 1)
        : deriveVisualRisk(stats).score;

    const analysis = {
      asset: agent.asset || {},
      analysis_scope: stats.analysis_scope, // engine-owned
      recurring_issues: merged,
      component_analysis: stats.component_analysis, // engine-owned
      issue_summary: stats.issue_summary, // engine-owned
      asset_risk: {
        risk_level: riskLevel,
        risk_score: riskScore,
        risk_drivers:
          agent.asset_risk && Array.isArray(agent.asset_risk.risk_drivers)
            ? agent.asset_risk.risk_drivers
            : deriveVisualRisk(stats).drivers,
      },
      overall_analysis: agent.overall_analysis || fallbackNarrative(stats),
      data_quality: {
        photo_evidence_confidence: stats.data_quality.photo_evidence_confidence,
        assessment_limited: stats.data_quality.assessment_limited,
        limitations: stats.data_quality.limitations,
        photo_backed_findings: stats.data_quality.photo_backed_findings,
        text_derived_findings: stats.data_quality.text_derived_findings,
      },
      photo_analysis: Array.isArray(agent.photo_analysis) ? agent.photo_analysis : [],
      // Three bases, not two. The same agent now also consolidates findings already on
      // record, and a stored row has to say which it was — judgment formed by looking at
      // photographs and judgment formed by merging prior readings carry different weight,
      // and nothing else in the row distinguishes them. The third value is deliberately
      // not named after work-order text: that path also carries photo findings from an
      // earlier run when nothing needed re-reading this time.
      analysis_source:
        agentIssues.length === 0
          ? "engine_only"
          : Array.isArray(agent.photo_analysis) && agent.photo_analysis.length > 0
          ? "photo_validation_agent"
          : "stored_findings_consolidated",
    };

    const now = nowIso();
    const id = nextId(db, "risk_analyses");
    db.query(
      "insert into risk_analyses (id, asset_id, analysis_json, engine_overrides_json, analyzed_at) values ($1,$2,$3,$4,$5)",
      [id, assetId, JSON.stringify(analysis), JSON.stringify({ count_mismatches: mismatches }), now]
    );

    return { ok: true, analysis_id: id, count_mismatches: mismatches, analysis };
  },
});

/** Visual/corrective-history risk (spec STEP 12) — no age, cost or criticality. */
function deriveVisualRisk(stats: any) {
  const issues = stats.recurring_issues || [];
  const comps = stats.component_analysis || [];
  const top = issues[0];
  let score = 0;
  const drivers: any[] = [];

  if (top) {
    score += clamp(top.occurrence_rate, 0, 1) * 0.35;
    score += (SEV_ORDER.indexOf(top.severity.overall) / 4) * 0.3;
    drivers.push({
      driver: `Repeated ${top.display_name.toLowerCase()}`,
      occurrence_count: top.occurrence_count,
      severity: top.severity.overall,
    });
  }
  let worst = "unknown";
  for (const i of issues) if (SEV_ORDER.indexOf(i.severity.overall) > SEV_ORDER.indexOf(worst)) worst = i.severity.overall;
  score += (SEV_ORDER.indexOf(worst) / 4) * 0.15;

  const topComp = comps[0];
  if (topComp && topComp.corrective_work_order_count >= 2) {
    const totalWos = Math.max(stats.analysis_scope.corrective_work_orders_analyzed, 1);
    score += clamp(topComp.corrective_work_order_count / totalWos, 0, 1) * 0.2;
    drivers.push({
      driver: `Corrective events concentrated on ${topComp.component}`,
      occurrence_count: topComp.corrective_work_order_count,
      severity: topComp.highest_severity,
    });
  }

  if (stats.data_quality.assessment_limited) score *= 0.9;

  const rounded = round(clamp(score, 0, 1), 2);
  const level =
    issues.length === 0
      ? "unknown"
      : rounded >= 0.8
      ? "critical"
      : rounded >= 0.6
      ? "high"
      : rounded >= 0.35
      ? "medium"
      : "low";
  return { score: rounded, level, drivers };
}

function fallbackNarrative(stats: any) {
  const top = stats.recurring_issues[0];
  const comp = stats.component_analysis[0];
  const total = stats.analysis_scope.corrective_work_orders_analyzed;
  if (!top) {
    return {
      primary_recurring_issue: "none",
      primary_issue_occurrence_count: 0,
      most_affected_component: "none",
      summary: "No issue evidence was identified from this asset's corrective history.",
      recurrence_finding: "No recurring issue could be established.",
      asset_pattern: "There is insufficient corrective evidence to describe a pattern.",
      risk_reason: "Risk cannot be assessed without corrective evidence.",
    };
  }
  return {
    primary_recurring_issue: top.issue,
    primary_issue_occurrence_count: top.occurrence_count,
    most_affected_component: comp ? comp.component : "unspecified",
    summary: comp
      ? `${comp.component} is the most frequently involved component in this asset's corrective history.`
      : `${top.display_name} is the most frequently recorded issue for this asset.`,
    recurrence_finding: `${top.display_name} occurred in ${top.occurrence_count} of ${total} corrective work orders.`,
    asset_pattern:
      comp && comp.corrective_work_order_count >= Math.max(2, total * 0.4)
        ? `Corrective issues are concentrated around ${comp.component} rather than spread evenly across the asset.`
        : "Corrective issues are distributed across several components rather than concentrated on one.",
    risk_reason: `${top.display_name} recurs across ${top.occurrence_count} separate corrective work orders at ${top.severity.overall} observed severity.`,
  };
}

/* ------------------------------------------------------------------ *
 * assess — downstream lifecycle engines. The agent spec deliberately
 * excludes age/cost/criticality, so they live here instead.
 * ------------------------------------------------------------------ */

/**
 * The inspection evidence stream, resolved in two tiers.
 *
 * Tier 1 — a SCORED template. Facilio computes `scorePercent` over a human-authored
 * rubric, so it is arithmetic rather than judgment and it is the better signal when
 * it exists. Latent in orgs whose templates are Checklists: those carry no point
 * values on any question, so no score field is ever returned at all.
 *
 * Tier 2 — the inspector's WRITTEN answers, normalized into `findings` rows by the
 * condition-core agent and quote-locked on the way in. The agent supplied perception
 * only; the arithmetic below is the engine's, and it mirrors the corrective severity
 * stream so the two indices are comparable.
 *
 * Only the LATEST inspection sets the index. Condition is a present-tense fact, and
 * averaging a 2019 walkthrough into today's grade would report an asset as it once was.
 *
 * The stream is named after the tier that produced it. Calling a prose-derived index
 * `inspection_grade` would imply a scored rubric stood behind it, the same reason
 * `sevStreamName` distinguishes photo_severity from wo_text_severity.
 */
async function inspectionStream(db: any, assetId: number) {
  const unavailable = (reason: string) => ({
    stream: missing<string>(reason),
    grade: null,
    basis: "none",
    count: 0,
  });

  /* ---- Tier 1: a scored template ---- */
  let insRows: any[] = [];
  try {
    const insRes = await cmms("list-inspections", {
      filters: `resource=${assetId}`,
      select:
        "id,scorePercent,totalScore,fullScore,responseStatus,status,actualWorkEnd,scheduledWorkStart,createdTime",
      page_size: 100,
    });
    insRows = insRes.data || [];
  } catch (e) {
    // Tier 2 reads the local table, so a CMMS outage must not sink the whole stream.
    insRows = [];
  }

  const scored = insRows.filter((r) => num(r.scorePercent) > 0 || num(r.totalScore) > 0);
  if (scored.length > 0) {
    const latest = scored
      .slice()
      .sort((a, b) =>
        String(a.actualWorkEnd || a.createdTime) < String(b.actualWorkEnd || b.createdTime) ? -1 : 1
      )
      .pop();
    const pct =
      num(latest.scorePercent) > 0
        ? num(latest.scorePercent)
        : num(latest.fullScore) > 0
        ? (num(latest.totalScore) / num(latest.fullScore)) * 100
        : 0;
    return {
      stream: have("available"),
      // A high score means good condition, so invert onto the 1..5 worst-is-5 scale.
      grade: round(1 + (100 - clamp(pct, 0, 100)) / 25, 2),
      basis: "template_score",
      count: scored.length,
    };
  }

  /* ---- Tier 2: quote-locked observations from the inspector's own words ---- */
  const { rows: obs } = db.query(
    `select wo_id, issue_code, severity, confidence, event_date from findings
      where asset_id = $1 and asset_id <> 0 and source = 'inspection'`,
    [assetId]
  );
  if (obs.length === 0) {
    return unavailable(
      insRows.length === 0
        ? "no inspections exist for this asset"
        : `${insRows.length} inspection(s) found, none scored and none yet read for written observations`
    );
  }

  // Latest inspection only. `wo_id` holds the inspection id on these rows.
  let latestId = 0;
  let latestDate = "";
  for (const r of obs) {
    const d = String(r.event_date || "");
    if (d > latestDate) {
      latestDate = d;
      latestId = num(r.wo_id);
    }
  }

  // One entry per issue within that inspection: the same defect restated across two
  // answers is one observation, the inspection analogue of the work-order rule.
  const worstByIssue: Record<string, { severity: string; confidence: number }> = {};
  for (const r of obs) {
    if (num(r.wo_id) !== latestId) continue;
    const k = String(r.issue_code);
    const sev = String(r.severity || "unknown");
    const conf = num(r.confidence);
    if (!worstByIssue[k]) worstByIssue[k] = { severity: sev, confidence: conf };
    else {
      worstByIssue[k].severity = worstSeverity([worstByIssue[k].severity, sev]);
      worstByIssue[k].confidence = Math.max(worstByIssue[k].confidence, conf);
    }
  }

  const issues = Object.keys(worstByIssue);
  if (issues.length === 0) return unavailable("the latest inspection recorded no condition observations");

  // Confidence-weighted mean of SEV_VALUE, matching the corrective severity stream.
  // No priority weighting: an inspection carries no priority, and `priorityWeight`
  // would silently return its default of 1, reading as a decision it never made.
  let numr = 0;
  let den = 0;
  for (const k of issues) {
    const c = Math.max(worstByIssue[k].confidence, 0.1);
    const v = SEV_VALUE[worstByIssue[k].severity];
    numr += (v === undefined ? 2.5 : v) * c;
    den += c;
  }

  return {
    stream: have("available"),
    grade: round(den > 0 ? numr / den : 1, 2),
    basis: "response_observations",
    count: issues.length,
    inspection_id: latestId,
    observed_at: latestDate.slice(0, 10),
  };
}

server.addHandler({
  name: "assess",
  description:
    "Run the downstream lifecycle engines for one asset (condition, deterioration, RUL, risk, CAPEX, recommendation) and upsert the condition register.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");

    const assetRes = await cmms("get-asset", { id: assetId });
    const asset = assetRes.data || assetRes;
    const facts = assetFacts(assetId, asset);
    const category = facts.asset_type || "DEFAULT";

    const woRes = await cmms("list-work-orders", {
      filters: `resource=${assetId}&type=Corrective,Breakdown`,
      select:
        "id,subject,priority,createdTime,scheduledStart,actualWorkStart,actualWorkEnd,actualWorkDuration",
      page_size: 200,
    });
    const wos: any[] = woRes.data || [];
    const totalCorrective = wos.length;

    const db = conn();
    const stats = computeStats(db, assetId, totalCorrective);
    const cfg = baselineFor(db, category, assetId);

    // `assess` rewrites the row by delete+insert, so anything in the old evidence blob
    // is lost unless carried across. The narrative is SUPPOSED to be lost — it
    // describes numbers that no longer exist — but the baseline sample is an INPUT to
    // the next run, and dropping it would silently demote the asset back to the
    // category estimate one run after condition-core supplied it.
    let priorBaselineSample: any = null;
    {
      const { rows: prior } = db.query(
        "select evidence_json from assessments where asset_id = $1 and asset_id <> 0 limit 1",
        [assetId]
      );
      if (prior.length > 0) {
        try {
          priorBaselineSample =
            (JSON.parse(String(prior[0].evidence_json || "{}")) || {}).baselines_sample || null;
        } catch (e) {
          priorBaselineSample = null;
        }
      }
    }

    /* ---- Reliability: MTBF, MTTR and repeat failures ---- */
    const { rows: issueDates } = db.query(
      `select wo_id, issue_code, event_date from findings
        where asset_id = $1 and asset_id <> 0 and source in ('photo','photo_manual','wo_text')`,
      [assetId]
    );
    const issueByWo: Record<string, string> = {};
    for (const r of issueDates) issueByWo[String(num(r.wo_id))] = String(r.issue_code);

    const reliability = computeReliability(
      wos.map((w) => ({
        wo_id: num(w.id),
        // `scheduledStart` is when the maintenance happened; `createdTime` is when
        // the record was written, which for imported history is all one day and
        // would collapse every MTBF interval to zero.
        date: String(w.scheduledStart || w.createdTime || ""),
        issue: issueByWo[String(num(w.id))],
        start: String(w.actualWorkStart || ""),
        end: String(w.actualWorkEnd || ""),
        duration: num(w.actualWorkDuration),
      }))
    );

    /* ---- MTBF for the dominant issue alone ----
     * Overall MTBF answers "how often does this asset need attention?". The dominant
     * issue's own series answers "is that specific problem accelerating?", which is
     * the sharper question and the one the recurrence analysis is about.
     */
    const dominant = stats.recurring_issues[0];
    const dominantWos: Record<string, boolean> = {};
    if (dominant) for (const w of dominant.work_order_references) dominantWos[String(w)] = true;
    const dominantReliability = dominant
      ? computeReliability(
          wos
            .filter((w) => dominantWos[String(num(w.id))])
            .map((w) => ({
              wo_id: num(w.id),
              date: String(w.scheduledStart || w.createdTime || ""),
              issue: dominant.issue,
            }))
        )
      : null;

    /* ---- Inspection stream: scored template, else quote-locked observations ---- */
    const inspection = await inspectionStream(db, assetId);

    /* ---- Condition score (1 best .. 5 worst) ---- */
    // Severity is weighted by confidence and by the work order's priority, so a
    // High-priority corrective event counts for more than a Low one.
    const priorityByWo: Record<string, string> = {};
    for (const w of wos) {
      priorityByWo[String(num(w.id))] = String(w.priority?.displayName || w.priority?.name || w.priority || "");
    }
    // Ungraded findings are excluded, not scored at SEV_VALUE's 2.5 midpoint.
    //
    // "unknown" means nobody assigned a severity — the agent read the wording and found
    // none in it. Averaging that in as 2.5 states an opinion the evidence never gave,
    // and when every row was ungraded (the old regex stream wrote nothing else) the
    // weighted mean collapsed algebraically to exactly 2.5 for the whole asset:
    // sevNum = Σ2.5·cᵢ, sevDen = Σcᵢ, so priorities cancelled and 45% of the condition
    // score was a constant. An ungraded row still counts toward recurrence and MTBF,
    // which need only wo_id and issue_code — see the query above.
    const { rows: sevWoRows } = db.query(
      `select wo_id, severity, confidence, source from findings
        where asset_id = $1 and asset_id <> 0 and source in ('photo','photo_manual','wo_text')
          and severity <> 'unknown'`,
      [assetId]
    );
    let sevNum = 0;
    let sevDen = 0;
    for (const r of sevWoRows) {
      const c = Math.max(num(r.confidence), 0.1) * priorityWeight(priorityByWo[String(num(r.wo_id))] || "");
      sevNum += SEV_VALUE[String(r.severity)] !== undefined ? SEV_VALUE[String(r.severity)] * c : 2.5 * c;
      sevDen += c;
    }
    // False when nothing was graded, which drops the severity stream entirely and lets
    // its 0.45 redistribute across the streams that do have evidence.
    const hasFindings = sevWoRows.length > 0;
    const sevIndex = sevDen > 0 ? sevNum / sevDen : 1;

    // Name the severity stream after where its evidence actually came from. With no
    // readable photos every severity is derived from work-order wording, and calling
    // that stream "photo_severity" would imply the score was visually corroborated
    // when nothing was ever seen.
    let sevPhotoBacked = 0;
    for (const r of sevWoRows) {
      const s = String(r.source);
      if (s === "photo" || s === "photo_manual") sevPhotoBacked++;
    }
    const sevStreamName =
      sevPhotoBacked === 0
        ? "wo_text_severity"
        : sevPhotoBacked === sevWoRows.length
        ? "photo_severity"
        : "mixed_severity";

    // Corrective pressure: events per year against a 3/yr reference. The span
    // comes from the work-order dates themselves, not from matched findings —
    // otherwise an asset whose findings cluster in one year looks artificially
    // dense and pins the index at its ceiling.
    const woYears: string[] = [];
    for (const w of wos) {
      const y = String(w.scheduledStart || w.createdTime || "").slice(0, 4);
      if (y && woYears.indexOf(y) === -1) woYears.push(y);
    }
    woYears.sort();
    const span = woYears.length >= 2 ? num(woYears[woYears.length - 1]) - num(woYears[0]) + 1 : 1;
    const perYear = totalCorrective / Math.max(span, 1);
    const pressureIndex = clamp(1 + (perYear / 3) * 4, 1, 5);

    // Three evidence streams. Inspection grade carries 0.35 when it exists; when a
    // stream is absent its weight is redistributed across those that remain, so an
    // absent stream never silently drags the score toward zero.
    const streams: Array<{ name: string; w: number; v: number }> = [];
    if (inspection.stream.available && inspection.grade !== null) {
      streams.push({
        name: inspection.basis === "template_score" ? "inspection_grade" : "inspection_condition",
        w: 0.35,
        v: num(inspection.grade),
      });
    }
    if (hasFindings) streams.push({ name: sevStreamName, w: 0.45, v: sevIndex });
    if (totalCorrective > 0) streams.push({ name: "corrective_pressure", w: 0.2, v: pressureIndex });
    const wSum = streams.reduce((a, s) => a + s.w, 0);
    const score = wSum > 0 ? round(streams.reduce((a, s) => a + s.w * s.v, 0) / wSum, 2) : 1;
    const streamsUsed = streams.map((s) => ({ name: s.name, weight: round(s.w / wSum, 2), value: round(s.v, 2) }));
    const grade =
      score < 1.8 ? "GOOD" : score < 2.6 ? "FAIR" : score < 3.4 ? "AVERAGE" : score < 4.2 ? "POOR" : "CRITICAL";

    /* ---- Deterioration from stored history ---- */
    const { rows: hist } = db.query(
      "select score, assessed_at from assessment_history where asset_id = $1 and asset_id <> 0 order by assessed_at asc",
      [assetId]
    );
    let deterioration = "steady";
    let velocity: Metric<number> = missing<number>("no prior assessment to measure against", hist.length);
    let deteriorationBasis = "measured";

    // A rate needs a span to divide by. Two assessments hours apart produce an
    // arithmetically valid but meaningless figure — a 0.14 score wobble overnight
    // annualises to 1.75 grade/year, which reads as measured fact and is not.
    const MIN_VELOCITY_DAYS = 60;
    const spanDays = (() => {
      if (hist.length < 2) return 0;
      const t0 = ms(String(hist[0].assessed_at || ""));
      const t1 = ms(String(hist[hist.length - 1].assessed_at || ""));
      return t0 !== null && t1 !== null && t1 > t0 ? (t1 - t0) / 86400000 : 0;
    })();
    const spanSufficient = spanDays >= MIN_VELOCITY_DAYS;

    if (hist.length >= 2 && spanSufficient) {
      const first = num(hist[0].score);
      const last = num(hist[hist.length - 1].score);
      const delta = last - first;
      deterioration = delta > 0.4 ? "accelerating" : delta < -0.2 ? "improving" : "steady";
      // Grade points per year over the actual elapsed time. No floor on the
      // denominator: the span gate above is what makes this divisible.
      velocity = have(round(delta / (spanDays / 365.25), 2), hist.length);
      deteriorationBasis = `measured across ${Math.round(spanDays)} days and ${hist.length} assessments`;
    } else {
      // Cold start, or a history too short to divide by. Either way the direction is
      // inferred from the corrective evidence and labelled as an inference, and the
      // velocity stays unavailable with the reason it is unavailable.
      const days = Math.round(spanDays);
      const whyNoSpan =
        hist.length < 2
          ? "one assessment on record"
          : days < 1
          ? `every assessment so far is from the same day, and a rate needs at least ${MIN_VELOCITY_DAYS} days`
          : `only ${days} day${days === 1 ? "" : "s"} separate the assessments, and a rate needs at least ${MIN_VELOCITY_DAYS}`;
      velocity = missing<number>(whyNoSpan, hist.length);

      const topTrend = stats.recurring_issues[0] ? stats.recurring_issues[0].trend : "insufficient_evidence";
      if (topTrend === "increasing") deterioration = "accelerating";
      deteriorationBasis =
        topTrend === "insufficient_evidence"
          ? `not established: ${whyNoSpan}, and there is no issue trend either`
          : `inferred from the ${topTrend} issue trend, because ${whyNoSpan}`;
      // A contracting MTBF is independent corroboration of acceleration.
      if (reliability.mtbf_verdict.available && reliability.mtbf_verdict.value === "contracting") {
        deterioration = "accelerating";
        deteriorationBasis = `inferred from a contracting MTBF and the ${topTrend} issue trend, because ${whyNoSpan}`;
      }
    }

    /* ---- Remaining useful life ---- */
    // Expected life has no Facilio field, so it comes only from the baseline agent
    // or an override. Without one there is no defensible figure, and RUL says so
    // rather than inheriting an invented default.
    const expectedLife = num(cfg.expected_life_years);
    const haveLife = cfg.resolved && expectedLife > 0;
    const purchased = String(facts.purchasedDate || "");
    let age: Metric<number> = missing<number>("no purchase date recorded on the asset");
    if (purchased.length >= 4) {
      const py = num(purchased.slice(0, 4));
      const pm = num(purchased.slice(5, 7)) || 1;
      const nowY = num(nowIso().slice(0, 4));
      const nowM = num(nowIso().slice(5, 7));
      age = have(round(nowY - py + (nowM - pm) / 12, 1));
    }
    const ageYears = age.available ? (age.value as number) : 0;
    const conditionFactor = score <= 2 ? 1.05 : score <= 3 ? 0.85 : score <= 4 ? 0.55 : 0.3;

    // RUL needs both an age and an expected life. Without an age it is unavailable,
    // and its risk term drops out rather than defaulting to a flattering zero.
    let rul: Metric<number>;
    if (!age.available) {
      rul = missing<number>("no purchase date, so age and remaining life cannot be derived");
    } else if (!haveLife) {
      rul = missing<number>(
        `no expected service life is available for category "${category}" — estimate its baselines or set an override`
      );
    } else {
      const baselineRul = Math.max(expectedLife - ageYears, 0);
      rul = have(
        round(
          clamp(baselineRul * conditionFactor * (deterioration === "accelerating" ? 0.7 : 1), 0, expectedLife),
          1
        )
      );
    }
    const rulYears = rul.available ? (rul.value as number) : 0;

    /* ---- Risk 0-100 ----
     * Terms are reweighted to sum to 100 across those that are available. Dropping
     * an unavailable term instead would cap the maximum — without RUL the ceiling
     * becomes 80 — and make every affected asset look safer than it is.
     */
    const criticality = String(cfg.criticality || "medium");
    const critFactor = criticality === "high" ? 1 : criticality === "medium" ? 0.66 : 0.33;
    const top = stats.recurring_issues[0];
    const dominantRecurrence = top ? top.occurrence_rate : 0;
    const topTrend = top ? top.trend : "insufficient_evidence";
    // No dominant issue is written as an empty code and an empty label, never a word.
    // Nothing branches on either — `register` and `asset-detail` only string-coerce them
    // for display — and ISSUE_LABELS has no entry for a sentinel, so "none" reached the
    // register's Dominant issue column raw, beside labels like "Corrosion". Empty lands
    // on the table's own "—" fallback instead.
    const dominantIssueCode = top ? top.issue : "";
    const dominantIssueLabel = top ? top.display_name : "";
    const trendKnown = !!top && topTrend !== "insufficient_evidence";
    const trendFactor = topTrend === "increasing" ? 1 : topTrend === "recurring" || topTrend === "stable" ? 0.4 : 0;
    const rulFactor = rulYears <= 1 ? 1 : rulYears >= 8 ? 0 : round((8 - rulYears) / 7, 2);

    const riskTerms: Array<{ name: string; weight: number; factor: number }> = [
      { name: "condition", weight: 30, factor: score / 5 },
      { name: "criticality", weight: 20, factor: critFactor },
      { name: "recurrence", weight: 15, factor: dominantRecurrence },
    ];
    const riskExcluded: string[] = [];
    if (trendKnown) riskTerms.push({ name: "trend", weight: 15, factor: trendFactor });
    else riskExcluded.push("trend — not enough chronological evidence");
    if (rul.available) riskTerms.push({ name: "remaining_life", weight: 20, factor: rulFactor });
    else riskExcluded.push("remaining_life — no purchase date on the asset");

    const weightTotal = riskTerms.reduce((a, t) => a + t.weight, 0);
    const riskScore = Math.round(
      riskTerms.reduce((a, t) => a + (t.weight / weightTotal) * 100 * t.factor, 0)
    );
    const riskLevel = riskScore < 40 ? "LOW" : riskScore < 70 ? "MEDIUM" : "HIGH";

    /* ---- CAPEX: no cost fields exist in this org, so configured rates ---- */
    const avgRepair = num(cfg.avg_repair_cost);
    const replacementCost = num(cfg.replacement_cost);
    // A real 36-month window, not a calendar-year one. Comparing on year alone with
    // `>= now - 3` admitted the current year plus THREE full prior years — up to 47
    // months of work orders labelled "last 3 years" — inflating repair_spend and the
    // spendRatio that feeds the P1 gate.
    const threeYearsAgo = Date.now() - 3 * 365.25 * 86400000;
    const recentWos = wos.filter((w) => {
      const t = ms(String(w.scheduledStart || w.createdTime || ""));
      return t !== null && t >= threeYearsAgo;
    }).length;
    const repairSpend = recentWos * avgRepair;
    const spendRatio = replacementCost > 0 ? repairSpend / replacementCost : 0;
    // `rul.available` guards the rulYears test, exactly as the REPLACE rule below already
    // does. Without it an unavailable RUL lands here as rulYears = 0, and "remaining life
    // unknown" silently reads as "remaining life is under 2 years" — promoting a HIGH-risk
    // asset with no purchase date to P1 (and through P1, to REPLACE) on a figure the same
    // handler just reported as impossible to derive.
    const capexPriority =
      riskLevel === "HIGH" && ((rul.available && rulYears < 2) || spendRatio > 0.3)
        ? "P1"
        : riskLevel === "HIGH" || (riskLevel === "MEDIUM" && topTrend === "increasing")
        ? "P2"
        : riskLevel === "MEDIUM"
        ? "P3"
        : "-";

    /* ---- Warranty gate ----
     * Replacing an asset the manufacturer is still liable for is money thrown away,
     * so an in-warranty asset is downgraded to REFURBISH and the reason recorded.
     */
    const warrantyIso = String(facts.warrantyExpiryDate || "");
    const warrantyMs = ms(warrantyIso);
    let warranty: Metric<string>;
    if (warrantyMs === null) {
      warranty = missing<string>("no warranty expiry date recorded on the asset");
    } else {
      warranty = have(warrantyMs > Date.now() ? "active" : "expired");
    }
    const warrantyActive = warranty.available && warranty.value === "active";

    const ruleRecommendation =
      capexPriority === "P1" || (score >= 4.2 && rulYears < 2 && rul.available)
        ? "REPLACE"
        : score >= 3.4 && riskLevel === "HIGH"
        ? "REFURBISH"
        : riskLevel === "MEDIUM" || dominantRecurrence >= 0.3
        ? "REPAIR"
        : "MONITOR";

    const recommendation =
      warrantyActive && ruleRecommendation === "REPLACE" ? "REFURBISH" : ruleRecommendation;
    const warrantyGateApplied = recommendation !== ruleRecommendation;

    /* ---- Visual risk from the most recent agent analysis, if any ---- */
    const { rows: raRows } = db.query(
      "select analysis_json from risk_analyses where asset_id = $1 and asset_id <> 0 order by analyzed_at desc, id desc limit 1",
      [assetId]
    );
    let visualLevel = "unknown";
    let visualScore = 0;
    if (raRows.length > 0) {
      try {
        const ra = JSON.parse(String(raRows[0].analysis_json));
        visualLevel = String(ra?.asset_risk?.risk_level || "unknown");
        visualScore = num(ra?.asset_risk?.risk_score);
      } catch (e) {
        /* stored JSON unreadable — leave as unknown */
      }
    }

    /* ---- What could not be computed, and why ---- */
    const unavailable: Array<{ metric: string; reason: string }> = [];
    if (!reliability.mttr_hours.available)
      unavailable.push({ metric: "MTTR", reason: String(reliability.mttr_hours.reason) });
    if (!reliability.mtbf_series.available)
      unavailable.push({ metric: "MTBF", reason: String(reliability.mtbf_series.reason) });
    else if (!reliability.mtbf_verdict.available)
      unavailable.push({ metric: "MTBF direction", reason: String(reliability.mtbf_verdict.reason) });
    if (!inspection.stream.available)
      unavailable.push({ metric: "inspection history", reason: String(inspection.stream.reason) });
    if (!rul.available) unavailable.push({ metric: "remaining useful life", reason: String(rul.reason) });
    if (!velocity.available)
      unavailable.push({ metric: "deterioration velocity", reason: String(velocity.reason) });
    if (!warranty.available) unavailable.push({ metric: "warranty status", reason: String(warranty.reason) });
    if (!facts.retirement_known)
      unavailable.push({ metric: "retirement status", reason: "the decommission field is not populated" });
    for (const l of stats.data_quality.limitations) unavailable.push({ metric: "evidence", reason: l });

    const evidence = {
      inputs: {
        condition_score: score,
        severity_index: round(sevIndex, 2),
        corrective_pressure_index: round(pressureIndex, 2),
        streams_used: streamsUsed,
        age_years: age.available ? age.value : null,
        // The date itself, not just the age derived from it. The asset page's "In
        // service" fact used to read the photo agent's `asset` block, whose output
        // schema has no purchasedDate — so a recorded date still showed "not recorded".
        // asset-detail serves this straight out of evidence_json.
        purchased_date: purchased ? purchased.slice(0, 10) : null,
        expected_life_years: expectedLife,
        condition_factor: conditionFactor,
        deterioration,
        deterioration_basis: deteriorationBasis,
        deterioration_velocity: velocity.available ? velocity.value : null,
        criticality,
        dominant_recurrence: dominantRecurrence,
        dominant_trend: topTrend,
        rul_years: rul.available ? rul.value : null,
        rul_factor: rul.available ? rulFactor : null,
        mtbf_mean_months: reliability.mtbf_mean_months.available ? reliability.mtbf_mean_months.value : null,
        mtbf_verdict: reliability.mtbf_verdict.available ? reliability.mtbf_verdict.value : null,
        mtbf_series: reliability.mtbf_series.available ? reliability.mtbf_series.value : null,
        // The dominant issue's own interval series answers "is THIS problem
        // accelerating?", which is sharper than the all-events series.
        //
        // Absent is null here, not the "none" the assessments row and column carry:
        // `register` and `asset-detail` gate the whole dominant_issue_mtbf block on
        // this key's truthiness, and the "none" string would fabricate that block —
        // issue "none", empty label, three unavailable metrics — for every asset that
        // never had a recurring issue at all.
        dominant_issue: dominant ? dominant.issue : null,
        dominant_issue_label: dominant ? dominant.display_name : null,
        dominant_mtbf_series:
          dominantReliability && dominantReliability.mtbf_series.available
            ? dominantReliability.mtbf_series.value
            : null,
        dominant_mtbf_mean_months:
          dominantReliability && dominantReliability.mtbf_mean_months.available
            ? dominantReliability.mtbf_mean_months.value
            : null,
        dominant_mtbf_verdict:
          dominantReliability && dominantReliability.mtbf_verdict.available
            ? dominantReliability.mtbf_verdict.value
            : null,
        mttr_hours: reliability.mttr_hours.available ? reliability.mttr_hours.value : null,
        repeat_failures: reliability.repeat_failures.available ? reliability.repeat_failures.value : null,
        corrective_wos_last_3y: recentWos,
        avg_repair_cost: avgRepair,
        spend_ratio: round(spendRatio, 2),
        warranty_status: warranty.available ? warranty.value : null,
        warranty_expiry: warrantyIso ? warrantyIso.slice(0, 10) : null,
        warranty_gate_applied: warrantyGateApplied,
        rule_recommendation: ruleRecommendation,
      },
      risk_terms: riskTerms.map((t) => ({
        name: t.name,
        weight: round((t.weight / weightTotal) * 100, 1),
        factor: round(t.factor, 2),
        contribution: round((t.weight / weightTotal) * 100 * t.factor, 1),
      })),
      risk_terms_excluded: riskExcluded,
      formulas: {
        condition: "weighted mean of the available evidence streams, weights renormalised to 1",
        risk: `sum of available terms reweighted to 100: ${riskTerms.map((t) => t.name).join(" + ")}`,
        rul: "max(expectedLife - age, 0) * conditionFactor * (accelerating ? 0.7 : 1)",
        mtbf: "months between consecutive corrective work orders; contracting when the later half averages <= 0.7 of the earlier half",
        repair_spend: "corrective WOs in the last 3 years x the baseline repair rate",
      },
      inspection_basis: inspection.basis,
      inspection_observations_used: inspection.count,
      baselines: {
        source: cfg.source,
        expected_life_years: expectedLife,
        avg_repair_cost: avgRepair,
        replacement_cost: replacementCost,
        criticality,
        confidence: cfg.confidence,
        low_confidence: cfg.confidence.repair < 0.6 || cfg.confidence.replacement < 0.6,
        estimated_at: cfg.estimated_at,
      },
      cost_basis:
        cfg.source === "actuals"
          ? "actual costs logged in the CMMS"
          : cfg.source === "override"
          ? "manually overridden in Settings"
          : "AI-estimated reference rates — treat as indicative",
      unavailable,
    };

    const now = nowIso();
    db.query("delete from assessments where asset_id = $1", [assetId]);
    db.query(
      `insert into assessments
         (asset_id, asset_name, category, score, grade, dominant_issue, dominant_recurrence_pct,
          trend_direction, deterioration, rul_years, risk_score, risk_level, visual_risk_level,
          visual_risk_score, repair_spend, replacement_cost, capex_priority, recommendation,
          corrective_wo_count, evidence_json, assessed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        assetId,
        String(asset?.name || ""),
        category,
        score,
        grade,
        dominantIssueCode,
        round(dominantRecurrence * 100, 0),
        topTrend,
        deterioration,
        rulYears,
        riskScore,
        riskLevel,
        visualLevel,
        visualScore,
        repairSpend,
        replacementCost,
        capexPriority,
        recommendation,
        totalCorrective,
        JSON.stringify(evidence),
        now,
      ]
    );

    // One history point per calendar day. Without this, re-running an assessment
    // stacks identical points and the deterioration engine reads the flat run as
    // measured stability — fabricating a trend out of repeated clicks.
    const today = now.slice(0, 10);
    const { rows: sameDay } = db.query(
      "select id from assessment_history where asset_id = $1 and substr(assessed_at, 1, 10) = $2 limit 1",
      [assetId, today]
    );
    if (sameDay.length > 0) {
      db.query(
        "update assessment_history set score = $1, risk_score = $2, rul_years = $3, assessed_at = $4 where id = $5",
        [score, riskScore, rulYears, now, num(sameDay[0].id)]
      );
    } else {
      const histId = nextId(db, "assessment_history");
      db.query(
        "insert into assessment_history (id, asset_id, score, risk_score, rul_years, assessed_at) values ($1,$2,$3,$4,$5,$6)",
        [histId, assetId, score, riskScore, rulYears, now]
      );
    }

    /* ---- The block the condition-assessment agent is allowed to see ----
     * Only already-calculated values. The agent may restate any figure here and no
     * other, which is what save-narrative enforces.
     */
    const mtbfList = reliability.mtbf_series.available
      ? (reliability.mtbf_series.value as Array<{ months: number }>).map((g) => g.months).join(", ")
      : "";
    const narrativeBlock = [
      "CALCULATED RESULTS — explain these. Do not introduce any number not listed here.",
      "",
      `asset: ${facts.asset_name}, ${category}${facts.manufacturer ? ", " + facts.manufacturer : ""}${
        facts.model ? " " + facts.model : ""
      }${facts.location ? ", " + facts.location : ""}`,
      "",
      `condition_score: ${score} of 5`,
      `condition_grade: ${grade}`,
      `evidence_streams_used: ${streamsUsed
        .map((s) => `${s.name} weighted ${s.weight}`)
        .join("; ")}`,
      inspection.stream.available
        ? `inspection_condition_index: ${inspection.grade} of 5, from ${
            inspection.basis === "template_score"
              ? "a scored inspection template"
              : `${inspection.count} observation(s) an inspector wrote on ${inspection.observed_at}`
          }`
        : `evidence_stream_absent: inspection grade — ${inspection.stream.reason}`,
      "",
      `dominant_issue: ${top ? top.display_name : "none identified"}`,
      top
        ? `dominant_issue_occurrences: ${top.occurrence_count} corrective work orders of ${stats.analysis_scope.corrective_work_orders_analyzed} analysed`
        : "",
      top ? `dominant_issue_rate: ${round(top.occurrence_rate * 100, 0)}%` : "",
      top ? `dominant_issue_trend: ${top.trend}` : "",
      stats.component_analysis[0]
        ? `component_concentration: ${stats.component_analysis[0].component}, ${stats.component_analysis[0].corrective_work_order_count} corrective work orders`
        : "",
      "",
      mtbfList ? `mtbf_all_corrective_interval_months: ${mtbfList}` : "",
      reliability.mtbf_mean_months.available
        ? `mtbf_all_corrective_mean_months: ${reliability.mtbf_mean_months.value}`
        : "",
      reliability.mtbf_verdict.available ? `mtbf_all_corrective_verdict: ${reliability.mtbf_verdict.value}` : "",
      dominantReliability && dominantReliability.mtbf_series.available
        ? `mtbf_${dominant.issue}_interval_months: ${(dominantReliability.mtbf_series.value as Array<{ months: number }>)
            .map((g) => g.months)
            .join(", ")}`
        : "",
      dominantReliability && dominantReliability.mtbf_verdict.available
        ? `mtbf_${dominant.issue}_verdict: ${dominantReliability.mtbf_verdict.value}`
        : "",
      "",
      `deterioration: ${deterioration}`,
      velocity.available ? `deterioration_velocity: ${velocity.value} grade per year` : "",
      `deterioration_basis: ${deteriorationBasis}`,
      "",
      age.available ? `asset_age_years: ${age.value}` : "",
      `expected_life_years: ${expectedLife}`,
      rul.available ? `remaining_useful_life_years: ${rul.value}` : "",
      "",
      `risk_score: ${riskScore} of 100`,
      `risk_level: ${riskLevel}`,
      `risk_terms_included: ${riskTerms.map((t) => t.name).join(", ")}`,
      `criticality: ${criticality}`,
      "",
      `capex_priority: ${capexPriority}`,
      `repair_spend_3y: ${repairSpend}`,
      `replacement_cost: ${replacementCost}`,
      `RECOMMENDATION: ${recommendation}`,
      warrantyGateApplied
        ? `note: the rule produced ${ruleRecommendation} but the asset is under warranty, so the recommendation was downgraded`
        : "",
      "",
      `provenance: expected_life_years, criticality and both cost figures are ${
        cfg.source === "ai_estimate" ? "AI estimates" : cfg.source === "override" ? "manual overrides" : "configured values"
      }; cost confidence ${cfg.confidence.replacement}`,
      warranty.available ? `warranty: ${warranty.value}${warrantyIso ? " " + warrantyIso.slice(0, 10) : ""}` : "",
      "",
      "unavailable:",
      ...unavailable.map((u) => `- ${u.metric}: ${u.reason}`),
    ]
      .filter((l) => l !== "")
      .join("\n");

    // Persist the block alongside the evidence it describes. `save-narrative` used to
    // rely on the browser handing it back; `core-input` runs server-side and needs it
    // from the row, so the whole core loop can be driven without a browser.
    evidence.narrative_block = narrativeBlock;
    if (priorBaselineSample) evidence.baselines_sample = priorBaselineSample;
    db.query("update assessments set evidence_json = $1 where asset_id = $2", [
      JSON.stringify(evidence),
      assetId,
    ]);

    const row = {
      asset_id: assetId,
      asset_name: facts.asset_name,
      category,
      score,
      grade,
      dominant_issue: dominantIssueCode,
      dominant_issue_label: dominantIssueLabel,
      dominant_recurrence_pct: round(dominantRecurrence * 100, 0),
      trend_direction: topTrend,
      deterioration,
      deterioration_basis: deteriorationBasis,
      deterioration_velocity: velocity,
      rul: rul,
      rul_years: rulYears,
      risk_score: riskScore,
      risk_level: riskLevel,
      visual_risk_level: visualLevel,
      visual_risk_score: visualScore,
      repair_spend: repairSpend,
      replacement_cost: replacementCost,
      capex_priority: capexPriority,
      recommendation,
      rule_recommendation: ruleRecommendation,
      warranty,
      warranty_gate_applied: warrantyGateApplied,
      corrective_wo_count: totalCorrective,
      mtbf: {
        series: reliability.mtbf_series,
        mean_months: reliability.mtbf_mean_months,
        verdict: reliability.mtbf_verdict,
      },
      dominant_issue_mtbf: dominantReliability
        ? {
            issue: dominant.issue,
            issue_label: dominant.display_name,
            series: dominantReliability.mtbf_series,
            mean_months: dominantReliability.mtbf_mean_months,
            verdict: dominantReliability.mtbf_verdict,
          }
        : null,
      mttr_hours: reliability.mttr_hours,
      repeat_failures: reliability.repeat_failures,
      inspection_stream: inspection.stream,
      baselines: evidence.baselines,
      unavailable,
      evidence,
      narrative_block: narrativeBlock,
      assessed_at: now,
    };

    await events.publish("assessments", { type: "assessment.updated", asset_id: assetId, row });
    return row;
  },
});

/* ------------------------------------------------------------------ *
 * Read handlers for the UI
 * ------------------------------------------------------------------ */

server.addHandler({
  name: "assets",
  description: "List assets available for assessment, with corrective work-order counts already assessed.",
  parameters: {
    pageSize: { description: "How many assets to return (default 200)", type: "number" },
  },
  execute: async (args) => {
    const pageSize = num(args.pageSize) || 200;
    const res = await cmms("list-assets", {
      page_size: pageSize,
      select: "id,name,category,type,manufacturer,model,purchasedDate,warrantyExpiryDate",
    });
    const assets: any[] = res.data || [];
    const db = conn();
    const { rows } = db.query(
      "select asset_id, score, grade, risk_score, risk_level, recommendation, capex_priority, assessed_at from assessments where asset_id <> 0"
    );
    const byId: Record<string, any> = {};
    for (const r of rows) byId[String(num(r.asset_id))] = r;
    return {
      assets: assets.map((a) => {
        const done = byId[String(num(a.id))];
        return {
          asset_id: num(a.id),
          name: a.name || "",
          category: a.category || a.type || "",
          manufacturer: a.manufacturer || "",
          model: a.model || "",
          purchasedDate: a.purchasedDate || "",
          assessed: !!done,
          score: done ? num(done.score) : null,
          grade: done ? String(done.grade) : null,
          risk_score: done ? num(done.risk_score) : null,
          risk_level: done ? String(done.risk_level) : null,
          recommendation: done ? String(done.recommendation) : null,
          capex_priority: done ? String(done.capex_priority) : null,
          assessed_at: done ? String(done.assessed_at) : null,
        };
      }),
    };
  },
});

server.addHandler({
  name: "register",
  description: "The condition register — every assessed asset with its computed condition, risk, RUL and recommendation.",
  parameters: {},
  execute: async () => {
    const db = conn();
    const { rows } = db.query(
      "select * from assessments where asset_id <> 0 order by risk_score desc, score desc"
    );
    // Reliability figures and metric envelopes live in evidence_json, so lift the
    // ones the register needs rather than making the table dig through the blob.
    const liftEvidence = (raw: unknown) => {
      try {
        return JSON.parse(String(raw || "{}"));
      } catch (e) {
        return {};
      }
    };
    const asMetric = (v: unknown, reason: string) =>
      v === null || v === undefined ? { value: null, available: false, reason } : { value: v, available: true };

    const register = rows.map((r: any) => ({
      asset_id: num(r.asset_id),
      asset_name: String(r.asset_name || ""),
      category: String(r.category || ""),
      score: num(r.score),
      grade: String(r.grade || ""),
      dominant_issue: String(r.dominant_issue || ""),
      dominant_issue_label: ISSUE_LABELS[String(r.dominant_issue)] || String(r.dominant_issue || ""),
      dominant_recurrence_pct: num(r.dominant_recurrence_pct),
      trend_direction: String(r.trend_direction || ""),
      deterioration: String(r.deterioration || ""),
      rul_years: num(r.rul_years),
      risk_score: num(r.risk_score),
      risk_level: String(r.risk_level || ""),
      visual_risk_level: String(r.visual_risk_level || "unknown"),
      visual_risk_score: num(r.visual_risk_score),
      repair_spend: num(r.repair_spend),
      replacement_cost: num(r.replacement_cost),
      capex_priority: String(r.capex_priority || "-"),
      recommendation: String(r.recommendation || ""),
      corrective_wo_count: num(r.corrective_wo_count),
      assessed_at: String(r.assessed_at || ""),
      ...(() => {
        const inp = liftEvidence(r.evidence_json).inputs || {};
        return {
          deterioration_basis: inp.deterioration_basis || "",
          rul: asMetric(inp.rul_years, "remaining life could not be derived"),
          warranty: asMetric(inp.warranty_status, "no warranty expiry date recorded"),
          mtbf: {
            series: asMetric(inp.mtbf_series, "not enough dated corrective events"),
            mean_months: asMetric(inp.mtbf_mean_months, "not enough dated corrective events"),
            verdict: asMetric(inp.mtbf_verdict, "not enough intervals to call a direction"),
          },
          dominant_issue_mtbf: inp.dominant_issue
            ? {
                issue: inp.dominant_issue,
                issue_label: inp.dominant_issue_label || "",
                series: asMetric(inp.dominant_mtbf_series, "not enough dated events for this issue"),
                mean_months: asMetric(inp.dominant_mtbf_mean_months, "not enough dated events for this issue"),
                verdict: asMetric(inp.dominant_mtbf_verdict, "not enough intervals to call a direction"),
              }
            : null,
          unavailable: liftEvidence(r.evidence_json).unavailable || [],
        };
      })(),
    }));

    const kpis = {
      assets_assessed: register.length,
      accelerating_count: register.filter((r) => r.deterioration === "accelerating").length,
      contracting_mtbf_count: register.filter(
        (r) => r.dominant_issue_mtbf?.verdict?.available && r.dominant_issue_mtbf.verdict.value === "contracting"
      ).length,
      high_risk: register.filter((r) => r.risk_level === "HIGH").length,
      medium_risk: register.filter((r) => r.risk_level === "MEDIUM").length,
      low_risk: register.filter((r) => r.risk_level === "LOW").length,
      replace_count: register.filter((r) => r.recommendation === "REPLACE").length,
      refurbish_count: register.filter((r) => r.recommendation === "REFURBISH").length,
      repair_count: register.filter((r) => r.recommendation === "REPAIR").length,
      monitor_count: register.filter((r) => r.recommendation === "MONITOR").length,
      p1_count: register.filter((r) => r.capex_priority === "P1").length,
      total_capex_exposure: register
        .filter((r) => r.recommendation === "REPLACE" || r.recommendation === "REFURBISH")
        .reduce((a, r) => a + r.replacement_cost, 0),
      total_repair_spend: register.reduce((a, r) => a + r.repair_spend, 0),
      avg_score: register.length
        ? round(register.reduce((a, r) => a + r.score, 0) / register.length, 2)
        : 0,
    };

    return { kpis, register };
  },
});

server.addHandler({
  name: "asset-detail",
  description: "Everything the asset page needs: latest agent analysis, findings traceability, per-year issue matrix and history.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");
    const db = conn();

    const { rows: aRows } = db.query("select * from assessments where asset_id = $1", [assetId]);
    const { rows: raRows } = db.query(
      "select id, analysis_json, engine_overrides_json, analyzed_at from risk_analyses where asset_id = $1 and asset_id <> 0 order by analyzed_at desc, id desc limit 1",
      [assetId]
    );
    const { rows: fRows } = db.query(
      `select wo_id, attachment_id, source, issue_code, component, location, severity,
              confidence, extent_percent, evidence, photo_file_id, photo_usable,
              photo_quality_score, asset_type_match, component_match, event_date
         from findings where asset_id = $1 and asset_id <> 0
        order by event_date desc, wo_id desc`,
      [assetId]
    );
    const { rows: hRows } = db.query(
      "select score, risk_score, rul_years, assessed_at from assessment_history where asset_id = $1 and asset_id <> 0 order by assessed_at asc",
      [assetId]
    );

    let analysis: any = null;
    let overrides: any = null;
    if (raRows.length > 0) {
      try {
        analysis = JSON.parse(String(raRows[0].analysis_json));
        overrides = JSON.parse(String(raRows[0].engine_overrides_json || "{}"));
      } catch (e) {
        analysis = null;
      }
    }

    const findings = fRows.map((r: any) => {
      let ev: string[] = [];
      try {
        const parsed = JSON.parse(String(r.evidence || "[]"));
        if (Array.isArray(parsed)) ev = parsed.filter((x: unknown) => typeof x === "string");
      } catch (e) {
        ev = [];
      }
      return {
        wo_id: num(r.wo_id),
        attachment_id: num(r.attachment_id),
        source: String(r.source),
        issue_code: String(r.issue_code),
        issue_label: ISSUE_LABELS[String(r.issue_code)] || String(r.issue_code),
        component: r.component ? canonicalComponent(String(r.component)) : "",
        location: String(r.location || ""),
        severity: String(r.severity || "unknown"),
        confidence: num(r.confidence),
        extent_percent: num(r.extent_percent),
        evidence: ev,
        photo_file_id: num(r.photo_file_id),
        photo_usable: num(r.photo_usable) === 1,
        photo_quality_score: num(r.photo_quality_score),
        asset_type_match: String(r.asset_type_match || "uncertain"),
        component_match: String(r.component_match || "uncertain"),
        event_date: String(r.event_date || ""),
      };
    });

    // Per-year distinct-WO matrix, the visual form of the trend evidence.
    const matrix: Record<string, Record<string, number[]>> = {};
    for (const f of findings) {
      if (!isCorrectiveEvidence(f.source)) continue;
      const y = f.event_date.slice(0, 4);
      if (!y) continue;
      if (!matrix[f.issue_code]) matrix[f.issue_code] = {};
      if (!matrix[f.issue_code][y]) matrix[f.issue_code][y] = [];
      if (matrix[f.issue_code][y].indexOf(f.wo_id) === -1) matrix[f.issue_code][y].push(f.wo_id);
    }
    const years: string[] = [];
    for (const issue of Object.keys(matrix)) {
      for (const y of Object.keys(matrix[issue])) if (years.indexOf(y) === -1) years.push(y);
    }
    years.sort();
    const issueMatrix = Object.keys(matrix).map((issue) => ({
      issue,
      label: ISSUE_LABELS[issue] || issue,
      counts: years.map((y) => (matrix[issue][y] ? matrix[issue][y].length : 0)),
    }));

    const a = aRows[0];
    let evidenceJson: any = null;
    if (a) {
      try {
        evidenceJson = JSON.parse(String(a.evidence_json || "{}"));
      } catch (e) {
        evidenceJson = null;
      }
    }

    // The register row holds only the original columns; the metric envelopes and
    // reliability figures live in evidence_json, so rebuild them here rather than
    // making the UI dig through the blob.
    const inp: any = evidenceJson?.inputs || {};
    const metricOf = <T,>(v: T | null | undefined, reason: string): any =>
      v === null || v === undefined ? { value: null, available: false, reason } : { value: v, available: true };

    return {
      assessment: a
        ? {
            asset_id: num(a.asset_id),
            asset_name: String(a.asset_name || ""),
            category: String(a.category || ""),
            score: num(a.score),
            grade: String(a.grade || ""),
            dominant_issue: String(a.dominant_issue || ""),
            dominant_issue_label: ISSUE_LABELS[String(a.dominant_issue)] || String(a.dominant_issue || ""),
            dominant_recurrence_pct: num(a.dominant_recurrence_pct),
            trend_direction: String(a.trend_direction || ""),
            deterioration: String(a.deterioration || ""),
            deterioration_basis: inp.deterioration_basis || "",
            deterioration_velocity: metricOf(
              inp.deterioration_velocity,
              "no prior assessment to measure against"
            ),
            rul: metricOf(inp.rul_years, "remaining life could not be derived"),
            rul_years: num(a.rul_years),
            risk_score: num(a.risk_score),
            risk_level: String(a.risk_level || ""),
            visual_risk_level: String(a.visual_risk_level || "unknown"),
            visual_risk_score: num(a.visual_risk_score),
            repair_spend: num(a.repair_spend),
            replacement_cost: num(a.replacement_cost),
            capex_priority: String(a.capex_priority || "-"),
            recommendation: String(a.recommendation || ""),
            rule_recommendation: inp.rule_recommendation || String(a.recommendation || ""),
            warranty: metricOf(inp.warranty_status, "no warranty expiry date recorded"),
            // The inspection stream was computed and weighted but never returned here,
            // so the UI could not report it either way. It can now.
            //
            // Read from the top level of evidence_json, not from `inputs`: `assess`
            // stores `inspection_basis` beside `inputs`, so the `inp.` read always came
            // back undefined and every asset reported "no inspection evidence" even
            // when the inspection stream carried 0.35 of its score.
            inspection_stream: metricOf(
              evidenceJson?.inspection_basis && evidenceJson.inspection_basis !== "none"
                ? evidenceJson.inspection_basis
                : null,
              "no inspection evidence reached this assessment"
            ),
            warranty_gate_applied: inp.warranty_gate_applied === true,
            corrective_wo_count: num(a.corrective_wo_count),
            mtbf: {
              series: metricOf(inp.mtbf_series, "not enough dated corrective events"),
              mean_months: metricOf(inp.mtbf_mean_months, "not enough dated corrective events"),
              verdict: metricOf(inp.mtbf_verdict, "not enough intervals to call a direction"),
            },
            dominant_issue_mtbf: inp.dominant_issue
              ? {
                  issue: inp.dominant_issue,
                  issue_label: inp.dominant_issue_label || ISSUE_LABELS[String(inp.dominant_issue)] || "",
                  series: metricOf(inp.dominant_mtbf_series, "not enough dated events for this issue"),
                  mean_months: metricOf(inp.dominant_mtbf_mean_months, "not enough dated events for this issue"),
                  verdict: metricOf(inp.dominant_mtbf_verdict, "not enough intervals to call a direction"),
                }
              : null,
            mttr_hours: metricOf(inp.mttr_hours, "no work-order duration recorded in the CMMS"),
            repeat_failures: metricOf(inp.repeat_failures, "no dated issue evidence to compare"),
            baselines: evidenceJson?.baselines || null,
            unavailable: evidenceJson?.unavailable || [],
            evidence: evidenceJson,
            assessed_at: String(a.assessed_at || ""),
          }
        : null,
      analysis,
      engine_overrides: overrides,
      findings,
      issue_matrix: { years, rows: issueMatrix },
      history: hRows.map((h: any) => ({
        score: num(h.score),
        risk_score: num(h.risk_score),
        rul_years: num(h.rul_years),
        assessed_at: String(h.assessed_at || ""),
      })),
    };
  },
});


/* ------------------------------------------------------------------ *
 * Maintenance helpers
 * ------------------------------------------------------------------ */

server.addHandler({
  name: "cleanup-seed",
  description: "Remove the sentinel rows that the CSV table import created.",
  parameters: {},
  execute: async () => {
    const db = conn();
    const out: Record<string, number> = {};
    for (const t of ["findings", "risk_analyses", "assessments", "assessment_history"]) {
      const r = db.query(`delete from ${t} where asset_id = 0`);
      out[t] = num(r.rowCount);
    }
    const wm = db.query("delete from wo_meta where wo_id = 0");
    out["wo_meta"] = num(wm.rowCount);
    const bl = db.query("delete from baselines where category = '__seed__'");
    out["baselines"] = num(bl.rowCount);
    return { ok: true, deleted: out };
  },
});

server.addHandler({
  name: "dedupe-history",
  description:
    "Collapse assessment_history to one row per asset per calendar day, keeping the most recent. Repairs history written before the one-per-day rule existed.",
  parameters: {},
  execute: async () => {
    const db = conn();
    const { rows } = db.query(
      "select id, asset_id, assessed_at from assessment_history where asset_id <> 0 order by asset_id, assessed_at asc"
    );
    // Keep the last row for each (asset, day); delete the earlier ones.
    const keep: Record<string, number> = {};
    for (const r of rows) {
      const key = `${num(r.asset_id)}|${String(r.assessed_at).slice(0, 10)}`;
      keep[key] = num(r.id);
    }
    const keepIds: number[] = [];
    for (const k of Object.keys(keep)) keepIds.push(keep[k]);

    let removed = 0;
    for (const r of rows) {
      if (keepIds.indexOf(num(r.id)) === -1) {
        db.query("delete from assessment_history where id = $1", [num(r.id)]);
        removed++;
      }
    }
    return { ok: true, examined: rows.length, kept: keepIds.length, removed };
  },
});

server.addHandler({
  name: "unread-photos",
  description:
    "List the BEFORE photos on this asset's corrective work orders that have no findings yet — what an operator would need to supply while Facilio's attachment URLs stay unreadable from a browser.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");

    const woRes = await cmms("list-work-orders", {
      filters: `resource=${assetId}&type=Corrective,Breakdown`,
      select: "id,subject,scheduledStart,createdTime,noOfAttachments",
      page_size: 200,
    });
    const wos: any[] = woRes.data || [];

    const db = conn();
    const { rows: done } = db.query(
      `select distinct attachment_id from findings
        where asset_id = $1 and attachment_id <> 0 and source in ${PHOTO_SOURCES_SQL}`,
      [assetId]
    );
    const analyzed: number[] = done.map((r: any) => num(r.attachment_id));

    const pending: any[] = [];
    let total = 0;
    for (const wo of wos) {
      // noOfAttachments is populated in this org, so work orders with no files cost
      // nothing to skip.
      if (num(wo.noOfAttachments) === 0) continue;
      let atts: any[] = [];
      try {
        const r = await cmms("list-workorder-attachments", {
          work_order_id: num(wo.id),
          attachment_type: "before",
        });
        atts = r.data || [];
      } catch (e) {
        continue;
      }
      for (const a of atts) {
        total++;
        const attachmentId = num(a.id);
        if (analyzed.indexOf(attachmentId) >= 0) continue;
        pending.push({
          attachment_id: attachmentId,
          wo_id: num(wo.id),
          wo_subject: String(wo.subject || ""),
          wo_date: String(wo.scheduledStart || wo.createdTime || "").slice(0, 10),
          filename: String(a.fileName || ""),
          size: num(a.fileSize),
          content_type: String(a.contentType || "image/jpeg"),
        });
      }
    }

    return { asset_id: assetId, before_photos_total: total, analyzed: total - pending.length, pending };
  },
});

server.addHandler({
  name: "purge-photo-findings",
  description:
    "Delete every photo-derived finding across all assets. Used when photo evidence must be re-established from live Facilio data only.",
  parameters: {},
  execute: async () => {
    const db = conn();
    // Both sources go: `photo` carried the defects, `photo_unusable` recorded photos
    // that yielded none. Neither can be reproduced from live data at present, so
    // leaving either behind would show visual evidence the app cannot obtain.
    const findings = db.query("delete from findings where source in ('photo', 'photo_manual', 'photo_unusable')");
    return {
      ok: true,
      findings_deleted: num(findings.rowCount),
      note: "Re-run assess for every affected asset: the condition score weighted photo severities, so stored assessments are now stale.",
    };
  },
});

server.addHandler({
  name: "reset-asset",
  description: "Delete all stored findings, analyses and assessments for one asset so it can be re-assessed from scratch.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");
    const db = conn();
    const out: Record<string, number> = {};
    for (const t of ["findings", "risk_analyses", "assessments", "assessment_history"]) {
      const r = db.query(`delete from ${t} where asset_id = $1`, [assetId]);
      out[t] = num(r.rowCount);
    }
    return { ok: true, asset_id: assetId, deleted: out };
  },
});

/* ------------------------------------------------------------------ *
 * The two narrow deletes a fresh re-assessment needs.
 *
 * Both exist because `assess` weights every finding ROW into the condition
 * score (see sevWoRows), not one vote per work order. Re-deriving evidence
 * without first removing what it supersedes leaves two rows for one photo or
 * one work order, and the grade moves on data that never changed.
 *
 * `reset-asset` above is deliberately NOT reused. It also empties
 * assessment_history, which is the only record of how this asset's score has
 * moved: clearing it resets trend_direction to insufficient_evidence and
 * strips deterioration out of the risk score. A fresh run must re-derive
 * evidence, never erase history.
 * ------------------------------------------------------------------ */

server.addHandler({
  name: "clear-wo-text-findings",
  description:
    "Delete one asset's work-order findings without replacing them. The assessment path does not use this — save-wo-evidence takes replace=true and does the delete alongside its insert, so a failed agent cannot leave the asset emptied. Kept for Settings, which clears an asset deliberately.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");
    const db = conn();
    const r = db.query("delete from findings where asset_id = $1 and asset_id <> 0 and source = 'wo_text'", [assetId]);
    return { ok: true, asset_id: assetId, deleted: num(r.rowCount) };
  },
});

server.addHandler({
  name: "clear-attachment-findings",
  description:
    "Delete every finding recorded against the given attachment ids for one asset, whatever its source, so a fresh analysis of those photos replaces the old rows instead of adding to them. Pass only attachments that were just re-read and re-analyzed.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
    attachmentIds: { description: "Comma-separated attachment ids that were just re-analyzed", type: "string" },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");

    const ids: number[] = [];
    for (const part of String(args.attachmentIds || "").split(",")) {
      const id = num(part);
      // attachment_id 0 is the no-attachment sentinel every wo_text row carries,
      // and num() turns a blank or malformed entry into 0. Dropping anything that
      // is not a positive id is what keeps an empty list from deleting the whole
      // text stream.
      if (id > 0 && ids.indexOf(id) === -1) ids.push(id);
    }
    if (ids.length === 0) return { ok: true, asset_id: assetId, attachments: 0, deleted: 0 };

    // One statement per id rather than a built IN list: every other query in this
    // file is fully parameterized, and a photo-bearing asset has tens, not thousands.
    //
    // Not filtered by source on purpose. A surviving photo_manual row plus a fresh
    // photo row for the same attachment slips past save-findings' (attachment_id,
    // issue_code) guard whenever the issue code differs, and that one photo then
    // votes twice into the score.
    const db = conn();
    let deleted = 0;
    for (const id of ids) {
      const r = db.query(
        "delete from findings where asset_id = $1 and asset_id <> 0 and attachment_id = $2 and attachment_id <> 0",
        [assetId, id]
      );
      deleted += num(r.rowCount);
    }
    return { ok: true, asset_id: assetId, attachments: ids.length, deleted };
  },
});

server.addHandler({
  name: "assess-all",
  description: "Re-run text normalization and the lifecycle engines for every asset that has corrective work orders. Intended for a scheduled job.",
  parameters: {
    limit: { description: "Max assets to process (default 25)", type: "number" },
  },
  execute: async (args) => {
    const limit = num(args.limit) || 25;
    const res = await cmms("list-assets", { page_size: 200, select: "id,name,category" });
    const assets: any[] = (res.data || []).slice(0, limit);
    const done: number[] = [];
    const failed: any[] = [];
    for (const a of assets) {
      const id = num(a.id);
      try {
        const woRes = await cmms("list-work-orders", {
          filters: `resource=${id}&type=Corrective,Breakdown`,
          select: "id",
          page_size: 1,
          include_count: true,
        });
        if (num(woRes.count) === 0 && (woRes.data || []).length === 0) continue;
        done.push(id);
      } catch (e) {
        failed.push({ asset_id: id, error: String(e) });
      }
    }
    await events.publish("assessments", { type: "batch.scanned", assets: done.length });
    return { ok: true, candidates: done, failed };
  },
});

/* ------------------------------------------------------------------ *
 * Baselines — the four values Facilio holds no field for.
 *
 * Precedence is actuals > human override > AI estimate, so a real number always
 * beats an estimate and the estimate retires itself the moment costs are logged.
 * Agents cannot be called from here (the sandbox has AGENTS_TOKEN but no
 * AGENTS_URL), so the browser runs `asset-baseline` and posts the reply to
 * save-baselines.
 * ------------------------------------------------------------------ */

/**
 * Resolve one category's baselines, reporting where each number came from.
 *
 * There is deliberately no default. Expected life, criticality and cost have no
 * field in Facilio, so their only honest sources are the asset-baseline agent —
 * which states its basis and confidence — or a human override. When neither
 * exists the numbers come back as zero with `resolved: false`, and every consumer
 * reports the dependent metric unavailable. A hardcoded "15 years, medium" would
 * silently produce a remaining-life figure and a CAPEX priority that nobody could
 * source, which is worse than admitting the gap.
 */
function baselineFor(db: any, category: string, assetId?: number) {
  const fromRow = (r: any, source: string) => ({
    expected_life_years: num(r.expected_life_years),
    avg_repair_cost: num(r.avg_repair_cost),
    replacement_cost: num(r.replacement_cost),
    criticality: String(r.criticality || ""),
    source,
    confidence: {
      life: num(r.conf_life),
      criticality: num(r.conf_criticality),
      repair: num(r.conf_repair),
      replacement: num(r.conf_replacement),
    },
    basis: String(r.basis_json || "[]"),
    assumptions: String(r.assumptions_json || "[]"),
    estimated_at: String(r.estimated_at || ""),
    resolved: true,
  });

  const { rows } = db.query("select * from baselines where category = $1 limit 1", [category]);
  const categoryRow = rows.length > 0 ? rows[0] : null;

  // A human override outranks every estimate, including this asset's own sample —
  // otherwise the next assessment would silently overwrite the correction.
  if (categoryRow && String(categoryRow.source) === "override") {
    return fromRow(categoryRow, "override");
  }

  // This asset's most recent condition-core sample. Per-asset by request: the agent
  // re-supplies the constants on every run, so two assets of one category can differ.
  if (assetId) {
    const { rows: aRows } = db.query(
      "select evidence_json from assessments where asset_id = $1 and asset_id <> 0 limit 1",
      [assetId]
    );
    if (aRows.length > 0) {
      let sample: any = null;
      try {
        sample = (JSON.parse(String(aRows[0].evidence_json || "{}")) || {}).baselines_sample;
      } catch (e) {
        sample = null;
      }
      if (sample && num(sample.expected_life_years) > 0) return fromRow(sample, "asset_sample");
    }
  }

  // Cold start: the category-level estimate, seeded from the Baselines page.
  if (categoryRow) return fromRow(categoryRow, String(categoryRow.source || "ai_estimate"));

  return {
    expected_life_years: 0,
    avg_repair_cost: 0,
    replacement_cost: 0,
    criticality: "",
    source: "unresolved",
    confidence: { life: 0, criticality: 0, repair: 0, replacement: 0 },
    basis: "[]",
    assumptions: "[]",
    estimated_at: "",
    resolved: false,
  };
}

server.addHandler({
  name: "baselines",
  description: "Read every category's baselines with provenance, confidence, basis and assumptions.",
  parameters: {},
  execute: async () => {
    const db = conn();
    const { rows } = db.query("select * from baselines where category <> '__seed__' order by category");
    const parse = (s: string) => {
      try {
        return JSON.parse(String(s || "{}"));
      } catch (e) {
        return {};
      }
    };
    return {
      baselines: rows.map((r: any) => ({
        category: String(r.category),
        expected_life_years: num(r.expected_life_years),
        avg_repair_cost: num(r.avg_repair_cost),
        replacement_cost: num(r.replacement_cost),
        criticality: String(r.criticality || "medium"),
        source: String(r.source || "ai_estimate"),
        confidence: {
          life: num(r.conf_life),
          criticality: num(r.conf_criticality),
          repair: num(r.conf_repair),
          replacement: num(r.conf_replacement),
        },
        basis: parse(r.basis_json),
        assumptions: parse(r.assumptions_json),
        estimated_at: String(r.estimated_at || ""),
      })),
    };
  },
});

server.addHandler({
  name: "set-baseline-override",
  description:
    "Override one category's baselines by hand. Marks the row as an override so later estimates cannot overwrite it.",
  parameters: {
    category: { description: "Asset category", type: "string" },
    expectedLifeYears: { description: "Expected useful life in years", type: "number" },
    avgRepairCost: { description: "Average cost of one corrective repair", type: "number" },
    replacementCost: { description: "Full replacement cost", type: "number" },
    criticality: { description: "low | medium | high", type: "string" },
  },
  execute: async (args) => {
    const category = String(args.category || "").trim();
    if (!category) throw new Error("category is required");
    let crit = String(args.criticality || "medium");
    if (["low", "medium", "high"].indexOf(crit) === -1) crit = "medium";
    const life = clamp(num(args.expectedLifeYears), 1, 100);
    const repair = Math.max(num(args.avgRepairCost), 0);
    const replacement = Math.max(num(args.replacementCost), 0);

    const db = conn();
    const now = nowIso();
    const { rows: hit } = db.query("select 1 as h from baselines where category = $1 limit 1", [category]);
    if (hit.length > 0) {
      db.query(
        `update baselines set expected_life_years = $1, avg_repair_cost = $2, replacement_cost = $3,
           criticality = $4, source = 'override', conf_life = 1, conf_criticality = 1, conf_repair = 1,
           conf_replacement = 1, estimated_at = $5 where category = $6`,
        [life, repair, replacement, crit, now, category]
      );
    } else {
      db.query(
        `insert into baselines
           (category, expected_life_years, avg_repair_cost, replacement_cost, criticality, source,
            conf_life, conf_criticality, conf_repair, conf_replacement, basis_json, assumptions_json, estimated_at)
         values ($1,$2,$3,$4,$5,'override',1,1,1,1,'{}','{}',$6)`,
        [category, life, repair, replacement, crit, now]
      );
    }
    return { ok: true, category, source: "override" };
  },
});

/* ------------------------------------------------------------------ *
 * condition-core — the single analyst agent's input and output.
 *
 * `core-input` mints the block; `save-core` validates the reply and is the only
 * writer of inspection evidence. Between them sit the two locks that let one agent
 * be trusted with four jobs at once: the number lock on the prose it writes about
 * calculated results, and the quote lock on the claims it makes about what an
 * inspector wrote.
 * ------------------------------------------------------------------ */

/**
 * Closed inspections for one asset, with the inspector's written answers.
 *
 * `responseStatus === "Completed"` is the gate. A partially answered walkthrough is a
 * half-formed opinion, and reading it would let an inspector's first two notes stand
 * as the asset's condition of record. Note that `status` is the workflow state and is
 * NOT the gate: in this org every inspection sits at status "Open" while three are
 * responseStatus "Completed", so `status` would exclude all of them.
 *
 * A BOOLEAN answer carries no condition information on its own — only its `comments`
 * do. FILE_UPLOAD answers are skipped: this app cannot read attachment bytes.
 */
async function coreInspections(assetId: number) {
  let rows: any[] = [];
  try {
    const res = await cmms("list-inspections", {
      filters: `resource=${assetId}`,
      select: "id,name,responseStatus,status,scheduledWorkStart,createdTime",
      page_size: 100,
    });
    rows = res.data || [];
  } catch (e) {
    return [];
  }

  const closed = rows.filter((r) => String(r.responseStatus || "") === "Completed");
  const out: any[] = [];

  for (const r of closed) {
    const inspectionId = num(r.id);
    let detail: any = null;
    try {
      const res = await cmms("get-inspection", { inspectionId });
      detail = res.data || res;
    } catch (e) {
      continue;
    }

    const answers: any[] = [];
    for (const page of detail?.pages || []) {
      for (const q of page?.questions || []) {
        const a = q?.answer;
        if (!a) continue;
        const qType = String(q.questionType || "");
        if (qType === "FILE_UPLOAD") continue;
        const text = typeof a.answer === "string" ? a.answer : "";
        const comments = String(a.comments || "");
        if (!text && !comments) continue;
        answers.push({
          answer_id: String(num(a.id)),
          question: String(q.question || ""),
          question_type: qType,
          answer_value: typeof a.answer === "boolean" ? (a.answer ? "Yes" : "No") : "",
          text,
          comments,
        });
      }
    }
    if (answers.length === 0) continue;

    out.push({
      inspection_id: String(inspectionId),
      name: String(r.name || "Inspection"),
      event_date: String(r.scheduledWorkStart || r.createdTime || "").slice(0, 10),
      answers,
    });
  }

  return out;
}

/** Render the observed corrective volume and priority mix for one category. */
function categoryEvidence(db: any, category: string) {
  const { rows: mix } = db.query(
    `select priority, count(*) as n from wo_meta
      where wo_id <> 0 and asset_id in (
        select distinct asset_id from assessments where category = $1 and asset_id <> 0
      )
      group by priority`,
    [category]
  );
  const { rows: vol } = db.query(
    "select coalesce(sum(corrective_wo_count),0) as total, count(*) as assets from assessments where category = $1 and asset_id <> 0",
    [category]
  );
  return {
    volume: `${num(vol[0]?.total)} corrective work orders across ${num(vol[0]?.assets)} assessed asset(s) of this category`,
    mix: mix.length
      ? mix.map((m: any) => `${String(m.priority || "unspecified")} ${num(m.n)}`).join(", ")
      : "not available",
  };
}

server.addHandler({
  name: "core-input",
  description:
    "Build the condition-core agent's input block. With assetId: the full five-section block including closed-inspection answers. With category only: the baseline request alone, for the Baselines page.",
  parameters: {
    assetId: { description: "Facilio asset id, for the full block", type: "number" },
    category: { description: "Asset category, for a baseline-only block", type: "string" },
  },
  execute: async (args) => {
    const db = conn();
    const assetId = num(args.assetId);

    /* ---- Baseline-only mode: the Baselines page, no asset in play ---- */
    if (!assetId) {
      const category = String(args.category || "").trim();
      if (!category) throw new Error("assetId or category is required");
      let sample: any = {};
      try {
        const res = await cmms("list-assets", {
          filters: `category=${category}`,
          select: "id,name,category,type,manufacturer,model,description",
          page_size: 1,
        });
        sample = (res.data || [])[0] || {};
      } catch (e) {
        /* category may not be filterable; the agent copes without a model */
      }
      const ev = categoryEvidence(db, category);
      const input = [
        "MODE: BASELINES ONLY",
        "No asset is under assessment. Return the four class reference constants in",
        "`baselines`. For the other three sections return empty strings, empty arrays,",
        "zero inspections reviewed and confidence_in_recommendation \"low\".",
        "",
        "=== 5. BASELINE REQUEST ===",
        `asset_category: ${category}`,
        `asset_type: ${sample?.type?.displayName || "(not recorded)"}`,
        `manufacturer: ${sample?.manufacturer || "(not recorded)"}`,
        `model: ${sample?.model || "(not recorded)"}`,
        `description: ${sample?.description || "(not recorded)"}`,
        `currency: USD`,
        `region: India`,
        `corrective_volume: ${ev.volume}`,
        `priority_mix: ${ev.mix}`,
      ].join("\n");
      return { mode: "baselines_only", category, input, answers: [], inspection_count: 0 };
    }

    /* ---- Full mode ---- */
    const { rows: aRows } = db.query(
      "select category, asset_name, evidence_json from assessments where asset_id = $1 and asset_id <> 0 limit 1",
      [assetId]
    );
    if (aRows.length === 0) throw new Error(`no assessment stored for asset ${assetId} — run assess first`);
    const category = String(aRows[0].category || "DEFAULT");
    let calculated = "";
    try {
      calculated = String((JSON.parse(String(aRows[0].evidence_json || "{}")) || {}).narrative_block || "");
    } catch (e) {
      calculated = "";
    }
    if (!calculated) throw new Error(`asset ${assetId} has no stored calculated results — re-run assess`);

    const assetRes = await cmms("get-asset", { id: assetId });
    const facts = assetFacts(assetId, assetRes.data || assetRes);

    // Section 3: the photo agent's issues, counts already corrected by save-analysis.
    const { rows: anRows } = db.query(
      "select analysis_json from risk_analyses where asset_id = $1 and asset_id <> 0 order by analyzed_at desc limit 1",
      [assetId]
    );
    let photoLines: string[] = ["no photo analysis stored for this asset"];
    if (anRows.length > 0) {
      try {
        const an = JSON.parse(String(anRows[0].analysis_json || "{}"));
        const issues = (an.recurring_issues || []).slice(0, 8);
        if (issues.length > 0) {
          photoLines = issues.map(
            (i: any) =>
              `${i.display_name || i.issue}: ${num(i.occurrence_count)} corrective work orders, severity ${
                i.severity?.overall || "unknown"
              }, trend ${i.trend || "insufficient_evidence"}`
          );
        }
        const dq = an.data_quality || {};
        if (dq.assessment_limited) {
          photoLines.push(`data_quality: ${(dq.limitations || []).join("; ") || "assessment limited"}`);
        }
      } catch (e) {
        photoLines = ["photo analysis could not be read"];
      }
    }

    // Section 4: the inspector's own words, closed inspections only.
    const inspections = await coreInspections(assetId);
    const inspectionLines: string[] = [];
    if (inspections.length === 0) {
      inspectionLines.push("No closed inspection exists for this asset. Report zero inspections reviewed.");
    } else {
      for (const ins of inspections) {
        inspectionLines.push(`inspection ${ins.inspection_id} "${ins.name}" · ${ins.event_date}`);
        for (const a of ins.answers) {
          inspectionLines.push(`  answer ${a.answer_id} [${a.question_type}] "${a.question}":`);
          if (a.answer_value) inspectionLines.push(`    answered: ${a.answer_value}`);
          if (a.text) inspectionLines.push(`    "${a.text}"`);
          if (a.comments) inspectionLines.push(`    remarks: "${a.comments}"`);
        }
      }
    }

    const ev = categoryEvidence(db, category);
    const input = [
      "MODE: ASSESS-AND-EXPLAIN",
      "",
      "=== 1. ASSET ===",
      `asset_id: ${facts.asset_id}`,
      `name: ${facts.asset_name} · category: ${category}`,
      `manufacturer: ${facts.manufacturer || "unknown"} · model: ${facts.model || "unknown"}`,
      `location: ${facts.location || "unknown"}`,
      "",
      "=== 2. CALCULATED RESULTS (number-locked — introduce no figure absent here) ===",
      calculated,
      "",
      "=== 3. PHOTO ANALYSIS (counts already corrected by the engine) ===",
      ...photoLines,
      "",
      "=== 4. INSPECTIONS (closed only, the inspector's own words) ===",
      ...inspectionLines,
      "",
      "=== 5. BASELINE REQUEST ===",
      `asset_category: ${category}`,
      `manufacturer: ${facts.manufacturer || "(not recorded)"} · model: ${facts.model || "(not recorded)"}`,
      `currency: USD`,
      `region: India`,
      `corrective_volume: ${ev.volume}`,
      `priority_mix: ${ev.mix}`,
    ].join("\n");

    return {
      mode: "full",
      asset_id: assetId,
      category,
      input,
      block: calculated,
      answers: inspections,
      inspection_count: inspections.length,
    };
  },
});

server.addHandler({
  name: "save-core",
  description:
    "Validate and store the condition-core agent's single reply: number lock on the prose, quote lock on every inspection claim, clamps on the baselines. Writes inspection findings, which reach the condition score on the next assess.",
  parameters: {
    assetId: { description: "Facilio asset id; omit for a baselines-only reply", type: "number" },
    category: { description: "Asset category; required when assetId is omitted", type: "string" },
    block: { description: "The CALCULATED RESULTS section the agent was given", type: "string" },
    answers: { description: "The inspections/answers core-input returned, stringified", type: "string" },
    reply: { description: "The agent's JSON reply, stringified", type: "string" },
  },
  execute: async (args) => {
    let reply: any;
    try {
      reply = JSON.parse(String(args.reply || "{}"));
    } catch (e) {
      throw new Error("reply must be valid JSON");
    }
    const db = conn();
    const now = nowIso();

    /* ---- Baselines: clamped identically wherever they land ---- */
    const b = reply?.baselines || {};
    const life = num(b?.expected_life_years?.value);
    let crit = String(b?.criticality?.value || "medium");
    if (["low", "medium", "high"].indexOf(crit) === -1) crit = "medium";
    const repair = Math.max(num(b?.avg_repair_cost?.value), 0);
    const replacement = Math.max(num(b?.replacement_cost?.value), 0);
    // A cost figure without a customer rate card cannot be trusted above 0.6,
    // whatever the model claims.
    const confLife = clamp(num(b?.expected_life_years?.confidence), 0, 1);
    const confCrit = clamp(num(b?.criticality?.confidence), 0, 1);
    const confRepair = clamp(num(b?.avg_repair_cost?.confidence), 0, 0.6);
    const confReplacement = clamp(num(b?.replacement_cost?.confidence), 0, 0.6);
    const basisJson = JSON.stringify({
      expected_life_years: b?.expected_life_years?.basis || [],
      criticality: b?.criticality?.basis || [],
      avg_repair_cost: b?.avg_repair_cost?.basis || [],
      replacement_cost: b?.replacement_cost?.basis || [],
      capacity_inferred: b?.replacement_cost?.capacity_inferred || "",
      currency: b?.replacement_cost?.currency || "USD",
    });
    const assumptionsJson = JSON.stringify({
      expected_life_years: b?.expected_life_years?.assumptions || [],
      criticality: b?.criticality?.assumptions || [],
      avg_repair_cost: b?.avg_repair_cost?.assumptions || [],
      replacement_cost: b?.replacement_cost?.assumptions || [],
    });

    /* ---- Baselines-only mode: the Baselines page writes the category row ---- */
    const assetId = num(args.assetId);
    if (!assetId) {
      const category = String(args.category || "").trim();
      if (!category) throw new Error("assetId or category is required");
      const { rows: hit } = db.query("select source from baselines where category = $1 limit 1", [category]);
      if (hit.length > 0 && String(hit[0].source) === "override") {
        return { ok: true, category, skipped: "a human override is in place" };
      }
      if (hit.length > 0) {
        db.query(
          `update baselines set expected_life_years = $1, avg_repair_cost = $2, replacement_cost = $3,
             criticality = $4, source = 'ai_estimate', conf_life = $5, conf_criticality = $6,
             conf_repair = $7, conf_replacement = $8, basis_json = $9, assumptions_json = $10,
             estimated_at = $11 where category = $12`,
          [life, repair, replacement, crit, confLife, confCrit, confRepair, confReplacement,
           basisJson, assumptionsJson, now, category]
        );
      } else {
        db.query(
          `insert into baselines
             (category, expected_life_years, avg_repair_cost, replacement_cost, criticality, source,
              conf_life, conf_criticality, conf_repair, conf_replacement, basis_json, assumptions_json, estimated_at)
           values ($1,$2,$3,$4,$5,'ai_estimate',$6,$7,$8,$9,$10,$11,$12)`,
          [category, life, repair, replacement, crit, confLife, confCrit, confRepair, confReplacement,
           basisJson, assumptionsJson, now]
        );
      }
      return {
        ok: true,
        category,
        expected_life_years: life,
        criticality: crit,
        avg_repair_cost: repair,
        replacement_cost: replacement,
        low_confidence: confRepair < 0.6 || confReplacement < 0.6,
      };
    }

    /* ---- The number lock, over the prose sections only ---- *
     * `baselines` is exempt by design: it is the one section the agent is ASKED to
     * produce figures for. Everything in narrative and cross_stream must restate a
     * figure the engine already calculated. Compare on digit runs so "1.8" and
     * "1.8 years" both match, and strip thousands separators first.                */
    const block = String(args.block || "");
    const norm = (s: string) => s.replace(/,(?=\d{3}\b)/g, "");
    const digits = (s: string) => (norm(s).match(/\d+(?:\.\d+)?/g) || []);
    const allowed: Record<string, boolean> = {};
    for (const d of digits(block)) allowed[d] = true;
    const prose = JSON.stringify(reply?.narrative || {}) + JSON.stringify(reply?.cross_stream || {});
    const unseen: string[] = [];
    for (const d of digits(prose)) {
      if (!allowed[d] && unseen.indexOf(d) === -1) unseen.push(d);
    }
    const accepted = unseen.length === 0;

    /* ---- The quote lock ---- *
     * The engine can re-read the inspector's text, so unlike a photograph it can
     * check the claim. Every observation must cite a span that is actually there;
     * one that is not is dropped rather than stored as an inspector's words.       */
    let answerText: Record<string, string> = {};
    try {
      for (const ins of JSON.parse(String(args.answers || "[]"))) {
        for (const a of ins.answers || []) {
          answerText[String(a.answer_id)] = `${a.text || ""} ${a.comments || ""}`;
        }
      }
    } catch (e) {
      answerText = {};
    }
    // Delegates to the module-level lock, which `save-wo-evidence` uses too. Two copies
    // of a check that decides whether an LLM claim is admissible would eventually drift.
    const quoted = (answerId: string, quote: string) =>
      quoteFoundIn(answerText[String(answerId)] || "", quote);

    const ia = reply?.inspection_analysis || {};
    const observations: any[] = Array.isArray(ia.observations) ? ia.observations : [];
    const unquoted: string[] = [];
    const kept: any[] = [];
    for (const o of observations) {
      const issue = String(o?.type || "");
      if (ISSUE_CODES.indexOf(issue) === -1) {
        unquoted.push(`unknown issue_code "${issue}"`);
        continue;
      }
      if (!quoted(String(o?.answer_id || ""), String(o?.quote || ""))) {
        unquoted.push(`${issue}: quote not found in answer ${o?.answer_id}`);
        continue;
      }
      kept.push(o);
    }

    /* ---- Store surviving observations as inspection findings ---- *
     * `wo_id` carries the inspection id and `attachment_id` the answer id: the app
     * database allows no DDL, so these two columns are overloaded. Every corrective
     * query is scoped by `source` to keep them apart — see isCorrectiveEvidence.   */
    const dateByInspection: Record<string, string> = {};
    try {
      for (const ins of JSON.parse(String(args.answers || "[]"))) {
        dateByInspection[String(ins.inspection_id)] = String(ins.event_date || "");
      }
    } catch (e) {
      /* dates stay empty; the stream then has nothing to order by */
    }

    let id = nextId(db, "findings");
    let inserted = 0;
    let duplicates = 0;
    for (const o of kept) {
      const answerId = num(o.answer_id);
      const inspectionId = num(o.inspection_id);
      const issue = String(o.type);
      let severity = String(o.severity || "unknown");
      if (SEV_ORDER.indexOf(severity) === -1) severity = "unknown";

      const { rows: dup } = db.query(
        `select 1 as hit from findings
          where asset_id = $1 and attachment_id = $2 and issue_code = $3 and source = 'inspection' limit 1`,
        [assetId, answerId, issue]
      );
      if (dup.length > 0) {
        duplicates++;
        continue;
      }

      db.query(
        `insert into findings
           (id, asset_id, wo_id, attachment_id, source, issue_code, component, location,
            severity, confidence, extent_percent, evidence, photo_file_id, photo_usable,
            photo_quality_score, asset_type_match, component_match, event_date, created_at)
         values ($1,$2,$3,$4,'inspection',$5,$6,$7,$8,$9,0,$10,0,1,0,'uncertain','uncertain',$11,$12)`,
        [
          id++,
          assetId,
          inspectionId,
          answerId,
          issue,
          String(o.component || "unspecified"),
          String(o.location || ""),
          severity,
          clamp(num(o.confidence), 0, 1),
          JSON.stringify([
            `Inspection ${inspectionId}, answer ${answerId}: "${String(o.quote || "").slice(0, 300)}"`,
            "Inspector-observed condition, not a photograph and not a corrective work order.",
          ]),
          dateByInspection[String(o.inspection_id)] || "",
          now,
        ]
      );
      inserted++;
    }

    /* ---- Persist onto the assessment's evidence blob ---- */
    const { rows } = db.query("select evidence_json from assessments where asset_id = $1 limit 1", [assetId]);
    if (rows.length === 0) throw new Error(`no assessment stored for asset ${assetId}`);
    let evidence: any = {};
    try {
      evidence = JSON.parse(String(rows[0].evidence_json || "{}"));
    } catch (e) {
      evidence = {};
    }

    evidence.narrative = accepted
      ? { ...(reply.narrative || {}), source: "condition_core_agent", generated_at: now }
      : {
          source: "rejected_agent_reply",
          rejected_because: `reply contained figures absent from its input: ${unseen.join(", ")}`,
          generated_at: now,
        };
    evidence.narrative_number_lock = { accepted, unseen_figures: unseen };
    evidence.cross_stream = accepted ? reply.cross_stream || null : null;
    evidence.inspection_observations = {
      inspections_reviewed: num(ia.inspections_reviewed),
      kept: kept.length,
      confirms_good_condition: ia.confirms_good_condition === true,
      operability: ia.operability || null,
      repair_effectiveness: Array.isArray(ia.repair_effectiveness)
        ? ia.repair_effectiveness.filter((r: any) => quoted(String(r?.answer_id || ""), String(r?.quote || "")) || !r?.quote)
        : [],
      observations: kept,
    };
    evidence.quote_lock = { kept: kept.length, unquoted };
    // Read by baselineFor on the NEXT assess — this reply cannot change the score it
    // was asked to explain, only the one after it.
    evidence.baselines_sample = {
      expected_life_years: life,
      avg_repair_cost: repair,
      replacement_cost: replacement,
      criticality: crit,
      conf_life: confLife,
      conf_criticality: confCrit,
      conf_repair: confRepair,
      conf_replacement: confReplacement,
      basis_json: basisJson,
      assumptions_json: assumptionsJson,
      estimated_at: now,
    };

    db.query("update assessments set evidence_json = $1 where asset_id = $2", [
      JSON.stringify(evidence),
      assetId,
    ]);

    return {
      ok: true,
      asset_id: assetId,
      accepted,
      unseen_figures: unseen,
      observations_kept: kept.length,
      observations_unquoted: unquoted,
      inspection_findings_inserted: inserted,
      inspection_findings_duplicate: duplicates,
      expected_life_years: life,
      criticality: crit,
      low_confidence: confRepair < 0.6 || confReplacement < 0.6,
    };
  },
});

server.execute();
