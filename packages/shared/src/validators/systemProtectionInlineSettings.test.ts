import { describe, it, expect } from 'vitest';
import {
  systemProtectionInlineSettingsSchema,
  SYSTEM_PROTECTION_DEFAULTS,
} from './systemProtectionInlineSettings';
import { addFeatureLinkSchema } from './index';

describe('systemProtectionInlineSettingsSchema', () => {
  it('applies the legacy-parity defaults for an empty object', () => {
    const parsed = systemProtectionInlineSettingsSchema.parse({});
    // beforePatching defaults TRUE to match what the agent already does today
    // (a point per non-definitions update); the two new paths default FALSE so
    // enabling the feature never surprises a fleet.
    expect(parsed).toEqual({
      beforePatching: true,
      beforeScripts: false,
      beforeSoftwareInstall: false,
      labelPrefix: 'Breeze',
    });
    expect(SYSTEM_PROTECTION_DEFAULTS).toEqual(parsed);
  });

  it('fills unspecified fields from the defaults when only one toggle is set', () => {
    expect(systemProtectionInlineSettingsSchema.parse({ beforeScripts: true })).toEqual({
      beforePatching: true,
      beforeScripts: true,
      beforeSoftwareInstall: false,
      labelPrefix: 'Breeze',
    });
  });

  it('freezes the defaults constant so callers cannot mutate the shared value', () => {
    expect(Object.isFrozen(SYSTEM_PROTECTION_DEFAULTS)).toBe(true);
  });

  it('rejects unknown keys rather than silently persisting them', () => {
    // An AI-guessed key like `beforeRemoteTerminal` must not be stored and
    // echoed back as if it took effect -- the runtime reader would ignore it.
    const res = systemProtectionInlineSettingsSchema.safeParse({
      beforePatching: true,
      beforeRemoteTerminal: true,
    });
    expect(res.success).toBe(false);
  });

  it('rejects a non-boolean toggle', () => {
    expect(systemProtectionInlineSettingsSchema.safeParse({ beforeScripts: 'yes' }).success).toBe(false);
    expect(systemProtectionInlineSettingsSchema.safeParse({ beforeScripts: 1 }).success).toBe(false);
    expect(systemProtectionInlineSettingsSchema.safeParse({ beforePatching: null }).success).toBe(false);
  });

  it('bounds labelPrefix to 64 characters and rejects an empty one', () => {
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: 'x'.repeat(64) }).success).toBe(true);
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: 'x'.repeat(65) }).success).toBe(false);
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: '' }).success).toBe(false);
    // Whitespace-only would produce a description with no visible prefix.
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: '   ' }).success).toBe(false);
  });

  it('rejects a labelPrefix containing control characters', () => {
    // It ends up inside a fixed-width native UTF-16 buffer AND inside the
    // unique description that identity verification matches on.
    const withSOH = 'a' + String.fromCharCode(1) + 'b';
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: withSOH }).success).toBe(false);
    const withNewline = 'a' + String.fromCharCode(10) + 'b';
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: withNewline }).success).toBe(false);
    const withDEL = 'a' + String.fromCharCode(127) + 'b';
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: withDEL }).success).toBe(false);
    expect(systemProtectionInlineSettingsSchema.safeParse({ labelPrefix: 'Breeze Ops' }).success).toBe(true);
  });

  it('does NOT accept an onFailure / abort knob -- v1 is reporting-only', () => {
    // Strict modes are v2, shaped as PER-ACTION off | best_effort |
    // require_recent. A global onFailure is the wrong granularity.
    expect(systemProtectionInlineSettingsSchema.safeParse({ onFailure: 'abort' }).success).toBe(false);
  });
});

describe('addFeatureLinkSchema system_protection', () => {
  it('accepts system_protection with inlineSettings', () => {
    const res = addFeatureLinkSchema.safeParse({
      featureType: 'system_protection',
      inlineSettings: { beforeScripts: true },
    });
    expect(res.success).toBe(true);
  });
});
