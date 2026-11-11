import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDnsTxtResolverForTest } from '../../emailDomains/dnsOwnershipProof';
import { dnsTxtChecker, portalDomainTxtRecord } from './dnsTxt';
import type { DomainCheckTarget } from '../types';

const target = (over: Partial<DomainCheckTarget> = {}): DomainCheckTarget => ({
  rowId: 'row-1',
  orgId: 'org-1',
  partnerId: 'partner-1',
  domain: 'acme.test',
  verificationToken: 'tok123',
  ...over,
});

const resolveWith = (records: string[][]) => {
  const resolveTxt = vi.fn(async (_h: string) => records);
  setDnsTxtResolverForTest({ resolveTxt });
  return resolveTxt;
};

describe('dnsTxtChecker', () => {
  afterEach(() => setDnsTxtResolverForTest(null));

  it('builds the record name and value', () => {
    expect(portalDomainTxtRecord('acme.test', 'tok123')).toEqual({
      recordName: '_breeze-verify.acme.test',
      recordValue: 'breeze-verification=tok123',
    });
    expect(dnsTxtChecker.method).toBe('dns_txt');
  });

  it('passes on breeze-verification=<token> among other TXT records at _breeze-verify.<domain>', async () => {
    const resolveTxt = resolveWith([['v=spf1 -all'], ['breeze-verification=', 'tok123']]);
    await expect(dnsTxtChecker.check(target())).resolves.toEqual({
      status: 'pass',
      evidence: { via: 'dns_txt', recordName: '_breeze-verify.acme.test' },
    });
    expect(resolveTxt).toHaveBeenCalledWith('_breeze-verify.acme.test');
  });

  it("fails record_missing on another org's token, SSO's breeze-domain-verify=<token>, or a raw token", async () => {
    for (const value of ['breeze-verification=other', 'breeze-domain-verify=tok123', 'tok123']) {
      resolveWith([[value]]);
      await expect(dnsTxtChecker.check(target())).resolves.toEqual({ status: 'fail', reason: 'record_missing' });
    }
  });

  it('fails record_missing when the name is absent', async () => {
    setDnsTxtResolverForTest({
      resolveTxt: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); },
    });
    await expect(dnsTxtChecker.check(target())).resolves.toEqual({ status: 'fail', reason: 'record_missing' });
  });

  it('passes unavailable lookups through', async () => {
    setDnsTxtResolverForTest({
      resolveTxt: async () => { throw Object.assign(new Error('x'), { code: 'ESERVFAIL' }); },
    });
    await expect(dnsTxtChecker.check(target())).resolves.toEqual({ status: 'unavailable', reason: 'dns_error' });
  });

  it('fails record_missing without a lookup when the row has no token', async () => {
    const resolveTxt = resolveWith([['breeze-verification=null']]);
    await expect(dnsTxtChecker.check(target({ verificationToken: null }))).resolves.toEqual({
      status: 'fail',
      reason: 'record_missing',
    });
    expect(resolveTxt).not.toHaveBeenCalled();
  });

  it('compares the token exactly (case and whitespace inside the value matter)', async () => {
    for (const value of ['breeze-verification=TOK123', 'breeze-verification= tok123', 'breeze-verification=tok 123']) {
      resolveWith([[value]]);
      await expect(dnsTxtChecker.check(target())).resolves.toEqual({ status: 'fail', reason: 'record_missing' });
    }
  });
});
