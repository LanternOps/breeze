/**
 * Baseline-then-tighten policy resolver (spec D6).
 *
 * Partner row (or code defaults when absent) is the BASELINE. An org row may
 * only tighten each field via the operator table below; a request that would
 * loosen is ignored and reported in `ignored`. Equality keeps the baseline's
 * provenance. Pure: no I/O in `resolveEffectivePolicy` / `policyResponse`.
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../../db';
import { organizations } from '../../db/schema/orgs';
import { callerVerificationPolicies } from '../../db/schema/callerVerification';
import type { PolicyRow } from './types';

export interface EffectiveCallerVerificationPolicy {
  requiredTierResetPassword: number;
  requiredTierDisableUser: number;
  disableUserAuthorizerRoles: string[];
  verificationTtlMinutes: number;
  allowedMethods: Array<'workstation' | 'sms' | 'email' | 'callback_attestation'>;
  workstationTimeoutSeconds: number;
  destinationMinAgeDays: number;
  requireAttestedDestination: boolean;
  requireTicket: boolean;
  allowCrossTechnicianUse: boolean;
  allowAdministrativeDisable: boolean;
  maxAttemptsPerHour: number;
  coolingOffHours: number;
  provenance: Record<string, 'default' | 'partner' | 'org'>;
  ignored: string[];
}

export const CALLER_VERIFICATION_POLICY_DEFAULTS: Omit<EffectiveCallerVerificationPolicy, 'provenance' | 'ignored'> = {
  requiredTierResetPassword: 2,
  requiredTierDisableUser: 2,
  disableUserAuthorizerRoles: ['admin'],
  verificationTtlMinutes: 30,
  allowedMethods: ['workstation', 'sms', 'email', 'callback_attestation'],
  workstationTimeoutSeconds: 120,
  destinationMinAgeDays: 7,
  requireAttestedDestination: false,
  requireTicket: false,
  allowCrossTechnicianUse: false,
  allowAdministrativeDisable: true,
  maxAttemptsPerHour: 3,
  coolingOffHours: 24,
};

type Key = keyof typeof CALLER_VERIFICATION_POLICY_DEFAULTS;

/** Tightening direction per field: an org value can only move this way. */
const operators: Record<Key, 'max' | 'min' | 'or' | 'and' | 'intersection'> = {
  requiredTierResetPassword: 'max',
  requiredTierDisableUser: 'max',
  disableUserAuthorizerRoles: 'intersection',
  verificationTtlMinutes: 'min',
  allowedMethods: 'intersection',
  workstationTimeoutSeconds: 'min',
  destinationMinAgeDays: 'max',
  requireAttestedDestination: 'or',
  requireTicket: 'or',
  allowCrossTechnicianUse: 'and',
  allowAdministrativeDisable: 'and',
  maxAttemptsPerHour: 'min',
  coolingOffHours: 'max',
};

const equal = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v) => b.includes(v)) : a === b;

export function resolveEffectivePolicy(partnerRow: PolicyRow | null, orgRow: PolicyRow | null): EffectiveCallerVerificationPolicy {
  const result = structuredClone(CALLER_VERIFICATION_POLICY_DEFAULTS) as EffectiveCallerVerificationPolicy;
  result.provenance = {};
  result.ignored = [];
  for (const key of Object.keys(operators) as Key[]) {
    const base: unknown = partnerRow?.[key] ?? CALLER_VERIFICATION_POLICY_DEFAULTS[key];
    const requested: unknown = orgRow?.[key];
    let effective: unknown = base;
    result.provenance[key] = partnerRow?.[key] != null ? 'partner' : 'default';
    if (requested != null) {
      switch (operators[key]) {
        case 'max': effective = Math.max(base as number, requested as number); break;
        case 'min': effective = Math.min(base as number, requested as number); break;
        case 'or': effective = Boolean(base) || Boolean(requested); break;
        case 'and': effective = Boolean(base) && Boolean(requested); break;
        case 'intersection': effective = (base as string[]).filter((v) => (requested as string[]).includes(v)); break;
      }
      if (!equal(effective, requested)) result.ignored.push(key);
      if (!equal(effective, base)) result.provenance[key] = 'org';
    }
    (result as unknown as Record<string, unknown>)[key] = effective;
  }
  return result;
}

async function loadOrgAndPartnerRows(orgId: string): Promise<{ partnerRow: PolicyRow | null; orgRow: PolicyRow | null }> {
  const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  if (!org) throw new Error('Organization not found');
  const rows = await db.select().from(callerVerificationPolicies).where(or(
    eq(callerVerificationPolicies.orgId, orgId),
    and(isNull(callerVerificationPolicies.orgId), eq(callerVerificationPolicies.partnerId, org.partnerId)),
  ));
  return {
    partnerRow: rows.find((r) => r.orgId === null && r.partnerId === org.partnerId) ?? null,
    orgRow: rows.find((r) => r.orgId === orgId) ?? null,
  };
}

export async function getEffectivePolicy(orgId: string): Promise<EffectiveCallerVerificationPolicy> {
  const { partnerRow, orgRow } = await loadOrgAndPartnerRows(orgId);
  return resolveEffectivePolicy(partnerRow, orgRow);
}

/**
 * Response projection for GET/PUT policy: the owner's own row, code
 * defaults, the baseline the owner inherits, and the effective result. For
 * the partner owner, `effective` is the baseline itself (no org tightening).
 */
export function policyResponse(partnerRow: PolicyRow | null, orgRow: PolicyRow | null, owner: 'org' | 'partner') {
  const { provenance: _provenance, ignored: _ignored, ...baseline } = resolveEffectivePolicy(partnerRow, null);
  return {
    row: owner === 'partner' ? partnerRow : orgRow,
    defaults: structuredClone(CALLER_VERIFICATION_POLICY_DEFAULTS),
    baseline,
    effective: resolveEffectivePolicy(partnerRow, owner === 'org' ? orgRow : null),
  };
}

export async function getPolicyResponse(owner: 'org' | 'partner', ownerId: string) {
  if (owner === 'partner') {
    const [row] = await db.select().from(callerVerificationPolicies)
      .where(and(eq(callerVerificationPolicies.partnerId, ownerId), isNull(callerVerificationPolicies.orgId))).limit(1);
    return policyResponse(row ?? null, null, 'partner');
  }
  const { partnerRow, orgRow } = await loadOrgAndPartnerRows(ownerId);
  return policyResponse(partnerRow, orgRow, 'org');
}
