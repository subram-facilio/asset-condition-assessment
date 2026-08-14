/**
 * condition-engine — server-side brain of the Condition Assessment Agent.
 *
 * Owns everything deterministic: fetching corrective work orders and their
 * BEFORE photos from Facilio CMMS, normalizing work-order text into issue
 * codes, counting occurrences (STEP 5/6/8 of the agent spec), and the
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
 * Work-order TEXT normalizer. The agent spec (rule 5) accepts "explicitly
 * stated work-order information" as evidence, which keeps recurrence analysis
 * working for assets that have no before photos at all.
 * Order matters: oil_leakage must be tested before the generic leakage.
 */
const WO_TEXT_RULES: Array<{ re: RegExp; issue: string; component?: string }> = [
  { re: /oil\s*(leak|seep|stain)|lubricant\s*leak/i, issue: "oil_leakage" },
  { re: /corro|rust|oxidi[sz]/i, issue: "corrosion" },
  { re: /insulat|lagging/i, issue: "insulation_damage" },
  { re: /crack|fractur|split/i, issue: "crack_fracture" },
  { re: /dent|deform|bent|buckl/i, issue: "dent_deformation" },
  { re: /broken|snapped|shatter/i, issue: "broken_component" },
  { re: /missing|absent/i, issue: "missing_component" },
  { re: /paint|coating|peel/i, issue: "coating_deterioration" },
  { re: /foul|clog|block|choke|dirt|strainer|coil clean|filter/i, issue: "fouling" },
  { re: /scal(e|ing)|deposit|limescale/i, issue: "scaling" },
  { re: /overheat|burn|scorch|thermal|short circuit|electrical|wiring|terminal/i, issue: "thermal_damage" },
  { re: /vibrat|align|loose|slack|belt tension/i, issue: "loose_component" },
  { re: /wear|erod|erosion|abrasion|worn/i, issue: "physical_wear" },
  { re: /leak|drip|seep|weep/i, issue: "leakage" },
  { re: /pitting|surface deterior|degrad/i, issue: "surface_deterioration" },
];

/** Component guess from work-order text — used only for wo_text findings. */
const COMPONENT_RULES: Array<{ re: RegExp; component: string }> = [
  { re: /compressor/i, component: "compressor" },
  { re: /impeller/i, component: "impeller" },
  { re: /coil|condenser coil|evaporator/i, component: "coil" },
  { re: /strainer|filter/i, component: "strainer" },
  { re: /bearing/i, component: "bearing" },
  { re: /seal|gasket/i, component: "seal" },
  { re: /motor/i, component: "motor" },
  { re: /pipe|piping|pipework|joint|flange/i, component: "piping" },
  { re: /panel|switchgear|breaker|mcc/i, component: "electrical_panel" },
  { re: /fan|blower/i, component: "fan" },
  { re: /pump\b/i, component: "pump_body" },
  { re: /valve/i, component: "valve" },
  { re: /housing|casing|body|shell/i, component: "housing" },
  { re: /duct/i, component: "duct" },
  { re: /belt/i, component: "belt" },
];

function normalizeWoText(text: string): { issue: string; component: string } | null {
  if (!text) return null;
  for (const rule of WO_TEXT_RULES) {
    if (rule.re.test(text)) {
      let component = "unspecified";
      for (const c of COMPONENT_RULES) {
        if (c.re.test(text)) {
          component = c.component;
          break;
        }
      }
      return { issue: rule.issue, component };
    }
  }
  return null;
}

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
    "Fetch an asset, its corrective work orders, their BEFORE photos and any inspections. Returns the evidence bundle plus which attachments already have cached findings.",
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
      "select distinct attachment_id from findings where asset_id = $1 and source = 'photo' and attachment_id <> 0",
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

    let inspections: any[] = [];
    let inspectionError = "";
    try {
      const insRes = await cmms("list-inspections", {
        filters: `resource=${assetId}`,
        page_size: 50,
        include_count: true,
      });
      inspections = insRes.data || [];
    } catch (e) {
      inspectionError = String(e);
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
      inspections,
      inspectionError,
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
      const source = unusable ? "photo_unusable" : "photo";
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
          "select 1 as hit from findings where attachment_id = $1 and issue_code = $2 and attachment_id <> 0 limit 1",
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
          String(f.component || "unspecified"),
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
 * normalize-wo-text — deterministic evidence stream from work-order text.
 * ------------------------------------------------------------------ */

server.addHandler({
  name: "normalize-wo-text",
  description:
    "Derive issue findings from corrective work-order subject/description text for one asset. Runs without photos and is deduped per (wo_id, issue).",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");

    const woRes = await cmms("list-work-orders", {
      filters: `resource=${assetId}&type=Corrective,Breakdown`,
      select: "id,subject,description,type,createdTime,scheduledStart",
      page_size: 200,
    });
    const wos: any[] = woRes.data || [];

    const db = conn();
    const now = nowIso();
    let id = nextId(db, "findings");
    let inserted = 0;
    let unmatched = 0;

    for (const wo of wos) {
      const text = `${wo.subject || ""} ${wo.description || ""}`;
      const hit = normalizeWoText(text);
      if (!hit) {
        unmatched++;
        continue;
      }
      const woId = num(wo.id);
      const { rows } = db.query(
        "select 1 as hit from findings where asset_id = $1 and wo_id = $2 and issue_code = $3 and source = 'wo_text' limit 1",
        [assetId, woId, hit.issue]
      );
      if (rows.length > 0) continue;

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
          hit.issue,
          hit.component,
          "unknown",
          0.55,
          JSON.stringify([
            `Work order ${woId} text states: "${String(wo.subject || "").slice(0, 160)}".`,
            "Derived from work-order wording, not from photo evidence.",
          ]),
          String(wo.scheduledStart || wo.createdTime || ""),
          now,
        ]
      );
      inserted++;
    }

    return { ok: true, work_orders_scanned: wos.length, inserted, unmatched };
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
    component: String(r.component || "unspecified"),
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
  const findings = allRows.filter((f) => f.source !== "photo_unusable");
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
  const photoFindings = findings.filter((f) => f.source === "photo");
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
        confidence: eng.confidence,
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
      analysis_source: agentIssues.length > 0 ? "photo_validation_agent" : "engine_only",
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
    const cfg = baselineFor(db, category);

    /* ---- Reliability: MTBF, MTTR and repeat failures ---- */
    const { rows: issueDates } = db.query(
      "select wo_id, issue_code, event_date from findings where asset_id = $1 and asset_id <> 0 and source <> 'photo_unusable'",
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

    /* ---- Inspection stream (dormant while the org has none) ---- */
    let inspection: any = { stream: missing<string>("not queried") };
    try {
      const insRes = await cmms("list-inspections", {
        filters: `resource=${assetId}`,
        select:
          "id,scorePercent,totalScore,fullScore,totalFindings,totalFindingsClosed,responseStatus,status,actualWorkEnd,scheduledWorkStart,createdTime",
        page_size: 100,
      });
      const insRows: any[] = insRes.data || [];
      if (insRows.length === 0) {
        inspection = { stream: missing<string>("no inspections exist for this asset"), grade: null };
      } else {
        const scored = insRows.filter((r) => num(r.scorePercent) > 0 || num(r.totalScore) > 0);
        if (scored.length === 0) {
          inspection = {
            stream: missing<string>(`${insRows.length} inspection(s) found but none is scored`),
            grade: null,
          };
        } else {
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
          inspection = {
            stream: have("available"),
            grade: round(1 + (100 - clamp(pct, 0, 100)) / 25, 2),
            count: scored.length,
          };
        }
      }
    } catch (e) {
      inspection = { stream: missing<string>(`inspection lookup failed`), grade: null };
    }

    /* ---- Condition score (1 best .. 5 worst) ---- */
    const { rows: sevRows } = db.query(
      "select severity, confidence, source from findings where asset_id = $1 and asset_id <> 0",
      [assetId]
    );
    // Severity is weighted by confidence and by the work order's priority, so a
    // High-priority corrective event counts for more than a Low one.
    const priorityByWo: Record<string, string> = {};
    for (const w of wos) {
      priorityByWo[String(num(w.id))] = String(w.priority?.displayName || w.priority?.name || w.priority || "");
    }
    const { rows: sevWoRows } = db.query(
      "select wo_id, severity, confidence, source from findings where asset_id = $1 and asset_id <> 0 and source <> 'photo_unusable'",
      [assetId]
    );
    let sevNum = 0;
    let sevDen = 0;
    for (const r of sevWoRows) {
      const c = Math.max(num(r.confidence), 0.1) * priorityWeight(priorityByWo[String(num(r.wo_id))] || "");
      sevNum += SEV_VALUE[String(r.severity)] !== undefined ? SEV_VALUE[String(r.severity)] * c : 2.5 * c;
      sevDen += c;
    }
    const hasFindings = sevWoRows.length > 0;
    const sevIndex = sevDen > 0 ? sevNum / sevDen : 1;

    // Name the severity stream after where its evidence actually came from. With no
    // readable photos every severity is derived from work-order wording, and calling
    // that stream "photo_severity" would imply the score was visually corroborated
    // when nothing was ever seen.
    let sevPhotoBacked = 0;
    for (const r of sevWoRows) if (String(r.source) === "photo") sevPhotoBacked++;
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
      streams.push({ name: "inspection_grade", w: 0.35, v: num(inspection.grade) });
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
    const recentWos = wos.filter((w) => {
      const d = String(w.scheduledStart || w.createdTime || "");
      return d && num(d.slice(0, 4)) >= num(nowIso().slice(0, 4)) - 3;
    }).length;
    const repairSpend = recentWos * avgRepair;
    const spendRatio = replacementCost > 0 ? repairSpend / replacementCost : 0;
    const capexPriority =
      riskLevel === "HIGH" && (rulYears < 2 || spendRatio > 0.3)
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
        expected_life_years: expectedLife,
        condition_factor: conditionFactor,
        deterioration,
        deterioration_basis: deteriorationBasis,
        deterioration_velocity: velocity.available ? velocity.value : null,
        criticality,
        dominant_issue: top ? top.issue : "none",
        dominant_recurrence: dominantRecurrence,
        dominant_trend: topTrend,
        rul_years: rul.available ? rul.value : null,
        rul_factor: rul.available ? rulFactor : null,
        mtbf_mean_months: reliability.mtbf_mean_months.available ? reliability.mtbf_mean_months.value : null,
        mtbf_verdict: reliability.mtbf_verdict.available ? reliability.mtbf_verdict.value : null,
        mtbf_series: reliability.mtbf_series.available ? reliability.mtbf_series.value : null,
        // The dominant issue's own interval series answers "is THIS problem
        // accelerating?", which is sharper than the all-events series.
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
          ? "actual costs logged in Facilio"
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
        top ? top.issue : "none",
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
      inspection.stream.available ? "" : `evidence_stream_absent: inspection grade — ${inspection.stream.reason}`,
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

    const row = {
      asset_id: assetId,
      asset_name: facts.asset_name,
      category,
      score,
      grade,
      dominant_issue: top ? top.issue : "none",
      dominant_issue_label: top ? top.display_name : "None",
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
        component: String(r.component || ""),
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
    for (const t of ["findings", "risk_analyses", "assessments", "assessment_history", "photo_analysis"]) {
      const r = db.query(`delete from ${t} where asset_id = 0`);
      out[t] = num(r.rowCount);
    }
    const wm = db.query("delete from wo_meta where wo_id = 0");
    out["wo_meta"] = num(wm.rowCount);
    const bl = db.query("delete from baselines where category = '__seed__'");
    out["baselines"] = num(bl.rowCount);
    const zp = db.query("delete from zz_probe");
    out["zz_probe"] = num(zp.rowCount);
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
  name: "purge-photo-findings",
  description:
    "Delete every photo-derived finding and every stored agent photo reply, across all assets. Used when photo evidence must be re-established from live Facilio data only.",
  parameters: {},
  execute: async () => {
    const db = conn();
    // Both sources go: `photo` carried the defects, `photo_unusable` recorded photos
    // that yielded none. Neither can be reproduced from live data at present, so
    // leaving either behind would show visual evidence the app cannot obtain.
    const findings = db.query("delete from findings where source in ('photo', 'photo_unusable')");
    const analyses = db.query("delete from photo_analysis");
    return {
      ok: true,
      findings_deleted: num(findings.rowCount),
      photo_analyses_deleted: num(analyses.rowCount),
      note: "Re-run assess for every affected asset: the condition score weighted photo severities, so stored assessments are now stale.",
    };
  },
});

server.addHandler({
  name: "purge-cost-config",
  description:
    "Empty the legacy cost_config table. The table itself cannot be dropped — the app DB role has no DDL — so its rows are removed instead.",
  parameters: {},
  execute: async () => {
    const db = conn();
    const r = db.query("delete from cost_config");
    return { ok: true, rows_deleted: num(r.rowCount) };
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
function baselineFor(db: any, category: string) {
  const { rows } = db.query("select * from baselines where category = $1 limit 1", [category]);
  if (rows.length > 0) {
    const r = rows[0];
    return {
      expected_life_years: num(r.expected_life_years),
      avg_repair_cost: num(r.avg_repair_cost),
      replacement_cost: num(r.replacement_cost),
      criticality: String(r.criticality || ""),
      source: String(r.source || "ai_estimate"),
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
    };
  }

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
  name: "baseline-input",
  description:
    "Build the input block for the asset-baseline agent for one category, including the observed corrective volume and priority mix. Returns cached:true when an estimate already exists.",
  parameters: {
    category: { description: "Asset category", type: "string" },
    force: { description: "1 to re-estimate even when cached", type: "number" },
  },
  execute: async (args) => {
    const category = String(args.category || "").trim();
    if (!category) throw new Error("category is required");
    const db = conn();

    if (!num(args.force)) {
      const { rows } = db.query("select category, estimated_at from baselines where category = $1 limit 1", [
        category,
      ]);
      if (rows.length > 0) {
        return { cached: true, category, estimated_at: String(rows[0].estimated_at || ""), input: "" };
      }
    }

    // One representative asset of this category, for manufacturer and model.
    let sample: any = {};
    try {
      const res = await cmms("list-assets", {
        filters: `category=${category}`,
        select: "id,name,category,manufacturer,model,description",
        page_size: 1,
      });
      sample = (res.data || [])[0] || {};
    } catch (e) {
      /* category may not be filterable; the agent copes without a model */
    }

    // Observed corrective volume and priority mix for this category, which is real
    // evidence the agent may use for its criticality judgement.
    const { rows: mix } = db.query(
      `select priority, count(*) as n from wo_meta
        where wo_id <> 0 and asset_id in (
          select distinct asset_id from assessments where category = $1 and asset_id <> 0
        )
        group by priority`,
      [category]
    );
    const mixText = mix.length
      ? mix.map((m: any) => `${String(m.priority || "unspecified")} ${num(m.n)}`).join(", ")
      : "not available";
    const { rows: vol } = db.query(
      "select coalesce(sum(corrective_wo_count),0) as total, count(*) as assets from assessments where category = $1 and asset_id <> 0",
      [category]
    );

    const input = [
      `asset_category: ${category}`,
      `asset_type: ${sample?.type?.displayName || "(not recorded)"}`,
      `manufacturer: ${sample?.manufacturer || "(not recorded)"}`,
      `model: ${sample?.model || "(not recorded)"}`,
      `description: ${sample?.description || "(not recorded)"}`,
      `currency: INR`,
      `region: India`,
      `corrective_volume: ${num(vol[0]?.total)} corrective work orders across ${num(vol[0]?.assets)} assessed asset(s) of this category`,
      `priority_mix: ${mixText}`,
    ].join("\n");

    return { cached: false, category, input };
  },
});

server.addHandler({
  name: "save-baselines",
  description:
    "Store the asset-baseline agent's reply for one category, with its basis, assumptions and per-field confidence. Cost confidence is capped so a low-basis figure can never present as certain.",
  parameters: {
    category: { description: "Asset category", type: "string" },
    reply: { description: "The agent's JSON reply, stringified", type: "string" },
  },
  execute: async (args) => {
    const category = String(args.category || "").trim();
    if (!category) throw new Error("category is required");
    let r: any;
    try {
      r = JSON.parse(String(args.reply || "{}"));
    } catch (e) {
      throw new Error("reply must be valid JSON");
    }

    const life = num(r?.expected_life_years?.value) || BASELINE_FALLBACK.expected_life_years;
    let crit = String(r?.criticality?.value || BASELINE_FALLBACK.criticality);
    if (["low", "medium", "high"].indexOf(crit) === -1) crit = "medium";
    const repair = Math.max(num(r?.avg_repair_cost?.value), 0);
    const replacement = Math.max(num(r?.replacement_cost?.value), 0);

    // A cost figure without a customer rate card cannot be trusted above 0.6,
    // whatever the model claims.
    const confLife = clamp(num(r?.expected_life_years?.confidence), 0, 1);
    const confCrit = clamp(num(r?.criticality?.confidence), 0, 1);
    const confRepair = clamp(num(r?.avg_repair_cost?.confidence), 0, 0.6);
    const confReplacement = clamp(num(r?.replacement_cost?.confidence), 0, 0.6);

    const basis = {
      expected_life_years: r?.expected_life_years?.basis || [],
      criticality: r?.criticality?.basis || [],
      avg_repair_cost: r?.avg_repair_cost?.basis || [],
      replacement_cost: r?.replacement_cost?.basis || [],
      capacity_inferred: r?.replacement_cost?.capacity_inferred || "",
      currency: r?.replacement_cost?.currency || "INR",
    };
    const assumptions = {
      expected_life_years: r?.expected_life_years?.assumptions || [],
      criticality: r?.criticality?.assumptions || [],
      avg_repair_cost: r?.avg_repair_cost?.assumptions || [],
      replacement_cost: r?.replacement_cost?.assumptions || [],
    };

    const db = conn();
    const now = nowIso();
    const { rows: hit } = db.query("select source from baselines where category = $1 limit 1", [category]);

    if (hit.length > 0) {
      // Never let an estimate overwrite a human override.
      if (String(hit[0].source) === "override") {
        return { ok: true, category, skipped: "a human override is in place" };
      }
      db.query(
        `update baselines set expected_life_years = $1, avg_repair_cost = $2, replacement_cost = $3,
           criticality = $4, source = 'ai_estimate', conf_life = $5, conf_criticality = $6,
           conf_repair = $7, conf_replacement = $8, basis_json = $9, assumptions_json = $10,
           estimated_at = $11 where category = $12`,
        [
          life,
          repair,
          replacement,
          crit,
          confLife,
          confCrit,
          confRepair,
          confReplacement,
          JSON.stringify(basis),
          JSON.stringify(assumptions),
          now,
          category,
        ]
      );
    } else {
      db.query(
        `insert into baselines
           (category, expected_life_years, avg_repair_cost, replacement_cost, criticality, source,
            conf_life, conf_criticality, conf_repair, conf_replacement, basis_json, assumptions_json, estimated_at)
         values ($1,$2,$3,$4,$5,'ai_estimate',$6,$7,$8,$9,$10,$11,$12)`,
        [
          category,
          life,
          repair,
          replacement,
          crit,
          confLife,
          confCrit,
          confRepair,
          confReplacement,
          JSON.stringify(basis),
          JSON.stringify(assumptions),
          now,
        ]
      );
    }

    return {
      ok: true,
      category,
      expected_life_years: life,
      criticality: crit,
      avg_repair_cost: repair,
      replacement_cost: replacement,
      confidence: { life: confLife, criticality: confCrit, repair: confRepair, replacement: confReplacement },
      low_confidence: confRepair < 0.6 || confReplacement < 0.6,
    };
  },
});

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
 * analyze-inspections — the inspection evidence stream.
 *
 * Built against verified fields but dormant in this org: there are no inspections
 * and no templates, and templates cannot be created through the connection. It
 * activates with no code change the moment one exists.
 * ------------------------------------------------------------------ */

server.addHandler({
  name: "analyze-inspections",
  description:
    "Read completed inspections for one asset and return the condition trajectory from scorePercent plus the unresolved finding burden.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");

    let rows: any[] = [];
    let error = "";
    try {
      const res = await cmms("list-inspections", {
        filters: `resource=${assetId}`,
        select:
          "id,name,resource,parent,templateType,scorePercent,totalScore,fullScore," +
          "totalFindings,totalFindingsClosed,totalQuestion,totalAnswered," +
          "responseStatus,status,actualWorkEnd,scheduledWorkStart,createdTime",
        page_size: 100,
      });
      rows = res.data || [];
    } catch (e) {
      error = String(e);
    }

    if (error) {
      return {
        stream: missing<string>(`inspection lookup failed: ${error.slice(0, 160)}`),
        inspections: [],
      };
    }
    if (rows.length === 0) {
      return {
        stream: missing<string>("no inspections exist for this asset"),
        inspections: [],
        grade_index: missing<number>("no inspections exist for this asset", 0),
        trajectory: [],
        open_findings: missing<number>("no inspections exist for this asset", 0),
      };
    }

    // Only completed inspections may inform a condition grade.
    const done = rows.filter((r) => {
      const s = String(r.responseStatus || r.status || "").toLowerCase();
      return s === "" || s.indexOf("complete") >= 0 || s.indexOf("submit") >= 0 || s.indexOf("closed") >= 0;
    });
    const usable = done.filter((r) => num(r.scorePercent) > 0 || num(r.totalScore) > 0);

    if (usable.length === 0) {
      return {
        stream: missing<string>(
          `${rows.length} inspection(s) found but none is complete with a score`
        ),
        inspections: rows.length,
        grade_index: missing<number>("no completed, scored inspection", rows.length),
        trajectory: [],
        open_findings: missing<number>("no completed, scored inspection", rows.length),
      };
    }

    const traj = usable
      .map((r) => {
        const pct =
          num(r.scorePercent) > 0
            ? num(r.scorePercent)
            : num(r.fullScore) > 0
            ? (num(r.totalScore) / num(r.fullScore)) * 100
            : 0;
        return {
          inspection_id: num(r.id),
          date: String(r.actualWorkEnd || r.scheduledWorkStart || r.createdTime || "").slice(0, 10),
          score_percent: round(pct, 1),
          // A high score means good condition, so invert onto the 1..5 worst-is-5 scale.
          grade: round(1 + (100 - clamp(pct, 0, 100)) / 25, 2),
          findings: num(r.totalFindings),
          findings_closed: num(r.totalFindingsClosed),
          template_type: String(r.templateType || ""),
        };
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));

    const latest = traj[traj.length - 1];
    const open = traj.reduce((a, t) => a + Math.max(t.findings - t.findings_closed, 0), 0);

    return {
      stream: have("available"),
      inspections: rows.length,
      completed: usable.length,
      grade_index: have(latest.grade, usable.length),
      trajectory: traj,
      open_findings: have(open, usable.length),
    };
  },
});

/* ------------------------------------------------------------------ *
 * save-narrative — store the condition-assessment agent's prose after
 * enforcing the number lock.
 *
 * The agent may only restate figures it was given. Any other numeric token means
 * the reply is discarded in favour of the deterministic narrative, because a
 * plausible invented figure is worse than a plain one.
 * ------------------------------------------------------------------ */

server.addHandler({
  name: "save-narrative",
  description:
    "Validate and store the condition-assessment agent's explanation. Rejects any reply containing a number absent from the input block it was given.",
  parameters: {
    assetId: { description: "Facilio asset id", type: "number" },
    block: { description: "The exact input block the agent was given", type: "string" },
    reply: { description: "The agent's JSON reply, stringified", type: "string" },
  },
  execute: async (args) => {
    const assetId = num(args.assetId);
    if (!assetId) throw new Error("assetId is required");
    const block = String(args.block || "");
    let reply: any;
    try {
      reply = JSON.parse(String(args.reply || "{}"));
    } catch (e) {
      throw new Error("reply must be valid JSON");
    }

    // Every number in the reply must appear in the block. Compare on digit runs so
    // "1.8" and "1.8 years" both match, and strip thousands separators first.
    const norm = (s: string) => s.replace(/,(?=\d{3}\b)/g, "");
    const digits = (s: string) => (norm(s).match(/\d+(?:\.\d+)?/g) || []);
    const allowed: Record<string, boolean> = {};
    for (const d of digits(block)) allowed[d] = true;

    const prose = JSON.stringify(reply);
    const unseen: string[] = [];
    for (const d of digits(prose)) {
      if (!allowed[d] && unseen.indexOf(d) === -1) unseen.push(d);
    }

    const accepted = unseen.length === 0;
    const db = conn();
    const { rows } = db.query("select evidence_json from assessments where asset_id = $1 limit 1", [assetId]);
    if (rows.length === 0) throw new Error(`no assessment stored for asset ${assetId}`);

    let evidence: any = {};
    try {
      evidence = JSON.parse(String(rows[0].evidence_json || "{}"));
    } catch (e) {
      evidence = {};
    }

    evidence.narrative = accepted
      ? {
          ...reply,
          source: "condition_assessment_agent",
          generated_at: nowIso(),
        }
      : {
          source: "rejected_agent_reply",
          rejected_because: `reply contained figures absent from its input: ${unseen.join(", ")}`,
          generated_at: nowIso(),
        };
    evidence.narrative_number_lock = { accepted, unseen_figures: unseen };

    db.query("update assessments set evidence_json = $1 where asset_id = $2", [
      JSON.stringify(evidence),
      assetId,
    ]);

    return { ok: true, accepted, unseen_figures: unseen, asset_id: assetId };
  },
});

server.execute();
