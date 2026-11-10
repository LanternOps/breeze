import { afterEach, describe, expect, it, vi } from 'vitest';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('./proxyTrustBootCheck', () => ({ warnOnTrustedProxyCidrMismatch: warnSpy }));

import { validateConfig } from './validate';

const baseEnv: Record<string, string> = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/breeze',
  DATABASE_URL_APP: 'postgresql://breeze_app:request-secret@localhost:5432/breeze',
  JWT_SECRET: 'a7f3b9c2d1e4f6a8b0c3d5e7f9a1b3c5e7d9f1a3b5c7d9e1f3a5b7c9d1e3f5',
  APP_ENCRYPTION_KEY: '440e7e4bafb77c92cc38f818c90ad2e4c155089a438e6a790572a328e532b60a',
  MFA_ENCRYPTION_KEY: 'a725b6546832661a86e27bf46ea556099f163efc5a5f1daa58697f13f6204510',
  NODE_ENV: 'development',
  TRUSTED_PROXY_CIDRS: '198.51.100.7/32',
};

describe('validateConfig → proxy-trust boot check wiring (#2987)', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
    warnSpy.mockClear();
  });

  it('runs the check once, with the process env, after a successful validation', () => {
    process.env = { ...saved, ...baseEnv };
    validateConfig();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatchObject({ TRUSTED_PROXY_CIDRS: '198.51.100.7/32' });
  });

  it('does not run when validation fails', () => {
    process.env = { ...saved, ...baseEnv, JWT_SECRET: '' };
    expect(() => validateConfig()).toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
