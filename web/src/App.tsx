import { useEffect, useState, type FormEvent } from "react";
import { getHealth, requestBrief, type Brief, type Health } from "./api.ts";
import { AgentLog } from "./components/AgentLog.tsx";
import { Demographics } from "./components/Demographics.tsx";
import { FanMap } from "./components/FanMap.tsx";
import { Openers } from "./components/Openers.tsx";

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void getHealth().then(setHealth);
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const capacity = String(f.get("capacity") ?? "").trim();
    setLoading(true);
    setError(null);
    try {
      setBrief(
        await requestBrief({
          headliner: String(f.get("headliner") ?? ""),
          city: String(f.get("city") ?? ""),
          dateFrom: String(f.get("dateFrom") ?? "") || undefined,
          dateTo: String(f.get("dateTo") ?? "") || undefined,
          capacity: capacity ? Number(capacity) : undefined,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <h1>Opener</h1>
          <p className="lede">Who should open for your headliner in this city, and the Qloo evidence behind every pick.</p>
        </div>
        {health && (
          <span className={`badge ${health.qloo === "mock" ? "badge-warn" : "badge-ok"}`}>
            {health.qloo === "mock" ? "Demo data (no Qloo key)" : "Live Qloo"} · {health.llm ? "LLM agent" : "scripted agent"}
          </span>
        )}
      </header>

      <form className="card form" onSubmit={onSubmit}>
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
        <label>
          Capacity
          <input name="capacity" type="number" min={1} max={200000} placeholder="optional" />
        </label>
        <button type="submit" disabled={loading}>{loading ? "Agent working…" : "Build brief"}</button>
      </form>

      {error && <p className="card error" role="alert">{error}</p>}

      {brief && (
        <div className="grid">
          <section className="card span-2">
            <h2>Brief: {brief.headliner.name} in {brief.input.city}</h2>
            <p className="narrative">{brief.narrative}</p>
            <p className="meta">
              Headliner trend (90 days): <strong>{brief.headliner.trend}</strong> · agent: {brief.agent} · data: {brief.mode}
            </p>
          </section>

          <section className="card span-2">
            <h2>Top opener candidates</h2>
            <Openers openers={brief.openers} />
          </section>

          <section className="card">
            <h2>Where the fans are</h2>
            <FanMap points={brief.heatmap} />
            <p className="meta">Relative affinity inside {brief.input.city}; not head counts.</p>
          </section>

          <section className="card">
            <h2>Audience skew</h2>
            <Demographics data={brief.demographics} />
            {brief.tasteTags.length > 0 && (
              <p className="tags">{brief.tasteTags.map((t) => <span key={t} className="tag">{t}</span>)}</p>
            )}
          </section>

          <section className="card">
            <h2>Local partners</h2>
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
            <AgentLog steps={brief.trace} />
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
