import type { TFunction } from 'i18next';
import type {
  CustomerDomainView,
  DomainCheckFailReason,
  DomainCheckUnavailableReason,
  DomainVerificationClearedReason,
  DomainVerificationErrorCode,
  DomainVerificationMethod,
} from './types';
import { GOOGLE_DOMAIN_SCOPE } from './types';
import type { EntraUnavailableReason, GoogleUnavailableReason } from './methodAvailability';

/**
 * Static key maps for the `settings:orgDomains.*` labels: every value the API
 * can send maps to a literal key, so keyUsage.test.ts can see them all.
 */
const METHOD_KEYS: Record<DomainVerificationMethod, string> = {
  dns_txt: 'settings:orgDomains.methods.dns_txt',
  entra_tenant: 'settings:orgDomains.methods.entra_tenant',
  google_directory: 'settings:orgDomains.methods.google_directory',
};

const METHOD_SHORT_KEYS: Record<DomainVerificationMethod, string> = {
  dns_txt: 'settings:orgDomains.methodsShort.dns_txt',
  entra_tenant: 'settings:orgDomains.methodsShort.entra_tenant',
  google_directory: 'settings:orgDomains.methodsShort.google_directory',
};

const CLEARED_KEYS: Record<DomainVerificationClearedReason, string> = {
  record_missing: 'settings:orgDomains.cleared.record_missing',
  not_in_directory: 'settings:orgDomains.cleared.not_in_directory',
  tenant_not_proven: 'settings:orgDomains.cleared.tenant_not_proven',
  connection_missing: 'settings:orgDomains.cleared.connection_missing',
  stale: 'settings:orgDomains.cleared.stale',
  repointed: 'settings:orgDomains.cleared.repointed',
  msp_removed: 'settings:orgDomains.cleared.msp_removed',
  displaced: 'settings:orgDomains.cleared.displaced',
};

const CHECK_REASON_KEYS: Record<DomainCheckFailReason | DomainCheckUnavailableReason, string> = {
  record_missing: 'settings:orgDomains.checkReasons.record_missing',
  not_in_directory: 'settings:orgDomains.checkReasons.not_in_directory',
  tenant_not_proven: 'settings:orgDomains.checkReasons.tenant_not_proven',
  connection_missing: 'settings:orgDomains.checkReasons.connection_missing',
  dns_error: 'settings:orgDomains.checkReasons.dns_error',
  timeout: 'settings:orgDomains.checkReasons.timeout',
  graph_unavailable: 'settings:orgDomains.checkReasons.graph_unavailable',
  graph_tenant_mismatch: 'settings:orgDomains.checkReasons.graph_tenant_mismatch',
  google_scope_missing: 'settings:orgDomains.checkReasons.google_scope_missing',
  google_access_denied: 'settings:orgDomains.checkReasons.google_access_denied',
  google_unavailable: 'settings:orgDomains.checkReasons.google_unavailable',
};

const ERROR_KEYS: Record<DomainVerificationErrorCode, string> = {
  CUSTOMER_DOMAIN_NOT_FOUND: 'settings:orgDomains.verifyErrors.CUSTOMER_DOMAIN_NOT_FOUND',
  DOMAIN_VERIFIED_ELSEWHERE: 'settings:orgDomains.verifyErrors.DOMAIN_VERIFIED_ELSEWHERE',
  DOMAIN_VERIFICATION_CONFLICT_RETRY: 'settings:orgDomains.verifyErrors.DOMAIN_VERIFICATION_CONFLICT_RETRY',
  DOMAIN_INACTIVE: 'settings:orgDomains.verifyErrors.DOMAIN_INACTIVE',
  DOMAIN_DNS_NOT_STARTED: 'settings:orgDomains.verifyErrors.DOMAIN_DNS_NOT_STARTED',
  DOMAIN_ALREADY_VERIFIED: 'settings:orgDomains.verifyErrors.DOMAIN_ALREADY_VERIFIED',
};

const ENTRA_UNAVAILABLE_KEYS: Record<EntraUnavailableReason, string> = {
  tenant_not_proven: 'settings:orgDomains.methodUnavailable.entra_tenant.tenant_not_proven',
  connection_missing: 'settings:orgDomains.methodUnavailable.entra_tenant.connection_missing',
  not_enabled: 'settings:orgDomains.methodUnavailable.entra_tenant.not_enabled',
};

const GOOGLE_UNAVAILABLE_KEYS: Record<GoogleUnavailableReason, string> = {
  connection_missing: 'settings:orgDomains.methodUnavailable.google_directory.connection_missing',
  not_enabled: 'settings:orgDomains.methodUnavailable.google_directory.not_enabled',
};

/** Own-key lookup: an API value like "constructor" must never reach the prototype. */
function keyFor<K extends string>(map: Record<K, string>, value: string): string | undefined {
  return Object.hasOwn(map, value) ? map[value as K] : undefined;
}

export const methodLabel = (t: TFunction, method: DomainVerificationMethod) => t(/* i18n-dynamic */ METHOD_KEYS[method]);
export const methodShortLabel = (t: TFunction, method: DomainVerificationMethod) => t(/* i18n-dynamic */ METHOD_SHORT_KEYS[method]);

/** "Verification lost: …", or null when the key is unknown (an API newer than this build). */
export function clearedLabel(t: TFunction, reason: string): string | null {
  const key = keyFor(CLEARED_KEYS, reason);
  return key ? t(/* i18n-dynamic */ key) : null;
}

export function checkReasonLabel(t: TFunction, reason: string): string {
  const key = keyFor(CHECK_REASON_KEYS, reason);
  return key ? t(/* i18n-dynamic */ key, { scope: GOOGLE_DOMAIN_SCOPE }) : t('settings:orgDomains.checkReasons.unknown');
}

export const verifyErrorLabel = (t: TFunction, code: DomainVerificationErrorCode) => t(/* i18n-dynamic */ ERROR_KEYS[code]);

export const entraUnavailableLabel = (t: TFunction, reason: EntraUnavailableReason) =>
  t(/* i18n-dynamic */ ENTRA_UNAVAILABLE_KEYS[reason]);
export const googleUnavailableLabel = (t: TFunction, reason: GoogleUnavailableReason) =>
  t(/* i18n-dynamic */ GOOGLE_UNAVAILABLE_KEYS[reason]);

/** The table's state badge text. */
export function stateLabel(t: TFunction, domain: Pick<CustomerDomainView, 'state' | 'method'>): string {
  if (domain.state === 'verified' && domain.method) {
    return t('settings:orgDomains.states.verified', { method: methodShortLabel(t, domain.method) });
  }
  if (domain.state === 'pending_dns') return t('settings:orgDomains.states.pending_dns');
  return t('settings:orgDomains.states.declared');
}

/** The state badge colours (shared by the Domains tab and the Ticketing summary). */
export function stateBadgeClass(state: CustomerDomainView['state']): string {
  if (state === 'verified') return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200';
  if (state === 'pending_dns') return 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200';
  return 'bg-muted text-muted-foreground';
}
