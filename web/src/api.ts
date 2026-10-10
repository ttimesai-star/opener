import type { AgentEvent, Brief, BriefInput, LlmCall, TraceStep } from "../../server/src/agent/types.ts";

export type { AgentEvent, Brief, BriefInput, LlmCall, TraceStep };

// Empty when the same Node process serves web + API (default). Set VITE_API_BASE
// at build time when the web app is hosted separately (e.g. Cloudflare Pages).
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? "";

export interface Health {
  ok: boolean;
  qloo: "mock" | "live";
  llm: boolean;
}

export type StoredBrief = Brief & { id: string; cached?: boolean };

export async function getHealth(): Promise<Health | null> {
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    return res.ok ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
}

export async function getBrief(id: string): Promise<StoredBrief> {
  const res = await fetch(`${API_BASE}/api/briefs/${encodeURIComponent(id)}`);
  const data = (await res.json().catch(() => ({}))) as StoredBrief & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

export const markdownUrl = (id: string) => `${API_BASE}/api/briefs/${encodeURIComponent(id)}.md`;

/**
 * Runs the agent and streams its steps (Server-Sent Events over a POST, read
 * with fetch so the input can be validated as JSON). Resolves with the brief.
 */
export async function streamBrief(input: Record<string, unknown>, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<StoredBrief> {
  const res = await fetch(`${API_BASE}/api/brief/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let brief: StoredBrief | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (signal?.aborted) break;
    // Normalise CRLF on the whole buffer: a \r\n pair can be split across two chunks.
    buffer = (buffer + value).replace(/\r\n/g, "\n");
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5)); // SSE strips one space only
      }
      if (data.length === 0) continue; // heartbeat comment
      const payload = JSON.parse(data.join("\n")) as unknown;
      if (signal?.aborted) break; // a newer request owns the timeline now
      if (event === "step") onEvent(payload as AgentEvent);
      else if (event === "brief") brief = payload as StoredBrief;
      else if (event === "error") throw new Error((payload as { error?: string }).error ?? "agent failed");
    }
  }
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  if (!brief) throw new Error("The stream ended before the brief was ready. Try again.");
  return brief;
}
