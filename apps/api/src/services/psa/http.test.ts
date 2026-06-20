import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { psaFetch, validatePsaBaseUrl } from './http';
import { safeFetch, SsrfBlockedError } from '../urlSafety';
import * as env from '../../config/env';

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
    // Default the suite to hosted-SaaS (strict) unless a test opts into self-host.
    vi.spyOn(env, 'isHosted').mockReturnValue(true);
    process.env.IS_HOSTED = 'true';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.IS_HOSTED;
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
        method: 'POST',
        headers: { Authorization: 'Bearer token' },
      })
    );
  });

  it('keeps hosted SaaS strict: no allowPrivateNetwork on the safeFetch call', async () => {
    await psaFetch('https://psa.example.com/api');

    expect(safeFetch).toHaveBeenCalledWith(
      'https://psa.example.com/api',
      expect.objectContaining({ allowPrivateNetwork: false })
    );
  });

  describe('on-prem (self-hosted) PSA base URLs', () => {
    it('ALLOWS http + RFC1918 PSA URLs when self-hosted', async () => {
      vi.spyOn(env, 'isHosted').mockReturnValue(false);
      process.env.IS_HOSTED = 'false';

      // Static write-time validation accepts http:// and private IPs.
      expect(validatePsaBaseUrl('http://10.0.0.5/api')).toBeNull();
      expect(validatePsaBaseUrl('https://jira.corp.local/rest')).toBeNull();

      // Call-time path threads allowPrivateNetwork through to safeFetch so
      // DNS-resolved RFC1918 targets aren't blocked.
      await psaFetch('http://10.0.0.5/api');
      expect(safeFetch).toHaveBeenCalledWith(
        'http://10.0.0.5/api',
        expect.objectContaining({ allowPrivateNetwork: true })
      );
    });

    it('BLOCKS http + RFC1918 PSA URLs when hosted SaaS', async () => {
      vi.spyOn(env, 'isHosted').mockReturnValue(true);
      process.env.IS_HOSTED = 'true';

      expect(validatePsaBaseUrl('http://10.0.0.5/api')).toBe('URL must use https://');
      expect(validatePsaBaseUrl('https://10.0.0.5/api')).toContain('private/RFC1918');

      await expect(psaFetch('http://10.0.0.5/api')).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(safeFetch).not.toHaveBeenCalled();
    });

    it('fails closed: garbage IS_HOSTED stays strict', async () => {
      // isHosted() (envFlag) returns false for unrecognized values, but the
      // private-network gate must NOT open without an affirmative self-host signal.
      vi.spyOn(env, 'isHosted').mockReturnValue(false);
      process.env.IS_HOSTED = 'banana';

      expect(validatePsaBaseUrl('http://10.0.0.5/api')).toBe('URL must use https://');
      await expect(psaFetch('http://10.0.0.5/api')).rejects.toBeInstanceOf(SsrfBlockedError);
      expect(safeFetch).not.toHaveBeenCalled();
    });
  });
});
