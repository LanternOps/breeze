import { describe, expect, it, vi } from 'vitest';
import { getEntraTokenInteractive, getEntraTokenSilent, type EntraTokenDeps } from './entraToken';

function deps(overrides: Partial<EntraTokenDeps> = {}): EntraTokenDeps {
  return {
    getSsoToken: vi.fn(async () => 'sso-token'),
    getMsalToken: vi.fn(async () => 'msal-token'),
    ...overrides,
  };
}

describe('getEntraTokenInteractive — fallback ordering', () => {
  it('returns the Office SSO token without touching MSAL when SSO succeeds', async () => {
    const d = deps();
    await expect(getEntraTokenInteractive(d)).resolves.toBe('sso-token');
    expect(d.getMsalToken).not.toHaveBeenCalled();
  });

  it('falls back to the MSAL popup when Office SSO fails', async () => {
    const d = deps({ getSsoToken: vi.fn(async () => Promise.reject(new Error('13001'))) });
    await expect(getEntraTokenInteractive(d)).resolves.toBe('msal-token');
    expect(d.getMsalToken).toHaveBeenCalledTimes(1);
  });
});

describe('getEntraTokenSilent', () => {
  it('never opens MSAL — rejects when SSO fails', async () => {
    const d = deps({ getSsoToken: vi.fn(async () => Promise.reject(new Error('13001'))) });
    await expect(getEntraTokenSilent(d)).rejects.toThrow('13001');
    expect(d.getMsalToken).not.toHaveBeenCalled();
  });
});
