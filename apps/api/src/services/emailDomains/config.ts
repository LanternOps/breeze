import { isHosted } from '../../config/env';

/**
 * Parsed EMAIL_DOMAINS_* configuration (spec §11).
 *
 * Read at CALL TIME, never at module scope — the `config/partnerTrustMode.ts`
 * pattern. Tests flip a variable per case without `vi.resetModules()`, and a
 * worker restart is enough to pick up an operator's change.
 *
 * This module never throws. `config/validate.ts` already refused an
 * unrecognised provider, `fake` in production, `static` on hosted and identical
 * Resend keys on hosted at boot; anything that reaches here is either valid or
 * a value a non-validating entrypoint supplied, and "off" is the safe reading.
 */

export type EmailDomainsProviderId = 'resend' | 'static' | 'fake';

export interface StaticAllowedEntry {
  domain: string;
  /** null = any partner on the instance may claim it (the single-partner case). */
  partnerSlug: string | null;
}

export interface EmailDomainsConfig {
  provider: EmailDomainsProviderId | null;
  resendApiKey: string | null;
  resendSendingKey: string | null;
  region: string;
  maxPerPartner: number;
  /** 0 = unlimited. */
  dailySendCap: number;
  partnerAllowlist: string[];
  denylist: string[];
  staticAllowed: StaticAllowedEntry[];
  webhookSecret: string | null;
}

export const DEFAULT_EMAIL_DOMAINS_REGION = 'us-east-1';
export const DEFAULT_EMAIL_DOMAINS_MAX_PER_PARTNER = 3;
export const DEFAULT_HOSTED_DAILY_SEND_CAP = 2000;

function str(name: string): string | null {
  const value = (process.env[name] ?? '').trim();
  return value.length > 0 ? value : null;
}

function csv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function nonNegativeInt(name: string, fallback: number): number {
  const raw = str(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(`[emailDomains] Ignoring non-integer ${name}=${JSON.stringify(raw)}; using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

/** `domain` or `domain:partner-slug`, comma-separated. */
export function parseStaticAllowed(raw: string | undefined): StaticAllowedEntry[] {
  const entries: StaticAllowedEntry[] = [];
  for (const item of (raw ?? '').split(',')) {
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(':');
    const domain = (colon >= 0 ? trimmed.slice(0, colon) : trimmed).trim().toLowerCase().replace(/\.+$/, '');
    const slug = colon >= 0 ? trimmed.slice(colon + 1).trim().toLowerCase() : '';
    if (domain.length === 0) continue;
    // `acme.com:` is an operator typo, not "bound to nobody" — drop it rather
    // than silently widening the entry to every partner on the instance.
    if (colon >= 0 && slug.length === 0) continue;
    entries.push({ domain, partnerSlug: colon >= 0 ? slug : null });
  }
  return entries;
}

export function getEmailDomainsConfig(): EmailDomainsConfig {
  const rawProvider = (process.env.EMAIL_DOMAINS_PROVIDER ?? '').trim().toLowerCase();
  const provider: EmailDomainsProviderId | null =
    rawProvider === 'resend' || rawProvider === 'static' || rawProvider === 'fake' ? rawProvider : null;

  const resendApiKey = str('EMAIL_DOMAINS_RESEND_API_KEY');

  return {
    provider,
    resendApiKey,
    // An optional sending_access key keeps the management key off the send
    // path; without one the send path reuses the full_access key (spec §11).
    resendSendingKey: str('EMAIL_DOMAINS_RESEND_SENDING_KEY') ?? resendApiKey,
    region: str('EMAIL_DOMAINS_REGION') ?? DEFAULT_EMAIL_DOMAINS_REGION,
    maxPerPartner: nonNegativeInt('EMAIL_DOMAINS_MAX_PER_PARTNER', DEFAULT_EMAIL_DOMAINS_MAX_PER_PARTNER),
    // Unlimited self-hosted: a self-hoster's volume is their own business, and a
    // default that silently moved their ticket mail back to EMAIL_FROM at
    // message 2,001 would be a bug report, not a protection (spec §9.1).
    dailySendCap: nonNegativeInt('EMAIL_DOMAINS_DAILY_SEND_CAP', isHosted() ? DEFAULT_HOSTED_DAILY_SEND_CAP : 0),
    partnerAllowlist: csv('EMAIL_DOMAINS_PARTNER_ALLOWLIST'),
    denylist: csv('EMAIL_DOMAINS_DENYLIST').map((d) => d.toLowerCase().replace(/\.+$/, '')),
    staticAllowed: parseStaticAllowed(process.env.EMAIL_DOMAINS_STATIC_ALLOWED),
    webhookSecret: str('EMAIL_DOMAINS_WEBHOOK_SECRET')
  };
}

export function isPartnerLaneConfigured(): boolean {
  return getEmailDomainsConfig().provider !== null;
}

/**
 * Exact-domain lookup with the partner binding applied. An unbound entry
 * matches any partner; a bound entry matches only its slug. Subdomains do NOT
 * match — the operator lists precisely what the relay may send as.
 */
export function findStaticAllowedEntry(domain: string, partnerSlug: string | null): StaticAllowedEntry | null {
  const target = domain.trim().toLowerCase().replace(/\.+$/, '');
  for (const entry of getEmailDomainsConfig().staticAllowed) {
    if (entry.domain !== target) continue;
    if (entry.partnerSlug === null) return entry;
    if (partnerSlug !== null && entry.partnerSlug === partnerSlug.trim().toLowerCase()) return entry;
  }
  return null;
}
