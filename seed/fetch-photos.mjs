/**
 * Downloads a small set of CC0 / public-domain defect photos from Wikimedia
 * Commons to use as BEFORE-photo evidence in the demo org.
 *
 * Every image is licence-checked before it is written: anything that is not
 * CC0 or public domain is skipped rather than silently used.
 */
import { writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Commons rate-limits hard; pace every call and back off on 429. */
async function get(url, headers, attempt = 1) {
  const res = await fetch(url, { headers });
  if (res.status === 429 && attempt <= 4) {
    const wait = 2000 * attempt;
    console.log(`     429 — backing off ${wait}ms`);
    await sleep(wait);
    return get(url, headers, attempt + 1);
  }
  return res;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

const OUT = path.join(import.meta.dirname, "photos");
const UA = "facilio-vibe-condition-assessment-demo/1.0 (educational demo)";
const OK_LICENCES = ["cc0", "public domain", "pd"];

/** Each entry: the search phrase, and the filename we want locally. */
const WANTED = [
  { q: 'filetype:bitmap "Rust Pits in surface of Steel Water Pipe"', file: "corrosion_a1.jpg", want: "GN04590A" },
  { q: 'filetype:bitmap "Rust Pits in surface of Steel Water Pipe"', file: "corrosion_a2.jpg", want: "GN04591A" },
  { q: 'filetype:bitmap "Rust Pits in surface of Steel Water Pipe"', file: "corrosion_a3.jpg", want: "GN04592" },
  { q: "filetype:bitmap rusty corroded steel surface", file: "corrosion_b1.jpg" },
  { q: "filetype:bitmap corroded rusty tank metal", file: "corrosion_b2.jpg" },
  { q: "filetype:bitmap DAMAGED FOAM INSULATION LIQUID NITROGEN PIPING", file: "insulation_a1.jpg" },
  { q: "filetype:bitmap insulation removed pipe thermal", file: "insulation_a2.jpg" },
  { q: "filetype:bitmap oil spill stain concrete floor", file: "oil_leak_a1.jpg" },
  { q: "filetype:bitmap dirty dusty ventilation grille", file: "fouling_a1.jpg" },
  { q: "filetype:bitmap Cracked concrete retaining wall Medway", file: "crack_a1.jpg" },
  { q: "filetype:bitmap corroded water pipe joint", file: "leak_a1.jpg" },
];

async function search(query) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  const params = {
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: query,
    gsrnamespace: "6",
    gsrlimit: "8",
    prop: "imageinfo",
    iiprop: "url|size|extmetadata",
    iiurlwidth: "1000",
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await get(url, { "User-Agent": UA });
  if (!res.ok) throw new Error(`search failed ${res.status}`);
  const json = await res.json();
  return Object.values(json?.query?.pages || {});
}

function licenceOf(page) {
  const ii = (page.imageinfo || [])[0] || {};
  const meta = ii.extmetadata || {};
  return String(meta.LicenseShortName?.value || "").toLowerCase();
}

function isFree(lic) {
  return OK_LICENCES.some((l) => lic.includes(l));
}

await mkdir(OUT, { recursive: true });
const used = new Set();
const manifest = [];

for (const item of WANTED) {
  const dest = path.join(OUT, item.file);
  if (await exists(dest)) {
    console.log(`HAVE ${item.file}`);
    continue;
  }
  await sleep(1500);
  let pages;
  try {
    pages = await search(item.q);
  } catch (e) {
    console.log(`SKIP ${item.file}: search error ${e.message}`);
    continue;
  }

  const candidates = pages
    .filter((p) => isFree(licenceOf(p)))
    .filter((p) => !used.has(p.title))
    .filter((p) => (item.want ? p.title.includes(item.want) : true));

  const chosen = candidates[0];
  if (!chosen) {
    console.log(`SKIP ${item.file}: no free-licence match for "${item.q}"`);
    continue;
  }

  const ii = chosen.imageinfo[0];
  const src = ii.thumburl || ii.url;
  await sleep(1000);
  const res = await get(src, { "User-Agent": UA });
  if (!res.ok) {
    console.log(`SKIP ${item.file}: download ${res.status}`);
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // A Commons error page is HTML, not an image — refuse anything that is not JPEG/PNG.
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  if (!isJpeg && !isPng) {
    console.log(`SKIP ${item.file}: not an image (${buf.length} bytes)`);
    continue;
  }

  await writeFile(path.join(OUT, item.file), buf);
  used.add(chosen.title);
  manifest.push({
    file: item.file,
    title: chosen.title,
    licence: licenceOf(chosen),
    bytes: buf.length,
    source: src,
  });
  console.log(`OK   ${item.file}  ${(buf.length / 1024).toFixed(0)}KB  ${licenceOf(chosen)}  ${chosen.title}`);
}

await writeFile(path.join(OUT, "MANIFEST.json"), JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.length} images written to ${OUT}`);
