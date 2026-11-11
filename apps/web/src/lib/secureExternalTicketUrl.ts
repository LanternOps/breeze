/** The URL only if it is https; anything else renders as a plain label, not a link. */
export function secureExternalTicketUrl(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try { return new URL(value).protocol === 'https:' ? value : undefined; } catch { return undefined; }
}
