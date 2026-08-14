import { useEffect, useRef, useState } from "react";
import { FButton, FText } from "@facilio/dsm-react-wrapper";
import { fn } from "../lib/vibe";
import { supplyPhotoEvidence, runPipeline, type SuppliedPhoto } from "../lib/pipeline";
import { Card, CardTitle } from "./Card";
import { StatusTag } from "./StatusTag";

interface Pending {
  attachment_id: number;
  wo_id: number;
  wo_subject: string;
  wo_date: string;
  filename: string;
  size: number;
  content_type: string;
}

interface UnreadResult {
  before_photos_total: number;
  analyzed: number;
  pending: Pending[];
}

/**
 * Supply the before-photos the app cannot fetch for itself.
 *
 * Facilio hands out a download URL for every attachment, but its storage host does not
 * permit a browser to read the file, so the app can see that a photo exists and never
 * obtain it. This section lists exactly which photos are missing and lets the operator
 * hand over the same files, which are then matched back to their real Facilio
 * attachment ids.
 *
 * Files are matched on filename, so selecting the whole folder does the entire asset in
 * one go. A name matching several attachments is applied to each of them — the same
 * file legitimately appears on several work orders — and that is reported rather than
 * assumed silently.
 */
export function PhotoEvidence({ assetId, onDone }: { assetId: number; onDone: () => void }) {
  const [state, setState] = useState<UnreadResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    load();
  }, [assetId]);

  function load() {
    fn<UnreadResult>("unread-photos", { assetId })
      .then(setState)
      .catch((e) => setError(String(e?.message || e)));
  }

  async function onFiles(picked: FileList | null) {
    if (!picked || picked.length === 0 || !state) return;
    setBusy(true);
    setError("");
    setResult("");

    try {
      // Match on filename, case-insensitively. One picked file can satisfy several
      // attachments, since the same photo is attached to more than one work order.
      const byName = new Map<string, File>();
      for (const f of Array.from(picked)) byName.set(f.name.toLowerCase(), f);

      const supplied: SuppliedPhoto[] = [];
      const unmatchedAttachments: Pending[] = [];
      for (const p of state.pending) {
        const file = byName.get(p.filename.toLowerCase());
        if (file) supplied.push({ ...p, file });
        else unmatchedAttachments.push(p);
      }

      const usedNames = new Set(supplied.map((s) => s.filename.toLowerCase()));
      const unusedFiles = Array.from(byName.keys()).filter((n) => !usedNames.has(n));

      if (supplied.length === 0) {
        setError(
          `None of those ${picked.length} file${picked.length === 1 ? "" : "s"} matched a missing photo. Expected names: ${state.pending
            .map((p) => p.filename)
            .join(", ")}`
        );
        return;
      }

      const out = await supplyPhotoEvidence(assetId, supplied, setNote);

      // The findings now exist, so the normal pipeline treats them as cached, skips the
      // photo stage and produces the assessment with visual evidence included.
      setNote("Re-running the assessment with the new photo evidence…");
      await runPipeline(assetId, (_stages, n) => {
        if (n) setNote(n);
      });

      const parts = [
        `${out.photosAnalysed} photo${out.photosAnalysed === 1 ? "" : "s"} analyzed across ${out.woRuns} work order${
          out.woRuns === 1 ? "" : "s"
        }`,
        `${out.inserted} finding${out.inserted === 1 ? "" : "s"} stored`,
      ];
      if (unmatchedAttachments.length > 0) parts.push(`${unmatchedAttachments.length} still missing`);
      if (unusedFiles.length > 0) parts.push(`${unusedFiles.length} selected file(s) matched nothing`);
      setResult(parts.join(" · "));

      load();
      onDone();
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
      setNote("");
      if (input.current) input.current.value = "";
    }
  }

  if (error && !state) {
    return (
      <Card>
        <CardTitle>Photo evidence</CardTitle>
        <FText appearance="bodyReg14" styleProps={{ color: "textError", display: "block" }}>
          {error}
        </FText>
      </Card>
    );
  }
  if (!state) return null;
  if (state.before_photos_total === 0) return null;

  const allDone = state.pending.length === 0;

  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-container-xxlarge)" }}>
      <CardTitle
        action={
          !allDone ? (
            <FButton appearance="primary" size="medium" disabled={busy} onButtonClick={() => input.current?.click()}>
              {busy ? "Working…" : `Supply ${state.pending.length} photo${state.pending.length === 1 ? "" : "s"}`}
            </FButton>
          ) : undefined
        }
      >
        <span>
          Photo evidence{" "}
          <StatusTag tone={allDone ? "good" : "warn"}>
            {state.analyzed} of {state.before_photos_total} analyzed
          </StatusTag>
        </span>
      </CardTitle>

      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => onFiles(e.target.files)}
      />

      <FText appearance="bodyReg14" styleProps={{ color: "textDescription", display: "block" }}>
        {allDone
          ? "Every before-photo on this asset's corrective work orders has been analyzed."
          : "Facilio provides a download link for each of these photos, but its storage host does not allow a browser to read the file, so the app cannot fetch them itself. Select the same image files and they will be matched to their work orders by filename and analyzed."}
      </FText>

      {busy && note && (
        <FText appearance="bodyReg14" styleProps={{ color: "textDescription", display: "block" }}>
          {note}
        </FText>
      )}

      {result && (
        <FText appearance="bodyReg14" styleProps={{ color: "textSuccess", display: "block" }}>
          {result}
        </FText>
      )}

      {error && (
        <FText appearance="bodyReg14" styleProps={{ color: "textError", display: "block" }}>
          {error}
        </FText>
      )}

      {!allDone && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                {["Photo", "Work order", "Date", "Size"].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      padding: "6px 10px",
                      color: "var(--colors-text-caption)",
                      fontWeight: 600,
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                      borderBottom: "1px solid var(--colors-border-neutral-base-subtler)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.pending.map((p) => (
                <tr key={p.attachment_id}>
                  <td style={cell}>{p.filename}</td>
                  <td style={cell}>
                    #{p.wo_id} · {p.wo_subject}
                  </td>
                  <td style={cell}>{p.wo_date}</td>
                  <td style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {Math.round(p.size / 1024)} KB
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const cell: React.CSSProperties = {
  padding: "7px 10px",
  borderBottom: "1px solid var(--colors-border-neutral-base-subtler)",
  color: "var(--colors-text-description)",
};
