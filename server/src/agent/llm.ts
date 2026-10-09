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
      body: JSON.stringify({ model: p.model, messages, temperature: 0.2, ...(tools?.length ? { tools, tool_choice: "auto" } : {}) }),
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
