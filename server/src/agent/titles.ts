// Display helpers shared by the page and the Markdown export (no Node or browser APIs).

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * "Mohawk, Austin", but "Mohawk Austin" when Qloo's own name already carries
 * the city: live, the ambiguous "Mohawk" resolved as "Mohawk Austin" and the
 * title read "Mohawk Austin, Austin" (demo 2026-10-14).
 */
export function withCity(name: string, city: string): string {
  const c = city.trim();
  if (!c) return name;
  const inName = new RegExp(`(?<![\\p{L}\\p{N}])${escape(c)}(?![\\p{L}\\p{N}])`, "iu").test(name);
  return inName ? name : `${name}, ${c}`;
}
