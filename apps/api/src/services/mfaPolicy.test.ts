import { describe, it, expect, vi, beforeEach } from 'vitest';

const roleRows: { forceMfa: boolean }[] = [];
let effectiveSecurity: Record<string, unknown> | undefined;
let effectiveThrows = false;

vi.mock('../db', () => {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(roleRows),
    then: (r: (v: unknown[]) => unknown) => r(roleRows),
  };
  return {
    db: { select: () => chain },
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
  };
});

vi.mock('./effectiveSettings', () => ({
  getEffectiveOrgSettings: vi.fn(async () => {
    if (effectiveThrows) throw new Error('boom');
    return { effective: { security: effectiveSecurity ?? {} }, locked: [] };
  }),
}));

// Declare BEFORE the mock factory. The arrow defers the `killSwitch` read to
// call time, so per-test reassignment is seen (avoids the vitest-hoist TDZ
// footgun where a factory reading a not-yet-initialized let would throw).
let killSwitch = true;
vi.mock('../config/env', () => ({ mfaForcePartnerAdmin: () => killSwitch }));

import { getEffectiveMfaPolicy } from './mfaPolicy';

beforeEach(() => {
  roleRows.length = 0;
  effectiveSecurity = undefined;
  effectiveThrows = false;
  killSwitch = true;
});

describe('getEffectiveMfaPolicy', () => {
  it('system scope: never required, all methods allowed, no joins', async () => {
    const p = await getEffectiveMfaPolicy({ scope: 'system', userId: 'u1', orgId: null, partnerId: null });
    expect(p.required).toBe(false);
    expect(p.allowedMethods).toEqual({ totp: true, sms: true, passkey: true });
  });

  it('org role force_mfa=true forces required', async () => {
    roleRows.push({ forceMfa: true });
    const p = await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(p.required).toBe(true);
    expect(p.source.roleForceMfa).toBe(true);
  });

  it('org settings requireMfa=true forces required even when role does not', async () => {
    roleRows.push({ forceMfa: false });
    effectiveSecurity = { requireMfa: true };
    const p = await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(p.required).toBe(true);
    expect(p.source.settingsRequireMfa).toBe(true);
  });

  it('allowedMethods.sms=false disables sms; passkey stays allowed', async () => {
    roleRows.push({ forceMfa: false });
    effectiveSecurity = { allowedMethods: { totp: true, sms: false } };
    const p = await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(p.allowedMethods).toEqual({ totp: true, sms: false, passkey: true });
  });

  it('kill switch off suppresses role-force: role force_mfa=true + no settings requireMfa => not required', async () => {
    killSwitch = false;
    roleRows.push({ forceMfa: true });
    effectiveSecurity = undefined; // no settings requireMfa
    const p = await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(p.required).toBe(false);
    expect(p.source.killSwitchOff).toBe(true);
  });

  it('kill switch off does NOT suppress settings: settings requireMfa=true (role false) => still required', async () => {
    killSwitch = false;
    roleRows.push({ forceMfa: false });
    effectiveSecurity = { requireMfa: true };
    const p = await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(p.required).toBe(true);
    expect(p.source.settingsRequireMfa).toBe(true);
  });

  it('fails open on settings read error: not required, methods allowed', async () => {
    roleRows.push({ forceMfa: false });
    effectiveThrows = true;
    const p = await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(p.required).toBe(false);
    expect(p.allowedMethods).toEqual({ totp: true, sms: true, passkey: true });
  });
});
