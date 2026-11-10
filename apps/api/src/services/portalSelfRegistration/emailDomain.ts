/**
 * Characters that never belong in the single plain mailbox self-registration
 * accepts: whitespace and controls, quoting, address-list and display-name
 * syntax, comments, and route syntax. An address carrying any of them could
 * be parsed differently by a mail transport (two recipients, a display name)
 * than by this domain split, so it is refused outright (parser differential).
 */
const NOT_A_PLAIN_MAILBOX = /[\s\p{Cc}"'(),:;<>[\]\\]/u;

/**
 * The exact, lower-cased domain of a single plain mailbox `local@domain`
 * (W6 D5; W5 matches exactly, never a parent domain). Null for anything that
 * is not exactly one non-empty local part, one `@` and one non-empty domain,
 * or that carries list, quoting or display-name syntax.
 */
export function emailDomainOf(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (NOT_A_PLAIN_MAILBOX.test(normalized)) return null;
  const at = normalized.indexOf('@');
  if (at <= 0 || at !== normalized.lastIndexOf('@')) return null;
  const domain = normalized.slice(at + 1);
  return domain.length > 0 ? domain : null;
}
