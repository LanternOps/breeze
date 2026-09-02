export const TRUST_DENIED_EVENT = 'breeze:trust-denied';

export type TrustDenyCode = 'TRUST_PROBATION' | 'TRUST_RESTRICTED';
export type TrustCapability =
  | 'remote_control'
  | 'device_execute'
  | 'installer_distribute'
  | 'agent_enroll';

export interface TrustDenial {
  error: TrustDenyCode;
  capability: TrustCapability;
  reason: string;
  reviewRequested: boolean;
  meetingUrl: string | null;
}

const TRUST_DENY_CODES = new Set<TrustDenyCode>(['TRUST_PROBATION', 'TRUST_RESTRICTED']);
const TRUST_CAPABILITIES = new Set<TrustCapability>([
  'remote_control',
  'device_execute',
  'installer_distribute',
  'agent_enroll',
]);

export function isTrustDenial(body: unknown): body is TrustDenial {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return TRUST_DENY_CODES.has(value.error as TrustDenyCode)
    && TRUST_CAPABILITIES.has(value.capability as TrustCapability)
    && typeof value.reason === 'string'
    && typeof value.reviewRequested === 'boolean'
    && (value.meetingUrl === null || typeof value.meetingUrl === 'string');
}

export function dispatchTrustDenied(detail: TrustDenial): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<TrustDenial>(TRUST_DENIED_EVENT, { detail }));
}
