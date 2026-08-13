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
 * Run the photo-validation agent. Structured replies arrive as a JSON *string*
 * in response.content, so parsing here keeps every caller from repeating it.
 */
export async function runAgent<T = any>(input: string, fileIds?: number[]): Promise<T> {
  const res: any = await vibe.executeAgent("photo-validation", input, fileIds?.length ? { fileIds } : undefined);
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
