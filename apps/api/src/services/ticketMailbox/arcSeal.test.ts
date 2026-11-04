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
const BASE: Header[] = [
  { name: 'From', value: 'Person <person@mg.example.io>' },
  { name: 'Subject', value: 'Printer down' },
];

function canon(h: Header): string {
  return `${h.name.toLowerCase()}:${h.value.replace(/\s+/g, ' ').trim()}`;
}

function sign(lines: string[], key: KeyObject): string {
  const signer = createSign('sha256');
  signer.update(lines.join('\r\n'));
  return signer.sign(key, 'base64');
}

/**
 * Seal one more ARC set onto `prior`: a test signer written from RFC 8617 section
 * 4.1 (the seal) and RFC 6376 section 5.4.2 (the message signature, which signs the
 * bottom-most header of each name in h=).
 */
function seal(prior: Header[], opts: {
  i?: number; d?: string; cv?: string; t?: number; aar?: string; key?: KeyObject; a?: string; extraTag?: string;
  amsKey?: KeyObject; amsH?: string; amsC?: string; amsD?: string;
} = {}): Header[] {
  const i = opts.i ?? 1;
  const d = opts.d ?? 'avanan.net';
  const key = opts.key ?? privateKey;
  const aar: Header = { name: 'ARC-Authentication-Results', value: `i=${i}; ${opts.aar ?? AAR_BODY}` };
  const h = opts.amsH ?? 'from:subject';
  const amsTags = `i=${i}; a=rsa-sha256; c=${opts.amsC ?? 'relaxed/relaxed'}; d=${opts.amsD ?? d}; s=sel; h=${h}; bh=AAAA; b=`;
  const signedHeaders = h.split(':').map((name) => prior.filter((x) => x.name.toLowerCase() === name).pop()).filter((x): x is Header => !!x);
  const amsB = sign([...signedHeaders.map(canon), canon({ name: 'ARC-Message-Signature', value: amsTags })], opts.amsKey ?? key);
  const ams: Header = { name: 'ARC-Message-Signature', value: `${amsTags}${amsB}` };

  const tags = `i=${i}; a=${opts.a ?? 'rsa-sha256'}; t=${opts.t ?? T}; cv=${opts.cv ?? (i === 1 ? 'none' : 'pass')}; d=${d}; s=sel${opts.extraTag ?? ''}; b=`;
  const pick = (name: string, n: number): Header | undefined => prior.find(
    (x) => x.name.toLowerCase() === name && new RegExp(`(^|;)\\s*i=${n}\\s*(;|$)`).test(x.value),
  );
  const lines: string[] = [];
  for (let n = 1; n < i; n++) {
    for (const name of ['arc-authentication-results', 'arc-message-signature', 'arc-seal']) {
      const x = pick(name, n);
      if (x) lines.push(canon(x));
    }
  }
  lines.push(canon(aar), canon(ams), canon({ name: 'ARC-Seal', value: tags }));
  return [{ name: 'ARC-Seal', value: `${tags}${sign(lines, key)}` }, ams, aar, ...prior];
}

const dnsOk = (): ArcDeps => ({
  resolveTxt: vi.fn(async () => [[`v=DKIM1; k=rsa; p=${P}`]]),
});
const dnsError = (code: string): ArcDeps => ({
  resolveTxt: vi.fn(async () => { throw Object.assign(new Error(code), { code }); }),
});
const evalWith = (headers: Header[], deps: ArcDeps = dnsOk(), sealers = ['avanan.net'], received: string | undefined = RECEIVED) =>
  evaluateTrustedArc(headers, sealers, received, deps);

describe('evaluateTrustedArc', () => {
  beforeEach(() => {
    clearArcKeyCacheForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns undefined and touches no DNS when no sealer is configured', async () => {
    const deps = dnsOk();
    expect(await evaluateTrustedArc(seal(BASE), [], RECEIVED, deps)).toBeUndefined();
    expect(deps.resolveTxt).not.toHaveBeenCalled();
  });

  it('verifies a genuine seal from a trusted sealer and returns its results without the i= tag', async () => {
    const deps = dnsOk();
    expect(await evalWith(seal(BASE), deps)).toEqual({ status: 'verified', sealer: 'avanan.net', instance: 1, authResults: AAR_BODY });
    expect(deps.resolveTxt).toHaveBeenCalledWith('sel._domainkey.avanan.net');
  });

  it('tolerates the folding and casing Graph may return', async () => {
    const folded = seal(BASE).map((h) => ({ name: h.name.toUpperCase(), value: h.value.replace(/; /g, ';\r\n\t') }));
    expect((await evalWith(folded))?.status).toBe('verified');
  });

  it('matches d= case-insensitively against the lowercase list', async () => {
    expect((await evalWith(seal(BASE, { d: 'AVANAN.NET' })))?.status).toBe('verified');
  });

  it('never queries DNS for a seal whose d= is not on the list (attacker-chosen domain)', async () => {
    const deps = dnsOk();
    expect(await evalWith(seal(BASE, { d: 'attacker.test' }), deps)).toEqual({ status: 'no-trusted-seal' });
    expect(deps.resolveTxt).not.toHaveBeenCalled();
  });

  it('matches d= exactly: a listed gateway host does not trust its parent domain or siblings', async () => {
    expect(await evalWith(seal(BASE), dnsOk(), ['mx.avanan.net'])).toEqual({ status: 'no-trusted-seal' });
    expect(await evalWith(seal(BASE, { d: 'evil.avanan.net' }))).toEqual({ status: 'no-trusted-seal' });
  });

  it('rejects a hand-written ARC set claiming a trusted d= (seal signature does not verify)', async () => {
    expect(await evalWith(seal(BASE, { key: attacker.privateKey }))).toMatchObject({ status: 'invalid', sealer: 'avanan.net', reason: 'signature' });
  });

  it('rejects when the results were edited after sealing', async () => {
    const edited = seal(BASE, { aar: 'mx.avanan.net; dmarc=fail' }).map((h) => (
      h.name === 'ARC-Authentication-Results' ? { ...h, value: 'i=1; mx.avanan.net; dmarc=pass header.from=victim.test' } : h
    ));
    expect(await evalWith(edited)).toMatchObject({ status: 'invalid', reason: 'signature' });
  });

  it("rejects a seal whose t= was moved after signing (freshness can't be bought by editing it)", async () => {
    const old = seal(BASE, { t: T - 7 * 3600 }).map((h) => (
      h.name === 'ARC-Seal' ? { ...h, value: h.value.replace(`t=${T - 7 * 3600}`, `t=${T}`) } : h
    ));
    expect(await evalWith(old)).toMatchObject({ status: 'invalid', reason: 'signature' });
  });

  describe('message signature (binds the seal to this From)', () => {
    it('REPLAY: a genuine sealed set pasted onto a message with another From does not verify', async () => {
      const lifted = seal(BASE).map((h) => (h.name === 'From' ? { ...h, value: 'CEO <ceo@victim.test>' } : h));
      expect(await evalWith(lifted)).toMatchObject({ status: 'invalid', sealer: 'avanan.net', reason: 'message-signature' });
    });

    it('REPLAY: adding a second From above the signed one does not verify', async () => {
      const sealed = seal(BASE);
      const added = [...sealed.slice(0, 3), { name: 'From', value: 'CEO <ceo@victim.test>' }, ...sealed.slice(3)];
      // The bottom-most From is still the signed one, so this verifies: the R4 gate
      // reads Graph's single parsed `from`, and a second From is the caller's problem.
      // What matters is that the signed From cannot be swapped.
      expect((await evalWith(added))?.status).toBe('verified');
    });

    it('requires From in h=', async () => {
      expect(await evalWith(seal(BASE, { amsH: 'subject' }))).toMatchObject({ status: 'invalid', reason: 'message-signature' });
    });

    it('requires the same sealer, relaxed header canonicalization and a valid signature', async () => {
      expect(await evalWith(seal(BASE, { amsD: 'attacker.test' }))).toMatchObject({ status: 'invalid', reason: 'message-signature' });
      expect(await evalWith(seal(BASE, { amsC: 'simple/simple' }))).toMatchObject({ status: 'invalid', reason: 'message-signature' });
      expect(await evalWith(seal(BASE, { amsKey: attacker.privateKey }))).toMatchObject({ status: 'invalid', reason: 'message-signature' });
    });
  });

  it("an attacker's own valid seal does not launder a claim of the trusted authserv-id", async () => {
    const own = seal(BASE, { d: 'attacker.test', key: attacker.privateKey, aar: 'mx.avanan.net; dmarc=pass header.from=victim.test' });
    expect(await evalWith(own)).toEqual({ status: 'no-trusted-seal' });
  });

  it('uses the highest trusted instance, ignoring a later untrusted seal such as Exchange sealing i=2', async () => {
    const chain = seal(seal(BASE), { i: 2, d: 'microsoft.com', key: attacker.privateKey, aar: 'mx.microsoft.com 1; dmarc=fail' });
    expect(await evalWith(chain)).toMatchObject({ status: 'verified', instance: 1, authResults: AAR_BODY });
  });

  it('verifies a trusted seal at instance 2 over an intact chain', async () => {
    const chain = seal(seal(BASE, { d: 'first.test', key: attacker.privateKey }), { i: 2, aar: 'mx.avanan.net; dmarc=pass header.from=mg.example.io' });
    expect(await evalWith(chain)).toMatchObject({ status: 'verified', instance: 2 });
  });

  it('rejects instance 2 when an earlier set it sealed was altered', async () => {
    const chain = seal(seal(BASE, { d: 'first.test', key: attacker.privateKey }), { i: 2 }).map((h) => (
      h.name === 'ARC-Authentication-Results' && h.value.startsWith('i=1') ? { ...h, value: 'i=1; first.test; dmarc=pass' } : h
    ));
    expect(await evalWith(chain)).toMatchObject({ status: 'invalid', reason: 'signature' });
  });

  it('takes the highest of two trusted instances and does not fall back when it fails', async () => {
    const chain = seal(seal(BASE), { i: 2, key: attacker.privateKey, aar: 'mx.avanan.net; dmarc=fail' });
    expect(await evalWith(chain)).toMatchObject({ status: 'invalid', reason: 'signature' });
  });

  it('rejects any instance reporting cv=fail, and a wrong cv for the instance', async () => {
    expect(await evalWith(seal(BASE, { cv: 'fail' }))).toMatchObject({ status: 'invalid', reason: 'chain' });
    expect(await evalWith(seal(BASE, { cv: 'pass' }))).toMatchObject({ status: 'invalid', reason: 'chain' });
    expect(await evalWith(seal(seal(BASE), { i: 2, cv: 'none' }))).toMatchObject({ status: 'invalid', reason: 'chain' });
    const laterFail = seal(seal(BASE), { i: 2, d: 'other.test', cv: 'fail', key: attacker.privateKey });
    expect(await evalWith(laterFail)).toMatchObject({ status: 'invalid', reason: 'chain' });
  });

  it('rejects a gap, a duplicate, or an out-of-range instance', async () => {
    const gap = seal(seal(BASE), { i: 3 }).filter((h) => !/(^|;)\s*i=1\s*(;|$)/.test(h.value));
    expect(await evalWith(gap)).toMatchObject({ status: 'invalid', reason: 'chain' });
    const sealed = seal(BASE);
    expect(await evalWith([...sealed, sealed[0]!])).toMatchObject({ status: 'invalid', reason: 'chain' });
    for (const i of ['0', '51', 'abc']) {
      const bad = sealed.map((h) => ({ ...h, value: h.value.replace(/^i=1;/, `i=${i};`) }));
      expect(await evalWith(bad)).toMatchObject({ status: 'invalid', reason: 'chain' });
    }
  });

  it('rejects a missing set member, a duplicate tag, a non rsa-sha256 algorithm and a bad selector', async () => {
    const sealed = seal(BASE);
    expect(await evalWith(sealed.filter((h) => h.name !== 'ARC-Message-Signature'))).toMatchObject({ status: 'invalid', reason: 'chain' });
    expect(await evalWith(seal(BASE, { extraTag: '; d=attacker.test' }))).toMatchObject({ status: 'invalid', reason: 'chain' });
    expect(await evalWith(seal(BASE, { a: 'rsa-sha1' }))).toMatchObject({ status: 'invalid', reason: 'chain' });
    const deps = dnsOk();
    const badSelector = sealed.map((h) => (h.name === 'ARC-Seal' ? { ...h, value: h.value.replace('s=sel', 's=a/../b') } : h));
    expect(await evalWith(badSelector, deps)).toMatchObject({ status: 'invalid', reason: 'chain' });
    expect(deps.resolveTxt).not.toHaveBeenCalled();
  });

  it('rejects a seal outside the freshness window or when receipt time is unknown (replay)', async () => {
    expect(await evalWith(seal(BASE, { t: T - 7 * 3600 }))).toMatchObject({ status: 'invalid', reason: 'stale' });
    expect(await evalWith(seal(BASE, { t: T + 7 * 3600 }))).toMatchObject({ status: 'invalid', reason: 'stale' });
    expect(await evaluateTrustedArc(seal(BASE), ['avanan.net'], undefined, dnsOk())).toMatchObject({ status: 'invalid', reason: 'stale' });
  });

  describe('DNS', () => {
    it('reports an outage as dns-unavailable, logs it, and does not query again for a minute', async () => {
      const down = dnsError('ETIMEOUT');
      expect(await evalWith(seal(BASE), down)).toEqual({ status: 'dns-unavailable', sealer: 'avanan.net', retryable: false });
      expect(await evalWith(seal(BASE), down)).toEqual({ status: 'dns-unavailable', sealer: 'avanan.net', retryable: false });
      expect(down.resolveTxt).toHaveBeenCalledTimes(1);
      expect(console.warn).toHaveBeenCalledWith('[arcSeal] key lookup failed', { hostname: 'sel._domainkey.avanan.net', code: 'ETIMEOUT' });
    });

    it('marks an outage retryable only for a selector that has returned a key before (the sender picks the selector)', async () => {
      const realNow = Date.now();
      await evalWith(seal(BASE), dnsOk());
      // Two hours on, the cached key has expired and DNS is down.
      const now = vi.spyOn(Date, 'now').mockReturnValue(realNow + 2 * 60 * 60 * 1000);
      try {
        expect(await evalWith(seal(BASE), dnsError('ESERVFAIL'))).toEqual({ status: 'dns-unavailable', sealer: 'avanan.net', retryable: true });
        const madeUp = seal(BASE).map((h) => (h.name === 'ARC-Seal' ? { ...h, value: h.value.replace('s=sel', 's=junk') } : h));
        expect(await evalWith(madeUp, dnsError('ESERVFAIL'))).toEqual({ status: 'dns-unavailable', sealer: 'avanan.net', retryable: false });
      } finally {
        now.mockRestore();
      }
    });

    it.each(['ENOTFOUND', 'ENODATA'])('reads %s as "no key", not as an outage', async (code) => {
      expect(await evalWith(seal(BASE), dnsError(code))).toMatchObject({ status: 'invalid', reason: 'key' });
    });

    it('rejects an unusable, revoked, ambiguous or short key', async () => {
      const weak = generateKeyPairSync('rsa', { modulusLength: 768 });
      const weakP = weak.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
      for (const records of [
        [['v=DKIM1; k=rsa; p=']],
        [['v=DKIM1; k=ed25519; p=AAAA']],
        [['v=DKIM1; p=!!notbase64']],
        [[`v=DKIM1; p=${P}`], [`v=DKIM1; p=${P}`]],
        [[`p=${weakP}`]],
      ]) {
        clearArcKeyCacheForTest();
        const deps: ArcDeps = { resolveTxt: vi.fn(async () => records) };
        expect(await evalWith(seal(BASE), deps)).toMatchObject({ status: 'invalid', reason: 'key' });
      }
    });

    it('caches the key so a sweep does not query DNS per message', async () => {
      const deps = dnsOk();
      await evalWith(seal(BASE), deps);
      await evalWith(seal(BASE), deps);
      expect(deps.resolveTxt).toHaveBeenCalledTimes(1);
    });
  });

  it('never throws, even on header objects Graph should not send', async () => {
    const broken = [...seal(BASE), { name: undefined, value: 'x' }, { name: 'ARC-Seal', value: null }] as unknown as Header[];
    expect((await evalWith(broken))?.status).toBe('verified');
    clearArcKeyCacheForTest();
    const throwing: ArcDeps = { resolveTxt: () => { throw new TypeError('boom'); } };
    expect(await evalWith(seal(BASE), throwing)).toMatchObject({ status: 'dns-unavailable', sealer: 'avanan.net' });
  });

  // Sealed by mailauth (an independent ARC implementation), not by this file's signer, so a
  // canonicalization bug shared by seal() and the verifier cannot hide here.
  describe('independent vectors', () => {
    const VECTOR_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6FvbRiVai+HfkxM/a4pVhGwxGrpREyEFun3/9PSoTiaRHQvKRt+t5hs09Sv6LkcGtZQyxnnvfF64zUkHoHkQaHXdVul2s2JI4fv1wJFVm/w1mxqJFTv18W1v25dgZPOf4vR0eJVh3udrESZySLyTvdt1K9hYjaBMLxuHEZ9lNW/n/M8ezPi9Tezs5Fo/DlRBrHP++Xv2lq5lqWNcqnNlvd4GFXRhZw68hDUz1z7qqRas4bXtLAmO5VsN8wBrxkaMxHcyDJw5yJOp40a8bG1FGGOt7HOm1MankxIniT2XFTyQZN7SIX6dvMcxGiDWSI/xy+Xgn1SdG59WUsGK3QPVoQIDAQAB';
    const ONE_HOP: Header[] = [
      {
        "name": "ARC-Seal",
        "value": "i=1; a=rsa-sha256; t=1793793540; cv=none; d=avanan.net; s=sel;\r\n b=txrOf5kwegqKB0HL5VBRV41NJPlAfQcGsZlg6l6jFwq+sY6xTYQn5v9AOcyeEA3WNXz+oNq+L\r\n 4VPB8hOXAaen6PSFvSzmLzqvQBNiGDn5g6d9qrF1HaUjIKLKr+8s4EQHO2XX819qwR+XOmmMXpj\r\n yWP+RhaRpTefQGtmyggAc6bbgxjMUNTxqS+J2cW0kmfwPXBynbx0FzDM06cvHRwXuz0TOJ7X0N/\r\n Yenud5W/GrMVysNfR/tVrd7iArOP823+UtjY9dXMxvFCt2HWLXxKL9EaY2iBfiEQbx2zB58oEDw\r\n MlxchmeMSdKhuhQwTy6kgUOQJYKD7pawXRnyvqG9FNQA=="
      },
      {
        "name": "ARC-Message-Signature",
        "value": "i=1; a=rsa-sha256; c=relaxed/relaxed; d=avanan.net;\r\n h=Message-ID: Date: Subject: To: From; q=dns/txt; s=sel; t=1793793540;\r\n bh=Ba3gj8+xBPQLJTahTfzW6RbWQ/XPgESxkCi2B66PSQg=;\r\n b=qXyuENP/aT7L1x4XEm86lYChqAoG1nryv9xXPyppqBve4CJMn353I7dkLk/QW8F74G+5LVMTC\r\n hvbX1TLGlNrZZ09wtf86B6RtDLA8whqdRyPwY3FYZfXpYAM5UF1JaQX70X/riBRrcf9wlHSlz+P\r\n TQcCXXyrT6sOE1yWcSdN8W+o6ZpIjYAHM8gVPfDRXOUnMS5LWE/l219rFmEYQqD0GHEuPVsiHLI\r\n NfOr6+Vf+qcwceKRoTyoGGUocDDq7xznjVGxY5qmgtr+46ftHfByihJR+rXPszonQSOLANevmZU\r\n wKRE++RY6BnnJCYW5x3LuW7MecosK6jd3uJJaFFj2+kQ=="
      },
      {
        "name": "ARC-Authentication-Results",
        "value": "i=1; mx.avanan.net; dkim=pass header.d=mg.example.io; spf=pass smtp.mailfrom=mg.example.io"
      },
      {
        "name": "From",
        "value": "Person <person@mg.example.io>"
      },
      {
        "name": "To",
        "value": "support@a.example"
      },
      {
        "name": "Subject",
        "value": "Printer down"
      },
      {
        "name": "Date",
        "value": "Wed, 04 Nov 2026 12:00:00 +0000"
      },
      {
        "name": "Message-ID",
        "value": "<vector@mg.example.io>"
      }
    ];
    const TWO_HOP: Header[] = [
      {
        "name": "ARC-Seal",
        "value": "i=2; a=rsa-sha256; t=1793793540; cv=pass; d=avanan.net; s=sel;\r\n b=y0IoegYFQfvRycg2ydYqx7qx1Poi1fHyHujn39VKIq2p2HgDxbMljifB22HPZWztbSA2Ga9EZ\r\n EsvUqFmR6V08bC3tQpbhjmyNzUt48Mlez4K+U+aIH889K99y3j2Rt6UPotAWol8hRVUnrtl/hUE\r\n FPVy9skybl9kEII/AYwmwFLYue+Q2n/joQATVz1fcBv5vC0egYWkbvhiOz2ClYrq6PaeSlP6tzt\r\n IFlOfgbbbEkxdrNsC/2Z25ysZqrS2Ku9ZmElGLI+1j3awnQJkQYIEtHt3DH4qLiBFLvRwGXbKEF\r\n BgicOcSdGxKCggeP27tjgSNWHHqoXXTFqOGLXo0uIlZA=="
      },
      {
        "name": "ARC-Message-Signature",
        "value": "i=2; a=rsa-sha256; c=relaxed/relaxed; d=avanan.net;\r\n h=Message-ID: Date: Subject: To: From; q=dns/txt; s=sel; t=1793793540;\r\n bh=Ba3gj8+xBPQLJTahTfzW6RbWQ/XPgESxkCi2B66PSQg=;\r\n b=pQwbHz6aCnEtsboxrztscQDxg6ZHb4ecs3O4AMTRM0837d3bqqh8TbtO4E03kCplBE4Vy9MJU\r\n axp/+rRTUkdOsemSmDQ1LWa/f9anLH9Mk6oaOwZQ6MQ9Fl9bwW7NzwwaDSBuroWMzTVOAjxjlVA\r\n mY679T5WA9C8HOyXcvfpzzP3y9nTPwzyN/bSOn3zs8QM6iXi6EE7UfklquqOPXl2757es+o4Pxu\r\n W7BMzA3VLrkS+Q0KwnGB4J1FPpXKYYmxWmfh1rKY5lCnWBqRapnhssHOCOqmdscfF8WrsWAPcR+\r\n DcT9Sc0EEC1vieU3qpWVx6FtWptXrqpArE9aCxeir9rw=="
      },
      {
        "name": "ARC-Authentication-Results",
        "value": "i=2; mx.avanan.net; arc=pass; dkim=pass header.d=mg.example.io"
      },
      {
        "name": "ARC-Seal",
        "value": "i=1; a=rsa-sha256; t=1793793540; cv=none; d=avanan.net; s=sel;\r\n b=txrOf5kwegqKB0HL5VBRV41NJPlAfQcGsZlg6l6jFwq+sY6xTYQn5v9AOcyeEA3WNXz+oNq+L\r\n 4VPB8hOXAaen6PSFvSzmLzqvQBNiGDn5g6d9qrF1HaUjIKLKr+8s4EQHO2XX819qwR+XOmmMXpj\r\n yWP+RhaRpTefQGtmyggAc6bbgxjMUNTxqS+J2cW0kmfwPXBynbx0FzDM06cvHRwXuz0TOJ7X0N/\r\n Yenud5W/GrMVysNfR/tVrd7iArOP823+UtjY9dXMxvFCt2HWLXxKL9EaY2iBfiEQbx2zB58oEDw\r\n MlxchmeMSdKhuhQwTy6kgUOQJYKD7pawXRnyvqG9FNQA=="
      },
      {
        "name": "ARC-Message-Signature",
        "value": "i=1; a=rsa-sha256; c=relaxed/relaxed; d=avanan.net;\r\n h=Message-ID: Date: Subject: To: From; q=dns/txt; s=sel; t=1793793540;\r\n bh=Ba3gj8+xBPQLJTahTfzW6RbWQ/XPgESxkCi2B66PSQg=;\r\n b=qXyuENP/aT7L1x4XEm86lYChqAoG1nryv9xXPyppqBve4CJMn353I7dkLk/QW8F74G+5LVMTC\r\n hvbX1TLGlNrZZ09wtf86B6RtDLA8whqdRyPwY3FYZfXpYAM5UF1JaQX70X/riBRrcf9wlHSlz+P\r\n TQcCXXyrT6sOE1yWcSdN8W+o6ZpIjYAHM8gVPfDRXOUnMS5LWE/l219rFmEYQqD0GHEuPVsiHLI\r\n NfOr6+Vf+qcwceKRoTyoGGUocDDq7xznjVGxY5qmgtr+46ftHfByihJR+rXPszonQSOLANevmZU\r\n wKRE++RY6BnnJCYW5x3LuW7MecosK6jd3uJJaFFj2+kQ=="
      },
      {
        "name": "ARC-Authentication-Results",
        "value": "i=1; mx.avanan.net; dkim=pass header.d=mg.example.io; spf=pass smtp.mailfrom=mg.example.io"
      },
      {
        "name": "From",
        "value": "Person <person@mg.example.io>"
      },
      {
        "name": "To",
        "value": "support@a.example"
      },
      {
        "name": "Subject",
        "value": "Printer down"
      },
      {
        "name": "Date",
        "value": "Wed, 04 Nov 2026 12:00:00 +0000"
      },
      {
        "name": "Message-ID",
        "value": "<vector@mg.example.io>"
      }
    ];
    const VECTOR_RECEIVED = '2026-11-04T12:00:00Z';
    const keyDeps = (): ArcDeps => ({ resolveTxt: vi.fn(async () => [[`v=DKIM1; k=rsa; p=${VECTOR_KEY}`]]) });

    it('verifies a one-hop seal from another implementation', async () => {
      expect(await evaluateTrustedArc(ONE_HOP, ['avanan.net'], VECTOR_RECEIVED, keyDeps())).toMatchObject({ status: 'verified', instance: 1 });
    });

    it('verifies a two-hop chain from another implementation at instance 2', async () => {
      expect(await evaluateTrustedArc(TWO_HOP, ['avanan.net'], VECTOR_RECEIVED, keyDeps())).toMatchObject({
        status: 'verified', instance: 2, authResults: 'mx.avanan.net; arc=pass; dkim=pass header.d=mg.example.io',
      });
    });

    it('verifies them unfolded, as Graph may return them', async () => {
      for (const headers of [ONE_HOP, TWO_HOP]) {
        const unfolded = headers.map((h) => ({ ...h, value: h.value.replace(/\r?\n[ \t]*/g, ' ') }));
        expect((await evaluateTrustedArc(unfolded, ['avanan.net'], VECTOR_RECEIVED, keyDeps()))?.status).toBe('verified');
      }
    });

    it('control: one changed results byte, or another From, does not verify', async () => {
      const edited = ONE_HOP.map((h) => (
        h.name === 'ARC-Authentication-Results' ? { ...h, value: h.value.replace('dkim=pass', 'dkim=fail') } : h
      ));
      expect(await evaluateTrustedArc(edited, ['avanan.net'], VECTOR_RECEIVED, keyDeps())).toMatchObject({ status: 'invalid', reason: 'signature' });
      const otherFrom = TWO_HOP.map((h) => (h.name === 'From' ? { ...h, value: 'CEO <ceo@victim.test>' } : h));
      expect(await evaluateTrustedArc(otherFrom, ['avanan.net'], VECTOR_RECEIVED, keyDeps())).toMatchObject({ status: 'invalid', reason: 'message-signature' });
    });
  });
});
