import type { Brief } from "../api.ts";

export function AgentLog({ steps }: { steps: Brief["trace"] }) {
  return (
    <ol className="log">
      {steps.map((s) => (
        <li key={s.index}>
          <details>
            <summary>
              <span className={`status status-${s.status}`}>{s.status}</span> <code>{s.tool}</code>
              <span className="meta"> · {s.actor} · {s.durationMs} ms</span>
              {s.purpose && <span className="purpose"> — {s.purpose}</span>}
            </summary>
            <p className="meta">{s.summary}</p>
            <pre>{JSON.stringify({ args: s.args, endpoint: s.endpoint, requests: s.requests }, null, 2)}</pre>
          </details>
        </li>
      ))}
    </ol>
  );
}
