/**
 * The exact, lower-cased domain of an address: the text after the LAST `@`
 * (W6 D5; W5 matches exactly, never a parent domain). Null when there is no
 * `@` or nothing follows it.
 */
export function emailDomainOf(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at < 0) return null;
  const domain = normalized.slice(at + 1);
  return domain.length > 0 ? domain : null;
}
