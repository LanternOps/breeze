import { describe, expect, it } from 'vitest';
import {
  WAKE_BUTTON_MODES,
  WAKE_ON_LAN_PLATFORM_DEFAULT,
  wakeOnLanInlineSettingsSchema,
} from './wakeOnLanInlineSettings';

describe('wakeOnLanInlineSettingsSchema', () => {
  it('accepts both button modes', () => {
    for (const buttonMode of WAKE_BUTTON_MODES) {
      expect(wakeOnLanInlineSettingsSchema.safeParse({ configureSettings: false, buttonMode }).success).toBe(true);
    }
  });

  it('rejects configureSettings true until writes ship', () => {
    expect(wakeOnLanInlineSettingsSchema.safeParse({ configureSettings: true, buttonMode: 'always' }).success).toBe(false);
  });

  it('rejects unknown keys and unknown modes', () => {
    expect(wakeOnLanInlineSettingsSchema.safeParse({ configureSettings: false, buttonMode: 'always', extra: 1 }).success).toBe(false);
    expect(wakeOnLanInlineSettingsSchema.safeParse({ configureSettings: false, buttonMode: 'never' }).success).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(wakeOnLanInlineSettingsSchema.safeParse({ buttonMode: 'always' }).success).toBe(false);
    expect(wakeOnLanInlineSettingsSchema.safeParse({ configureSettings: false }).success).toBe(false);
  });

  it('platform default is itself valid and shows the button on every offline device', () => {
    expect(wakeOnLanInlineSettingsSchema.safeParse(WAKE_ON_LAN_PLATFORM_DEFAULT).success).toBe(true);
    expect(WAKE_ON_LAN_PLATFORM_DEFAULT.buttonMode).toBe('always');
  });
});
