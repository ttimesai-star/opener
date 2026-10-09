import L from "leaflet";
import { useEffect, useRef } from "react";
import type { Brief } from "../api.ts";

export function FanMap({ points }: { points: Brief["heatmap"] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current || points.length === 0) return;
    const map = L.map(ref.current, { scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "© OpenStreetMap contributors",
    }).addTo(map);
    const layer = L.featureGroup(
      points.map((p) =>
        L.circleMarker([p.lat, p.lng], {
          radius: 6 + p.weight * 14,
          weight: 1,
          color: "#b4461b",
          fillColor: "#e8743b",
          fillOpacity: 0.25 + p.weight * 0.5,
        }).bindTooltip(`relative affinity ${Math.round(p.weight * 100)}`),
      ),
    ).addTo(map);
    map.fitBounds(layer.getBounds().pad(0.2));
    return () => {
      map.remove();
    };
  }, [points]);

  if (points.length === 0) return <p className="meta">No geographic data returned.</p>;
  return <div ref={ref} className="map" role="img" aria-label="Map of relative fan affinity" />;
}
