import { describe, expect, it } from 'vitest';
import {
  BASELINE_BLOCKED_REASON,
  computeBaselineAuthorityFingerprint,
  evaluateBaselineDispatchAuthority,
  type BaselineAuthorityRow,
  type BaselineAuthoritySubject,
} from './networkBaselineAuthority';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_SITE_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const SUBNET = '192.168.10.0/24';

function armedRow(overrides: Partial<BaselineAuthorityRow> = {}): BaselineAuthorityRow {
  const base: BaselineAuthorityRow = {
    id: '55555555-5555-4555-8555-555555555555',
    orgId: ORG_ID,
    siteId: SITE_ID,
    subnet: SUBNET,
    scanSchedule: { enabled: true, intervalHours: 4, nextScanAt: '2026-10-15T00:00:00.000Z' },
    authorityUserId: USER_ID,
    authoritySiteIds: null,
    authorityPermissionsEpoch: 7,
    authorityMfaEpoch: 3,
    authorityFingerprint: null,
    authorityGeneration: 2,
  };
  const row = { ...base, ...overrides };
  if (overrides.authorityFingerprint === undefined) {
    row.authorityFingerprint = computeBaselineAuthorityFingerprint(row);
  }
  return row;
}

function subject(overrides: Partial<BaselineAuthoritySubject> = {}): BaselineAuthoritySubject {
  return {
    userId: USER_ID,
    status: 'active',
    permissionsEpoch: 7,
    mfaEpoch: 3,
    membership: { allowedSiteIds: null, hasRequiredPermission: true },
    ...overrides,
  };
}

describe('computeBaselineAuthorityFingerprint', () => {
  it('is stable across nextScanAt rewrites (the scheduler rewrites it every tick)', () => {
    const a = computeBaselineAuthorityFingerprint(armedRow());
    const b = computeBaselineAuthorityFingerprint(
      armedRow({ scanSchedule: { enabled: true, intervalHours: 4, nextScanAt: '2027-01-01T00:00:00.000Z' } }),
    );
    expect(a).toBe(b);
  });

  it('changes when the subnet, site, org or effective schedule changes', () => {
    const base = computeBaselineAuthorityFingerprint(armedRow());
    expect(computeBaselineAuthorityFingerprint(armedRow({ subnet: '10.0.0.0/8' }))).not.toBe(base);
    expect(computeBaselineAuthorityFingerprint(armedRow({ siteId: OTHER_SITE_ID }))).not.toBe(base);
    expect(
      computeBaselineAuthorityFingerprint(
        armedRow({ scanSchedule: { enabled: true, intervalHours: 24, nextScanAt: null } }),
      ),
    ).not.toBe(base);
  });
});

describe('evaluateBaselineDispatchAuthority', () => {
  it('POSITIVE CONTROL: allows the authorized creator with unchanged state', () => {
    const decision = evaluateBaselineDispatchAuthority(armedRow(), subject(), { expectedGeneration: 2 });
    expect(decision).toEqual({ allowed: true });
  });

  it('allows when no generation expectation is supplied (interactive path)', () => {
    expect(evaluateBaselineDispatchAuthority(armedRow(), subject(), {})).toEqual({ allowed: true });
  });

  it('denies a legacy row with no envelope', () => {
    const row = armedRow({ authorityUserId: null, authorityFingerprint: null });
    const decision = evaluateBaselineDispatchAuthority(row, subject(), {});
    expect(decision).toEqual({ allowed: false, reason: BASELINE_BLOCKED_REASON.REAPPROVAL_REQUIRED });
  });

  it('denies a malformed partial envelope (user set, epochs missing)', () => {
    const row = armedRow({ authorityPermissionsEpoch: null });
    expect(evaluateBaselineDispatchAuthority(row, subject(), {})).toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.REAPPROVAL_REQUIRED,
    });
  });

  it('denies when the creator was deleted (FK SET NULL) or cannot be loaded', () => {
    expect(evaluateBaselineDispatchAuthority(armedRow(), null, {})).toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.AUTHORITY_REVOKED,
    });
  });

  it('denies when the creator is disabled', () => {
    expect(evaluateBaselineDispatchAuthority(armedRow(), subject({ status: 'disabled' }), {})).toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.AUTHORITY_REVOKED,
    });
  });

  it('denies when the creator was removed from the organization', () => {
    expect(evaluateBaselineDispatchAuthority(armedRow(), subject({ membership: null }), {})).toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.AUTHORITY_REVOKED,
    });
  });

  it('denies when devices:write was revoked', () => {
    const decision = evaluateBaselineDispatchAuthority(
      armedRow(),
      subject({ membership: { allowedSiteIds: null, hasRequiredPermission: false } }),
      {},
    );
    expect(decision).toEqual({ allowed: false, reason: BASELINE_BLOCKED_REASON.PERMISSION_REVOKED });
  });

  it('denies when the baseline site left the creator CURRENT site ceiling', () => {
    const decision = evaluateBaselineDispatchAuthority(
      armedRow(),
      subject({ membership: { allowedSiteIds: [OTHER_SITE_ID], hasRequiredPermission: true } }),
      {},
    );
    expect(decision).toEqual({ allowed: false, reason: BASELINE_BLOCKED_REASON.SITE_OUT_OF_SCOPE });
  });

  it('denies when the site ceiling narrowed to empty', () => {
    const decision = evaluateBaselineDispatchAuthority(
      armedRow(),
      subject({ membership: { allowedSiteIds: [], hasRequiredPermission: true } }),
      {},
    );
    expect(decision).toEqual({ allowed: false, reason: BASELINE_BLOCKED_REASON.SITE_OUT_OF_SCOPE });
  });

  it('denies when the baseline site is outside the ARMED ceiling even if current access widened', () => {
    const row = armedRow({ authoritySiteIds: [OTHER_SITE_ID] });
    const decision = evaluateBaselineDispatchAuthority(row, subject(), {});
    expect(decision).toEqual({ allowed: false, reason: BASELINE_BLOCKED_REASON.SITE_OUT_OF_SCOPE });
  });

  it('denies when the permissions epoch advanced', () => {
    expect(evaluateBaselineDispatchAuthority(armedRow(), subject({ permissionsEpoch: 8 }), {})).toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.EPOCH_CHANGED,
    });
  });

  it('denies when the MFA epoch advanced', () => {
    expect(evaluateBaselineDispatchAuthority(armedRow(), subject({ mfaEpoch: 4 }), {})).toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.EPOCH_CHANGED,
    });
  });

  it('denies when the effect fingerprint no longer matches the stored one', () => {
    const row = armedRow();
    row.subnet = '10.1.0.0/16';
    expect(evaluateBaselineDispatchAuthority(row, subject(), {})).toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.EFFECT_CHANGED,
    });
  });

  it('denies a stale generation (the tick was issued against an older envelope)', () => {
    expect(evaluateBaselineDispatchAuthority(armedRow(), subject(), { expectedGeneration: 1 })).toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.STALE_GENERATION,
    });
  });

  it('denies when the schedule is disabled', () => {
    const row = armedRow({ scanSchedule: { enabled: false, intervalHours: 4, nextScanAt: null } });
    expect(evaluateBaselineDispatchAuthority(row, subject(), {})).toEqual({
      allowed: false,
      reason: BASELINE_BLOCKED_REASON.SCHEDULE_DISABLED,
    });
  });
});
