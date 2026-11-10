import { describe, expect, it, vi } from 'vitest';

const { mfaState } = vi.hoisted(() => ({ mfaState: { satisfied: true } }));

vi.mock('../../middleware/auth', () => ({
  hasSatisfiedMfa: vi.fn(() => mfaState.satisfied),
}));

import {
  checkOemUpdatesArmAllowed,
  oemUpdatesPreviousForWrite,
  overrideDeleteArmsOemUpdates,
  policyArmsOemUpdates,
} from './oemUpdatesGate';

const auth = { token: { mfa: true } } as any;
const perms = (grants: Array<{ resource: string; action: string }>) => ({ permissions: grants } as any);
const EXECUTE = [{ resource: 'devices', action: 'execute' }];
const WRITE_ONLY = [{ resource: 'devices', action: 'write' }];

const BASE = {
  version: 1,
  schedule: { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 },
  catchUpNights: 7,
  reboot: 'overnight',
};
const ARMED = { ...BASE, enabled: true, vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [] } } };
const OFF = { ...BASE, enabled: false, vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [] } } };
const link = (inlineSettings: unknown) => ({ featureType: 'oem_updates', inlineSettings });
const other = { featureType: 'patch', inlineSettings: ARMED };

describe('checkOemUpdatesArmAllowed', () => {
  it('allows devices.execute with MFA', () => {
    mfaState.satisfied = true;
    expect(checkOemUpdatesArmAllowed(auth, perms(EXECUTE))).toEqual({ allowed: true });
  });

  it('denies devices.write only, and unresolved permissions, with the execute code', () => {
    mfaState.satisfied = true;
    expect(checkOemUpdatesArmAllowed(auth, perms(WRITE_ONLY))).toMatchObject({ allowed: false, body: { code: 'oem_updates_execute_required' } });
    expect(checkOemUpdatesArmAllowed(auth, undefined)).toMatchObject({ allowed: false, body: { code: 'oem_updates_execute_required' } });
  });

  it('denies execute without MFA with MFA_REQUIRED', () => {
    mfaState.satisfied = false;
    expect(checkOemUpdatesArmAllowed(auth, perms(EXECUTE))).toMatchObject({ allowed: false, body: { code: 'MFA_REQUIRED' } });
    mfaState.satisfied = true;
  });
});

describe('policyArmsOemUpdates (the link in effect: own, else inherited whole)', () => {
  it('reads the own link first, whatever the parent says', () => {
    expect(policyArmsOemUpdates({ featureLinks: [link(ARMED)] })).toBe(true);
    expect(policyArmsOemUpdates({ parentPolicyId: 'p', featureLinks: [link(OFF)], parentPolicy: { featureLinks: [link(ARMED)] } })).toBe(false);
  });

  it('inherits the parent link when the policy has none', () => {
    expect(policyArmsOemUpdates({ parentPolicyId: 'p', featureLinks: [other], parentPolicy: { featureLinks: [link(ARMED)] } })).toBe(true);
    expect(policyArmsOemUpdates({ parentPolicyId: 'p', featureLinks: [], parentPolicy: { featureLinks: [] } })).toBe(false);
  });

  it('no link anywhere is unarmed; another feature type never counts', () => {
    expect(policyArmsOemUpdates({ featureLinks: [other] })).toBe(false);
    expect(policyArmsOemUpdates({})).toBe(false);
  });

  it('unresolvable parent fails closed', () => {
    expect(policyArmsOemUpdates({ parentPolicyId: 'p', featureLinks: [], parentPolicy: null })).toBe(true);
    // An own link means the parent is never consulted.
    expect(policyArmsOemUpdates({ parentPolicyId: 'p', featureLinks: [link(OFF)], parentPolicy: null })).toBe(false);
  });
});

describe('overrideDeleteArmsOemUpdates', () => {
  it('reverting to an armed parent from a narrower override arms', () => {
    expect(overrideDeleteArmsOemUpdates({ parentPolicyId: 'p', featureLinks: [link(OFF)], parentPolicy: { featureLinks: [link(ARMED)] } })).toBe(true);
  });

  it('no parent, no parent link, or a parent no wider than the override does not', () => {
    expect(overrideDeleteArmsOemUpdates({ featureLinks: [link(ARMED)] })).toBe(false);
    expect(overrideDeleteArmsOemUpdates({ parentPolicyId: 'p', featureLinks: [link(OFF)], parentPolicy: { featureLinks: [] } })).toBe(false);
    expect(overrideDeleteArmsOemUpdates({ parentPolicyId: 'p', featureLinks: [link(ARMED)], parentPolicy: { featureLinks: [link(ARMED)] } })).toBe(false);
  });

  it('an unresolvable parent fails closed', () => {
    expect(overrideDeleteArmsOemUpdates({ parentPolicyId: 'p', featureLinks: [link(OFF)], parentPolicy: null })).toBe(true);
  });

  it('an own link that no longer parses shields nothing: reverting to an armed parent arms', () => {
    // Leniently this reads as armed (identical categories), but the resolver treats it as disabled.
    const corrupt = { ...ARMED, unknownKey: true };
    expect(overrideDeleteArmsOemUpdates({ parentPolicyId: 'p', featureLinks: [link(corrupt)], parentPolicy: { featureLinks: [link(ARMED)] } })).toBe(true);
  });
});

describe('oemUpdatesPreviousForWrite', () => {
  it('is the link in effect, or null when the parent cannot be read (the strict direction)', () => {
    expect(oemUpdatesPreviousForWrite({ featureLinks: [link(OFF)] })).toEqual(OFF);
    expect(oemUpdatesPreviousForWrite({ parentPolicyId: 'p', featureLinks: [], parentPolicy: { featureLinks: [link(ARMED)] } })).toEqual(ARMED);
    expect(oemUpdatesPreviousForWrite({ parentPolicyId: 'p', featureLinks: [], parentPolicy: null })).toBeNull();
  });
});
