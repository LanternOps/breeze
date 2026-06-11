import { afterEach, describe, expect, it, vi } from 'vitest';

describe('auth feature flag defaults', () => {
  const originalEnableRegistration = process.env.ENABLE_REGISTRATION;

  afterEach(() => {
    if (originalEnableRegistration === undefined) delete process.env.ENABLE_REGISTRATION;
    else process.env.ENABLE_REGISTRATION = originalEnableRegistration;
    vi.resetModules();
  });

  it('defaults public registration off unless explicitly enabled', async () => {
    delete process.env.ENABLE_REGISTRATION;
    vi.resetModules();

    const { ENABLE_REGISTRATION } = await import('./schemas');

    expect(ENABLE_REGISTRATION).toBe(false);
  });

  it('allows explicit public registration opt-in', async () => {
    process.env.ENABLE_REGISTRATION = 'true';
    vi.resetModules();

    const { ENABLE_REGISTRATION } = await import('./schemas');

    expect(ENABLE_REGISTRATION).toBe(true);
  });
});
