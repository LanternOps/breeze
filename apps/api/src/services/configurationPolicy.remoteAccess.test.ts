import { describe, it, expect } from 'vitest';
import { remoteAccessInlineSettingsSchema } from './configurationPolicy';

describe('remoteAccessInlineSettingsSchema', () => {
  it('applies spec defaults when empty', () => {
    const parsed = remoteAccessInlineSettingsSchema.parse({});
    expect(parsed).toEqual({
      sessionPromptMode: 'notify',
      consentUnavailableBehavior: 'proceed',
      notifyOnSessionEnd: true,
      showActiveIndicator: true,
      technicianIdentityLevel: 'name_email',
    });
  });

  it('rejects an invalid mode', () => {
    expect(() => remoteAccessInlineSettingsSchema.parse({ sessionPromptMode: 'always' })).toThrow();
  });

  it('rejects unknown keys (.strict())', () => {
    expect(() => remoteAccessInlineSettingsSchema.parse({ sessionPromptMode: 'consent', bogusKey: 1 })).toThrow();
  });
});
