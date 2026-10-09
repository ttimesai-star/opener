import { useEffect, useState } from "react";
import type { AgentEvent, Brief } from "../api.ts";

/** One row of the agent timeline: a Qloo tool call or an LLM round trip. */
export interface TimelineItem {
  seq: number;
  kind: "qloo" | "llm";
  title: string;
  actor: string;
  state: "running" | "done";
  startedAt?: number;
  status?: string;
  durationMs?: number;
  summary?: string;
  purpose?: string;
  details?: unknown;
}

const LLM_TITLE = { plan: "LLM: choose next Qloo calls", narrative: "LLM: write the narrative" } as const;

/** Folds one streamed event into the timeline (pure, for useState updaters). */
export function applyEvent(items: TimelineItem[], e: AgentEvent): TimelineItem[] {
  if (e.type === "start") {
    const item: TimelineItem = e.kind === "qloo"
      ? { seq: e.seq, kind: "qloo", title: e.tool, actor: e.actor, state: "running", startedAt: Date.now(), purpose: e.purpose, details: { args: e.args } }
      : { seq: e.seq, kind: "llm", title: LLM_TITLE[e.phase], actor: "llm", state: "running", startedAt: Date.now() };
    return [...items.filter((i) => i.seq !== e.seq), item];
  }
  const done: TimelineItem = e.kind === "qloo"
    ? {
        seq: e.seq, kind: "qloo", title: e.step.tool, actor: e.step.actor, state: "done", status: e.step.status,
        durationMs: e.step.durationMs, summary: e.step.summary, purpose: e.step.purpose,
        details: { args: e.step.args, endpoint: e.step.endpoint, requests: e.step.requests },
      }
    : {
        seq: e.seq, kind: "llm", title: LLM_TITLE[e.call.phase], actor: e.call.provider ? `llm · ${e.call.provider}` : "llm",
        state: "done", status: e.call.status, durationMs: e.call.durationMs, summary: e.call.summary,
      };
  const at = items.findIndex((i) => i.seq === e.seq);
  if (at < 0) return [...items, done];
  const next = [...items];
  next[at] = done;
  return next;
}

/** Timeline for a brief opened from a permalink (no live events). */
export function timelineFromBrief(brief: Brief): TimelineItem[] {
  const items = brief.trace.map((s) => applyEvent([], { type: "end", seq: s.index, kind: "qloo", step: s })[0] as TimelineItem);
  brief.llmCalls.forEach((c, i) => items.push(applyEvent([], { type: "end", seq: brief.trace.length + i + 1, kind: "llm", call: c })[0] as TimelineItem));
  return items;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function AgentLog({ items, live }: { items: TimelineItem[]; live?: boolean }) {
  const now = useNow(Boolean(live) && items.some((i) => i.state === "running"));
  if (items.length === 0) return <p className="meta">{live ? "Starting the agent…" : "No calls recorded."}</p>;
  const qloo = items.filter((i) => i.kind === "qloo" && i.state === "done");
  const total = items.reduce((sum, i) => sum + (i.durationMs ?? 0), 0);
  return (
    <>
      <p className="meta log-totals" aria-live="polite">
        {qloo.length} Qloo call{qloo.length === 1 ? "" : "s"} · {items.filter((i) => i.kind === "llm").length} LLM call(s) · {(total / 1000).toFixed(1)} s total
      </p>
      <ol className="log">
        {items.map((s) => (
          <li key={s.seq} className={`log-item log-${s.kind} ${s.state === "running" ? "is-running" : ""}`}>
            <details>
              <summary>
                {s.state === "running"
                  ? <span className="status status-running"><span className="spinner" aria-hidden="true" />running</span>
                  : <span className={`status status-${s.status}`}>{s.status}</span>}{" "}
                <span className={`kind kind-${s.kind}`}>{s.kind === "qloo" ? "Qloo" : "LLM"}</span> <code>{s.title}</code>
                <span className="meta">
                  {" "}· {s.actor} · {s.state === "running" ? `${((now - (s.startedAt ?? now)) / 1000).toFixed(1)} s` : `${s.durationMs ?? 0} ms`}
                </span>
                {s.purpose && <span className="purpose"> — {s.purpose}</span>}
                {s.summary && <span className="result">{s.summary}</span>}
              </summary>
              {s.details !== undefined && <pre>{JSON.stringify(s.details, null, 2)}</pre>}
            </details>
          </li>
        ))}
      </ol>
    </>
  );
}
