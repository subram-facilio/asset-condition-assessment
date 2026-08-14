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
        WO-text normalization                 severity judgment
        inspection answer fetch               recurrence status
        count(distinct wo_id)                 trend classification
        occurrence rates                                │
        component concentration                         │
        condition · deterioration             condition-core (gpt-4o)
        RUL · risk · CAPEX                    ─────────────────────────
        recommendation                        the explanation
                     │                        cross-stream judgment
                     │                        inspection normalization
                     │                        class reference constants
                     │                                │
                     └────────────┬───────────────────┘
                                  ▼
                        save-analysis · save-core
                        engine numbers overwrite agent numbers;
                        the number lock discards any prose figure
                        absent from the calculated results, and the
                        quote lock discards any inspection claim not
                        found verbatim in the inspector's own answer
                                  ▼
                        CONDITION REGISTER  (app Postgres)
                        findings · risk_analyses · assessments
                        assessment_history · cost_config
                                  ▼
                             Dashboard
```

Age, cost and criticality are deliberately **excluded** from the visual analysis and applied only in the downstream lifecycle engines, which is why the UI shows them in a separate section.

## What is AI and what is not

There are exactly **two** agents. `photo-validation` reads photographs;
`condition-core` does everything else an LLM does here, in one call per assessment.

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
  condition-engine.ts    all 23 server handlers
agent-schemas/
  photo-validation-instructions.txt   the photo agent specification
  photo-validation.json               structured-output schema
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
for t in findings risk_analyses assessments assessment_history cost_config; do
  facilio vibe db import --file ./seed/$t.csv --table $t
done
facilio vibe function run condition-engine cleanup-seed
```

The agent is created with the specification as its instructions:

```bash
facilio vibe agent create photo-validation \
  --model-provider openai --model-name gpt-4o \
  --instructions "$(cat ./agent-schemas/photo-validation-instructions.txt)" \
  --output-schema-file ./agent-schemas/photo-validation.json
```

## Known platform limitations

These are real constraints found while building, not design choices. Each is surfaced in the UI rather than papered over.

**Facilio photos cannot be read by the browser.** Attachment records carry no URL. `download-work-order-attachment` returns a working pre-signed S3 URL, but that bucket sends no `Access-Control-Allow-Origin`, so a browser `fetch` is blocked and an `<img>`-to-canvas read taints the canvas. The function sandbox is no help either — it decodes bodies as UTF-8, which corrupted a 196,764-byte JPEG into 186,304 characters with 78,878 replacement characters. Since `uploadFile` and `executeAgent` are browser-only, the bytes have nowhere to come from. The app therefore tries the live signed URL first and falls back to a bundled copy of the same file, and it states which source it used. A CORS policy on that bucket is the entire fix.

**No cost or criticality fields exist in this org.** Work orders expose no cost field and assets no criticality field, so both are read from the editable `cost_config` table and every figure is labelled as estimated rather than invented.

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

**Structured-output schemas must not describe object or array nodes.** Repeated sub-schemas are deduplicated into `$ref`s, and the provider rejects a `$ref` carrying sibling keywords: `$ref cannot have keywords {'description'}`. Descriptions live only on scalar leaves; the semantics live in the instructions.

## Auditability

Every assessment stores the inputs and formulas that produced it, so any number can be traced back:

```
risk = 30×(condition/5) + 20×criticality + 15×recurrence + 15×trend + 20×remaining-life factor
RUL  = max(expected_life − age, 0) × condition factor × (accelerating ? 0.7 : 1)
```

`risk_analyses.engine_overrides_json` records every count the engine corrected, and `data_quality.limitations` states what the evidence could not support — for example that only one calendar year of history exists, so no trend was claimed.
