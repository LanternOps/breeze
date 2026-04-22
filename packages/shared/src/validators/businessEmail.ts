// No type definitions shipped; the package's `main` is a JSON array of domain strings.
import disposableDomainsList from 'disposable-email-domains';

/**
 * Validator that rejects free-email and disposable-email addresses for
 * flows where a real business email is required (e.g. MCP tenant creation).
 *
 * Not gated on any feature flag — callers opt in by importing it.
 */

export type BusinessEmailReason =
  | 'invalid_format'
  | 'free_provider'
  | 'disposable'
  | 'blocked_override';

export type BusinessEmailResult =
  | { ok: true }
  | { ok: false; reason: BusinessEmailReason };

export interface ValidateBusinessEmailOptions {
  /** Domains to always allow, even if on the free-provider or disposable list. */
  alwaysAllow?: readonly string[];
  /** Domains to always block, even if otherwise acceptable. */
  alwaysBlock?: readonly string[];
}

/**
 * Curated free-email / consumer-email providers. Intentionally small and
 * conservative — we'd rather let an edge case through than reject a real
 * business. This is not the same as the disposable list.
 */
export const FREE_PROVIDERS: ReadonlySet<string> = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.jp',
  'ymail.com',
  'rocketmail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'tutanota.com',
  'tutanota.de',
  'tuta.io',
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'yandex.ru',
  'yandex.com',
  'mail.ru',
  'fastmail.com',
  'fastmail.fm',
  'zoho.com',
  'hushmail.com',
  'qq.com',
  '163.com',
  '126.com',
  'sina.com',
  'sina.cn',
  'naver.com',
  'daum.net',
  'hanmail.net',
]);

/** Set of disposable-email domains sourced from the `disposable-email-domains` package. */
export const DISPOSABLE: ReadonlySet<string> = new Set(
  (disposableDomainsList as string[]).map((d) => d.toLowerCase())
);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function extractDomain(email: string): string | null {
  if (!EMAIL_RE.test(email)) return null;
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).toLowerCase().trim();
  if (!domain) return null;
  return domain;
}

/**
 * Validate that an email address belongs to a business (non-free, non-disposable) domain.
 *
 * Returns `{ ok: true }` or `{ ok: false, reason }`.
 */
export function validateBusinessEmail(
  email: string,
  opts: ValidateBusinessEmailOptions = {}
): BusinessEmailResult {
  if (typeof email !== 'string' || email.length === 0) {
    return { ok: false, reason: 'invalid_format' };
  }
  const domain = extractDomain(email.trim());
  if (!domain) {
    return { ok: false, reason: 'invalid_format' };
  }

  const allow = new Set((opts.alwaysAllow ?? []).map((d) => d.toLowerCase()));
  const block = new Set((opts.alwaysBlock ?? []).map((d) => d.toLowerCase()));

  if (block.has(domain)) {
    return { ok: false, reason: 'blocked_override' };
  }
  if (allow.has(domain)) {
    return { ok: true };
  }

  if (FREE_PROVIDERS.has(domain)) {
    return { ok: false, reason: 'free_provider' };
  }
  if (DISPOSABLE.has(domain)) {
    return { ok: false, reason: 'disposable' };
  }
  return { ok: true };
}

/**
 * Load always-allow and always-block lists from environment variables.
 *
 * `BUSINESS_EMAIL_ALLOW` and `BUSINESS_EMAIL_BLOCK` are comma-separated domain lists.
 */
export function loadOverridesFromEnv(
  env?: Record<string, string | undefined>
): { alwaysAllow: string[]; alwaysBlock: string[] } {
  const source =
    env ??
    ((typeof globalThis !== 'undefined' &&
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env) ||
      {});
  const parse = (v: string | undefined): string[] =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  return {
    alwaysAllow: parse(source.BUSINESS_EMAIL_ALLOW),
    alwaysBlock: parse(source.BUSINESS_EMAIL_BLOCK),
  };
}
