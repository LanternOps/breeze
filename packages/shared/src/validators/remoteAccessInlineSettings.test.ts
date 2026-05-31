import { describe, expect, it } from 'vitest';
import { remoteAccessInlineSettingsSchema } from './remoteAccessInlineSettings';

describe('remoteAccessInlineSettingsSchema', () => {
  it('parses a valid partial object', () => {
    const result = remoteAccessInlineSettingsSchema.safeParse({
      clipboardHostToViewer: false,
      idleTimeoutMinutes: 15,
      maxSessionDurationHours: 12,
    });

    expect(result.success).toBe(true);
  });

  it('fails for a non-boolean clipboard flag', () => {
    const result = remoteAccessInlineSettingsSchema.safeParse({
      clipboardHostToViewer: 'yes',
    });

    expect(result.success).toBe(false);
  });

  it('fails for lifetime values above the configured maximums', () => {
    expect(
      remoteAccessInlineSettingsSchema.safeParse({ idleTimeoutMinutes: 1441 }).success
    ).toBe(false);
    expect(
      remoteAccessInlineSettingsSchema.safeParse({ maxSessionDurationHours: 169 }).success
    ).toBe(false);
  });

  it('fails for negative lifetime values', () => {
    expect(
      remoteAccessInlineSettingsSchema.safeParse({ idleTimeoutMinutes: -1 }).success
    ).toBe(false);
    expect(
      remoteAccessInlineSettingsSchema.safeParse({ maxSessionDurationHours: -1 }).success
    ).toBe(false);
  });

  it('parses an empty object', () => {
    const result = remoteAccessInlineSettingsSchema.safeParse({});

    expect(result.success).toBe(true);
  });
});
