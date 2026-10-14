// Keeps API keys out of anything the user can see: trace summaries, LLM call
// summaries, caveats. Provider and harness error text can echo request
// details, so every secret-looking env value is masked before it leaves the
// server.

const SECRET_ENV = /(^|_)(API_KEY|KEY|TOKEN|SECRET|PASSWORD)$/;
const MIN_SECRET_LENGTH = 6; // shorter values would mask ordinary words

/** Replaces the values of secret-looking env vars (QLOO_API_KEY, LLM_API_KEY, LLM_FALLBACK_API_KEY, ...) with a label. */
export function sanitizeSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!text) return text;
  // Longest first, so a key that contains another key is masked whole.
  const secrets = Object.entries(env)
    .filter(([name, value]) => SECRET_ENV.test(name) && typeof value === "string" && value.trim().length >= MIN_SECRET_LENGTH)
    .map(([name, value]) => [name, (value as string).trim()] as const)
    .sort((a, b) => b[1].length - a[1].length);
  let cleaned = text;
  for (const [name, value] of secrets) cleaned = cleaned.replaceAll(value, `[REDACTED_${name}]`);
  return cleaned;
}
