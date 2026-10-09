import type { Brief } from "../api.ts";

const TREND_LABEL = { rising: "↑ rising", falling: "↓ falling", flat: "→ flat", unknown: "n/a" } as const;

export function Openers({ openers }: { openers: Brief["openers"] }) {
  if (openers.length === 0) return <p className="meta">No candidates returned. Check the agent log.</p>;
  return (
    <table className="openers">
      <thead>
        <tr>
          <th>#</th>
          <th>Act</th>
          <th>Audience overlap</th>
          <th>90-day trend</th>
        </tr>
      </thead>
      <tbody>
        {openers.map((o, i) => (
          <tr key={o.name}>
            <td>{i + 1}</td>
            <td>{o.name}</td>
            <td>
              <div className="bar" aria-label={`overlap score ${o.overlapScore} of 100`}>
                <span style={{ width: `${o.overlapScore}%` }} />
              </div>
              <span className="score">{o.overlapScore}</span>
            </td>
            <td className={`trend trend-${o.trend}`}>{TREND_LABEL[o.trend]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
