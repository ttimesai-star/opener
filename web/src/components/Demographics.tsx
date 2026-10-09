import type { Brief } from "../api.ts";

const pretty = (k: string) => k.replace(/_/g, " ");

function Bars({ title, data }: { title: string; data: Record<string, number> }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  const max = Math.max(...entries.map(([, v]) => Math.abs(v)), 0.001);
  return (
    <div className="demo">
      <h3>{title}</h3>
      {entries.map(([k, v]) => (
        <div key={k} className="demo-row">
          <span className="demo-label">{pretty(k)}</span>
          <div className="diverging" aria-label={`${pretty(k)} ${v > 0 ? "over" : "under"}-indexed`}>
            <span className={v >= 0 ? "pos" : "neg"} style={{ width: `${(Math.abs(v) / max) * 50}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Demographics({ data }: { data: Brief["demographics"] }) {
  if (!data) return <p className="meta">No demographic data returned.</p>;
  return (
    <>
      <Bars title="Age (over / under-indexed)" data={data.age} />
      <Bars title="Gender" data={data.gender} />
    </>
  );
}
