# Asset Condition Assessment Agent

A Facilio Vibe app that assesses the physical condition of an asset from its **corrective maintenance history** — the work orders it has needed and the before-maintenance photos attached to them — and produces one consolidated, auditable condition assessment per asset.

There are no questionnaires and no manual condition entry. Every input is read live from Facilio CMMS.

## The core design decision

> The agent owns judgment. The engine owns every number.

An LLM interprets photographs and writes the explanation. It is never trusted with arithmetic. Recurrence counts, rates, trends, remaining life, risk and CAPEX are all computed in plain TypeScript against SQL, and the engine **overwrites** the agent's numeric fields before anything is stored — logging the difference rather than hiding it.

This is not theoretical caution. In testing, GPT-4o was given one work order containing three photos of the same leak and told explicitly that multiple photos in one work order count as one occurrence. It returned `occurrence_count: 3` while its own `work_order_references` array listed only two work orders — internally inconsistent. The engine corrected it to 2 and recorded the correction.

### The counting rule

The recurrence unit is the **corrective work order**, never the photo:

```
WO-001  photo 1 → corrosion
        photo 2 → corrosion   →  corrosion = 1 occurrence   (not 3)
        photo 3 → corrosion

WO-014  photo 1 → corrosion   →  corrosion = 2 occurrences
```

It is enforced three independent ways, so no single failure can break it:

1. **Prompt** — stated in the agent's instructions.
2. **Structure** — photos are batched one agent run per work order, so same-issue photos in one work order physically cannot become separate occurrences.
3. **Arithmetic** — `count(distinct wo_id)` overwrites whatever the agent returned.

## Architecture

```
                    FACILIO CMMS  (read-only, always live)
                    assets · corrective WOs · BEFORE photos · inspections
                                      │
                     ┌────────────────┴────────────────┐
                     ▼                                 ▼
        condition-engine (WASM function)      photo-validation (gpt-5.1)
        ───────────────────────────────       ─────────────────────────
        scope filter: corrective only         visual defect analysis
        BEFORE-photo filter                   issue normalization
        inspection answer fetch               severity judgment
        count(distinct wo_id)                 recurrence status
        occurrence rates                      trend classification
        component concentration               asset-level consolidation
        condition · deterioration                       │
        RUL · risk · CAPEX                    wo-evidence (gpt-5.1)
        recommendation                        ─────────────────────────
                     │                        issue · component from
                     │                        each WO's own wording
                     │                        severity · confidence
                     │                                │
                     │                        condition-core (gpt-5.1)
                     │                        ─────────────────────────
                     │                        the explanation
                     │                        cross-stream judgment
                     │                        inspection normalization
                     │                        class reference constants
                     │                                │
                     └────────────┬───────────────────┘
                                  ▼
                   save-wo-evidence · save-analysis · save-core
                        engine numbers overwrite agent numbers;
                        the number lock discards any prose figure
                        absent from the calculated results, and the
                        quote lock discards any claim not found
                        verbatim in its own source text
                                  ▼
                        CONDITION REGISTER  (app Postgres)
                        findings · risk_analyses · assessments
                        assessment_history · wo_meta · baselines
                                  ▼
                             Dashboard
```

Age, cost and criticality are deliberately **excluded** from the visual analysis and applied only in the downstream lifecycle engines, which is why the UI shows them in a separate section.

## What is AI and what is not

There are exactly **three** agents, one per kind of evidence. `photo-validation` reads
photographs and consolidates the asset-level analysis; `wo-evidence` reads what was
written on each corrective work order; `condition-core` does everything else an LLM does
here, in one call per assessment.

| Done by the agents | Done by deterministic code |
| --- | --- |
| Reading photographs | Fetching Facilio data |
| Identifying visible defects | Filtering to corrective work orders |
| Normalizing issue names | Selecting BEFORE photos only |
| Judging severity | Counting occurrences and rates |
| Classifying recurrence and trend | Component concentration |
| Reading inspector prose into observations | Deciding which inspections count (closed only) |
| Judging where evidence streams agree or conflict | Weighting and renormalizing the streams |
| Supplying equipment-class reference constants | Condition, deterioration, RUL, risk, CAPEX, recommendation |
| Writing the explanation | Enforcing the number lock and the quote lock |

Issue normalization is enforced by the output schema's enum rather than by prompt obedience: `rust`, `surface rust` and `rust scaling` can only ever be emitted as `corrosion`.

## Layout

```
src/
  lib/pipeline.ts        orchestrator — stages, photo batching, agent calls
  lib/vibe.ts            SDK wrappers
  lib/types.ts           shapes shared by engine and UI
  pages/Dashboard.tsx    portfolio health, recommendations, CAPEX queue
  pages/RunAssessment.tsx  asset picker + live pipeline progress
  pages/AssetDetail.tsx  consolidated analysis, issues, components, evidence
  pages/Register.tsx     the condition register
  pages/Settings.tsx     cost and lifecycle configuration
functions/
  condition-engine.ts    all 25 server handlers
agent-schemas/
  photo-validation-instructions.txt   the photo agent specification
  photo-validation.json               structured-output schema
  wo-evidence-instructions.txt        the work-order reader specification
  wo-evidence.json                    structured-output schema
  condition-core-instructions.txt     the core analyst specification
  condition-core.json                 structured-output schema
seed/
  fetch-photos.mjs       licence-checked CC0/public-domain defect images
  seed-demo.mjs          demo corrective history + BEFORE photos
  *.csv                  table definitions (see note below)
```

## Setup

```bash
npm install
facilio login
facilio vibe function create condition-engine --code ./functions/condition-engine.ts
facilio vibe function build condition-engine
npm run build && facilio vibe deploy
```

Tables are created by CSV import because the app database role cannot run DDL:

```bash
for t in findings risk_analyses assessments assessment_history baselines wo_meta; do
  facilio vibe db import --file ./seed/$t.csv --table $t
done
facilio vibe function run condition-engine cleanup-seed
```

**This step is required on every org — it is not sample data.** Each `seed/*.csv` is two lines: a
header that defines the columns and one sentinel row whose only job is to pin the column types,
because a CSV import is the only way to bring a table into existence without DDL. `cleanup-seed`
then deletes those sentinels. Every read query is written `where asset_id <> 0` (and the
equivalent for `wo_meta` and `baselines`), so a forgotten `cleanup-seed` never surfaces a phantom
asset — but a skipped import means the queries throw, and the home page shows an error banner
instead of its "Nothing assessed yet" empty state.

The demo fixtures are the *other* files in that directory — `seed-demo.mjs`, `seed-photos-*.mjs`,
`make_poor_photos.py` and `photos/`. Those push invented work orders and photographs into Facilio
CMMS for the hackathon org, and are deliberately absent from this setup block. Never run them
against a customer org.

`cost_config` is not in the list: `baselines` replaced it, and the table survives only because the
app DB role cannot drop one.

Each agent is created with its specification as its instructions:

```bash
facilio vibe agent create photo-validation \
  --model-provider openai --model-name gpt-5.1 \
  --model-params '{"verbosity":"low"}' \
  --instructions "$(cat ./agent-schemas/photo-validation-instructions.txt)" \
  --output-schema-file ./agent-schemas/photo-validation.json

facilio vibe agent create condition-core \
  --model-provider openai --model-name gpt-5.1 \
  --model-params '{"verbosity":"low"}' \
  --instructions "$(cat ./agent-schemas/condition-core-instructions.txt)" \
  --output-schema-file ./agent-schemas/condition-core.json

facilio vibe agent create wo-evidence \
  --model-provider openai --model-name gpt-5.1 \
  --instructions "$(cat ./agent-schemas/wo-evidence-instructions.txt)" \
  --output-schema-file ./agent-schemas/wo-evidence.json
```

All three run gpt-5.1. The model matters more here than it usually does, because every
agent is held to constraints a weaker model fails rather than bends: the number lock
discards an entire reply for one unseen figure, and the quote lock discards any claim not
found verbatim in its source — an inspector's answer for `condition-core`, the work
order's own subject and description for `wo-evidence`. A model that paraphrases
"1.8 years" as "roughly two years", or "Rust breakthrough on compressor housing base" as
"rust broke through the housing", loses that answer.

`wo-evidence` reads work-order wording and reports the issue, component, severity and
confidence behind each corrective finding. It replaced a keyword-matching table that
wrote severity `unknown` and confidence `0.55` into every row it produced — placeholders
the regex was never asked to compute, which nonetheless reached the condition score
through the 0.45 severity stream and collapsed it to a constant 2.5 on any asset without
readable photos. Ungraded findings are now excluded from that stream rather than scored
at its midpoint.

`--model-params` is passed to the provider verbatim, so `verbosity` arrives as the Responses API's
`text.verbosity`. `photo-validation` and `condition-core` both write prose that a manager reads next
to the numbers, and at the provider default they write paragraphs where a sentence carries the
finding. `reasoning_effort` is deliberately left unset: reasoning is what buys the precision the two
locks demand, while `verbosity` shortens the prose without spending it. Per-field word budgets live
in each agent's instructions and are repeated on the matching schema leaf so the two cannot drift.

`wo-evidence` is left at the provider default, because it emits no prose to shorten — every field it
returns is an enum, a number, or a verbatim quote that must not be trimmed.

## Known platform limitations

These are real constraints found while building, not design choices. Each is surfaced in the UI rather than papered over.

**Facilio photos cannot be read by the browser.** Attachment records carry no URL. `download-work-order-attachment` returns a working pre-signed S3 URL, but that bucket sends no `Access-Control-Allow-Origin`, so a browser `fetch` is blocked and an `<img>`-to-canvas read taints the canvas. The function sandbox is no help either — it decodes bodies as UTF-8, which corrupted a 196,764-byte JPEG into 186,304 characters with 78,878 replacement characters. Since `uploadFile` and `executeAgent` are browser-only, the bytes have nowhere to come from. The app therefore tries the live signed URL first and falls back to a bundled copy of the same file, and it states which source it used. A CORS policy on that bucket is the entire fix.

**No cost or criticality fields exist in this org.** Work orders expose no cost field and assets no criticality field. Both now come from the `baselines` table as equipment-*class* reference constants, supplied by `condition-core` and overridable per category in Settings, and every figure derived from them is labelled as estimated rather than invented. The `cost_config` table these used to be read from is retired.

**Inspections are read from the inspector's words, not from a score.** The condition score weights an
inspection stream at 0.35, resolved in two tiers. Tier 1 is a scored template's `scorePercent` — the
better signal, but latent here: every template in this org is a Checklist whose questions carry no
point values, so no score field is ever returned. Tier 2 is the written answers, which `condition-core`
normalizes into observations and the engine grades. Only **closed** inspections (`responseStatus`
`Completed`) are read — a partly answered walkthrough is a half-formed opinion. Every observation must
quote its source verbatim or it is discarded, so a claim about what an inspector said can always be
traced to the sentence they wrote. With no closed inspection the 0.35 is redistributed across the
streams that do exist, and the redistribution is reported in the assessment's derivation record.

Observations reach the condition score on the **next** assessment: the core agent runs after the
numbers are final, so evidence it contributes cannot move the score it was asked to explain.

**Structured-output schemas must not describe a `$ref` node.** Repeated sub-schemas are deduplicated into `$ref`s, and the provider rejects a `$ref` carrying sibling keywords: `$ref cannot have keywords {'description'}`. Neither schema here uses `$defs` today, so descriptions sit on scalar leaves and on the array nodes that carry a length budget; the semantics live in the instructions. If a sub-schema is ever repeated verbatim and gets deduplicated, its description is what breaks first.

**A schema's length and count constraints never reach the provider.** `output_schema` is not forwarded as written: flow-ai converts it to a Pydantic model first (`app/core/agno/output_schema.py`), and that conversion reads only `type`, `enum`, `required`, `default` and `description`. `maxLength`, `minLength`, `maxItems`, `minItems` and `pattern` are all dropped in the round-trip — silently, so the schema looks enforced in the repo and is not enforced at runtime. `description` is the only per-field keyword that survives, which is why every length budget in these two schemas is written as prose inside it and repeated in the instructions.

## Auditability

Every assessment stores the inputs and formulas that produced it, so any number can be traced back:

```
risk = 30×(condition/5) + 20×criticality + 15×recurrence + 15×trend + 20×remaining-life factor
RUL  = max(expected_life − age, 0) × condition factor × (accelerating ? 0.7 : 1)
```

`risk_analyses.engine_overrides_json` records every count the engine corrected, and `data_quality.limitations` states what the evidence could not support — for example that only one calendar year of history exists, so no trend was claimed.
