import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { clearArcKeyCacheForTest, evaluateTrustedArc, type ArcDeps } from './arcSeal';

type Header = { name: string; value: string };

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const P = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const attacker = generateKeyPairSync('rsa', { modulusLength: 2048 });
const RECEIVED = '2026-11-04T12:00:00Z';
const T = Math.floor(Date.parse(RECEIVED) / 1000) - 60;
const AAR_BODY = 'mx.avanan.net; dkim=pass header.d=mg.example.io; spf=pass smtp.mailfrom=mg.example.io';

function canon(h: Header): string {
  return `${h.name.toLowerCase()}:${h.value.replace(/\s+/g, ' ').trim()}`;
}

function instanceOf(h: Header): boolean {
  return /(^|;)\s*i=/.test(h.value);
}

/** Seal one more ARC set onto `prior`: a test signer written from RFC 8617 section 4.1.3. */
function seal(prior: Header[], opts: {
  i?: number; d?: string; cv?: string; t?: number; aar?: string; key?: KeyObject; a?: string; extraTag?: string;
} = {}): Header[] {
  const i = opts.i ?? 1;
  const d = opts.d ?? 'avanan.net';
  const aar: Header = { name: 'ARC-Authentication-Results', value: `i=${i}; ${opts.aar ?? AAR_BODY}` };
  const ams: Header = { name: 'ARC-Message-Signature', value: `i=${i}; a=rsa-sha256; c=relaxed/relaxed; d=${d}; s=sel; h=from; bh=AAAA; b=BBBB` };
  const tags = `i=${i}; a=${opts.a ?? 'rsa-sha256'}; t=${opts.t ?? T}; cv=${opts.cv ?? (i === 1 ? 'none' : 'pass')}; d=${d}; s=sel${opts.extraTag ?? ''}; b=`;
  const pick = (name: string, n: number): Header | undefined => prior.find(
    (h) => h.name.toLowerCase() === name && instanceOf(h) && new RegExp(`(^|;)\\s*i=${n}\\s*(;|$)`).test(h.value),
  );
  const lines: string[] = [];
  for (let n = 1; n < i; n++) {
    for (const name of ['arc-authentication-results', 'arc-message-signature', 'arc-seal']) {
      const h = pick(name, n);
      if (h) lines.push(canon(h));
    }
  }
  lines.push(canon(aar), canon(ams), canon({ name: 'ARC-Seal', value: tags }));
  const signer = createSign('sha256');
  signer.update(lines.join('\r\n'));
  const b = signer.sign(opts.key ?? privateKey, 'base64');
  return [{ name: 'ARC-Seal', value: `${tags}${b}` }, ams, aar, ...prior];
}

const dnsOk = (): ArcDeps => ({
  resolveTxt: vi.fn(async () => [[`v=DKIM1; k=rsa; p=${P}`]]),
});

describe('evaluateTrustedArc', () => {
  beforeEach(() => clearArcKeyCacheForTest());

  it('returns undefined and touches no DNS when no sealer is configured', async () => {
    const deps = dnsOk();
    expect(await evaluateTrustedArc(seal([]), [], RECEIVED, deps)).toBeUndefined();
    expect(deps.resolveTxt).not.toHaveBeenCalled();
  });

  it('verifies a genuine seal from a trusted sealer and returns its results without the i= tag', async () => {
    const deps = dnsOk();
    const r = await evaluateTrustedArc(seal([]), ['avanan.net'], RECEIVED, deps);
    expect(r).toEqual({ status: 'verified', sealer: 'avanan.net', instance: 1, authResults: AAR_BODY });
    expect(deps.resolveTxt).toHaveBeenCalledWith('sel._domainkey.avanan.net');
  });

  it('tolerates the folding and casing Graph may return', async () => {
    const folded = seal([]).map((h) => ({ name: h.name.toUpperCase(), value: h.value.replace(/; /g, ';\r\n\t') }));
    expect((await evaluateTrustedArc(folded, ['avanan.net'], RECEIVED, dnsOk()))?.status).toBe('verified');
  });

  it('never queries DNS for a seal whose d= is not on the list (attacker-chosen domain)', async () => {
    const deps = dnsOk();
    const r = await evaluateTrustedArc(seal([], { d: 'attacker.test' }), ['avanan.net'], RECEIVED, deps);
    expect(r).toEqual({ status: 'no-trusted-seal' });
    expect(deps.resolveTxt).not.toHaveBeenCalled();
  });

  it('matches d= exactly: a listed gateway host does not trust its parent domain or siblings', async () => {
    expect(await evaluateTrustedArc(seal([]), ['mx.avanan.net'], RECEIVED, dnsOk())).toEqual({ status: 'no-trusted-seal' });
    expect(await evaluateTrustedArc(seal([], { d: 'evil.avanan.net' }), ['avanan.net'], RECEIVED, dnsOk())).toEqual({ status: 'no-trusted-seal' });
  });

  it('rejects a hand-written ARC set claiming a trusted d= (signature does not verify)', async () => {
    const forged = seal([], { key: attacker.privateKey });
    const r = await evaluateTrustedArc(forged, ['avanan.net'], RECEIVED, dnsOk());
    expect(r).toMatchObject({ status: 'invalid', sealer: 'avanan.net', reason: 'signature' });
  });

  it('rejects when the results were edited after sealing', async () => {
    const edited = seal([], { aar: 'mx.avanan.net; dmarc=fail' }).map((h) => (
      h.name === 'ARC-Authentication-Results' ? { ...h, value: 'i=1; mx.avanan.net; dmarc=pass header.from=victim.test' } : h
    ));
    expect(await evaluateTrustedArc(edited, ['avanan.net'], RECEIVED, dnsOk())).toMatchObject({ status: 'invalid', reason: 'signature' });
  });

  it("an attacker's own valid seal does not launder a claim of the trusted authserv-id", async () => {
    const own = seal([], { d: 'attacker.test', key: attacker.privateKey, aar: 'mx.avanan.net; dmarc=pass header.from=victim.test' });
    expect(await evaluateTrustedArc(own, ['avanan.net'], RECEIVED, dnsOk())).toEqual({ status: 'no-trusted-seal' });
  });

  it('uses the highest trusted instance, ignoring a later untrusted seal such as Exchange sealing i=2', async () => {
    const chain = seal(seal([]), { i: 2, d: 'microsoft.com', key: attacker.privateKey, aar: 'mx.microsoft.com 1; dmarc=fail' });
    const r = await evaluateTrustedArc(chain, ['avanan.net'], RECEIVED, dnsOk());
    expect(r).toMatchObject({ status: 'verified', instance: 1, authResults: AAR_BODY });
  });

  it('takes the highest of two trusted instances and does not fall back when it fails', async () => {
    const chain = seal(seal([]), { i: 2, key: attacker.privateKey, aar: 'mx.avanan.net; dmarc=fail' });
    expect(await evaluateTrustedArc(chain, ['avanan.net'], RECEIVED, dnsOk())).toMatchObject({ status: 'invalid', reason: 'signature' });
  });

  it('rejects any instance reporting cv=fail, and a wrong cv for the instance', async () => {
    expect(await evaluateTrustedArc(seal([], { cv: 'fail' }), ['avanan.net'], RECEIVED, dnsOk())).toMatchObject({ status: 'invalid', reason: 'chain' });
    expect(await evaluateTrustedArc(seal([], { cv: 'pass' }), ['avanan.net'], RECEIVED, dnsOk())).toMatchObject({ status: 'invalid', reason: 'chain' });
    expect(await evaluateTrustedArc(seal(seal([]), { i: 2, cv: 'none' }), ['avanan.net'], RECEIVED, dnsOk())).toMatchObject({ status: 'invalid', reason: 'chain' });
    const laterFail = seal(seal([]), { i: 2, d: 'other.test', cv: 'fail', key: attacker.privateKey });
    expect(await evaluateTrustedArc(laterFail, ['avanan.net'], RECEIVED, dnsOk())).toMatchObject({ status: 'invalid', reason: 'chain' });
  });

  it('rejects a gap or duplicate in the instances', async () => {
    const gap = seal(seal([]), { i: 3 }).filter((h) => !/(^|;)\s*i=1\s*(;|$)/.test(h.value));
    expect(await evaluateTrustedArc(gap, ['avanan.net'], RECEIVED, dnsOk())).toMatchObject({ status: 'invalid', reason: 'chain' });
    const sealed = seal([]);
    expect(await evaluateTrustedArc([...sealed, sealed[0]!], ['avanan.net'], RECEIVED, dnsOk())).toMatchObject({ status: 'invalid', reason: 'chain' });
  });

  it('rejects a missing set member, a duplicate tag, and a non rsa-sha256 algorithm', async () => {
    const sealed = seal([]);
    expect(await evaluateTrustedArc(sealed.filter((h) => h.name !== 'ARC-Message-Signature'), ['avanan.net'], RECEIVED, dnsOk())).toMatchObject({ status: 'invalid', reason: 'chain' });
    expect(await evaluateTrustedArc(seal([], { extraTag: '; d=attacker.test' }), ['avanan.net'], RECEIVED, dnsOk())).toMatchObject({ status: 'invalid', reason: 'chain' });
    expect(await evaluateTrustedArc(seal([], { a: 'rsa-sha1' }), ['avanan.net'], RECEIVED, dnsOk())).toMatchObject({ status: 'invalid', reason: 'chain' });
  });

  it('rejects a seal outside the freshness window or when receipt time is unknown (replay)', async () => {
    expect(await evaluateTrustedArc(seal([], { t: T - 7 * 3600 }), ['avanan.net'], RECEIVED, dnsOk())).toMatchObject({ status: 'invalid', reason: 'stale' });
    expect(await evaluateTrustedArc(seal([], { t: T + 7 * 3600 }), ['avanan.net'], RECEIVED, dnsOk())).toMatchObject({ status: 'invalid', reason: 'stale' });
    expect(await evaluateTrustedArc(seal([]), ['avanan.net'], undefined, dnsOk())).toMatchObject({ status: 'invalid', reason: 'stale' });
  });

  it('fails closed on a DNS outage, and on an unusable or revoked key', async () => {
    const down: ArcDeps = { resolveTxt: vi.fn(async () => { throw new Error('ETIMEOUT'); }) };
    expect(await evaluateTrustedArc(seal([]), ['avanan.net'], RECEIVED, down)).toEqual({ status: 'dns-unavailable', sealer: 'avanan.net' });
    for (const rec of ['v=DKIM1; k=rsa; p=', 'v=DKIM1; k=ed25519; p=AAAA', 'v=DKIM1; p=!!notbase64']) {
      clearArcKeyCacheForTest();
      const deps: ArcDeps = { resolveTxt: vi.fn(async () => [[rec]]) };
      expect(await evaluateTrustedArc(seal([]), ['avanan.net'], RECEIVED, deps)).toMatchObject({ status: 'invalid', reason: 'key' });
    }
  });

  it('rejects an RSA key under 1024 bits', async () => {
    const weak = generateKeyPairSync('rsa', { modulusLength: 768 });
    const deps: ArcDeps = { resolveTxt: vi.fn(async () => [[`p=${weak.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`]]) };
    expect(await evaluateTrustedArc(seal([], { key: weak.privateKey }), ['avanan.net'], RECEIVED, deps)).toMatchObject({ status: 'invalid', reason: 'key' });
  });

  it('caches the key so a sweep does not query DNS per message', async () => {
    const deps = dnsOk();
    await evaluateTrustedArc(seal([]), ['avanan.net'], RECEIVED, deps);
    await evaluateTrustedArc(seal([]), ['avanan.net'], RECEIVED, deps);
    expect(deps.resolveTxt).toHaveBeenCalledTimes(1);
  });

  // Sealed by mailauth (an independent ARC implementation), not by this file's signer, so a
  // canonicalization bug shared by seal() and the verifier cannot hide here.
  describe('independent vector', () => {
    const VECTOR_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtMZ+DYm3GZXoP9UWT2R75UD9aiEM+j+p5YJl7FscY/JoR89S+5mSu/EfhLt/thjNwBQ3ykY7uBuEUBemYuK03os6hFUkqdPKqZCFUy/dk4MqXyP9qfy5A6hdnpWOVGuz2XDUqXNcvbYHXnjDFP66unji2J22F5SPnBBPLts6JgkhFc7sPkxxv6vzzcB9Masodnou43Oal2Hj+ANMAGkzUPp7ZRu5Q7jjFcsO6q1wzl2MzPfA+cQKXgn1ADNBTokPyxB876X6m9886F6dmcMN4I1rdCb0RMDlhdExfgfYOYnYjMrZiKlENLG/2D8URR/sqc0S+CGv35h5six2IlCJkQIDAQAB';
    const VECTOR_HEADERS: Header[] = [
          {
                "name": "ARC-Seal",
                "value": "i=1; a=rsa-sha256; t=1793793540; cv=none; d=avanan.net; s=sel;\r\n b=CkV+S5piEfPbYJLRSqFuAZZh6vW0VKOgdHSDfgnU25CtnGJs2dJhLb7DlVaX8ka56SmxAbbMy\r\n TyKR6D9tCwSjnghHmiiJh5zBrpkAF/BByHqL7pwcqrIUIrh3S+Wla/dJL98jrk/pLXOaZBGaHQw\r\n P1ADNVfmhDyo0NRFhWJO3X8TWwqfKhHqM0cCwW0qvUtNrPCZGPJmqfdsr/yniykv34zqrxZnBIb\r\n nRdoMCBP4RFDb8EKzyEMhMtmJ+iFVIBgSGMr0jT9ngUig5n3/cbJHtPF2dXlUNSpd0nOixJ6BVN\r\n YaWBQgS+rB9bXnEuVMOJmLfk8+OLm7uX8eiPURQresbA=="
          },
          {
                "name": "ARC-Message-Signature",
                "value": "i=1; a=rsa-sha256; c=relaxed/relaxed; d=avanan.net;\r\n h=Message-ID: Date: Subject: To: From; q=dns/txt; s=sel; t=1793793540;\r\n bh=Ba3gj8+xBPQLJTahTfzW6RbWQ/XPgESxkCi2B66PSQg=;\r\n b=hEdnvDj5H3/88Eof34dCywWJu6b20Wk6PR5lMSqh9iV8rbsFn6yMgb0fD/DrXyfTwjIhBcbUs\r\n cdUCnHPNCK3qdhf4KAp6e7rTRzPPsaX9UNVuU2k04MyxPd90+6b8zpzh/d/ubzu8T0bZqtvnS8W\r\n 87wZL/FqyVmO0cn7vTWx1hY2H4u40IqABmR7wPOF8gAUsLdd3z8+X/ozIoUiAegNXVW8yYghX4S\r\n AREGx0EzUagf7Ly2LfkN5DoBcMli/I1xpjBARIDVTIzNU+wWvQBojZEl6q3edS58al15U68Bq9I\r\n 9aL33vQOJSCCHxG7Kl6cq2ZnRZdPm7VMB16/+4n2Z4Xg=="
          },
          {
                "name": "ARC-Authentication-Results",
                "value": "i=1; mx.avanan.net; dkim=pass header.d=mg.example.io; spf=pass smtp.mailfrom=mg.example.io"
          }
    ];
    const VECTOR_RECEIVED = '2026-11-04T12:00:00Z';
    const keyDeps = (): ArcDeps => ({ resolveTxt: vi.fn(async () => [[`v=DKIM1; k=rsa; p=${VECTOR_KEY}`]]) });

    it('verifies a seal from another implementation', async () => {
      const r = await evaluateTrustedArc(VECTOR_HEADERS, ['avanan.net'], VECTOR_RECEIVED, keyDeps());
      expect(r).toMatchObject({ status: 'verified', sealer: 'avanan.net', instance: 1 });
    });

    it('verifies it unfolded, as Graph may return it', async () => {
      const unfolded = VECTOR_HEADERS.map((h) => ({ ...h, value: h.value.replace(/\r?\n[ \t]*/g, ' ') }));
      expect((await evaluateTrustedArc(unfolded, ['avanan.net'], VECTOR_RECEIVED, keyDeps()))?.status).toBe('verified');
    });

    it('control: the same vector with one results byte changed does not verify', async () => {
      const edited = VECTOR_HEADERS.map((h) => (
        h.name === 'ARC-Authentication-Results' ? { ...h, value: h.value.replace('dkim=pass', 'dkim=fail') } : h
      ));
      expect(await evaluateTrustedArc(edited, ['avanan.net'], VECTOR_RECEIVED, keyDeps())).toMatchObject({ status: 'invalid', reason: 'signature' });
    });
  });
});
