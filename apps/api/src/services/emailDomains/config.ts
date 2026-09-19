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
  autoSuspend: EmailDomainsAutoSuspendConfig;
}

export interface EmailDomainsAutoSuspendConfig {
  /**
   * Hosted: on by default (spec §9.3). Self-hosted: off until the operator sets
   * at least one threshold. A self-hoster's bounce rate is their own business,
   * and an upgrade that started suspending their only sending domain would be a
   * bug report, not a protection — the same argument as the send cap's
   * unlimited self-hosted default.
   */
  enabled: boolean;
  /** Fraction in (0, 1]. */
  bounceRate: number;
  /** Minimum messages in the window before the rate means anything. */
  minMessages: number;
  /** Complaints in the window that suspend regardless of rate. */
  complaints: number;
}

export const DEFAULT_EMAIL_DOMAINS_REGION = 'us-east-1';
export const DEFAULT_EMAIL_DOMAINS_MAX_PER_PARTNER = 3;
export const DEFAULT_HOSTED_DAILY_SEND_CAP = 2000;

export const DEFAULT_AUTOSUSPEND_BOUNCE_RATE = 0.08;
export const DEFAULT_AUTOSUSPEND_MIN_MESSAGES = 50;
export const DEFAULT_AUTOSUSPEND_COMPLAINTS = 3;

const AUTOSUSPEND_KEYS = [
  'EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE',
  'EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES',
  'EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS',
] as const;

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

/** A fraction in (0, 1]; anything else warns and falls back. */
function ratio(name: string, fallback: number): number {
  const raw = str(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    console.warn(`[emailDomains] Ignoring ${name}=${JSON.stringify(raw)} (want a fraction in (0,1]); using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

/** An integer >= 1; 0 would make one bounce enough to suspend. */
function positiveInt(name: string, fallback: number): number {
  const raw = str(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    console.warn(`[emailDomains] Ignoring ${name}=${JSON.stringify(raw)} (want an integer >= 1); using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

function readAutoSuspendConfig(): EmailDomainsAutoSuspendConfig {
  const configured = AUTOSUSPEND_KEYS.some((key) => str(key) !== null);
  return {
    enabled: isHosted() || configured,
    bounceRate: ratio('EMAIL_DOMAINS_AUTOSUSPEND_BOUNCE_RATE', DEFAULT_AUTOSUSPEND_BOUNCE_RATE),
    minMessages: positiveInt('EMAIL_DOMAINS_AUTOSUSPEND_MIN_MESSAGES', DEFAULT_AUTOSUSPEND_MIN_MESSAGES),
    complaints: positiveInt('EMAIL_DOMAINS_AUTOSUSPEND_COMPLAINTS', DEFAULT_AUTOSUSPEND_COMPLAINTS),
  };
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
    // A dropped entry is a domain the operator believes is allowed and that
    // silently is not, so say so — same reasoning as nonNegativeInt above.
    if (domain.length === 0) {
      console.warn(`[emailDomains] Ignoring EMAIL_DOMAINS_STATIC_ALLOWED entry ${JSON.stringify(trimmed)}: no domain before the colon.`);
      continue;
    }
    // `acme.com:` is an operator typo, not "bound to nobody" — drop it rather
    // than silently widening the entry to every partner on the instance.
    if (colon >= 0 && slug.length === 0) {
      console.warn(`[emailDomains] Ignoring EMAIL_DOMAINS_STATIC_ALLOWED entry ${JSON.stringify(trimmed)}: empty partner slug after the colon. Drop the colon to allow any partner.`);
      continue;
    }
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
    webhookSecret: str('EMAIL_DOMAINS_WEBHOOK_SECRET'),
    autoSuspend: readAutoSuspendConfig()
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
