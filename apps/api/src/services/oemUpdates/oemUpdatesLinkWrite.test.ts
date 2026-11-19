import { describe, expect, it, vi } from 'vitest';

const { effectiveRows } = vi.hoisted(() => ({ effectiveRows: { value: [] as Array<{ inlineSettings: unknown }> } }));

// Reads (the effective link a new override replaces) are answered; any write throws.
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => effectiveRows.value }) }) })),
    transaction: vi.fn(() => { throw new Error('db must not be reached'); }),
  },
}));

import {
  assertOemUpdatesLinkWrite,
  checkOemUpdatesLinkWrite,
  closedGateCategories,
  OemUpdatesLinkWriteError,
  type OemUpdatesLinkWriteInput,
} from './oemUpdatesLinkWrite';
import { addFeatureLink, updateFeatureLink } from '../configurationPolicy';
import { oemUpdatesInlineSettingsSchema } from '@breeze/shared';

const POLICY_ID = '22222222-2222-2222-2222-222222222222';
const SCHEDULE = { weekOfMonth: 'third', dayOfWeek: 'wed', windowStart: '01:00', windowHours: 4 };

const settings = (over: Record<string, unknown> = {}, dell: Record<string, unknown> = {}) => ({
  version: 1,
  enabled: true,
  schedule: SCHEDULE,
  catchUpNights: 7,
  reboot: 'overnight',
  vendors: { dell: { enabled: true, categories: { driver: true }, blockedUpdateIds: [], ...dell } },
  ...over,
});
const OFF = settings({ enabled: false });

// Driver and application open for Dell; bios and firmware closed; every other lane closed.
const DRIVER_OPEN = (lane: string, category: string) => lane === 'dell' && (category === 'driver' || category === 'application');
const ALL_CLOSED = () => false;

function code(input: OemUpdatesLinkWriteInput, gateOpen = DRIVER_OPEN) {
  const result = checkOemUpdatesLinkWrite(input, { isCategoryGateOpen: gateOpen });
  return result.ok ? 'ok' : result.refusal.body.code;
}

describe('checkOemUpdatesLinkWrite', () => {
  it('arming without execute is 403 before validation: the caller learns nothing else', () => {
    const everythingWrong = { ...settings({}, { categories: { bios: true } }), extra: 1 };
    expect(code({ featurePolicyId: POLICY_ID, previous: null, next: everythingWrong, armAuthorized: false }))
      .toBe('oem_updates_execute_required');
    expect(code({ featurePolicyId: POLICY_ID, previous: null, next: everythingWrong, armAuthorized: true }))
      .toBe('oem_updates_feature_policy_not_allowed');
    expect(code({ featurePolicyId: null, previous: null, next: everythingWrong, armAuthorized: true }))
      .toBe('oem_updates_invalid_settings');
    expect(code({ featurePolicyId: null, previous: null, next: settings({}, { categories: { bios: true } }), armAuthorized: true }))
      .toBe('oem_updates_category_gate_closed');
  });

  it('arming with execute and MFA passes, and returns the parsed settings to store', () => {
    const result = checkOemUpdatesLinkWrite(
      { featurePolicyId: null, previous: null, next: settings(), armAuthorized: true },
      { isCategoryGateOpen: DRIVER_OPEN },
    );
    expect(result).toEqual({ ok: true, inlineSettings: settings() });
  });

  it('narrowing with devices.write passes: switching off, removing a category, adding a blocked ID', () => {
    const armed = settings({}, { categories: { driver: true, application: true } });
    for (const next of [
      settings({ enabled: false }, { categories: { driver: true, application: true } }),
      settings({}, { categories: { driver: true } }),
      settings({}, { categories: { driver: true, application: true }, blockedUpdateIds: ['ABC12'] }),
      settings({ schedule: { ...SCHEDULE, windowStart: '00:00' } }, { categories: { driver: true, application: true } }),
    ]) {
      expect(code({ featurePolicyId: null, previous: armed, next, armAuthorized: false })).toBe('ok');
    }
  });

  it('a disabled link needs only devices.write', () => {
    expect(code({ featurePolicyId: null, previous: null, next: OFF, armAuthorized: false })).toBe('ok');
  });

  it('newly arming over an existing link needs execute', () => {
    expect(code({ featurePolicyId: null, previous: OFF, next: settings(), armAuthorized: false }))
      .toBe('oem_updates_execute_required');
    expect(code({
      featurePolicyId: null,
      previous: settings(),
      next: settings({}, { categories: { driver: true, application: true } }),
      armAuthorized: false,
    })).toBe('oem_updates_execute_required');
  });

  it('bios true on a closed gate is 400, even with the policy and vendor off', () => {
    for (const next of [
      settings({}, { categories: { bios: true } }),
      settings({ enabled: false }, { enabled: false, categories: { bios: true } }),
      settings({ vendors: { hp: { enabled: false, categories: { driver: true } } } }),
    ]) {
      const result = checkOemUpdatesLinkWrite(
        { featurePolicyId: null, previous: null, next, armAuthorized: true },
        { isCategoryGateOpen: DRIVER_OPEN },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusal.status).toBe(400);
        expect(result.refusal.body.code).toBe('oem_updates_category_gate_closed');
      }
    }
  });

  it('names every closed category and accepts an explicit false on one', () => {
    const result = checkOemUpdatesLinkWrite(
      { featurePolicyId: null, previous: null, next: settings({}, { categories: { bios: true, firmware: true, driver: true } }), armAuthorized: true },
      { isCategoryGateOpen: DRIVER_OPEN },
    );
    expect(result.ok ? null : result.refusal.body.categories).toEqual(['dell:bios', 'dell:firmware']);
    expect(code({ featurePolicyId: null, previous: null, next: settings({}, { categories: { bios: false, driver: true } }), armAuthorized: true })).toBe('ok');
  });

  it('uses the real manifest by default, where every gate is closed today', () => {
    expect(closedGateCategories(oemUpdatesInlineSettingsSchema.parse(settings()))).toEqual(['dell:driver']);
    const result = checkOemUpdatesLinkWrite({ featurePolicyId: null, previous: null, next: settings(), armAuthorized: true });
    expect(result.ok ? 'ok' : result.refusal.body.code).toBe('oem_updates_category_gate_closed');
    // A vendor on with nothing selected stores fine with every gate closed.
    expect(code({ featurePolicyId: null, previous: null, next: settings({}, { categories: {} }), armAuthorized: true }, ALL_CLOSED)).toBe('ok');
  });

  it('a category already stored true may be resent on a closed gate, so narrowing never fails on it', () => {
    const stored = settings({}, { categories: { bios: true, driver: true } });
    // Switching off and blocking an update, with bios still true from when its gate was open.
    for (const next of [
      settings({ enabled: false }, { categories: { bios: true, driver: true } }),
      settings({}, { categories: { bios: true, driver: true }, blockedUpdateIds: ['X1'] }),
    ]) {
      expect(code({ featurePolicyId: null, previous: stored, next, armAuthorized: false })).toBe('ok');
    }
    // A newly true closed category is still refused, even next to a resent one.
    expect(code({
      featurePolicyId: null,
      previous: stored,
      next: settings({}, { categories: { bios: true, firmware: true, driver: true } }),
      armAuthorized: true,
    })).toBe('oem_updates_category_gate_closed');
  });

  it('a previous that no longer parses counts as nothing armed', () => {
    // Leniently armed, but the resolver treats it as disabled: removing the bad key must not arm silently.
    const corrupt = { ...settings(), unknownKey: true };
    expect(code({ featurePolicyId: null, previous: corrupt, next: settings(), armAuthorized: false }))
      .toBe('oem_updates_execute_required');
    // Nor may it vouch for a closed category.
    const corruptBios = { ...settings({}, { categories: { bios: true } }), unknownKey: true };
    expect(code({ featurePolicyId: null, previous: corruptBios, next: settings({}, { categories: { bios: true } }), armAuthorized: true }))
      .toBe('oem_updates_category_gate_closed');
  });

  it('featurePolicyId set is 400', () => {
    expect(code({ featurePolicyId: POLICY_ID, previous: null, next: OFF, armAuthorized: false }))
      .toBe('oem_updates_feature_policy_not_allowed');
    expect(code({ featurePolicyId: POLICY_ID, previous: OFF, next: undefined, armAuthorized: false }))
      .toBe('oem_updates_feature_policy_not_allowed');
  });

  it('a PATCH without settings only checks featurePolicyId', () => {
    expect(code({ featurePolicyId: null, previous: settings(), next: undefined, armAuthorized: false })).toBe('ok');
    expect(code({ featurePolicyId: undefined, previous: settings(), next: undefined, armAuthorized: false })).toBe('ok');
  });

  it('null or malformed settings are 400 and never echo the rejected value', () => {
    expect(code({ featurePolicyId: null, previous: null, next: null, armAuthorized: true })).toBe('oem_updates_invalid_settings');
    const result = checkOemUpdatesLinkWrite(
      { featurePolicyId: null, previous: null, next: { ...OFF, secretKey: 'hunter2' }, armAuthorized: false },
      { isCategoryGateOpen: DRIVER_OPEN },
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});

describe('service backstop (#11070)', () => {
  it('assertOemUpdatesLinkWrite throws the refusal as OemUpdatesLinkWriteError', () => {
    try {
      assertOemUpdatesLinkWrite({ featurePolicyId: null, previous: null, next: settings(), armAuthorized: false });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OemUpdatesLinkWriteError);
      expect((err as OemUpdatesLinkWriteError).status).toBe(403);
      expect((err as OemUpdatesLinkWriteError).code).toBe('oem_updates_execute_required');
    }
  });

  it('addFeatureLink refuses to arm without the option, before any database write', async () => {
    effectiveRows.value = [];
    await expect(addFeatureLink(POLICY_ID, 'oem_updates', null, settings()))
      .rejects.toMatchObject({ code: 'oem_updates_execute_required', status: 403 });
  });

  it('addFeatureLink compares against the inherited link: an override that narrows needs only devices.write', async () => {
    effectiveRows.value = [{ inlineSettings: settings({}, { categories: { driver: true, application: true } }) }];
    // Narrowing reaches the write (which the mock refuses); arming is still refused.
    // (Real manifest: every gate is closed, so the narrowed link stores no category.)
    await expect(addFeatureLink(POLICY_ID, 'oem_updates', null, settings({ enabled: false }, { categories: {} })))
      .rejects.toThrow('db must not be reached');
    effectiveRows.value = [{ inlineSettings: OFF }];
    await expect(addFeatureLink(POLICY_ID, 'oem_updates', null, settings({}, { categories: {} })))
      .rejects.toMatchObject({ code: 'oem_updates_execute_required' });
  });

  it('addFeatureLink with arming authorized still refuses a closed gate', async () => {
    await expect(addFeatureLink(POLICY_ID, 'oem_updates', null, settings(), undefined, undefined, { oemUpdatesArmAuthorized: true }))
      .rejects.toMatchObject({ code: 'oem_updates_category_gate_closed', status: 400 });
  });

  it('addFeatureLink refuses a featurePolicyId and missing settings', async () => {
    await expect(addFeatureLink(POLICY_ID, 'oem_updates', POLICY_ID, OFF))
      .rejects.toMatchObject({ code: 'oem_updates_feature_policy_not_allowed' });
    await expect(addFeatureLink(POLICY_ID, 'oem_updates', null, null))
      .rejects.toMatchObject({ code: 'oem_updates_invalid_settings' });
  });

  it('updateFeatureLink applies the same backstop against the stored row, inside its transaction', async () => {
    const existing = { id: 'link-1', configPolicyId: POLICY_ID, featureType: 'oem_updates', featurePolicyId: null, inlineSettings: OFF };
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [existing] }) }) }),
      update: vi.fn(() => { throw new Error('must not write'); }),
    };
    const executor = { transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as any;
    await expect(updateFeatureLink('link-1', { inlineSettings: settings({}, { categories: {} }) }, POLICY_ID, undefined, executor))
      .rejects.toMatchObject({ code: 'oem_updates_execute_required' });
    // Narrowing an armed stored row reaches the write.
    existing.inlineSettings = settings({}, { categories: {} });
    await expect(updateFeatureLink('link-1', { inlineSettings: settings({ enabled: false }, { categories: {} }) }, POLICY_ID, undefined, executor))
      .rejects.toThrow('must not write');
    expect(tx.update).toHaveBeenCalled();
  });
});
