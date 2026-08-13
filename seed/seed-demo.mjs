/**
 * Seeds demo corrective-maintenance history into the Facilio org so the
 * Condition Assessment Agent has real evidence to analyse.
 *
 * The corrosion story is shaped deliberately to exercise the agent spec's
 * CRITICAL COUNTING RULE and STEP 10 trend rule at the same time:
 *
 *   WO-1 (2024) carries THREE photos of the same corrosion  -> 1 occurrence
 *   2025 carries two more corrosion work orders             -> 2 occurrences
 *   2026 carries three more                                 -> 3 occurrences
 *
 * so corrosion must come out as 6 occurrences from 8 photos across 6 work
 * orders (never 8), with an increasing year-on-year trend.
 *
 * Run:  node seed/seed-demo.mjs [--dry-run]
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DRY = process.argv.includes("--dry-run");
const PHOTOS = path.join(import.meta.dirname, "photos");

const ASSET_ID = 2282275; // VBA-CH-001, Carrier 30XA-1002, purchased 2011-03-10
const SITE_ID = 2282114; // VBA-Bay Tower

/** Each work order: date, subject, description, priority, and its before photos. */
const WORK_ORDERS = [
  {
    date: "2024-03-12T09:00:00Z",
    subject: "Compressor housing corrosion repair",
    description:
      "Site team reported visible rust and surface scaling across the lower compressor housing. Area cleaned, treated and re-coated.",
    priority: "High",
    photos: ["small_corrosion_a1.jpg", "small_corrosion_a2.jpg", "small_corrosion_a3.jpg"],
  },
  {
    date: "2025-01-20T09:00:00Z",
    subject: "Rust treatment on condenser shell",
    description: "Corrosion observed on the condenser shell surface during a reactive call-out. Rust removed and primed.",
    priority: "Medium",
    photos: ["small_corrosion_a1.jpg"],
  },
  {
    date: "2025-08-14T09:00:00Z",
    subject: "Corrosion scaling removal - compressor housing",
    description: "Recurring rust scaling on the compressor housing. Scale removed mechanically and surface treated.",
    priority: "High",
    photos: ["small_corrosion_a2.jpg"],
  },
  {
    date: "2026-01-15T09:00:00Z",
    subject: "Surface rust on compressor housing",
    description: "Surface rust reappeared on the compressor housing within six months of the previous treatment.",
    priority: "High",
    photos: ["small_corrosion_a3.jpg"],
  },
  {
    date: "2026-04-09T09:00:00Z",
    subject: "Rust pitting on chilled water pipe",
    description: "Pitting corrosion found on the chilled water pipe run adjacent to the compressor.",
    priority: "High",
    photos: ["small_corrosion_a1.jpg"],
  },
  {
    date: "2026-07-22T09:00:00Z",
    subject: "Corrosion repair - compressor mounting",
    description: "Corrosion at the compressor mounting bracket. Bracket cleaned and protective coating reapplied.",
    priority: "High",
    photos: ["small_corrosion_a2.jpg"],
  },
  {
    date: "2025-05-06T09:00:00Z",
    subject: "Chilled water pipe insulation damage",
    description: "Damaged and missing foam insulation on the chilled water piping, with condensation and ice build-up.",
    priority: "Medium",
    photos: ["small_insulation_a1.jpg"],
  },
  {
    date: "2026-06-11T09:00:00Z",
    subject: "Cracked equipment plinth",
    description: "Structural crack running through the concrete plinth supporting the chiller.",
    priority: "Medium",
    photos: ["small_crack_a1.jpg"],
  },
];

/** Run the Facilio CLI, passing action params over stdin so big base64 payloads are safe. */
function cli(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "facilio",
      args,
      { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${stderr}\n${stdout}`));
        resolve(stdout);
      }
    );
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

async function action(slug, params) {
  const out = await cli(["connections", "execute", slug, "--params", "-", "--json"], JSON.stringify(params));
  const start = out.indexOf("{");
  const parsed = JSON.parse(out.slice(start));
  const r = parsed.results?.[0];
  if (!r?.ok) throw new Error(`${slug} failed: ${JSON.stringify(r?.error || r).slice(0, 400)}`);
  if (r.result?.success === false) {
    throw new Error(`${slug} error: ${JSON.stringify(r.result.error).slice(0, 400)}`);
  }
  return r.result;
}

// Existing subjects on this asset, so re-running the seeder doesn't duplicate history.
const existing = await action("facilio-cmms.list-work-orders", {
  filters: `resource=${ASSET_ID}&type=Corrective,Breakdown`,
  select: "id,subject,scheduledStart",
  page_size: 200,
});
const existingSubjects = new Set((existing.data || []).map((w) => String(w.subject || "").trim()));
console.log(`Asset ${ASSET_ID} already has ${existingSubjects.size} corrective work orders.\n`);

let created = 0;
let attached = 0;
let skipped = 0;

for (const wo of WORK_ORDERS) {
  if (existingSubjects.has(wo.subject)) {
    console.log(`SKIP  "${wo.subject}" — already present`);
    skipped++;
    continue;
  }

  if (DRY) {
    console.log(`DRY   would create "${wo.subject}" (${wo.date.slice(0, 10)}) with ${wo.photos.length} before photo(s)`);
    continue;
  }

  const res = await action("facilio-cmms.create-work-order", {
    workorder: {
      subject: wo.subject,
      description: wo.description,
      type: "Corrective",
      priority: wo.priority,
      status: "Closed",
      // The action's schema advertises integer-or-object, but the API validator
      // only accepts the object form.
      siteId: { id: SITE_ID },
      resource: { id: ASSET_ID },
      scheduledStart: wo.date,
      dueDate: wo.date,
    },
  });

  const woId = res?.data?.id || res?.id || res?.data?.workorder?.id;
  if (!woId) throw new Error(`could not read new work order id from ${JSON.stringify(res).slice(0, 300)}`);
  created++;
  console.log(`OK    WO ${woId}  ${wo.date.slice(0, 10)}  "${wo.subject}"`);

  for (const file of wo.photos) {
    const buf = await readFile(path.join(PHOTOS, file));
    await action("facilio-cmms.add-work-order-before-photo", {
      work_order_id: woId,
      photo: {
        __file__: true,
        filename: file.replace(/^small_/, ""),
        content_type: "image/jpeg",
        file_base64: buf.toString("base64"),
        size: buf.length,
      },
    });
    attached++;
    console.log(`        + before photo ${file} (${(buf.length / 1024).toFixed(0)}KB)`);
  }
}

console.log(`\nCreated ${created} work orders, attached ${attached} before photos, skipped ${skipped}.`);
