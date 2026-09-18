import { parse as parseTld } from 'tldts';
import { isHosted } from '../../config/env';
import { isConsumerEmailDomain } from '../consumerEmailDomains';
import { getEmailDomainsConfig } from './config';

/**
 * API-only sending-domain policy (spec §4.1, "The API additionally rejects").
 *
 * The structural half — trim, lowercase, trailing dot, IDN->A-label, label
 * shape — is `normalizeSendingDomain` in @breeze/shared, shared with the web
 * form. These rules are here instead because they read server configuration
 * and a public-suffix list the browser bundle has no business carrying.
 *
 * Input is always an ALREADY NORMALISED domain (lowercase A-label, no trailing
 * dot). Callers run normalizeSendingDomain first.
 */

export type SendingDomainPolicyRejection =
  | 'platform_domain'
  | 'consumer_domain'
  | 'public_suffix'
  | 'denylisted';

export class SendingDomainPolicyError extends Error {
  constructor(readonly reason: SendingDomainPolicyRejection) {
    super(`sending domain refused: ${reason}`);
    this.name = 'SendingDomainPolicyError';
  }
}

/**
 * Breeze-owned names. Refused in EVERY deployment mode — nobody self-hosting
 * can prove ownership of these either — unlike the env-derived platform domains
 * below, which are hosted-only because on a self-hosted instance EMAIL_FROM's
 * domain IS the MSP's own domain and is exactly what the operator will add.
 */
export const PLATFORM_OWNED_DOMAINS = ['2breeze.app', 'breezermm.com', 'lanternops.io'] as const;

function domainOfAddressOrHost(raw: string | undefined): string | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return null;
  // `"Breeze" <no-reply@2breeze.app>` or a bare address.
  const at = value.lastIndexOf('@');
  const candidate = at >= 0 ? value.slice(at + 1) : value;
  return candidate.replace(/[>\s]+$/g, '').replace(/\.+$/, '') || null;
}

function hostOfUrl(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.+$/, '') || null;
  } catch {
    return null;
  }
}

/** Exact match, or a dot-boundary subdomain. `notbreezermm.com` is NOT a match. */
function isSelfOrSubdomainOf(domain: string, parent: string): boolean {
  return domain === parent || domain.endsWith(`.${parent}`);
}

export function assertSendingDomainAllowed(domain: string): void {
  const target = domain.trim().toLowerCase();

  // 1. Platform-owned names. Checked FIRST so the reason a partner sees is the
  //    accurate one even when the domain would also trip a later rule.
  for (const owned of PLATFORM_OWNED_DOMAINS) {
    if (isSelfOrSubdomainOf(target, owned)) throw new SendingDomainPolicyError('platform_domain');
  }
  if (isHosted()) {
    const platformDerived = [
      domainOfAddressOrHost(process.env.EMAIL_FROM),
      domainOfAddressOrHost(process.env.TICKETS_INBOUND_DOMAIN),
      hostOfUrl(process.env.PUBLIC_APP_URL)
    ].filter((value): value is string => value !== null);
    for (const owned of platformDerived) {
      if (isSelfOrSubdomainOf(target, owned)) throw new SendingDomainPolicyError('platform_domain');
    }
  }

  // 2. Consumer mailbox providers. isConsumerEmailDomain takes an ADDRESS, not
  //    a domain (services/consumerEmailDomains.ts:79 -> emailDomainOf at :66),
  //    so a local part is prepended. `postmaster` is never delivered anywhere —
  //    the string is only split on '@'.
  if (isConsumerEmailDomain(`postmaster@${target}`)) {
    throw new SendingDomainPolicyError('consumer_domain');
  }

  // 3. Public suffixes. `parseTld(...).domain` is null exactly when the input IS
  //    a suffix (or is otherwise unregistrable). allowPrivateDomains folds in
  //    github.io / herokuapp.com, which nobody may claim wholesale.
  const parsed = parseTld(target, { allowPrivateDomains: true });
  if (!parsed.domain || parsed.publicSuffix === target) {
    throw new SendingDomainPolicyError('public_suffix');
  }

  // 4. The operator's own denylist.
  for (const denied of getEmailDomainsConfig().denylist) {
    if (isSelfOrSubdomainOf(target, denied)) throw new SendingDomainPolicyError('denylisted');
  }
}
