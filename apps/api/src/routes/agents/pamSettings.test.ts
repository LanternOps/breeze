import { describe, expect, it } from 'vitest';
import { PAM_DEFAULTS, parsePamSettings } from './pamSettings';

describe('parsePamSettings', () => {
  it('defaults to interception enabled', () => {
    expect(PAM_DEFAULTS.uacInterceptionEnabled).toBe(true);
  });

  it('returns defaults for null/undefined/non-object input', () => {
    expect(parsePamSettings(null)).toEqual(PAM_DEFAULTS);
    expect(parsePamSettings(undefined)).toEqual(PAM_DEFAULTS);
    expect(parsePamSettings('nope')).toEqual(PAM_DEFAULTS);
    expect(parsePamSettings(42)).toEqual(PAM_DEFAULTS);
  });

  it('honors an explicit false', () => {
    expect(parsePamSettings({ uacInterceptionEnabled: false })).toEqual({
      uacInterceptionEnabled: false,
    });
  });

  it('honors an explicit true', () => {
    expect(parsePamSettings({ uacInterceptionEnabled: true })).toEqual({
      uacInterceptionEnabled: true,
    });
  });

  it('falls back to default when the key is missing or mistyped', () => {
    expect(parsePamSettings({})).toEqual(PAM_DEFAULTS);
    expect(parsePamSettings({ uacInterceptionEnabled: 'false' })).toEqual(PAM_DEFAULTS);
    expect(parsePamSettings({ uacInterceptionEnabled: 0 })).toEqual(PAM_DEFAULTS);
  });
});
