import type { Brief } from "../api.ts";

const TREND_LABEL = { rising: "↑ rising", falling: "↓ falling", flat: "→ flat", unknown: "n/a" } as const;

export function Openers({ candidates }: { candidates: Brief["candidates"] }) {
  if (candidates.length === 0) return <p className="meta">No candidates returned. Check the agent log.</p>;
  return (
    <table className="openers">
      <thead>
        <tr>
          <th>#</th>
          <th>Act</th>
          <th>Audience overlap</th>
          <th title="Qloo popularity percentile">Popularity</th>
          <th>90-day trend</th>
        </tr>
      </thead>
      <tbody>
        {candidates.map((o, i) => (
          <tr key={o.name}>
            <td>{i + 1}</td>
            <td>{o.name}</td>
            <td>
              <div className="bar" aria-label={`overlap score ${o.overlapScore} of 100`}>
                <span style={{ width: `${o.overlapScore}%` }} />
              </div>
              <span className="score">{o.overlapScore}</span>
            </td>
            <td className="score">{o.popularity === null ? "n/a" : Math.round(o.popularity * 100)}</td>
            <td className={`trend trend-${o.trend}`}>{TREND_LABEL[o.trend]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
