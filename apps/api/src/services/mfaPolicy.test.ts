import { describe, it, expect, vi, beforeEach } from 'vitest';

const roleRows: { forceMfa: boolean }[] = [];
const partnerRoleRows: { forceMfa: boolean }[] = [];
const partnerSettingsRows: { settings: Record<string, unknown> }[] = [];
let effectiveSecurity: Record<string, unknown> | undefined;
let effectiveThrows = false;

// The resolver issues three distinct select().from(<table>) queries (org role
// join, partner role join, direct partner-settings read) that must resolve to
// different fixtures. Route on the actual table object passed to `.from()` —
// schema tables aren't mocked here, so identity against the real exports is
// reliable. `partners`/`partnerUsers` are pulled in via an async factory (vi.mock
// factories run before the top-level `import`s below, so they can't close over
// a same-file import) — this doesn't affect timing since nothing else awaits
// module init here.
vi.mock('../db', async () => {
  const { partnerUsers } = await import('../db/schema/users');
  const { partners } = await import('../db/schema/orgs');
  let lastFrom: unknown;
  const chain = {
    from: (tbl: unknown) => {
      lastFrom = tbl;
      return chain;
    },
    innerJoin: () => chain,
    where: () => chain,
    limit: () => {
      if (lastFrom === partnerUsers) return Promise.resolve(partnerRoleRows);
      if (lastFrom === partners) return Promise.resolve(partnerSettingsRows);
      return Promise.resolve(roleRows);
    },
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
import { getEffectiveOrgSettings } from './effectiveSettings';

beforeEach(() => {
  roleRows.length = 0;
  partnerRoleRows.length = 0;
  partnerSettingsRows.length = 0;
  effectiveSecurity = undefined;
  effectiveThrows = false;
  killSwitch = true;
  vi.mocked(getEffectiveOrgSettings).mockClear();
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

  // I5: control gates (self-disable, last-factor removal) pass { failClosed: true }
  // so a transient settings-read error cannot relax org/partner-required MFA.
  it('I5: fails CLOSED (required) on settings read error when opts.failClosed is set', async () => {
    roleRows.push({ forceMfa: false });
    effectiveThrows = true;
    const p = await getEffectiveMfaPolicy(
      { scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null },
      { failClosed: true },
    );
    expect(p.required).toBe(true);
  });

  it('I5: failClosed does NOT force required when the settings read SUCCEEDS and requireMfa is false', async () => {
    roleRows.push({ forceMfa: false });
    effectiveSecurity = { requireMfa: false };
    const p = await getEffectiveMfaPolicy(
      { scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null },
      { failClosed: true },
    );
    expect(p.required).toBe(false);
  });

  describe('partner scope', () => {
    it('partner role force_mfa=true forces required (no partner settings requireMfa)', async () => {
      partnerRoleRows.push({ forceMfa: true });
      const p = await getEffectiveMfaPolicy({ scope: 'partner', userId: 'u1', orgId: null, partnerId: 'p1' });
      expect(p.required).toBe(true);
      expect(p.source.roleForceMfa).toBe(true);
    });

    it('partner settings security.requireMfa=true forces required via direct partners.settings read (role force=false)', async () => {
      partnerRoleRows.push({ forceMfa: false });
      partnerSettingsRows.push({ settings: { security: { requireMfa: true } } });
      const p = await getEffectiveMfaPolicy({ scope: 'partner', userId: 'u1', orgId: null, partnerId: 'p1' });
      expect(p.required).toBe(true);
      expect(p.source.settingsRequireMfa).toBe(true);
      // Proves the direct partners.settings path ran, not org-inheritance.
      expect(getEffectiveOrgSettings).not.toHaveBeenCalled();
    });

    it('partner settings allowedMethods.sms=false disables sms; passkey stays allowed', async () => {
      partnerRoleRows.push({ forceMfa: false });
      partnerSettingsRows.push({ settings: { security: { allowedMethods: { sms: false } } } });
      const p = await getEffectiveMfaPolicy({ scope: 'partner', userId: 'u1', orgId: null, partnerId: 'p1' });
      expect(p.allowedMethods).toEqual({ totp: true, sms: false, passkey: true });
    });

    it('kill switch off suppresses partner role-force too: role force_mfa=true + no settings requireMfa => not required', async () => {
      killSwitch = false;
      partnerRoleRows.push({ forceMfa: true });
      const p = await getEffectiveMfaPolicy({ scope: 'partner', userId: 'u1', orgId: null, partnerId: 'p1' });
      expect(p.required).toBe(false);
      expect(p.source.killSwitchOff).toBe(true);
    });
  });
});
