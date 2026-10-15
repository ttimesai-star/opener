import { popularityLabel, type Brief } from "../api.ts";

const TREND_LABEL = { rising: "↑ rising", falling: "↓ falling", flat: "→ flat", unknown: "n/a" } as const;

export function Openers({ candidates, rankedCount, scoreSource }: { candidates: Brief["candidates"]; rankedCount?: number; scoreSource?: Brief["scoreSource"] }) {
  if (candidates.length === 0) return <p className="meta">No candidates returned. Check the agent log.</p>;
  // Briefs stored before scoreSource existed were scored by the rank call.
  const recommended = scoreSource === "recommend";
  const base = rankedCount && rankedCount > 1
    ? `of the ${rankedCount} acts Qloo ${recommended ? "recommended" : "ranked"}`
    : recommended ? "in this Qloo recommendation call" : "in this Qloo rank call";
  return (
    <>
    <div className="table-wrap">
    <table className="openers">
      <thead>
        <tr>
          <th>#</th>
          <th>Act</th>
          <th title={`100 = strongest audience fit ${base}, 0 = weakest. Relative, not a forecast.`}>Audience fit</th>
          <th title="Qloo popularity percentile as the share of entities at least as popular: smaller = more popular">Qloo popularity</th>
          <th>90-day trend</th>
        </tr>
      </thead>
      <tbody>
        {candidates.map((o, i) => (
          <tr key={`${o.entityId ?? o.name}-${i}`}>
            <td>{i + 1}</td>
            <td>{o.name}</td>
            <td>
              <div className="bar" aria-label={`fit score ${o.overlapScore} of 100`} title={o.affinity === null ? undefined : `Qloo affinity ${o.affinity.toFixed(4)}`}>
                <span style={{ width: `${o.overlapScore}%` }} />
              </div>
              <span className="score">{o.overlapScore}</span>
            </td>
            <td className="score">{popularityLabel(o.popularity)}</td>
            <td className={`trend trend-${o.trend}`}>{TREND_LABEL[o.trend]}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
    <p className="meta">Audience fit: 100 = strongest {base}, 0 = weakest. Relative within this brief, not a sales forecast.{recommended ? " The rank call failed, so scores come from the artist recommendation." : ""}</p>
    </>
  );
}
