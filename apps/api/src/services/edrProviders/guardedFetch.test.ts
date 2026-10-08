import { describe, expect, it, vi } from 'vitest';
import { createGuardedFetch, hostAllowed, validateVendorUrl } from './guardedFetch';

const GZ = ['.gravityzone.bitdefender.com'];

describe('validateVendorUrl (Review Focus 4)', () => {
  it.each([
    ['https://cloud.gravityzone.bitdefender.com/api', true],
    ['https://cloudrbx.ovh.gravityzone.bitdefender.com/api', true],
    ['http://cloud.gravityzone.bitdefender.com/api', false],
    ['https://cloud.gravityzone.bitdefender.com.evil.example/api', false],
    ['https://evil.example/api?x=.gravityzone.bitdefender.com', false],
    ['https://gravityzone.bitdefender.com.attacker.io/api', false],
    ['https://gravityzone.bitdefender.com/api', false],
    [`https://user:pw${'@'}cloud.gravityzone.bitdefender.com/api`, false],
    ['https://cloud.gravityzone.bitdefender.com/other', false],
    ['https://127.0.0.1/api', false],
    ['https://169.254.169.254/api', false],
    ['not a url', false],
  ])('validateVendorUrl(%s) ok=%s', (url, ok) => {
    expect(validateVendorUrl(url, GZ, { pathPrefix: '/api' }).ok).toBe(ok);
  });

  it('a bare allowlist entry is an exact host, not a suffix', () => {
    expect(hostAllowed('id.sophos.com', ['id.sophos.com'])).toBe(true);
    expect(hostAllowed('xid.sophos.com', ['id.sophos.com'])).toBe(false);
    expect(hostAllowed('CLOUD.GravityZone.Bitdefender.com.', GZ)).toBe(true);
  });
});

describe('createGuardedFetch', () => {
  it('refuses every disallowed URL before calling the fetch implementation', async () => {
    const fetchImpl = vi.fn();
    const f = createGuardedFetch(GZ, { fetchImpl: fetchImpl as never });
    for (const url of [
      'https://example.com/api/v1.0/jsonrpc/network',
      'https://evil.example/?x=.gravityzone.bitdefender.com',
      'https://cloud.gravityzone.bitdefender.com.evil.example/api',
      'http://cloud.gravityzone.bitdefender.com/api',
    ]) {
      await expect(f(url, { method: 'POST', headers: {} })).rejects.toMatchObject({
        code: 'host_not_allowed',
        scope: 'connection',
        reauth: false,
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('delegates an allowed URL with a body-size cap and timeout', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: async () => '{}',
    });
    const f = createGuardedFetch(GZ, { fetchImpl: fetchImpl as never, maxBytes: 1234 });
    const res = await f('https://cloud.gravityzone.bitdefender.com/api/v1.0/jsonrpc/network', {
      method: 'POST',
      headers: { a: 'b' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{}');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ method: 'POST', maxBytes: 1234, timeoutMs: 30_000, body: '{}' });
  });
});
