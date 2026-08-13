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

    const woRes = await cmms("list-work-orders", {
      filters: `resource=${assetId}&type=Corrective,Breakdown`,
      select: "id,subject,description,type,status,priority,createdTime,scheduledStart",
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
    const wos: any[] = [];
    for (const wo of selected) {
      let photos: any[] = [];
      let attachmentError = "";
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
          url: pickUrl(a),
          raw: a,
        }));
      } catch (e) {
        attachmentError = String(e);
      }
      photosTotal += photos.length;
      wos.push({
        wo_id: num(wo.id),
        subject: wo.subject || "",
        description: wo.description || "",
        type: wo.type || "",
        status: wo.status || "",
        priority: wo.priority || "",
        event_date: String(wo.scheduledStart || wo.createdTime || ""),
        photos,
        attachmentError,
      });
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
      asset: {
        asset_id: assetId,
        asset_name: asset?.name || "",
        asset_type: asset?.category || asset?.type || "",
        manufacturer: asset?.manufacturer || "",
        model: asset?.model || "",
        location: asset?.space?.name || asset?.siteId?.name || "",
        purchasedDate: asset?.purchasedDate || "",
      },
      work_order_type_filter: "Corrective,Breakdown",
      total_corrective_work_orders: totalCorrective,
      work_orders_pulled: wos.length,
      capped: totalCorrective > cap,
      photos_available: photosTotal,
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

function costConfigFor(db: any, category: string) {
  const { rows } = db.query("select * from cost_config where category = $1 limit 1", [category]);
  if (rows.length > 0) return rows[0];
  const { rows: def } = db.query("select * from cost_config where category = 'DEFAULT' limit 1");
  return def[0] || { expected_life_years: 15, avg_repair_cost: 15000, replacement_cost: 500000, criticality: "medium" };
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
    const category = String(asset?.category || asset?.type || "DEFAULT");

    const woRes = await cmms("list-work-orders", {
      filters: `resource=${assetId}&type=Corrective,Breakdown`,
      select: "id,createdTime,scheduledStart",
      page_size: 200,
    });
    const wos: any[] = woRes.data || [];
    const totalCorrective = wos.length;

    const db = conn();
    const stats = computeStats(db, assetId, totalCorrective);
    const cfg = costConfigFor(db, category);

    /* ---- Condition score (1 best .. 5 worst) ---- */
    const { rows: sevRows } = db.query(
      "select severity, confidence, source from findings where asset_id = $1 and asset_id <> 0",
      [assetId]
    );
    let sevNum = 0;
    let sevDen = 0;
    for (const r of sevRows) {
      const c = Math.max(num(r.confidence), 0.1);
      sevNum += SEV_VALUE[String(r.severity)] !== undefined ? SEV_VALUE[String(r.severity)] * c : 2.5 * c;
      sevDen += c;
    }
    const hasFindings = sevRows.length > 0;
    const sevIndex = sevDen > 0 ? sevNum / sevDen : 1;

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

    // Inspection grade would carry 0.35; with none available the weight is
    // redistributed across the streams that do exist.
    const streams: Array<{ w: number; v: number }> = [];
    if (hasFindings) streams.push({ w: 0.45, v: sevIndex });
    if (totalCorrective > 0) streams.push({ w: 0.2, v: pressureIndex });
    const wSum = streams.reduce((a, s) => a + s.w, 0);
    const score = wSum > 0 ? round(streams.reduce((a, s) => a + s.w * s.v, 0) / wSum, 2) : 1;
    const grade =
      score < 1.8 ? "GOOD" : score < 2.6 ? "FAIR" : score < 3.4 ? "AVERAGE" : score < 4.2 ? "POOR" : "CRITICAL";

    /* ---- Deterioration from stored history ---- */
    const { rows: hist } = db.query(
      "select score, assessed_at from assessment_history where asset_id = $1 and asset_id <> 0 order by assessed_at asc",
      [assetId]
    );
    let deterioration = "steady";
    if (hist.length >= 2) {
      const first = num(hist[0].score);
      const last = num(hist[hist.length - 1].score);
      const delta = last - first;
      deterioration = delta > 0.4 ? "accelerating" : delta < -0.2 ? "improving" : "steady";
    } else {
      const topTrend = stats.recurring_issues[0] ? stats.recurring_issues[0].trend : "insufficient_evidence";
      if (topTrend === "increasing") deterioration = "accelerating";
    }

    /* ---- Remaining useful life ---- */
    const expectedLife = num(cfg.expected_life_years) || 15;
    const purchased = String(asset?.purchasedDate || "");
    let ageYears = 0;
    if (purchased.length >= 4) {
      const py = num(purchased.slice(0, 4));
      const pm = num(purchased.slice(5, 7)) || 1;
      const nowY = num(nowIso().slice(0, 4));
      const nowM = num(nowIso().slice(5, 7));
      ageYears = round(nowY - py + (nowM - pm) / 12, 1);
    }
    const baselineRul = Math.max(expectedLife - ageYears, 0);
    const conditionFactor = score <= 2 ? 1.05 : score <= 3 ? 0.85 : score <= 4 ? 0.55 : 0.3;
    const rulYears = round(
      clamp(baselineRul * conditionFactor * (deterioration === "accelerating" ? 0.7 : 1), 0, expectedLife),
      1
    );

    /* ---- Risk 0-100 (lifecycle risk; distinct from visual risk) ---- */
    const criticality = String(cfg.criticality || "medium");
    const critFactor = criticality === "high" ? 1 : criticality === "medium" ? 0.66 : 0.33;
    const top = stats.recurring_issues[0];
    const dominantRecurrence = top ? top.occurrence_rate : 0;
    const topTrend = top ? top.trend : "insufficient_evidence";
    const trendFactor = topTrend === "increasing" ? 1 : topTrend === "recurring" || topTrend === "stable" ? 0.4 : 0;
    const rulFactor = rulYears <= 1 ? 1 : rulYears >= 8 ? 0 : round((8 - rulYears) / 7, 2);
    const riskScore = Math.round(
      30 * (score / 5) + 20 * critFactor + 15 * dominantRecurrence + 15 * trendFactor + 20 * rulFactor
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

    const recommendation =
      capexPriority === "P1" || (score >= 4.2 && rulYears < 2)
        ? "REPLACE"
        : score >= 3.4 && riskLevel === "HIGH" && rulYears >= 2
        ? "REFURBISH"
        : riskLevel === "MEDIUM" || dominantRecurrence >= 0.3
        ? "REPAIR"
        : "MONITOR";

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

    const evidence = {
      inputs: {
        condition_score: score,
        severity_index: round(sevIndex, 2),
        corrective_pressure_index: round(pressureIndex, 2),
        streams_used: streams.length,
        inspection_stream: "absent — weight redistributed",
        age_years: ageYears,
        expected_life_years: expectedLife,
        baseline_rul_years: round(baselineRul, 1),
        condition_factor: conditionFactor,
        deterioration,
        criticality,
        dominant_issue: top ? top.issue : "none",
        dominant_recurrence: dominantRecurrence,
        dominant_trend: topTrend,
        rul_factor: rulFactor,
        corrective_wos_last_3y: recentWos,
        avg_repair_cost: avgRepair,
        spend_ratio: round(spendRatio, 2),
      },
      formulas: {
        risk: "30*(score/5) + 20*criticality + 15*recurrence + 15*trend + 20*rulFactor",
        rul: "max(expectedLife - age, 0) * conditionFactor * (accelerating ? 0.7 : 1)",
        repair_spend: "corrective WOs in last 3 years x configured avg repair cost (no cost fields exist in CMMS)",
      },
      cost_basis: "estimated from configured rates in cost_config",
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

    const histId = nextId(db, "assessment_history");
    db.query(
      "insert into assessment_history (id, asset_id, score, risk_score, rul_years, assessed_at) values ($1,$2,$3,$4,$5,$6)",
      [histId, assetId, score, riskScore, rulYears, now]
    );

    const row = {
      asset_id: assetId,
      asset_name: String(asset?.name || ""),
      category,
      score,
      grade,
      dominant_issue: top ? top.issue : "none",
      dominant_issue_label: top ? top.display_name : "None",
      dominant_recurrence_pct: round(dominantRecurrence * 100, 0),
      trend_direction: topTrend,
      deterioration,
      rul_years: rulYears,
      risk_score: riskScore,
      risk_level: riskLevel,
      visual_risk_level: visualLevel,
      visual_risk_score: visualScore,
      repair_spend: repairSpend,
      replacement_cost: replacementCost,
      capex_priority: capexPriority,
      recommendation,
      corrective_wo_count: totalCorrective,
      evidence,
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
    }));

    const kpis = {
      assets_assessed: register.length,
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
            rul_years: num(a.rul_years),
            risk_score: num(a.risk_score),
            risk_level: String(a.risk_level || ""),
            visual_risk_level: String(a.visual_risk_level || "unknown"),
            visual_risk_score: num(a.visual_risk_score),
            repair_spend: num(a.repair_spend),
            replacement_cost: num(a.replacement_cost),
            capex_priority: String(a.capex_priority || "-"),
            recommendation: String(a.recommendation || ""),
            corrective_wo_count: num(a.corrective_wo_count),
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
 * cost_config — the "approved cost database". Nothing is invented; if a
 * category has no configured rate the DEFAULT row is used and labelled.
 * ------------------------------------------------------------------ */

server.addHandler({
  name: "cost-config",
  description: "Read the configured expected life, repair/replacement costs and criticality per asset category.",
  parameters: {},
  execute: async () => {
    const db = conn();
    const { rows } = db.query("select * from cost_config order by category");
    return {
      config: rows.map((r: any) => ({
        category: String(r.category),
        expected_life_years: num(r.expected_life_years),
        avg_repair_cost: num(r.avg_repair_cost),
        replacement_cost: num(r.replacement_cost),
        criticality: String(r.criticality || "medium"),
      })),
    };
  },
});

server.addHandler({
  name: "set-cost-config",
  description: "Update one asset category's expected life, repair/replacement cost and criticality.",
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
    let criticality = String(args.criticality || "medium");
    if (["low", "medium", "high"].indexOf(criticality) === -1) criticality = "medium";
    const life = clamp(num(args.expectedLifeYears), 1, 100);
    const repair = Math.max(num(args.avgRepairCost), 0);
    const replacement = Math.max(num(args.replacementCost), 0);

    const db = conn();
    const { rows } = db.query("select 1 as hit from cost_config where category = $1 limit 1", [category]);
    if (rows.length > 0) {
      db.query(
        "update cost_config set expected_life_years = $1, avg_repair_cost = $2, replacement_cost = $3, criticality = $4 where category = $5",
        [life, repair, replacement, criticality, category]
      );
    } else {
      db.query(
        "insert into cost_config (category, expected_life_years, avg_repair_cost, replacement_cost, criticality) values ($1,$2,$3,$4,$5)",
        [category, life, repair, replacement, criticality]
      );
    }
    return { ok: true, category, expected_life_years: life, avg_repair_cost: repair, replacement_cost: replacement, criticality };
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
    return { ok: true, deleted: out };
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

server.execute();
