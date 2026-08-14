/**
 * Runs the asset-baseline agent for every asset category and stores the result.
 *
 * Normally the browser does this (the function sandbox has AGENTS_TOKEN but no
 * AGENTS_URL, so server code cannot reach the agents service). This script does the
 * same two calls from the CLI so the app ships with baselines already populated.
 */
import { execFile } from "node:child_process";

const run = (args, stdin) =>
  new Promise((res, rej) => {
    const c = execFile("facilio", args, { maxBuffer: 32 * 1024 * 1024 }, (e, so, se) =>
      e ? rej(new Error(se || so || e.message)) : res(so)
    );
    if (stdin !== undefined) {
      c.stdin.write(stdin);
      c.stdin.end();
    }
  });

const parse = (out) => JSON.parse(out.slice(out.indexOf("{")));

async function handler(name, args) {
  return parse(await run(["vibe", "function", "run", "condition-engine", name, "--args", JSON.stringify(args)]));
}

async function agent(name, input) {
  const out = await run(["vibe", "agent", "run", name, "--input", input]);
  const d = parse(out);
  if (d.status !== "completed") throw new Error(`${name}: ${d.status} ${d.error_message || ""}`);
  return d.response.content;
}

const CATEGORIES = [
  "Chiller",
  "AHU",
  "HVAC",
  "Cooling Tower",
  "Primary Pump",
  "Secondary Pump",
  "Condenser Pump",
  "FCU",
];

const force = process.argv.includes("--force");

for (const category of CATEGORIES) {
  try {
    const prep = await handler("baseline-input", { category, force: force ? 1 : 0 });
    if (prep.cached) {
      console.log(`CACHED  ${category.padEnd(16)} estimated ${String(prep.estimated_at).slice(0, 10)}`);
      continue;
    }
    const reply = await agent("asset-baseline", prep.input);
    const saved = await handler("save-baselines", { category, reply });
    const c = saved.confidence;
    console.log(
      `OK      ${category.padEnd(16)} life ${String(saved.expected_life_years).padEnd(4)} ` +
        `crit ${saved.criticality.padEnd(7)} repair ${String(saved.avg_repair_cost).padEnd(9)} ` +
        `replace ${String(saved.replacement_cost).padEnd(11)} ` +
        `conf life ${c.life} crit ${c.criticality} repair ${c.repair} replace ${c.replacement}` +
        (saved.low_confidence ? "  [cost low-confidence]" : "")
    );
  } catch (e) {
    console.log(`FAIL    ${category.padEnd(16)} ${String(e.message).slice(0, 140)}`);
  }
}
