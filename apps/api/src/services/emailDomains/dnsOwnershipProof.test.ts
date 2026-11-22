import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  generateOwnershipToken,
  lookupTxtValues,
  ownershipTxtRecordName,
  setDnsTxtResolverForTest,
  verifyDnsOwnershipToken,
} from './dnsOwnershipProof';

describe('generateOwnershipToken', () => {
  it('returns a random, sufficiently long token each call', () => {
    const a = generateOwnershipToken();
    const b = generateOwnershipToken();
    expect(a).not.toEqual(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });
});

describe('ownershipTxtRecordName', () => {
  it('prefixes the domain with the well-known verification label', () => {
    expect(ownershipTxtRecordName('mail.acme.test')).toBe('_breeze-verify.mail.acme.test');
  });
});

describe('verifyDnsOwnershipToken', () => {
  afterEach(() => setDnsTxtResolverForTest(null));

  it('returns true when the TXT record at _breeze-verify.<domain> equals the token', async () => {
    const resolveTxt = vi.fn(async (hostname: string) => {
      expect(hostname).toBe('_breeze-verify.mail.acme.test');
      return [['tok-123']];
    });
    setDnsTxtResolverForTest({ resolveTxt });
    await expect(verifyDnsOwnershipToken('mail.acme.test', 'tok-123')).resolves.toBe(true);
  });

  it('joins multi-chunk TXT records the way DNS actually returns long strings', async () => {
    setDnsTxtResolverForTest({ resolveTxt: async () => [['tok-', '123']] });
    await expect(verifyDnsOwnershipToken('mail.acme.test', 'tok-123')).resolves.toBe(true);
  });

  it('returns false when no TXT record matches the token', async () => {
    setDnsTxtResolverForTest({ resolveTxt: async () => [['some-other-value']] });
    await expect(verifyDnsOwnershipToken('mail.acme.test', 'tok-123')).resolves.toBe(false);
  });

  it('returns false (never throws) when DNS resolution fails, e.g. NXDOMAIN', async () => {
    setDnsTxtResolverForTest({
      resolveTxt: async () => { throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' }); },
    });
    await expect(verifyDnsOwnershipToken('mail.acme.test', 'tok-123')).resolves.toBe(false);
  });

  it('returns false against an empty or null token rather than matching any record', async () => {
    setDnsTxtResolverForTest({ resolveTxt: async () => [['']] });
    await expect(verifyDnsOwnershipToken('mail.acme.test', '')).resolves.toBe(false);
  });
});

describe('lookupTxtValues', () => {
  afterEach(() => setDnsTxtResolverForTest(null));

  it('lookupTxtValues joins chunks and trims', async () => {
    setDnsTxtResolverForTest({ resolveTxt: async () => [['  a-', 'b  '], ['plain']] });
    await expect(lookupTxtValues('_breeze-verify.acme.test')).resolves.toEqual({
      kind: 'answer',
      values: ['a-b', 'plain'],
    });
  });

  it('ENOTFOUND and ENODATA are absent', async () => {
    for (const code of ['ENOTFOUND', 'ENODATA']) {
      setDnsTxtResolverForTest({
        resolveTxt: async () => { throw Object.assign(new Error(code), { code }); },
      });
      await expect(lookupTxtValues('x.acme.test')).resolves.toEqual({ kind: 'absent' });
    }
  });

  it('SERVFAIL is unavailable dns_error, not absent', async () => {
    setDnsTxtResolverForTest({
      resolveTxt: async () => { throw Object.assign(new Error('SERVFAIL'), { code: 'ESERVFAIL' }); },
    });
    await expect(lookupTxtValues('x.acme.test')).resolves.toEqual({ kind: 'unavailable', reason: 'dns_error' });
  });

  it('a lookup slower than the timeout is unavailable timeout', async () => {
    setDnsTxtResolverForTest({ resolveTxt: () => new Promise(() => {}) });
    await expect(lookupTxtValues('x.acme.test', 20)).resolves.toEqual({ kind: 'unavailable', reason: 'timeout' });
  });
});
