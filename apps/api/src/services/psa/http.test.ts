import { beforeEach, describe, expect, it, vi } from 'vitest';
import { psaFetch, validatePsaBaseUrl } from './http';
import { safeFetch, SsrfBlockedError } from '../urlSafety';

vi.mock('../urlSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../urlSafety')>();
  return {
    ...actual,
    safeFetch: vi.fn(async () => new Response('{}', { status: 200 })),
  };
});

describe('PSA HTTP safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unsafe PSA base URLs before dialing', async () => {
    expect(validatePsaBaseUrl('http://psa.example.com/api')).toBe('URL must use https://');
    expect(validatePsaBaseUrl('https://169.254.169.254/latest/meta-data')).toContain('cloud-metadata');

    await expect(psaFetch('https://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(SsrfBlockedError);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('uses safeFetch with conservative PSA defaults for public HTTPS URLs', async () => {
    await psaFetch('https://psa.example.com/api', {
      method: 'POST',
      headers: { Authorization: 'Bearer token' },
    });

    expect(safeFetch).toHaveBeenCalledWith(
      'https://psa.example.com/api',
      expect.objectContaining({
        timeoutMs: 20_000,
        redirect: 'error',
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      })
    );
  });
});
