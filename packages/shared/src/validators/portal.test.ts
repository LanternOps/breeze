import { describe, it, expect } from 'vitest';
import { updatePortalSettingsSchema } from './portal';

describe('updatePortalSettingsSchema', () => {
  it('accepts a full valid payload', () => {
    const result = updatePortalSettingsSchema.safeParse({
      enableTickets: false,
      enableAssetCheckout: true,
      enableSelfService: true,
      enablePasswordReset: false,
      supportEmail: 'help@msp.example',
      supportPhone: '+1 555 0100',
      welcomeMessage: 'Welcome to support',
      footerText: 'MSP Inc.'
    });
    expect(result.success).toBe(true);
  });

  it('accepts a partial payload (single toggle)', () => {
    expect(updatePortalSettingsSchema.safeParse({ enableTickets: false }).success).toBe(true);
  });

  it('accepts an empty object (route layer rejects no-op separately)', () => {
    expect(updatePortalSettingsSchema.safeParse({}).success).toBe(true);
  });

  it('accepts null for the nullable string fields', () => {
    const result = updatePortalSettingsSchema.safeParse({
      supportEmail: null, supportPhone: null, welcomeMessage: null, footerText: null
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown keys (visual branding fields are not writable here)', () => {
    expect(updatePortalSettingsSchema.safeParse({ customDomain: 'evil.example' }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ logoUrl: 'https://x/y.png' }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ domainVerified: true }).success).toBe(false);
  });

  it('rejects an invalid support email', () => {
    expect(updatePortalSettingsSchema.safeParse({ supportEmail: 'not-an-email' }).success).toBe(false);
  });

  it('rejects null booleans', () => {
    expect(updatePortalSettingsSchema.safeParse({ enableTickets: null }).success).toBe(false);
  });

  it('accepts a supportEmail at exactly the 255-char limit', () => {
    const email = `${'a'.repeat(245)}@b.example`; // 245 + 10 = 255 chars
    expect(email).toHaveLength(255);
    expect(updatePortalSettingsSchema.safeParse({ supportEmail: email }).success).toBe(true);
  });

  it('accepts supportEmail: null on its own', () => {
    expect(updatePortalSettingsSchema.safeParse({ supportEmail: null }).success).toBe(true);
  });

  it('rejects over-length strings', () => {
    expect(updatePortalSettingsSchema.safeParse({ supportPhone: 'x'.repeat(51) }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ supportEmail: `${'a'.repeat(250)}@b.example` }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ welcomeMessage: 'x'.repeat(2001) }).success).toBe(false);
    expect(updatePortalSettingsSchema.safeParse({ footerText: 'x'.repeat(2001) }).success).toBe(false);
  });
});
