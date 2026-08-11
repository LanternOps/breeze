// Consumer / free / disposable mailbox providers, used to require a business
// email address at hosted partner signup.
//
// WHY AN EXACT-MATCH SET AND NOT A PATTERN: the boundary between "consumer" and
// "business" mail is genuinely fuzzy — a rural ISP mailbox and a franchise
// corporate domain look alike, and privacy providers (Tuta, Proton) are used by
// legitimate MSPs. A regex over provider names would over-match (e.g. any domain
// containing "mail"). Exact matching keeps every rejection explainable: the
// domain is on this list, or it is not.
//
// WHY THE LIST WILL NEVER BE COMPLETE: providers rebrand and add ccTLD variants
// faster than a hard-coded list tracks them — Tutanota's move to `tutamail.com`
// / `tuta.com` is the canonical example, and a list that had only `tutanota.com`
// would silently miss it. That is an accepted limitation: this control raises
// the cost of casual throwaway signups, it is not a security boundary. Anyone
// determined can register a domain for a couple of dollars. Do NOT add
// compensating cleverness here — add the domain, or extend via env.
//
// Every rejection is recoverable: the caller returns a scheduling link so a real
// business on a consumer mailbox can still get an account.
const CONSUMER_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  // Google
  'gmail.com', 'googlemail.com',
  // Microsoft
  'outlook.com', 'outlook.co.uk', 'outlook.fr', 'outlook.de', 'outlook.es', 'outlook.it',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.es', 'hotmail.it',
  'live.com', 'live.co.uk', 'live.nl', 'live.fr', 'live.de', 'msn.com',
  // Yahoo
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'yahoo.fr', 'yahoo.de', 'yahoo.es',
  'yahoo.it', 'yahoo.ca', 'yahoo.com.br', 'yahoo.com.mx', 'yahoo.com.au',
  'ymail.com', 'rocketmail.com',
  // Apple
  'icloud.com', 'me.com', 'mac.com',
  // AOL
  'aol.com', 'aim.com',
  // Privacy-focused. Legitimate MSPs do use these, which is exactly why the
  // scheduling escape hatch exists rather than a flat refusal.
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  'tutanota.com', 'tutanota.de', 'tutamail.com', 'tuta.com', 'tuta.io',
  'mailfence.com', 'hushmail.com', 'countermail.com',
  // GMX / German consumer
  'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'web.de', 'freenet.de',
  // Russian consumer portals
  'mail.ru', 'inbox.ru', 'bk.ru', 'list.ru', 'yandex.ru', 'yandex.com', 'ya.ru', 'rambler.ru',
  // Disposable / throwaway
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'sharklasers.com',
  'trashmail.com', 'maildrop.cc', 'getnada.com', 'dispostable.com',
  'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com',
]);

function parseDomainList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((d) => normalizeDomain(d))
    .filter((d) => d.length > 0);
}

// Lowercase, trim, drop a trailing root dot. Not a validator — the caller has
// already run Zod's `.email()`; this only canonicalizes for set lookup.
function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/\.+$/, '');
}

/** Domain part of an address, or '' when there is no usable one. */
export function emailDomainOf(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return '';
  return normalizeDomain(email.slice(at + 1));
}

// Env hooks are read at call time so both can be changed without a redeploy and
// so tests can flip them per-case without `vi.resetModules()`.
//
// SIGNUP_EXTRA_CONSUMER_EMAIL_DOMAINS — additive; the list above will go stale.
// SIGNUP_ALLOWED_EMAIL_DOMAINS — an explicit escape valve that WINS over both,
// for when a real customer is stuck behind a listed provider and waiting on a
// call is not acceptable.
export function isConsumerEmailDomain(email: string): boolean {
  const domain = emailDomainOf(email);
  if (!domain) return false;

  if (parseDomainList(process.env.SIGNUP_ALLOWED_EMAIL_DOMAINS).includes(domain)) return false;

  return (
    CONSUMER_EMAIL_DOMAINS.has(domain) ||
    parseDomainList(process.env.SIGNUP_EXTRA_CONSUMER_EMAIL_DOMAINS).includes(domain)
  );
}

/**
 * Where a rejected signup is sent to talk to a human. Configurable so the
 * scheduling link can change without a deploy.
 */
export function businessEmailContactUrl(): string {
  return process.env.SIGNUP_BUSINESS_EMAIL_CONTACT_URL?.trim() || 'https://breezermm.com/contact';
}

/**
 * Whether hosted signup requires a business email.
 *
 * Hosted-only by construction: a self-hosted operator registering their own
 * partner with a personal address is entirely legitimate and must never be
 * blocked. Callers pass `hosted` rather than reading `isHosted()` here so this
 * module stays pure and trivially testable.
 *
 * Defaults ON when hosted, and is disabled ONLY by an explicit `false`. That
 * direction is deliberate: this is a product restriction, not a security
 * boundary, so an instant kill switch is worth more than fail-closed strictness
 * if the list ever misfires against a real customer mid-signup.
 */
export function businessEmailRequired(hosted: boolean): boolean {
  if (!hosted) return false;
  const raw = (process.env.SIGNUP_REQUIRE_BUSINESS_EMAIL ?? '').trim().toLowerCase();
  return !new Set(['0', 'false', 'no', 'off']).has(raw);
}
