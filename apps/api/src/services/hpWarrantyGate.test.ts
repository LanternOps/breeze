import { afterEach, describe, expect, it, vi } from 'vitest';
import { warrantySettingsWireSchema } from '@breeze/shared/validators';
import { HP_WARRANTY_ACT_TIERS, hpCmslMode, toWarrantySettingsWire } from './hpWarrantyGate';
import { VENDOR_STAGES } from './vendorCanary';

// Synthetic partner ids; the canary partner is never named in this repo.
const CANARY = '00000000-0000-4000-8000-0000000000c1';
const OTHER = '00000000-0000-4000-8000-0000000000c2';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hpCmslMode', () => {
  it('is off for a partner that is not in the canary list, even with current consent', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    expect(hpCmslMode(true, OTHER)).toBe('off');
  });

  it('is off for everyone while the canary list is empty', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', '');
    expect(hpCmslMode(true, CANARY)).toBe('off');
  });

  it('is observe for the canary partner with consent to the current EULA', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    expect(hpCmslMode(true, CANARY)).toBe('observe');
    expect(hpCmslMode(true, CANARY.toUpperCase())).toBe('observe');
  });

  it('is off for the canary partner without effective consent (none, or a superseded EULA)', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    expect(hpCmslMode(false, CANARY)).toBe('off');
  });

  it('is off when the pair is disabled', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    vi.stubEnv('BREEZE_VENDOR_CANARY_DISABLED', 'hp_warranty:hp');
    expect(hpCmslMode(true, CANARY)).toBe('off');
  });

  it('is off with no partner', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    expect(hpCmslMode(true, null)).toBe('off');
    expect(hpCmslMode(true, undefined)).toBe('off');
  });
});

describe('toWarrantySettingsWire', () => {
  it('always sends all three fields, and each parses against the shared wire schema', () => {
    for (const mode of ['off', 'observe', 'act'] as const) {
      const wire = toWarrantySettingsWire(mode);
      expect(Object.keys(wire).sort()).toEqual(['hp_cmsl_enabled', 'hp_cmsl_mode', 'hp_cmsl_tiers']);
      const parsed = warrantySettingsWireSchema.safeParse(wire);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it('sends hp_cmsl_enabled false unless the mode is act, so a persisted true is revoked', () => {
    expect(toWarrantySettingsWire('off')).toEqual({ hp_cmsl_enabled: false, hp_cmsl_mode: 'off', hp_cmsl_tiers: [] });
    expect(toWarrantySettingsWire('observe')).toEqual({
      hp_cmsl_enabled: false,
      hp_cmsl_mode: 'observe',
      hp_cmsl_tiers: [],
    });
    expect(toWarrantySettingsWire('act').hp_cmsl_enabled).toBe(true);
  });

  it('sends the open tiers only when the mode is act', () => {
    expect(toWarrantySettingsWire('act', ['t0_ingest']).hp_cmsl_tiers).toEqual(['t0_ingest']);
    expect(toWarrantySettingsWire('observe', ['t0_ingest']).hp_cmsl_tiers).toEqual([]);
    expect(toWarrantySettingsWire('off', ['t0_ingest']).hp_cmsl_tiers).toEqual([]);
  });

  it('returns a copy of the tier list, never the frozen constant', () => {
    const tiers = toWarrantySettingsWire('act', ['t0_ingest']).hp_cmsl_tiers;
    tiers.push('install');
    expect(toWarrantySettingsWire('act', ['t0_ingest']).hp_cmsl_tiers).toEqual(['t0_ingest']);
  });
});

describe('stage snapshot (each change is its own reviewed PR with observe evidence)', () => {
  it('opens no act tier', () => {
    expect(HP_WARRANTY_ACT_TIERS).toEqual([]);
    expect(Object.isFrozen(HP_WARRANTY_ACT_TIERS)).toBe(true);
  });

  it('keeps hp_warranty:hp at observe', () => {
    expect(VENDOR_STAGES.hp_warranty).toEqual({ hp: 'observe' });
  });
});
