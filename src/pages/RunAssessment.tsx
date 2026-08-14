import { useEffect, useMemo, useState } from "react";
import { fn } from "../lib/vibe";
import { INITIAL_STAGES, runPipeline, type PipelineResult, type Stage } from "../lib/pipeline";
import type { AssetRow } from "../lib/types";
import { Empty, Pill, gradeTone, recommendationTone, riskTone } from "../lib/ui";

export function RunAssessment({ presetAssetId }: { presetAssetId?: number }) {
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [selected, setSelected] = useState<number | null>(presetAssetId ?? null);
  const [query, setQuery] = useState("");
  const [stages, setStages] = useState<Stage[]>(INITIAL_STAGES);
  const [note, setNote] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fn<{ assets: AssetRow[] }>("assets", { pageSize: 200 })
      .then((r) => setAssets(r.assets))
      .catch((e) => setError(String(e?.message || e)));
  }, []);

  const filtered = useMemo(() => {
    if (!assets) return [];
    const q = query.trim().toLowerCase();
    const list = q
      ? assets.filter((a) => `${a.name} ${a.category} ${a.manufacturer} ${a.model}`.toLowerCase().includes(q))
      : assets;
    return list.slice(0, 60);
  }, [assets, query]);

  const chosen = assets?.find((a) => a.asset_id === selected) || null;

  async function start() {
    if (!selected) return;
    setRunning(true);
    setError("");
    setResult(null);
    setNote("");
    setStages(INITIAL_STAGES.map((s) => ({ ...s })));
    try {
      const res = await runPipeline(selected, (next, n) => {
        setStages(next);
        if (n !== undefined) setNote(n);
      });
      setResult(res);
    } catch (e: any) {
      setError(String(e?.message || e));
      setStages((prev) => prev.map((s) => (s.state === "running" ? { ...s, state: "failed" } : s)));
    } finally {
      setRunning(false);
    }
  }

  if (error && !assets) return <div className="banner bad">Could not load assets: {error}</div>;
  if (!assets) return <Empty>Loading assets from Facilio…</Empty>;

  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Run assessment</h1>
      <p className="muted" style={{ marginTop: 0 }}>
        Pick an asset. The agent reads its corrective work orders and before-maintenance photos from Facilio and
        produces one consolidated condition assessment. Nothing is entered by hand.
      </p>

      <div className="grid g2">
        <div className="card">
          <div className="card-title">1 · Choose an asset</div>
          <input
            type="text"
            placeholder="Search by name, category, manufacturer…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: "100%", marginBottom: 10 }}
            disabled={running}
          />
          <div className="tbl-wrap" style={{ maxHeight: 340, overflowY: "auto" }}>
            <table>
              <tbody>
                {filtered.map((a) => (
                  <tr
                    key={a.asset_id}
                    onClick={() => !running && setSelected(a.asset_id)}
                    style={{
                      cursor: running ? "default" : "pointer",
                      background: a.asset_id === selected ? "var(--accent-soft)" : undefined,
                    }}
                  >
                    <td>
                      <div style={{ fontWeight: a.asset_id === selected ? 650 : 500 }}>{a.name}</div>
                      <div className="muted small">
                        {a.category}
                        {a.manufacturer ? ` · ${a.manufacturer}` : ""}
                        {a.purchasedDate ? ` · in service ${a.purchasedDate.slice(0, 4)}` : ""}
                      </div>
                    </td>
                    <td style={{ width: 1, whiteSpace: "nowrap" }}>
                      {a.assessed ? (
                        <Pill tone={riskTone(a.risk_level || "")}>{a.grade}</Pill>
                      ) : (
                        <span className="muted small">not assessed</span>
                      )}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td className="muted small">No asset matches “{query}”.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="row spread" style={{ marginTop: 12 }}>
            <div className="small muted">
              {chosen ? (
                <>
                  Selected: <b style={{ color: "var(--text)" }}>{chosen.name}</b>
                </>
              ) : (
                "Nothing selected yet"
              )}
            </div>
            <button className="btn primary" disabled={!selected || running} onClick={start}>
              {running ? "Assessing…" : "Start assessment"}
            </button>
          </div>
        </div>

        <div className="card">
          <div className="card-title">2 · Pipeline</div>
          {stages.map((s) => (
            <div className="stage" key={s.key}>
              <div className={`dot ${s.state}`}>{s.state === "done" ? "✓" : s.state === "failed" ? "!" : "–"}</div>
              <div style={{ minWidth: 0 }}>
                <div className="stage-l">{s.label}</div>
                <div className="stage-d">{s.detail}</div>
              </div>
            </div>
          ))}
          {note && (
            <div className="muted small" style={{ marginTop: 10 }}>
              {note}
            </div>
          )}
          {error && (
            <div className="banner bad" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}
        </div>
      </div>

      {result && (
        <>
          {result.photoMode === "bundled_fallback" && (
            <div className="banner warn" style={{ marginTop: 14 }}>
              <span>
                <b>Photo bytes came from bundled copies.</b> Facilio returns a pre-signed URL for each attachment, but
                that storage host sends no CORS header, so the browser cannot read the bytes directly. The app fell back
                to its bundled copy of the same file. Allowing cross-origin reads on that bucket would make this step
                fully live.
              </span>
            </div>
          )}
          {result.photoMode === "unavailable" && (
            <div className="banner warn" style={{ marginTop: 14 }}>
              <span>
                <b>Photos exist but could not be read.</b> Facilio's pre-signed attachment URLs are not readable
                cross-origin, so no visual evidence could be analysed. Everything below rests on work-order text only.
              </span>
            </div>
          )}
          {!result.narrativeAccepted && result.narrativeRejectedFigures.length > 0 && (
            <div className="banner warn" style={{ marginTop: 14 }}>
              <span>
                <b>The written explanation was rejected.</b> The agent introduced figures that were not in the
                computed values it was given ({result.narrativeRejectedFigures.join(", ")}), so the prose was
                discarded. Every number below is unaffected.
              </span>
            </div>
          )}
          {result.countMismatches.length > 0 && (
            <div className="banner info" style={{ marginTop: 14 }}>
              <span>
                <b>Agent counts corrected by the engine.</b> The recurrence unit is the corrective work order, never the
                photo, so every count was recomputed from distinct work orders:
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {result.countMismatches.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </span>
            </div>
          )}

          <div className="card" style={{ marginTop: 14 }}>
            <div className="row spread">
              <div>
                <div className="card-title" style={{ marginBottom: 6 }}>
                  Result
                </div>
                <h2 style={{ marginBottom: 6 }}>{result.assessment.asset_name}</h2>
                <div className="row">
                  <Pill tone={gradeTone(result.assessment.grade)}>
                    Condition {result.assessment.score} / 5 · {result.assessment.grade}
                  </Pill>
                  <Pill tone={riskTone(result.assessment.risk_level)}>Risk {result.assessment.risk_score} / 100</Pill>
                  <Pill tone="mute">
                    RUL{" "}
                    {result.assessment.rul?.available === false
                      ? "not available"
                      : `${result.assessment.rul_years} years`}
                  </Pill>
                  {result.assessment.dominant_issue_mtbf?.verdict?.available && (
                    <Pill
                      tone={result.assessment.dominant_issue_mtbf.verdict.value === "contracting" ? "bad" : "mute"}
                    >
                      MTBF {result.assessment.dominant_issue_mtbf.verdict.value}
                    </Pill>
                  )}
                  <Pill tone={recommendationTone(result.assessment.recommendation)}>
                    {result.assessment.recommendation}
                  </Pill>
                </div>
                {result.assessment.unavailable && result.assessment.unavailable.length > 0 && (
                  <div className="muted small" style={{ marginTop: 8 }}>
                    {result.assessment.unavailable.length} metric
                    {result.assessment.unavailable.length === 1 ? "" : "s"} could not be computed — see the asset page
                    for what and why.
                  </div>
                )}
              </div>
              <a className="btn primary" href={`#/asset/${result.assessment.asset_id}`}>
                Open full analysis
              </a>
            </div>
          </div>
        </>
      )}
    </>
  );
}
