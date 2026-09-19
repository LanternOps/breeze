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

// #5306 grace window. The DEFAULT fixture is "no grant" (the account has held a
// factor at some point, mfa_epoch > 1) so every pre-existing expectation below
// still describes immediate role-force enforcement; the grace suite overrides it.
let graceFacts: { hasFactor: boolean; deadline: Date | null; expired: boolean } =
  { hasFactor: false, deadline: null, expired: false };
const evaluateMfaEnrollmentGraceMock = vi.fn(async () => graceFacts);
vi.mock('./mfaEnrollmentGrace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mfaEnrollmentGrace')>()),
  evaluateMfaEnrollmentGrace: (...args: unknown[]) => evaluateMfaEnrollmentGraceMock(...(args as [])),
}));

import { getEffectiveMfaPolicy } from './mfaPolicy';
import { getEffectiveOrgSettings } from './effectiveSettings';

beforeEach(() => {
  roleRows.length = 0;
  partnerRoleRows.length = 0;
  partnerSettingsRows.length = 0;
  effectiveSecurity = undefined;
  effectiveThrows = false;
  killSwitch = true;
  graceFacts = { hasFactor: false, deadline: null, expired: false };
  evaluateMfaEnrollmentGraceMock.mockClear();
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
  it('fails closed for tenant-disableable methods when failClosedMethods is set', async () => {
    roleRows.push({ forceMfa: false });
    effectiveThrows = true;
    const p = await getEffectiveMfaPolicy(
      { scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null },
      { failClosedMethods: true },
    );
    expect(p.allowedMethods).toEqual({ totp: false, sms: false, passkey: true });
  });

  it('I5: fails CLOSED (required) on settings read error when opts.failClosed is set', async () => {
    roleRows.push({ forceMfa: false });
    effectiveThrows = true;
    const p = await getEffectiveMfaPolicy(
      { scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null },
      { failClosed: true },
    );
    expect(p.required).toBe(true);
  });

  it('denies configurable methods on a real settings read error in strict method mode', async () => {
    roleRows.push({ forceMfa: false });
    effectiveThrows = true;
    const p = await getEffectiveMfaPolicy(
      { scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null },
      { failClosed: true, failClosedMethods: true },
    );
    expect(p.required).toBe(true);
    expect(p.allowedMethods).toEqual({ totp: false, sms: false, passkey: true });
  });

  it('strict method mode preserves resolved method policy when the settings read succeeds', async () => {
    roleRows.push({ forceMfa: false });
    effectiveSecurity = { allowedMethods: { totp: true, sms: false } };
    const p = await getEffectiveMfaPolicy(
      { scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null },
      { failClosed: true, failClosedMethods: true },
    );
    expect(p.allowedMethods).toEqual({ totp: true, sms: false, passkey: true });
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

// #5306 - a role-forced user gets a notification period before force_mfa bites.
// The window relaxes ONLY the role-force axis, only for an account with no
// factor, and only while the kill switch is ON (with it off the role force is
// already suppressed, so there is nothing to postpone).
describe('enrolment grace window (#5306)', () => {
  const future = () => new Date(Date.now() + 5 * 86_400_000);

  it('inside the window: role-forced, factorless user is NOT required and the deadline is surfaced', async () => {
    partnerRoleRows.push({ forceMfa: true });
    const deadline = future();
    graceFacts = { hasFactor: false, deadline, expired: false };
    const p = await getEffectiveMfaPolicy({ scope: 'partner', userId: 'u1', orgId: null, partnerId: 'p1' });
    expect(p.required).toBe(false);
    expect(p.pendingEnrollment).toEqual({ deadline: deadline.toISOString() });
    expect(p.source.graceWindow).toBe('active');
    expect(p.source.roleForceMfa).toBe(true);
  });

  it('past the window: required exactly as before the feature, no pending window', async () => {
    partnerRoleRows.push({ forceMfa: true });
    graceFacts = { hasFactor: false, deadline: new Date(Date.now() - 1000), expired: true };
    const p = await getEffectiveMfaPolicy({ scope: 'partner', userId: 'u1', orgId: null, partnerId: 'p1' });
    expect(p.required).toBe(true);
    expect(p.pendingEnrollment).toBeNull();
    expect(p.source.graceWindow).toBe('expired');
  });

  it('a user who already holds a factor is required during the window (self-disable stays blocked)', async () => {
    partnerRoleRows.push({ forceMfa: true });
    graceFacts = { hasFactor: true, deadline: null, expired: false };
    const p = await getEffectiveMfaPolicy({ scope: 'partner', userId: 'u1', orgId: null, partnerId: 'p1' });
    expect(p.required).toBe(true);
    expect(p.pendingEnrollment).toBeNull();
  });

  it('kill switch off: no window is opened at all (role force already suppressed)', async () => {
    killSwitch = false;
    partnerRoleRows.push({ forceMfa: true });
    graceFacts = { hasFactor: false, deadline: future(), expired: false };
    const p = await getEffectiveMfaPolicy({ scope: 'partner', userId: 'u1', orgId: null, partnerId: 'p1' });
    expect(p.required).toBe(false);
    expect(p.pendingEnrollment).toBeNull();
    expect(p.source.graceWindow).toBe('none');
    expect(evaluateMfaEnrollmentGraceMock).not.toHaveBeenCalled();
  });

  it('settings requireMfa=true is unaffected by the window (strictest-wins)', async () => {
    partnerRoleRows.push({ forceMfa: true });
    partnerSettingsRows.push({ settings: { security: { requireMfa: true } } });
    graceFacts = { hasFactor: false, deadline: future(), expired: false };
    const p = await getEffectiveMfaPolicy({ scope: 'partner', userId: 'u1', orgId: null, partnerId: 'p1' });
    expect(p.required).toBe(true);
    expect(p.pendingEnrollment).toBeNull();
    expect(evaluateMfaEnrollmentGraceMock).not.toHaveBeenCalled();
  });

  it('a non-role-forced user never opens a window (no extra query, no pending field)', async () => {
    roleRows.push({ forceMfa: false });
    const p = await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(p.required).toBe(false);
    expect(p.pendingEnrollment).toBeNull();
    expect(evaluateMfaEnrollmentGraceMock).not.toHaveBeenCalled();
  });

  it('org scope resolves the window length from partner-inherited effective settings', async () => {
    roleRows.push({ forceMfa: true });
    effectiveSecurity = { mfaEnrollmentGraceDays: 3 };
    graceFacts = { hasFactor: false, deadline: future(), expired: false };
    await getEffectiveMfaPolicy({ scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null });
    expect(evaluateMfaEnrollmentGraceMock).toHaveBeenCalledWith('u1', 3);
  });

  it('system scope carries no window', async () => {
    const p = await getEffectiveMfaPolicy({ scope: 'system', userId: 'u1', orgId: null, partnerId: null });
    expect(p.pendingEnrollment).toBeNull();
    expect(p.source.graceWindow).toBe('none');
  });

  // The grace read sits OUTSIDE the settings try/catch on purpose: a failure
  // there is a hard error, not optional enrichment. If someone later "helpfully"
  // wraps it, this test fails instead of the resolver quietly deciding
  // `required: false` off an unreadable grant.
  it('propagates a grace-read failure instead of swallowing it into a permissive verdict', async () => {
    partnerRoleRows.push({ forceMfa: true });
    evaluateMfaEnrollmentGraceMock.mockRejectedValueOnce(new Error('grace read boom'));

    await expect(
      getEffectiveMfaPolicy({ scope: 'partner', userId: 'u1', orgId: null, partnerId: 'p1' }),
    ).rejects.toThrow('grace read boom');
  });

  it('a settings-read failure under failClosed still requires MFA even with an active window', async () => {
    partnerRoleRows.push({ forceMfa: true });
    effectiveThrows = true;
    graceFacts = { hasFactor: false, deadline: future(), expired: false };
    const p = await getEffectiveMfaPolicy(
      { scope: 'organization', userId: 'u1', orgId: 'o1', partnerId: null },
      { failClosed: true },
    );
    expect(p.required).toBe(true);
  });
});
