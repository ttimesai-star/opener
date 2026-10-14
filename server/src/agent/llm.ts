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

export interface ChatOptions {
  /** Aborts the call (and any provider fallback) when the agent's time budget runs out. */
  signal?: AbortSignal;
}

export interface Llm {
  chat(messages: ChatMessage[], tools?: ToolSpec[], opts?: ChatOptions): Promise<ChatResult>;
}

interface Provider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const STRICT_ID = /^[A-Za-z0-9]{9}$/;

/** One LLM HTTP request; a slow free model is cut here and the next provider or the planner takes over. */
export const DEFAULT_LLM_CALL_TIMEOUT_MS = 20_000;
/**
 * After a 429 the provider is skipped for this long. A spent free-tier quota
 * (Gemini, live demo 2026-10-14) answered 429 on every later turn, and each
 * turn paid two requests plus a 1.5 s wait before reaching the fallback.
 */
export const RATE_LIMIT_COOLDOWN_MS = 120_000;

/**
 * An abort signal that fires after `ms`, on a normal (ref'd) timer. AbortSignal.timeout()
 * uses an unref'd timer: on Node 22 a run waiting only on it ended with the promise still
 * pending (CI, 2026-10-15). Call clear() once the work is done.
 */
export function timeoutSignal(ms: number, reason = `timed out after ${ms} ms`): { signal: AbortSignal; clear: () => void } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(reason)), ms);
  return { signal: ctl.signal, clear: () => clearTimeout(timer) };
}

/** Positive integer from env, else the default. */
export function envMs(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

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
  private readonly now: () => number;
  /** Provider name -> time until which it is skipped (after a 429). */
  private readonly coolingUntil = new Map<string, number>();

  constructor(providers: Provider[], timeoutMs = DEFAULT_LLM_CALL_TIMEOUT_MS, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    if (providers.length === 0) throw new Error("No LLM provider configured");
    this.providers = providers;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async chat(messages: ChatMessage[], tools?: ToolSpec[], opts: ChatOptions = {}): Promise<ChatResult> {
    let lastError: unknown;
    const now = this.now();
    // Providers in a 429 cooldown go last, not away, the one that cools down sooner first; if all are cooling, still try them.
    const remaining = (p: Provider) => Math.max(0, (this.coolingUntil.get(p.name) ?? 0) - now);
    const order = [...this.providers].sort((a, b) => remaining(a) - remaining(b));
    for (const p of order) {
      // One bounded retry per provider for transient 5xx (preview models flap); a 429 moves on at once.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (opts.signal?.aborted) throw new Error(`LLM call stopped: ${String(opts.signal.reason ?? "time budget spent")}`);
        try {
          const res = await this.chatWith(p, messages, tools, opts.signal);
          this.coolingUntil.delete(p.name);
          return res;
        } catch (error) {
          lastError = error;
          const msg = (error as Error).message;
          if (/HTTP 429/.test(msg)) {
            this.coolingUntil.set(p.name, this.now() + RATE_LIMIT_COOLDOWN_MS);
            break;
          }
          if (opts.signal?.aborted || !/HTTP 5\d\d/.test(msg) || attempt === 1) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (opts.signal?.aborted) break;
    }
    throw lastError instanceof Error ? lastError : new Error("All LLM providers failed");
  }

  private async chatWith(p: Provider, messages: ChatMessage[], tools?: ToolSpec[], signal?: AbortSignal): Promise<ChatResult> {
    // The timer covers the whole request including the body read.
    const timeout = timeoutSignal(this.timeoutMs, `${p.name} LLM timed out after ${this.timeoutMs} ms`);
    try {
      return await this.request(p, messages, tools, signal ? AbortSignal.any([timeout.signal, signal]) : timeout.signal);
    } finally {
      timeout.clear();
    }
  }

  private async request(p: Provider, messages: ChatMessage[], tools: ToolSpec[] | undefined, signal: AbortSignal): Promise<ChatResult> {
    const res = await this.fetchImpl(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({ model: p.model, messages: keepsVendorFields(p.baseUrl) ? messages : toStrictMessages(messages), temperature: 0.2, ...(tools?.length ? { tools, tool_choice: "auto" } : {}) }),
      signal,
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
 * LLM_CALL_TIMEOUT_MS                            one HTTP request (default 20 s)
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
  return providers.length > 0 ? new OpenAiCompatibleLlm(providers, envMs(env.LLM_CALL_TIMEOUT_MS, DEFAULT_LLM_CALL_TIMEOUT_MS)) : null;
}
