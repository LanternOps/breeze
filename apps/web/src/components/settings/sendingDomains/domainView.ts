import type {
  PartnerMailStreamValue,
  SenderIdentityDto,
  SendingDomainDnsRecordDto,
  SendingDomainDto,
  SendingDomainsCapabilityDto,
} from '@breeze/shared';

/**
 * Pure view model for the custom sender-address tab. Everything the UI decides
 * about a domain lives here so the states of spec §10 can be tested without
 * rendering, and so the components stay presentational.
 *
 * All of these return an i18n key SUFFIX under `partnerSendingDomains.`, never a
 * full key: the components interpolate the group prefix, which keeps
 * apps/web/src/lib/i18n/keyUsage.test.ts able to prove the group exists.
 */

export const SENDING_DOMAIN_STREAMS: readonly PartnerMailStreamValue[] = ['support', 'billing', 'general'];

/** Spec §3.2's "suggested local part" column. */
export const SUGGESTED_LOCAL_PARTS: Record<PartnerMailStreamValue, string> = {
  support: 'support',
  billing: 'billing',
  general: 'notifications',
};

/** Spec §13: show the delay notice once provisioning has run for two minutes. */
export const PROVISIONING_SLOW_AFTER_MS = 120_000;
/**
 * Spec §4.3 / §6.1: the worker moves a `failed` row to `removing` 72 h after it
 * failed, and that is exactly the window in which "Try again" keeps the same DNS
 * records. 72 h in ms.
 */
export const RETRY_WINDOW_MS = 72 * 60 * 60 * 1_000;
/** Spec §10: `provisioning` polls every 2 s. */
export const POLL_PROVISIONING_MS = 2_000;
/** Spec §10: `pending` auto-refreshes every 15 s. */
export const POLL_PENDING_MS = 15_000;

/**
 * The tab is hidden if and only if this INSTANCE has no provider — either the
 * route 404'd (capability null) or the capability reports no provider. A
 * configured provider whose key cannot manage domains still shows the tab, with
 * the locked card explaining why (spec §5.1 against spec §10's "unsupported"
 * row; see the plan amendments).
 */
export function isTabVisible(capability: SendingDomainsCapabilityDto | null): boolean {
  return capability !== null && capability.provider !== null;
}

/** Which locked-card copy the capability's reason calls for. */
export function lockedCopySuffix(capability: SendingDomainsCapabilityDto): string {
  switch (capability.reason) {
    case 'provider_key_send_only':
      return 'lockedProviderKeySendOnly';
    case 'partner_inactive':
      return 'lockedPartnerInactive';
    case 'not_allowlisted':
      return 'lockedNotAllowlisted';
    case 'restricted':
      return 'lockedRestricted';
    default:
      // Every remaining case is the trust evaluator's own reason string
      // (probation_default_deny today). "Still being verified" is the accurate
      // and least alarming default for an unrecognised one.
      return 'lockedProbation';
  }
}

/**
 * Only a trust-derived lock can be explained by TrustProbationBanner, which is
 * where the checklist and "Request review" live. An allowlist or key problem is
 * nothing that banner knows about.
 */
export function isTrustLock(capability: SendingDomainsCapabilityDto): boolean {
  if (capability.eligible) return false;
  return capability.reason === 'restricted' || capability.reason === 'probation_default_deny';
}

/** Which failure copy a `failed` row calls for. */
export function failureCopySuffix(domain: SendingDomainDto): string {
  switch (domain.statusReason) {
    case 'provider_conflict':
      return 'failedProviderConflict';
    case 'provider_rejected':
      // In `static` mode a rejection means the operator has not listed the
      // domain in EMAIL_DOMAINS_STATIC_ALLOWED, which the partner cannot fix.
      return domain.provider === 'static' ? 'staticNotAllowed' : 'failedProviderRejected';
    case 'quota_exhausted':
      return 'failedQuotaExhausted';
    case 'dns_not_detected':
      return 'failedDnsNotDetected';
    case 'dns_removed':
      return 'failedDnsRemoved';
    default:
      return 'failedUnknown';
  }
}

/** The record the at-risk banner must name (spec §10). */
export function firstUnhealthyRecord(domain: SendingDomainDto): SendingDomainDnsRecordDto | null {
  return domain.dnsRecords.find((record) => record.status !== 'verified') ?? null;
}

/** Spec §7: an identity's domain must be the caller's and `verified` or `at_risk`. */
export function sendableDomains(domains: SendingDomainDto[]): SendingDomainDto[] {
  return domains.filter((d) => d.status === 'verified' || d.status === 'at_risk');
}

/**
 * The exact From address a stream will send with, composed from a local part and
 * the domain row in the SAME response.
 *
 * A saved identity also carries its own `fromAddress` from the API, and that is
 * the authority for what the server will actually send with. This function is
 * for the FORM: it previews the local part and domain the partner is editing
 * right now, which no server field can know before the save.
 */
export function fromAddressFor(
  identity: Pick<SenderIdentityDto, 'localPart' | 'sendingDomainId'>,
  domains: SendingDomainDto[],
): string | null {
  const match = domains.find((d) => d.id === identity.sendingDomainId);
  return match ? `${identity.localPart}@${match.domain}` : null;
}

/** How fast to re-read, or null to stop entirely. */
export function pollIntervalMs(domains: SendingDomainDto[]): number | null {
  if (domains.some((d) => d.status === 'provisioning')) return POLL_PROVISIONING_MS;
  const waiting = domains.some(
    (d) => d.status === 'pending' || d.status === 'removing' || d.lastTestStatus === 'pending',
  );
  return waiting ? POLL_PENDING_MS : null;
}

/** Spec §13's "delay notice after 2 min" while the provider is unreachable. */
export function isProvisioningSlow(domain: SendingDomainDto, nowMs: number): boolean {
  if (domain.status !== 'provisioning') return false;
  const created = Date.parse(domain.createdAt);
  if (Number.isNaN(created)) return false;
  return nowMs - created > PROVISIONING_SLOW_AFTER_MS;
}

/**
 * Spec §10's `failed` row: "Retry (inside the window)". The window runs from the
 * moment the row failed — `statusChangedAt` — for 72 h, after which the worker
 * expires the row to `removing` and the same DNS records are gone.
 *
 * The SERVER is the authority: `requestDomainCheck` enforces the window too, so
 * a click that races the boundary surfaces the server's error like any other
 * failure. This only decides whether the button is worth offering, which is why
 * an unparseable timestamp errs toward showing it rather than hiding the one
 * action left on a broken domain.
 */
export function isInsideRetryWindow(domain: SendingDomainDto, nowMs: number): boolean {
  if (domain.status !== 'failed') return false;
  const failedAt = Date.parse(domain.statusChangedAt);
  if (Number.isNaN(failedAt)) return true;
  return nowMs - failedAt < RETRY_WINDOW_MS;
}
