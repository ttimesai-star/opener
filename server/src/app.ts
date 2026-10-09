// HTTP layer: one Node process serves the built web app and the agent API.
// Live Qloo calls stay on this server (the kit forbids keys in browser apps).

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { runAgent } from "./agent/agent.ts";
import type { Llm } from "./agent/llm.ts";
import type { Brief, BriefInput } from "./agent/types.ts";
import type { QlooClient } from "./qloo/types.ts";

export interface AppDeps {
  qloo: QlooClient;
  llm: Llm | null;
  staticDir?: string;
  allowedOrigin?: string; // CORS origin for a separately hosted web app, e.g. https://opener.pages.dev
  rateLimitPerHour?: number;
  globalLimitPerHour?: number; // cap on uncached briefs for everyone: protects the Qloo quota
  trustProxy?: boolean; // behind one reverse proxy (HF Spaces, Render): use the address it appended
  cacheTtlMs?: number;
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
  const headliner = text(b.headliner);
  const city = text(b.city);
  if (!headliner || headliner.length > 80) return { ok: false, error: "headliner is required (1-80 characters)" };
  if (!city || city.length > 80) return { ok: false, error: "city is required (1-80 characters)" };
  // Qloo safe-use guide: do not send personal data. Reject obvious emails/phone numbers.
  if (EMAIL_OR_PHONE.test(headliner) || EMAIL_OR_PHONE.test(city)) return { ok: false, error: "inputs must be an artist and a city, not personal data" };
  const input: BriefInput = { headliner, city };
  for (const key of ["dateFrom", "dateTo"] as const) {
    const v = text(b[key]);
    if (v) {
      if (!DATE.test(v)) return { ok: false, error: `${key} must be YYYY-MM-DD` };
      input[key] = v;
    }
  }
  if (b.capacity !== undefined && b.capacity !== null && b.capacity !== "") {
    const c = Number(b.capacity);
    if (!Number.isInteger(c) || c < 1 || c > 200_000) return { ok: false, error: "capacity must be an integer between 1 and 200000" };
    input.capacity = c;
  }
  return { ok: true, input };
}

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
  const ttl = deps.cacheTtlMs ?? 6 * 3600_000;
  const hits = new Map<string, number[]>();
  // Private server-side cache (allowed by the hackathon guide); never written to the repo.
  const cache = new Map<string, { at: number; brief: Brief }>();
  const staticRoot = deps.staticDir ? resolve(deps.staticDir) : undefined;

  const allow = (ip: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
    const all = (hits.get("*") ?? []).filter((t) => now - t < 3600_000);
    if (recent.length >= limit || all.length >= globalLimit) return false;
    recent.push(now);
    all.push(now);
    hits.set(ip, recent);
    hits.set("*", all);
    return true;
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
        const parsed = validateInput(await readJson(req).catch(() => null));
        if (!parsed.ok) return send(res, 400, { error: parsed.error });
        const key = JSON.stringify(parsed.input).toLowerCase();
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < ttl) return send(res, 200, { ...hit.brief, cached: true });
        if (!allow(clientIp(req))) return send(res, 429, { error: "rate limit: try again later" });
        const brief = await runAgent({ input: parsed.input, qloo: deps.qloo, llm: deps.llm });
        cache.set(key, { at: Date.now(), brief });
        return send(res, 200, brief);
      }
      if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      if (staticRoot && (req.method === "GET" || req.method === "HEAD")) return serveStatic(staticRoot, url.pathname, res);
      return send(res, 404, { error: "not found" });
    } catch (error) {
      console.error("request failed:", (error as Error).message);
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
