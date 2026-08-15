/**
 * The batch that outlives the page.
 *
 * `App` rebuilds the routed page on every `hashchange`, so anything a batch needs is
 * destroyed the moment the user opens the register or an asset. The work itself never
 * stopped — nothing cancels `runBatch`, and its writes kept landing — but the queue, the
 * stage list and the elapsed clock all lived in `RunAssessment`'s `useState`, so coming
 * back showed an idle screen over a batch still in flight.
 *
 * A module outlives a component, which is the whole trick here. `runBatch` is called from
 * this scope and reports into it; the page subscribes and renders whatever it finds,
 * whether it started the run or arrived halfway through someone else's.
 *
 * This owns run state ONLY. The asset picker, the search box and the selection stay in the
 * page, because those are per-view and a remount is supposed to reset them.
 */
import { runBatch, type AssetRun, type BatchTarget, type RunOptions } from "./pipeline";

export interface RunSnapshot {
  runs: AssetRun[];
  running: boolean;
  /** Epoch ms the batch began, 0 when none has. Kept so the clock survives a remount. */
  startedAt: number;
  /** Epoch ms the batch ended, 0 while running — the frozen clock after it finishes. */
  finishedAt: number;
  error: string;
}

const EMPTY: RunSnapshot = { runs: [], running: false, startedAt: 0, finishedAt: 0, error: "" };

let snapshot: RunSnapshot = EMPTY;
let cancelled = false;

const listeners = new Set<() => void>();

/**
 * Always a fresh object, never a mutated one. `useSyncExternalStore` compares snapshots by
 * identity, so mutating in place would leave the page frozen on the first render it saw —
 * the same reason `runBatch.publish` rebuilds its array on every emit.
 */
function set(patch: Partial<RunSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): RunSnapshot {
  return snapshot;
}

/** True while a batch is in flight — the guard `startBatch` uses, exported for callers. */
export function isRunning(): boolean {
  return snapshot.running;
}

/**
 * Run a batch, or do nothing if one is already going.
 *
 * The guard is not cosmetic. Re-assess on an asset page routes to `/run/<id>`, which mounts
 * this page fresh with that asset preselected, so a second Start is one click away while a
 * batch runs. `runBatch` assumes it is the only loop in flight: two would interleave one
 * asset's `clear-wo-text-findings` delete with the other's inserts.
 *
 * `onFinished` runs even when the page that started the batch is long unmounted, which is
 * what keeps the picker's grades correct after a run that finished on another screen.
 */
export async function startBatch(
  targets: BatchTarget[],
  opts: RunOptions = {},
  onFinished?: (runs: AssetRun[]) => void
): Promise<void> {
  if (snapshot.running || targets.length === 0) return;

  cancelled = false;
  set({ runs: [], running: true, startedAt: Date.now(), finishedAt: 0, error: "" });

  try {
    const finished = await runBatch(targets, (runs) => set({ runs }), () => cancelled, opts);
    set({ runs: finished });
    if (onFinished) onFinished(finished);
  } catch (e: any) {
    set({ error: String(e?.message || e) });
  } finally {
    set({ running: false, finishedAt: Date.now() });
  }
}

/**
 * Stop after the asset currently running. Checked between assets only — the SDK's HTTP
 * layer ignores AbortSignal, so an agent call already in flight cannot be interrupted.
 */
export function cancelBatch(): void {
  if (!snapshot.running) return;
  cancelled = true;
  // Re-emit so the button can read `cancelRequested` and say "Stopping…" immediately,
  // rather than looking dead until the current asset finishes.
  set({ runs: snapshot.runs.map((r) => ({ ...r })) });
}

export function cancelRequested(): boolean {
  return cancelled;
}
