import type { Brief, BriefInput } from "../../server/src/agent/types.ts";

export type { Brief, BriefInput };

// Empty when the same Node process serves web + API (default). Set VITE_API_BASE
// at build time when the web app is hosted separately (e.g. Cloudflare Pages).
const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

export interface Health {
  ok: boolean;
  qloo: "mock" | "live";
  llm: boolean;
}

export async function getHealth(): Promise<Health | null> {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    return res.ok ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
}

export async function requestBrief(input: BriefInput): Promise<Brief> {
  const res = await fetch(`${API_BASE}/api/brief`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = (await res.json().catch(() => ({}))) as Brief & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}
