import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { getBrief, getHealth, markdownUrl, popularityLabel, streamBrief, type Health, type StoredBrief } from "./api.ts";
import { AgentLog, applyEvent, timelineFromBrief, type TimelineItem } from "./components/AgentLog.tsx";
import { Demographics } from "./components/Demographics.tsx";
import { FanMap } from "./components/FanMap.tsx";
import { Openers } from "./components/Openers.tsx";

type Scenario = "opener" | "venue";

const PERMALINK = /^\/b\/([A-Za-z0-9_-]{12})\/?$/;

function briefTitle(b: StoredBrief): string {
  return b.input.scenario === "venue"
    ? `${b.subject.name}, ${b.input.city}${b.input.date ? ` · ${b.input.date}` : ""}: whom to book`
    : `Openers for ${b.subject.name} in ${b.input.city}`;
}

/** Header badge: what actually ran for the brief on screen, not only what is configured. */
export function agentLabel(llmConfigured: boolean, ran?: "llm" | "planner" | "hybrid"): string {
  if (!llmConfigured) return "scripted agent";
  if (ran === "planner") return "scripted planner (LLM unavailable this run)";
  if (ran === "hybrid") return "LLM agent + scripted planner";
  return "LLM agent";
}

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [scenario, setScenario] = useState<Scenario>("opener");
  const [brief, setBrief] = useState<StoredBrief | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    void getHealth().then(setHealth);
    const open = () => {
      const id = PERMALINK.exec(window.location.pathname)?.[1];
      if (!id) return;
      getBrief(id)
        .then((b) => {
          setBrief(b);
          setScenario(b.input.scenario);
          setTimeline(timelineFromBrief(b));
          setError(null);
        })
        .catch((err: Error) => setError(`${err.message}. Shared briefs live in server memory and expire; build it again below.`));
    };
    open();
    window.addEventListener("popstate", open);
    return () => window.removeEventListener("popstate", open);
  }, []);

  useEffect(() => {
    document.title = brief ? `${briefTitle(brief)} · Opener` : "Opener";
  }, [brief]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const field = (k: string) => String(f.get(k) ?? "").trim() || undefined;
    const input = scenario === "venue"
      ? { scenario, venue: field("venue"), city: field("city"), date: field("date"), capacity: field("capacity") }
      : { scenario, headliner: field("headliner"), city: field("city"), dateFrom: field("dateFrom"), dateTo: field("dateTo"), capacity: field("capacity") };
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setLoading(true);
    setError(null);
    setBrief(null);
    setTimeline([]);
    setCopied(false);
    try {
      const b = await streamBrief(input, (ev) => {
        if (!controller.signal.aborted) setTimeline((items) => applyEvent(items, ev));
      }, controller.signal);
      if (controller.signal.aborted) return;
      setBrief(b);
      window.history.pushState(null, "", `/b/${b.id}`);
    } catch (err) {
      if (!controller.signal.aborted) setError((err as Error).message);
    } finally {
      if (abort.current === controller) setLoading(false);
    }
  }

  async function copyLink() {
    if (!brief) return;
    const url = `${window.location.origin}/b/${brief.id}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      window.prompt("Copy this link", url);
    }
  }

  const venue = scenario === "venue";

  // Arrow keys move between the two tabs (WAI-ARIA tabs pattern).
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next: Scenario = e.key === "Home" ? "opener" : e.key === "End" ? "venue" : venue ? "opener" : "venue";
    setScenario(next);
    document.getElementById(`tab-${next}`)?.focus();
  }

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <h1>Opener</h1>
          <p className="lede">Booking decisions from Qloo's taste graph, with the evidence behind every pick.</p>
        </div>
        {health && (
          <span className={`badge ${health.qloo === "mock" ? "badge-warn" : "badge-ok"}`}>
            {health.qloo === "mock" ? "Demo data (no Qloo key)" : "Live Qloo"} · {agentLabel(health.llm, brief?.agent)}
          </span>
        )}
      </header>

      <div className="tabs no-print" role="tablist" aria-label="Booking question">
        <button type="button" role="tab" id="tab-opener" aria-controls="brief-form" aria-selected={!venue} tabIndex={venue ? -1 : 0}
          className={!venue ? "tab active" : "tab"} onClick={() => setScenario("opener")} onKeyDown={onTabKey}>
          Find an opener for a headliner
        </button>
        <button type="button" role="tab" id="tab-venue" aria-controls="brief-form" aria-selected={venue} tabIndex={venue ? 0 : -1}
          className={venue ? "tab active" : "tab"} onClick={() => setScenario("venue")} onKeyDown={onTabKey}>
          Fill a free date at a venue
        </button>
      </div>

      <form key={scenario} id="brief-form" role="tabpanel" aria-labelledby={venue ? "tab-venue" : "tab-opener"}
        className={`card form no-print ${venue ? "form-venue" : ""}`} onSubmit={onSubmit}>
        {venue ? (
          <>
            <label>
              Venue
              <input name="venue" required maxLength={80} placeholder="e.g. a club or hall you book" />
            </label>
            <label>
              City
              <input name="city" required maxLength={80} placeholder="e.g. Berlin" />
            </label>
            <label>
              Free date
              <input name="date" type="date" />
            </label>
          </>
        ) : (
          <>
            <label>
              Headliner
              <input name="headliner" required maxLength={80} placeholder="e.g. an artist you are booking" />
            </label>
            <label>
              City
              <input name="city" required maxLength={80} placeholder="e.g. Berlin" />
            </label>
            <label>
              From
              <input name="dateFrom" type="date" />
            </label>
            <label>
              To
              <input name="dateTo" type="date" />
            </label>
          </>
        )}
        <label>
          Capacity
          <input name="capacity" type="number" min={1} max={200000} placeholder="optional" />
        </label>
        <button type="submit" disabled={loading}>{loading ? "Agent working…" : "Build brief"}</button>
      </form>

      {error && <p className="card error" role="alert">{error}</p>}

      {(loading || timeline.length > 0) && !brief && (
        <section className="card live" aria-busy={loading}>
          <h2>Agent at work</h2>
          <p className="meta">Each Qloo and LLM call appears here as it happens.</p>
          <AgentLog items={timeline} live />
        </section>
      )}

      {brief && (
        <div className="grid">
          <section className="card span-2">
            <div className="brief-head">
              <h2>{briefTitle(brief)}</h2>
              <div className="actions no-print">
                <button type="button" className="ghost" onClick={copyLink}>{copied ? "Link copied" : "Copy link"}</button>
                <a className="ghost button" href={markdownUrl(brief.id)} download>Markdown</a>
                <button type="button" className="ghost" onClick={() => window.print()}>Print / PDF</button>
              </div>
            </div>
            <p className="narrative">{brief.narrative}</p>
            <p className="meta">
              {brief.input.scenario === "opener" && <>Headliner trend (90 days): <strong>{brief.subject.trend}</strong> · </>}
              {brief.input.scenario === "opener" && typeof brief.subject.popularity === "number" && <>headliner Qloo popularity: {popularityLabel(brief.subject.popularity)} · </>}
              {brief.input.capacity ? <>capacity {brief.input.capacity} · </> : null}
              agent: {brief.agent} · data: {brief.mode} · {brief.generatedAt.slice(0, 16).replace("T", " ")} UTC
              {brief.cached ? " · from cache" : ""}
            </p>
            <p className="meta print-only">Shared link: {window.location.origin}/b/{brief.id} (expires; stored in server memory only)</p>
          </section>

          <section className="card span-2">
            <h2>{brief.input.scenario === "venue" ? "Acts to book" : "Top opener candidates"}</h2>
            <Openers candidates={brief.candidates} rankedCount={brief.rankedCount} scoreSource={brief.scoreSource} />
          </section>

          <section className="card">
            <h2>Where the fans are</h2>
            <FanMap points={brief.heatmap} />
            <p className="meta">
              {brief.heatmapOf ? `Fans of ${brief.heatmapOf}: ` : ""}relative affinity inside {brief.input.city}; not head counts.
            </p>
          </section>

          <section className="card">
            <h2>{brief.input.scenario === "venue" ? "The venue's crowd" : "Audience skew"}</h2>
            <Demographics data={brief.demographics} />
            {brief.demographicsOf && (
              <p className="meta">Qloo has no demographics for the venue itself; this is the skew of fans of {brief.demographicsOf}, the act its crowd likes most.</p>
            )}
            {brief.tasteTags.length > 0 && (
              <p className="tags">{brief.tasteTags.map((t) => <span key={t} className="tag">{t}</span>)}</p>
            )}
          </section>

          <section className="card">
            <h2>{brief.input.scenario === "venue" ? "Cross-promotion and sponsors" : "Local partners"}</h2>
            {brief.partners.length === 0 ? (
              <p className="meta">No partner leads returned.</p>
            ) : (
              <ul className="partners">
                {brief.partners.map((p) => (
                  <li key={`${p.kind}:${p.name}`}>
                    <span className="tag">{p.kind}</span> {p.name}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card caveats">
            <h2>What this does not prove</h2>
            <ul>{brief.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
          </section>

          <section className="card span-2">
            <h2>Agent log</h2>
            <AgentLog items={timeline.length > 0 ? timeline : timelineFromBrief(brief)} />
          </section>
        </div>
      )}

      <footer className="footer">
        Built for the Qloo Agentic Hackathon with Qloo's Insights API via <code>@qloo/qloo-harness</code>. Built with AI coding agents. Results describe
        aggregate taste affinities, never individuals.
      </footer>
    </main>
  );
}
