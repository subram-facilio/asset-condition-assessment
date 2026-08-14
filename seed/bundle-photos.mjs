/**
 * Downloads every BEFORE photo for the given assets into public/evidence/,
 * named by attachment id, so the browser has a same-origin copy to analyse.
 *
 * This exists because of one asymmetry: Facilio's pre-signed attachment URLs are
 * fetchable by any ordinary HTTP client but NOT by a browser, since the storage
 * host sends no Access-Control-Allow-Origin header. curl gets the bytes; a
 * browser gets 200 OK with the body withheld. So the bytes are pulled here, at
 * build time, and served from the app's own origin at runtime.
 *
 * Keyed on attachment id, never filename: the same filename legitimately appears
 * on several work orders (corrosion_a1.jpg is attached to three), so a
 * filename-keyed cache would collide and analyse the wrong image.
 *
 * Run:  node seed/bundle-photos.mjs <assetId> [assetId...]
 */
import { execFile } from "node:child_process";
import { writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";

const OUT = path.join(import.meta.dirname, "..", "public", "evidence");
const assetIds = process.argv.slice(2).map(Number).filter(Boolean);

if (assetIds.length === 0) {
  console.error("usage: node seed/bundle-photos.mjs <assetId> [assetId...]");
  process.exit(1);
}

function cli(args, stdin) {
  return new Promise((resolve, reject) => {
    const child = execFile("facilio", args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message}\n${stderr}`));
      resolve(stdout);
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

async function action(slug, params) {
  const out = await cli(["connections", "execute", slug, "--params", "-", "--json"], JSON.stringify(params));
  const r = JSON.parse(out.slice(out.indexOf("{"))).results[0];
  if (!r?.ok) throw new Error(`${slug}: ${JSON.stringify(r?.error).slice(0, 300)}`);
  if (r.result?.success === false) throw new Error(`${slug}: ${JSON.stringify(r.result.error).slice(0, 300)}`);
  return r.result;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

await mkdir(OUT, { recursive: true });

const manifest = [];
let written = 0;
let skipped = 0;

for (const assetId of assetIds) {
  const wos = (
    await action("facilio-cmms.list-work-orders", {
      filters: `resource=${assetId}&type=Corrective,Breakdown`,
      select: "id,subject,noOfAttachments",
      page_size: 200,
    })
  ).data || [];
  console.log(`asset ${assetId}: ${wos.length} corrective work orders`);

  for (const wo of wos) {
    // noOfAttachments is populated in this org, so work orders with no files
    // are skipped without paying for an attachments call.
    if (Number(wo.noOfAttachments || 0) === 0) continue;

    let atts = [];
    try {
      atts = (await action("facilio-cmms.list-workorder-attachments", {
        work_order_id: Number(wo.id),
        attachment_type: "before",
      })).data || [];
    } catch (e) {
      console.log(`  WO ${wo.id}: attachments failed — ${e.message.slice(0, 80)}`);
      continue;
    }

    for (const a of atts) {
      const id = Number(a.id);
      const dest = path.join(OUT, `${id}.jpg`);
      if (await exists(dest)) {
        skipped++;
        manifest.push({ attachment_id: id, wo_id: Number(wo.id), filename: a.fileName, bundled: `${id}.jpg` });
        continue;
      }

      let url = "";
      try {
        url = String(
          (await action("facilio-cmms.download-work-order-attachment", {
            work_order_id: Number(wo.id),
            attachment_id: id,
          })).file_signed_url || ""
        );
      } catch (e) {
        console.log(`  attachment ${id}: no signed url — ${e.message.slice(0, 80)}`);
        continue;
      }
      if (!url) continue;

      const res = await fetch(url);
      if (!res.ok) {
        console.log(`  attachment ${id}: download ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // Refuse anything that is not actually an image — a stale signed URL
      // returns an XML error document, which would otherwise be handed to the
      // vision model as if it were a photograph.
      const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      if (!isJpeg && !isPng) {
        console.log(`  attachment ${id}: not an image (${buf.length}b) — skipped`);
        continue;
      }

      await writeFile(dest, buf);
      written++;
      manifest.push({ attachment_id: id, wo_id: Number(wo.id), filename: a.fileName, bundled: `${id}.jpg` });
      console.log(`  OK  ${id}.jpg  ${(buf.length / 1024).toFixed(0)}KB  (${a.fileName}, WO ${wo.id})`);
    }
  }
}

await writeFile(path.join(OUT, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
console.log(`\n${written} written, ${skipped} already present, ${manifest.length} in manifest.`);
