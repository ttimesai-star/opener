// Minimal OpenAI-compatible chat client (Cerebras, Mistral, Groq, OpenRouter
// all speak this). Primary + optional fallback provider, both from env.
// Keys stay server-side and are never logged.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Vendor data echoed back to the same vendor only (Gemini 3 thought signatures). */
  extra_content?: unknown;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatResult {
  content: string | null;
  toolCalls: ToolCall[];
  provider: string;
}

export interface Llm {
  chat(messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult>;
}

interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const STRICT_ID = /^[A-Za-z0-9]{9}$/;

/** Gemini's endpoint wants its own extra_content back; every other provider gets plain OpenAI format. */
export function keepsVendorFields(baseUrl: string): boolean {
  return /(^|\.)generativelanguage\.googleapis\.com(\/|$)/.test(baseUrl.replace(/^https?:\/\//, ""));
}

/**
 * Plain OpenAI chat messages: only role, content, tool_calls {id, type,
 * function {name, arguments}} and tool_call_id. A history started on Gemini
 * carries tool_calls[].extra_content, which Mistral rejects with 422 (live
 * demo run, 2026-10-14). Mistral also requires tool call ids of exactly nine
 * letters or digits, so other ids are mapped consistently in assistant calls
 * and in the tool messages that answer them.
 */
export function toStrictMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const m of messages) for (const c of m.tool_calls ?? []) if (STRICT_ID.test(c.id)) used.add(c.id);
  let n = 0;
  const idFor = (id: string): string => {
    if (STRICT_ID.test(id)) return id;
    const known = ids.get(id);
    if (known) return known;
    let out = "";
    do out = `call${(n++).toString(36).padStart(5, "0")}`; while (used.has(out));
    ids.set(id, out);
    used.add(out);
    return out;
  };
  return messages.map((m) => {
    const out: Record<string, unknown> = { role: m.role, content: m.content ?? (m.tool_calls?.length ? "" : null) };
    if (m.tool_calls?.length) {
      out.tool_calls = m.tool_calls.map((c) => ({ id: idFor(c.id), type: "function", function: { name: c.function.name, arguments: c.function.arguments } }));
    }
    if (m.role === "tool" && m.tool_call_id !== undefined) out.tool_call_id = idFor(m.tool_call_id);
    return out;
  });
}

export class OpenAiCompatibleLlm implements Llm {
  // Plain fields, not parameter properties: Node's type stripping only handles erasable syntax.
  private readonly providers: Provider[];
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(providers: Provider[], timeoutMs = 30_000, fetchImpl: typeof fetch = fetch) {
    if (providers.length === 0) throw new Error("No LLM provider configured");
    this.providers = providers;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async chat(messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
    let lastError: unknown;
    for (const p of this.providers) {
      // One bounded retry per provider for transient 429/5xx (free tiers and preview models flap).
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await this.chatWith(p, messages, tools);
        } catch (error) {
          lastError = error;
          if (!/HTTP (429|5\d\d)/.test((error as Error).message) || attempt === 1) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("All LLM providers failed");
  }

  private async chatWith(p: Provider, messages: ChatMessage[], tools?: ToolSpec[]): Promise<ChatResult> {
    const res = await this.fetchImpl(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({ model: p.model, messages: keepsVendorFields(p.baseUrl) ? messages : toStrictMessages(messages), temperature: 0.2, ...(tools?.length ? { tools, tool_choice: "auto" } : {}) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      throw new Error(`${p.name} LLM HTTP ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[] };
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error(`${p.name} returned no message`);
    return { content: msg.content ?? null, toolCalls: msg.tool_calls ?? [], provider: p.name };
  }
}

/**
 * LLM_BASE_URL / LLM_API_KEY / LLM_MODEL         primary (default: Gemini OpenAI-compatible endpoint, free tier)
 * LLM_FALLBACK_BASE_URL / _API_KEY / _MODEL      optional second provider (e.g. Mistral)
 * Returns null when no key is set: the agent then runs the scripted planner.
 */
export function createLlm(env: NodeJS.ProcessEnv = process.env): Llm | null {
  const providers: Provider[] = [];
  if (env.LLM_API_KEY) {
    providers.push({ name: "primary", baseUrl: env.LLM_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: env.LLM_API_KEY, model: env.LLM_MODEL ?? "gemini-3-flash-preview" });
  }
  if (env.LLM_FALLBACK_API_KEY) {
    providers.push({ name: "fallback", baseUrl: env.LLM_FALLBACK_BASE_URL ?? "https://api.mistral.ai/v1", apiKey: env.LLM_FALLBACK_API_KEY, model: env.LLM_FALLBACK_MODEL ?? "mistral-small-latest" });
  }
  return providers.length > 0 ? new OpenAiCompatibleLlm(providers) : null;
}
