import { describe, expect, it } from 'vitest';
import { runSaveUnits, unitOrder, isUnitValid, UNIT_TABS, type SaveOutcome, type SaveUnit, type SaveUnitId, type TabValidity } from './saveUnits';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const VALID: TabValidity = { isValid: true, invalidCount: 0, firstInvalidFieldId: null };
const INVALID: TabValidity = { isValid: false, invalidCount: 1, firstInvalidFieldId: 'x' };

function fakeUnit(id: SaveUnitId, opts: { dirty?: boolean; valid?: boolean; save?: () => Promise<SaveOutcome> } = {}): SaveUnit & { calls: number } {
  const unit = {
    id,
    tabs: UNIT_TABS[id],
    calls: 0,
    isDirty: () => opts.dirty ?? true,
    validity: () => Object.fromEntries(UNIT_TABS[id].map(t => [t, opts.valid === false ? INVALID : VALID])),
    save: async () => {
      unit.calls += 1;
      return opts.save ? opts.save() : { status: 'saved' as const, savedAt: 1 };
    },
  };
  return unit;
}

describe('saveUnits', () => {
  it('maps the ten partners/me tabs to one unit', () => {
    expect(UNIT_TABS.partnersMe).toEqual([
      'company', 'regional', 'defaults', 'eventLogs', 'remoteAccess', 'security', 'notifications', 'aiBudgets', 'aiApprovals', 'branding',
    ]);
    expect(UNIT_TABS.aiFeatureDefaults).toEqual(['aiProvider']);
    expect(UNIT_TABS.aiDataPolicy).toEqual(['aiFeatures']);
  });

  it('orders units by their earliest tab in the rail', () => {
    const ids = unitOrder([
      fakeUnit('trustCenter'), fakeUnit('aiDataPolicy'), fakeUnit('loginBranding'),
      fakeUnit('aiFeatureDefaults'), fakeUnit('callerVerification'), fakeUnit('partnersMe'),
    ]).map(u => u.id);
    expect(ids).toEqual(['partnersMe', 'callerVerification', 'aiFeatureDefaults', 'aiDataPolicy', 'loginBranding', 'trustCenter']);
  });

  it('a unit is valid only when every tab entry is valid', () => {
    expect(isUnitValid(fakeUnit('partnersMe'))).toBe(true);
    expect(isUnitValid(fakeUnit('partnersMe', { valid: false }))).toBe(false);
  });

  it('runs dirty valid units sequentially in rail order', async () => {
    const events: string[] = [];
    const gates = { partnersMe: deferred<void>(), loginBranding: deferred<void>(), trustCenter: deferred<void>() };
    const make = (id: keyof typeof gates) => fakeUnit(id, {
      save: async () => {
        events.push(`start:${id}`);
        await gates[id].promise;
        events.push(`end:${id}`);
        return { status: 'saved', savedAt: 1 };
      },
    });
    const run = runSaveUnits([make('trustCenter'), make('loginBranding'), make('partnersMe')]);
    await Promise.resolve();
    expect(events).toEqual(['start:partnersMe']);
    gates.partnersMe.resolve();
    await new Promise(r => setTimeout(r, 0));
    expect(events).toEqual(['start:partnersMe', 'end:partnersMe', 'start:loginBranding']);
    gates.loginBranding.resolve();
    gates.trustCenter.resolve();
    const outcomes = await run;
    expect(events).toEqual([
      'start:partnersMe', 'end:partnersMe', 'start:loginBranding', 'end:loginBranding', 'start:trustCenter', 'end:trustCenter',
    ]);
    expect(Object.keys(outcomes)).toEqual(['partnersMe', 'loginBranding', 'trustCenter']);
  });

  it('skips clean and invalid units', async () => {
    const clean = fakeUnit('partnersMe', { dirty: false });
    const invalid = fakeUnit('loginBranding', { valid: false });
    const ok = fakeUnit('trustCenter');
    const outcomes = await runSaveUnits([clean, invalid, ok]);
    expect(clean.calls).toBe(0);
    expect(invalid.calls).toBe(0);
    expect(ok.calls).toBe(1);
    expect(outcomes).toEqual({ trustCenter: { status: 'saved', savedAt: 1 } });
  });

  it('a failure does not stop later units', async () => {
    const failing = fakeUnit('partnersMe', { save: async () => ({ status: 'failed' }) });
    const later = fakeUnit('loginBranding');
    const outcomes = await runSaveUnits([failing, later]);
    expect(later.calls).toBe(1);
    expect(outcomes.partnersMe).toEqual({ status: 'failed' });
    expect(outcomes.loginBranding?.status).toBe('saved');
  });

  it('a save that throws is reported as failed and later units still run', async () => {
    const throwing = fakeUnit('partnersMe', { save: async () => { throw new Error('boom'); } });
    const later = fakeUnit('trustCenter');
    const outcomes = await runSaveUnits([throwing, later]);
    expect(outcomes.partnersMe).toEqual({ status: 'failed' });
    expect(later.calls).toBe(1);
  });

  it('retry re-runs only failed units', async () => {
    let loginDirty = true;
    let meDirty = true;
    const me = fakeUnit('partnersMe', { save: async () => { meDirty = false; return { status: 'saved', savedAt: 1 }; } });
    me.isDirty = () => meDirty;
    const login = fakeUnit('loginBranding', { save: async () => ({ status: 'failed' }) });
    login.isDirty = () => loginDirty;
    await runSaveUnits([me, login]);
    expect([me.calls, login.calls]).toEqual([1, 1]);
    await runSaveUnits([me, login]);
    expect([me.calls, login.calls]).toEqual([1, 2]);
    loginDirty = false;
  });
});
