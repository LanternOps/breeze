import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadFlag(value: string | undefined): Promise<boolean> {
  vi.resetModules();
  if (value === undefined) vi.stubEnv('PUBLIC_ENABLE_ENDPOINT_MESSAGING', '');
  else vi.stubEnv('PUBLIC_ENABLE_ENDPOINT_MESSAGING', value);
  return (await import('./featureFlags')).ENABLE_ENDPOINT_MESSAGING;
}

describe('ENABLE_ENDPOINT_MESSAGING', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is on when the build sets nothing, so the published web image shows messaging and chat', async () => {
    expect(await loadFlag(undefined)).toBe(true);
  });

  it('can still be switched off at build time', async () => {
    expect(await loadFlag('false')).toBe(false);
  });

  it('stays on when set to true', async () => {
    expect(await loadFlag('true')).toBe(true);
  });
});
