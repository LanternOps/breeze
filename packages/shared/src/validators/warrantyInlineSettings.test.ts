import { describe, expect, it } from 'vitest';
import {
  HP_CMSL_EULA_ID,
  readRecordedWarrantyHpCmslConsent,
  clientSuppliedWarrantyHpCmslConsent,
  storedWarrantyInlineSettingsSchema,
  warrantyHpCmslCollectionEffective,
  warrantyHpCmslRequested,
  warrantyInlineSettingsSchema,
  warrantySettingsWireSchema,
  HP_CMSL_ACT_TIERS,
  HP_CMSL_MODES,
} from './warrantyInlineSettings';

const CONSENT = {
  acceptedByUserId: 'user-1',
  acceptedAt: '2026-09-10T12:00:00.000Z',
  eulaId: HP_CMSL_EULA_ID,
};

describe('warrantyInlineSettingsSchema (client-facing)', () => {
  it('accepts the legacy three-field alerting shape unchanged', () => {
    const parsed = warrantyInlineSettingsSchema.safeParse({
      enabled: true,
      warnDays: 90,
      criticalDays: 30,
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an hpCmsl block with only `enabled`', () => {
    const parsed = warrantyInlineSettingsSchema.safeParse({
      enabled: true,
      warnDays: 90,
      criticalDays: 30,
      hpCmsl: { enabled: true },
    });
    expect(parsed.success).toBe(true);
  });

  it('REFUSES a client-supplied consent object (D3 — never silently stripped)', () => {
    const parsed = warrantyInlineSettingsSchema.safeParse({
      hpCmsl: { enabled: true, consent: CONSENT },
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses an unknown top-level key rather than persisting it', () => {
    expect(warrantyInlineSettingsSchema.safeParse({ hpCsml: { enabled: true } }).success).toBe(false);
  });

  it('refuses an hpCmsl block with no `enabled`', () => {
    expect(warrantyInlineSettingsSchema.safeParse({ hpCmsl: {} }).success).toBe(false);
  });
});

describe('storedWarrantyInlineSettingsSchema (server/stored)', () => {
  it('accepts a stamped consent', () => {
    const parsed = storedWarrantyInlineSettingsSchema.safeParse({
      hpCmsl: { enabled: true, consent: CONSENT },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a consent with a non-ISO acceptedAt', () => {
    const parsed = storedWarrantyInlineSettingsSchema.safeParse({
      hpCmsl: { enabled: true, consent: { ...CONSENT, acceptedAt: 'yesterday' } },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('clientSuppliedWarrantyHpCmslConsent', () => {
  it('is true when the key is present at all, even undefined-valued', () => {
    expect(clientSuppliedWarrantyHpCmslConsent({ hpCmsl: { enabled: true, consent: undefined } })).toBe(true);
    expect(clientSuppliedWarrantyHpCmslConsent({ hpCmsl: { enabled: true, consent: null } })).toBe(true);
  });

  it('is false for a clean payload and for non-objects', () => {
    expect(clientSuppliedWarrantyHpCmslConsent({ hpCmsl: { enabled: true } })).toBe(false);
    expect(clientSuppliedWarrantyHpCmslConsent({ enabled: true })).toBe(false);
    expect(clientSuppliedWarrantyHpCmslConsent(null)).toBe(false);
    expect(clientSuppliedWarrantyHpCmslConsent('nope')).toBe(false);
  });
});

describe('warrantyHpCmslRequested (pre-stamp gate input)', () => {
  it('is true for an enable request that carries no consent yet', () => {
    expect(warrantyHpCmslRequested({ hpCmsl: { enabled: true } })).toBe(true);
  });

  it('is false for an explicit disable, an absent block, and junk', () => {
    expect(warrantyHpCmslRequested({ hpCmsl: { enabled: false } })).toBe(false);
    expect(warrantyHpCmslRequested({ enabled: true, warnDays: 90 })).toBe(false);
    expect(warrantyHpCmslRequested({ hpCmsl: 'yes' })).toBe(false);
    expect(warrantyHpCmslRequested(undefined)).toBe(false);
  });
});

describe('warrantyHpCmslCollectionEffective (delivery + inheritance gates)', () => {
  it('is true only for enabled + consent against the current EULA id', () => {
    expect(warrantyHpCmslCollectionEffective({ hpCmsl: { enabled: true, consent: CONSENT } })).toBe(true);
  });

  it('is false when consent is missing entirely', () => {
    expect(warrantyHpCmslCollectionEffective({ hpCmsl: { enabled: true } })).toBe(false);
  });

  it('is false when consent names a superseded EULA id (D2 — re-consent required)', () => {
    expect(
      warrantyHpCmslCollectionEffective({
        hpCmsl: { enabled: true, consent: { ...CONSENT, eulaId: 'hp-cmsl-eula-2020-01-01' } },
      }),
    ).toBe(false);
  });

  it('is false for a disabled block that still carries consent', () => {
    expect(warrantyHpCmslCollectionEffective({ hpCmsl: { enabled: false, consent: CONSENT } })).toBe(false);
  });

  it('is false for a malformed block — fail safe, never collect on a blob we cannot read', () => {
    expect(warrantyHpCmslCollectionEffective({ hpCmsl: { enabled: true, consent: CONSENT, extra: 1 } })).toBe(false);
    expect(warrantyHpCmslCollectionEffective(null)).toBe(false);
  });

  it('ignores unrelated alert-threshold junk on the same object', () => {
    // The block predicates parse the hpCmsl SUB-BLOCK only, deliberately: a
    // stray or out-of-range warnDays must not silently switch collection off.
    expect(
      warrantyHpCmslCollectionEffective({ warnDays: 99999, hpCmsl: { enabled: true, consent: CONSENT } }),
    ).toBe(true);
  });
});

describe('readRecordedWarrantyHpCmslConsent', () => {
  it('returns the acceptance verbatim, superseded or not', () => {
    expect(readRecordedWarrantyHpCmslConsent({ hpCmsl: { enabled: true, consent: CONSENT } })).toEqual(CONSENT);
    const old = { ...CONSENT, eulaId: 'hp-cmsl-eula-2020-01-01' };
    expect(readRecordedWarrantyHpCmslConsent({ hpCmsl: { enabled: true, consent: old } })).toEqual(old);
  });

  it('returns null when there is no acceptance or the block is unreadable', () => {
    expect(readRecordedWarrantyHpCmslConsent({ hpCmsl: { enabled: true } })).toBeNull();
    expect(readRecordedWarrantyHpCmslConsent({ enabled: true })).toBeNull();
    expect(readRecordedWarrantyHpCmslConsent({ hpCmsl: { enabled: true, extra: 1 } })).toBeNull();
    expect(readRecordedWarrantyHpCmslConsent(undefined)).toBeNull();
  });
});

describe('warrantySettingsWireSchema (heartbeat warranty_settings, #5511 observe-first §1)', () => {
  const wire = (v: Record<string, unknown>) => warrantySettingsWireSchema.safeParse(v).success;

  it('accepts off and observe with empty tiers and enabled false', () => {
    for (const mode of ['off', 'observe'] as const) {
      expect(wire({ hp_cmsl_enabled: false, hp_cmsl_mode: mode, hp_cmsl_tiers: [] })).toBe(true);
    }
  });

  it('accepts act with enabled true and known tiers, including none open yet', () => {
    expect(wire({ hp_cmsl_enabled: true, hp_cmsl_mode: 'act', hp_cmsl_tiers: ['t0_ingest'] })).toBe(true);
    expect(wire({ hp_cmsl_enabled: true, hp_cmsl_mode: 'act', hp_cmsl_tiers: [] })).toBe(true);
  });

  it('requires every field: an omitted key would leave an older agent on its persisted flag', () => {
    expect(wire({ hp_cmsl_mode: 'off', hp_cmsl_tiers: [] })).toBe(false);
    expect(wire({ hp_cmsl_enabled: false, hp_cmsl_tiers: [] })).toBe(false);
    expect(wire({ hp_cmsl_enabled: false, hp_cmsl_mode: 'off' })).toBe(false);
  });

  it('refuses enabled true unless the mode is act, and act without enabled', () => {
    expect(wire({ hp_cmsl_enabled: true, hp_cmsl_mode: 'observe', hp_cmsl_tiers: [] })).toBe(false);
    expect(wire({ hp_cmsl_enabled: false, hp_cmsl_mode: 'act', hp_cmsl_tiers: [] })).toBe(false);
  });

  it('refuses tiers outside act, unknown tiers, duplicates and extra keys', () => {
    expect(wire({ hp_cmsl_enabled: false, hp_cmsl_mode: 'observe', hp_cmsl_tiers: ['t0_ingest'] })).toBe(false);
    expect(wire({ hp_cmsl_enabled: true, hp_cmsl_mode: 'act', hp_cmsl_tiers: ['t9'] })).toBe(false);
    expect(wire({ hp_cmsl_enabled: true, hp_cmsl_mode: 'act', hp_cmsl_tiers: ['t0_ingest', 't0_ingest'] })).toBe(false);
    expect(wire({ hp_cmsl_enabled: false, hp_cmsl_mode: 'off', hp_cmsl_tiers: [], extra: 1 })).toBe(false);
  });

  it('lists the modes and the act tiers in opening order', () => {
    expect(HP_CMSL_MODES).toEqual(['off', 'observe', 'act']);
    expect(HP_CMSL_ACT_TIERS).toEqual(['t0_ingest', 't1_refresh', 'install']);
  });
});
