// HTTP layer: one Node process serves the built web app and the agent API.
// Live Qloo calls stay on this server (the kit forbids keys in browser apps).

import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { runAgent } from "./agent/agent.ts";
import type { Llm } from "./agent/llm.ts";
import { briefToMarkdown } from "./agent/markdown.ts";
import type { AgentEvent, Brief, BriefInput, OpenerInput, VenueInput } from "./agent/types.ts";
import type { QlooClient } from "./qloo/types.ts";

export interface AppDeps {
  qloo: QlooClient;
  llm: Llm | null;
  staticDir?: string;
  allowedOrigin?: string; // CORS origin for a separately hosted web app, e.g. https://opener.pages.dev
  rateLimitPerHour?: number;
  globalLimitPerHour?: number; // cap on uncached briefs for everyone: protects the Qloo quota
  trustProxy?: boolean; // behind one reverse proxy (HF Spaces, Render): use the address it appended
  cacheTtlMs?: number; // identical inputs reuse the stored brief for this long
  briefTtlMs?: number; // permalinks live this long, in server memory only
  maxStoredBriefs?: number;
  heartbeatMs?: number; // SSE keep-alive comment interval
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon",
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_OR_PHONE = /@|\+?\d[\d\s-]{7,}/;

export function validateInput(body: unknown): { ok: true; input: BriefInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "");
  const scenario = b.scenario === undefined || b.scenario === null || b.scenario === "" ? "opener" : b.scenario;
  if (scenario !== "opener" && scenario !== "venue") return { ok: false, error: "scenario must be opener or venue" };
  const city = text(b.city);
  const anchorKey = scenario === "venue" ? "venue" : "headliner";
  const anchor = text(b[anchorKey]);
  if (!anchor || anchor.length > 80) return { ok: false, error: `${anchorKey} is required (1-80 characters)` };
  if (!city || city.length > 80) return { ok: false, error: "city is required (1-80 characters)" };
  // Qloo safe-use guide: do not send personal data. Reject obvious emails/phone numbers.
  if (EMAIL_OR_PHONE.test(anchor) || EMAIL_OR_PHONE.test(city)) {
    return { ok: false, error: `inputs must be ${scenario === "venue" ? "a venue" : "an artist"} and a city, not personal data` };
  }
  const date = (key: string): { value?: string; error?: string } => {
    const v = text(b[key]);
    if (!v) return {};
    if (!DATE.test(v) || Number.isNaN(Date.parse(v))) return { error: `${key} must be YYYY-MM-DD` };
    return { value: v };
  };
  let capacity: number | undefined;
  if (b.capacity !== undefined && b.capacity !== null && b.capacity !== "") {
    const c = Number(b.capacity);
    if (!Number.isInteger(c) || c < 1 || c > 200_000) return { ok: false, error: "capacity must be an integer between 1 and 200000" };
    capacity = c;
  }
  if (scenario === "venue") {
    const d = date("date");
    if (d.error) return { ok: false, error: d.error };
    const input: VenueInput = { scenario, venue: anchor, city };
    if (d.value) input.date = d.value;
    if (capacity !== undefined) input.capacity = capacity;
    return { ok: true, input };
  }
  const input: OpenerInput = { scenario, headliner: anchor, city };
  for (const key of ["dateFrom", "dateTo"] as const) {
    const d = date(key);
    if (d.error) return { ok: false, error: d.error };
    if (d.value) input[key] = d.value;
  }
  if (capacity !== undefined) input.capacity = capacity;
  return { ok: true, input };
}

/** Stable cache key: field order and case do not matter. */
export function cacheKey(input: BriefInput): string {
  const entries = Object.entries(input).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries).toLowerCase();
}

const BRIEF_ID = /^[A-Za-z0-9_-]{12}$/;
const PERMALINK = /^\/api\/briefs\/([^/]+?)(\.md)?$/;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 4096): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export function createApp(deps: AppDeps): Server {
  const limit = deps.rateLimitPerHour ?? 30;
  const globalLimit = deps.globalLimitPerHour ?? 300;
  const briefTtl = deps.briefTtlMs ?? 24 * 3600_000;
  const ttl = Math.min(deps.cacheTtlMs ?? 6 * 3600_000, briefTtl);
  const maxStored = Math.max(1, deps.maxStoredBriefs ?? 500);
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const hits = new Map<string, number[]>();
  // Private server-side store (allowed by the hackathon guide); never written to disk or the repo.
  // briefs: permalink id -> brief. cache: input key -> id of the brief for that input.
  const briefs = new Map<string, { at: number; brief: Brief }>();
  const cache = new Map<string, string>();
  const staticRoot = deps.staticDir ? resolve(deps.staticDir) : undefined;

  const allow = (ip: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
    const all = (hits.get("*") ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= limit || all.length >= globalLimit) return false;
    if (hits.size > 5000) {
      // Bound memory: forget addresses with no request in the last hour.
      for (const [k, ts] of hits) if (k !== "*" && !ts.some((t) => now - t < 3600_000)) hits.delete(k);
    }
    recent.push(now);
    all.push(now);
    hits.set(ip, recent);
    hits.set("*", all);
    return true;
  };

  const getStored = (id: string): Brief | null => {
    const hit = briefs.get(id);
    if (!hit) return null;
    if (Date.now() - hit.at >= briefTtl) {
      briefs.delete(id);
      return null;
    }
    return hit.brief;
  };

  let lastSweep = 0;
  const sweep = (now: number) => {
    if (now - lastSweep < 60_000) return;
    lastSweep = now;
    for (const [id, v] of briefs) if (now - v.at >= briefTtl) briefs.delete(id); // drop expired
    for (const [k, id] of cache) if (!briefs.has(id)) cache.delete(k);
  };

  const store = (key: string, brief: Brief): Brief => {
    const now = Date.now();
    lastSweep = 0;
    sweep(now);
    while (briefs.size >= maxStored) {
      const oldest = briefs.keys().next().value as string; // Map keeps insertion order
      briefs.delete(oldest);
    }
    for (const [k, id] of cache) if (!briefs.has(id)) cache.delete(k);
    const id = randomBytes(9).toString("base64url");
    const stored: Brief = { ...brief, id };
    briefs.set(id, { at: now, brief: stored });
    cache.set(key, id);
    return stored;
  };

  const cached = (key: string): Brief | null => {
    const id = cache.get(key);
    const hit = id ? briefs.get(id) : undefined;
    return hit && Date.now() - hit.at < ttl ? hit.brief : null;
  };

  // The left-most X-Forwarded-For entry is client-controlled. Only the entry the
  // trusted proxy appended (right-most) is used, and only when TRUST_PROXY is on.
  const clientIp = (req: IncomingMessage): string => {
    const xff = req.headers["x-forwarded-for"];
    if (deps.trustProxy && typeof xff === "string") {
      const last = xff.split(",").map((s) => s.trim()).filter(Boolean).pop();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? "?";
  };

  type Prepared = { status: number; body: unknown } | { key: string; input: BriefInput; hit: Brief | null };

  /** Validation, cache and rate limit shared by the JSON and the streaming endpoint. */
  const prepare = async (req: IncomingMessage): Promise<Prepared> => {
    sweep(Date.now());
    const parsed = validateInput(await readJson(req).catch(() => null));
    if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
    const key = cacheKey(parsed.input);
    const hit = cached(key);
    if (hit) return { key, input: parsed.input, hit };
    if (!allow(clientIp(req))) return { status: 429, body: { error: "rate limit: try again later" } };
    return { key, input: parsed.input, hit: null };
  };

  const streamBrief = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const p = await prepare(req);
    if ("status" in p) return send(res, p.status, p.body);
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no", // ask reverse proxies not to buffer the stream
      connection: "keep-alive",
    });
    let open = true;
    res.on("close", () => {
      open = false;
    });
    res.on("error", (error) => {
      open = false; // viewer went away mid-stream; the run still finishes and is stored
      console.warn(`stream socket error: ${error.message}`);
    });
    const write = (event: string, data: unknown) => {
      if (open && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const beat = setInterval(() => {
      if (open && !res.writableEnded) res.write(": ping\n\n");
    }, heartbeatMs);
    try {
      if (p.hit) {
        // Replay the stored log so a cached brief still shows its evidence trail.
        for (const step of p.hit.trace) write("step", { type: "end", seq: step.index, kind: "qloo", step } satisfies AgentEvent);
        write("brief", { ...p.hit, cached: true });
        return;
      }
      write("ready", { qloo: deps.qloo.mode, llm: deps.llm !== null });
      // The run continues if the viewer leaves: the brief is stored and the quota is not wasted.
      const brief = await runAgent({ input: p.input, qloo: deps.qloo, llm: deps.llm, onEvent: (e) => write("step", e) });
      write("brief", store(p.key, brief));
    } catch (error) {
      console.error("stream failed:", (error as Error).message);
      write("error", { error: "internal error" });
    } finally {
      clearInterval(beat);
      if (!res.writableEnded) res.end();
    }
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (deps.allowedOrigin && req.headers.origin === deps.allowedOrigin) {
      res.setHeader("access-control-allow-origin", deps.allowedOrigin);
      res.setHeader("access-control-allow-headers", "content-type");
      res.setHeader("vary", "origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
    }
    try {
      if (url.pathname === "/api/health" && req.method === "GET") {
        return send(res, 200, { ok: true, qloo: deps.qloo.mode, llm: deps.llm !== null });
      }
      if (url.pathname === "/api/brief" && req.method === "POST") {
        const p = await prepare(req);
        if ("status" in p) return send(res, p.status, p.body);
        if (p.hit) return send(res, 200, { ...p.hit, cached: true });
        const brief = await runAgent({ input: p.input, qloo: deps.qloo, llm: deps.llm });
        return send(res, 200, store(p.key, brief));
      }
      if (url.pathname === "/api/brief/stream" && req.method === "POST") return await streamBrief(req, res);
      const permalink = PERMALINK.exec(url.pathname);
      if (permalink && req.method === "GET") {
        const id = permalink[1] ?? "";
        const brief = BRIEF_ID.test(id) ? getStored(id) : null;
        if (!brief) return send(res, 404, { error: "brief not found or expired" });
        if (!permalink[2]) return send(res, 200, brief);
        res.writeHead(200, {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="opener-brief-${id}.md"`,
          "cache-control": "no-store",
        });
        res.end(briefToMarkdown(brief));
        return;
      }
      if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      if (staticRoot && (req.method === "GET" || req.method === "HEAD")) return serveStatic(staticRoot, url.pathname, res);
      return send(res, 404, { error: "not found" });
    } catch (error) {
      console.error("request failed:", (error as Error).message);
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      return send(res, 500, { error: "internal error" });
    }
  });
}

function serveStatic(root: string, pathname: string, res: ServerResponse): void {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = join(root, rel);
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html"); // SPA fallback
  if (!existsSync(file)) {
    res.writeHead(404).end("web app not built: run npm run build");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}
