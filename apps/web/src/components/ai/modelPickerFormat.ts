/** Compact context size: 1_000_000 → '1M', 200_000 → '200K'. */
export function formatContextTokens(tokens: number | null): string | null {
  if (tokens === null || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}K`;
}

/** Cents per million tokens → '$3', '$0.75', '$12.50'. */
export function formatCentsPerM(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}
