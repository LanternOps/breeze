import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isVendorCanaryPartner,
  VENDOR_STAGES,
  vendorCanaryFingerprint,
  vendorPairDisabled,
  vendorStage,
} from './vendorCanary';

// Fake partners only. The real canary partner is an env value and never appears in the repo.
const CANARY = 'aaaaaaaa-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('vendorStage', () => {
  it('empty env: every pair is off', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', '');
    for (const [feature, vendors] of Object.entries(VENDOR_STAGES)) {
      for (const vendor of Object.keys(vendors)) {
        expect(vendorStage(feature as keyof typeof VENDOR_STAGES, vendor, CANARY)).toBe('off');
      }
    }
  });

  it('unset env is off too', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', undefined as unknown as string);
    expect(vendorStage('oem_updates', 'surface', CANARY)).toBe('off');
  });

  it('partner listed + table observe: observe', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    expect(vendorStage('oem_updates', 'surface', CANARY)).toBe('observe');
    expect(vendorStage('oem_updates', 'lenovo', CANARY.toUpperCase())).toBe('observe');
    expect(vendorStage('hp_warranty', 'hp', CANARY)).toBe('observe');
  });

  it('partner not listed: off', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    expect(vendorStage('oem_updates', 'surface', OTHER)).toBe('off');
    expect(vendorStage('oem_updates', 'surface', null)).toBe('off');
  });

  it('a pair with no table entry is off for a canary partner', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    expect(vendorStage('oem_updates', 'dell', CANARY)).toBe('off');
    expect(vendorStage('hp_warranty', 'lenovo', CANARY)).toBe('off');
    expect(vendorStage('oem_updates', 'toString', CANARY)).toBe('off');
    expect(vendorStage('oem_updates', '__proto__', CANARY)).toBe('off');
  });

  it('disabled pair: off, and only that pair', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    vi.stubEnv('BREEZE_VENDOR_CANARY_DISABLED', 'oem_updates:hp, wake_on_lan:lenovo');
    expect(vendorStage('oem_updates', 'hp', CANARY)).toBe('off');
    expect(vendorStage('wake_on_lan', 'lenovo', CANARY)).toBe('off');
    expect(vendorStage('oem_updates', 'lenovo', CANARY)).toBe('observe');
    expect(vendorStage('wake_on_lan', 'hp', CANARY)).toBe('observe');
    expect(vendorPairDisabled('oem_updates', 'hp')).toBe(true);
    expect(vendorPairDisabled('oem_updates', 'lenovo')).toBe(false);
  });
});

describe('isVendorCanaryPartner', () => {
  it('is the list, case-insensitive, and nothing when empty', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', '');
    expect(isVendorCanaryPartner(CANARY)).toBe(false);
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', ` ${CANARY.toUpperCase()} `);
    expect(isVendorCanaryPartner(CANARY)).toBe(true);
    expect(isVendorCanaryPartner(OTHER)).toBe(false);
    expect(isVendorCanaryPartner(null)).toBe(false);
  });
});

describe('VENDOR_STAGES', () => {
  it('equals the reviewed table', () => {
    // A stage change must be a visible diff here, in a PR carrying observe evidence.
    expect(VENDOR_STAGES).toEqual({
      oem_updates: { surface: 'observe', hp: 'observe', lenovo: 'observe' },
      wake_on_lan: { hp: 'observe', lenovo: 'observe', surface: 'observe' },
      hp_warranty: { hp: 'observe' },
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(VENDOR_STAGES)).toBe(true);
    expect(Object.isFrozen(VENDOR_STAGES.oem_updates)).toBe(true);
  });
});

describe('vendorCanaryFingerprint', () => {
  it('changes when the env changes, and not on order or case', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', '');
    const off = vendorCanaryFingerprint();
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', `${CANARY},${OTHER}`);
    const two = vendorCanaryFingerprint();
    expect(two).not.toBe(off);
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', `${OTHER.toUpperCase()}, ${CANARY}`);
    expect(vendorCanaryFingerprint()).toBe(two);
    vi.stubEnv('BREEZE_VENDOR_CANARY_DISABLED', 'oem_updates:hp');
    expect(vendorCanaryFingerprint()).not.toBe(two);
  });

  it('changes when the table changes', () => {
    vi.stubEnv('BREEZE_VENDOR_CANARY_PARTNER_IDS', CANARY);
    const before = vendorCanaryFingerprint();
    expect(vendorCanaryFingerprint(VENDOR_STAGES)).toBe(before);
    expect(vendorCanaryFingerprint({
      ...VENDOR_STAGES,
      oem_updates: { ...VENDOR_STAGES.oem_updates, surface: 'act' },
    })).not.toBe(before);
  });
});
