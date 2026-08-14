import { createVibe } from "@facilio/vibe-sdk";

export const vibe = createVibe();

/** Call a condition-engine handler. All handler args are numbers or strings. */
export async function fn<T = any>(handler: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await vibe.executeFunction("condition-engine", handler, args)) as T;
}

/** Call a Facilio CMMS connection action from the browser. */
export async function action<T = any>(actionSlug: string, payload: Record<string, unknown> = {}): Promise<T> {
  return (await vibe.executeAction("facilio-cmms", actionSlug, payload)) as T;
}

/**
 * Call the org's "Facilio CMMS Files" companion connection (custom, org 2920).
 * Same CMMS upstream as `action`, but its actions are saved with
 * output_config {kind:"file", mode:"base64"}: the file arrives base64-encoded
 * inside the JSON response, through the app's own origin. This is the only
 * file route a browser can read — the main connection's mode is "signed_url",
 * and that S3 host sends no CORS header, so its URLs display but never fetch.
 */
export async function fileAction<T = any>(actionSlug: string, payload: Record<string, unknown> = {}): Promise<T> {
  return (await vibe.executeAction("facilio-cmms-files", actionSlug, payload)) as T;
}

export type AgentName = "photo-validation" | "asset-baseline" | "condition-assessment";

/**
 * Run one of the app's agents. Structured replies arrive as a JSON *string* in
 * response.content, so parsing here keeps every caller from repeating it.
 *
 * Agents must be called from the browser: the function sandbox has AGENTS_TOKEN but
 * no AGENTS_URL, so server-side code cannot reach the agents service.
 */
export async function runAgent<T = any>(
  input: string,
  fileIds?: number[],
  agent: AgentName = "photo-validation"
): Promise<T> {
  const res: any = await vibe.executeAgent(agent, input, fileIds?.length ? { fileIds } : undefined);
  const raw = res?.response?.content;
  if (typeof raw !== "string") return raw as T;
  return JSON.parse(raw) as T;
}

export function inr(v: number): string {
  if (!v) return "₹0";
  if (v >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
  if (v >= 1000) return `₹${(v / 1000).toFixed(0)}K`;
  return `₹${v}`;
}
