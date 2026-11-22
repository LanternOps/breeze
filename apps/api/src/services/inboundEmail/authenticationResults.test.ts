import { describe, it, expect } from 'vitest';
import { buildSenderAuth, dkimIdentitiesAllowStamps, dmarcAuthenticatedDomain, envelopeAllowsStamps, mechanism, parseAuthClauses, parseAuthClausesOrNull, splitAuthClauses } from './authenticationResults';

describe('parseAuthClauses', () => {
  it('reads each clause with lowercased properties and drops the authserv-id', () => {
    const clauses = parseAuthClauses('mx.example; spf=pass smtp.mailfrom=B@X.com; dkim=pass header.d=X.com header.s="sel"');
    expect(clauses.map((c) => [c.method, c.result])).toEqual([['spf', 'pass'], ['dkim', 'pass']]);
    expect(clauses[0]!.props.get('smtp.mailfrom')).toBe('b@x.com');
    expect(clauses[1]!.props.get('header.d')).toBe('x.com');
    expect(clauses[1]!.props.get('header.s')).toBe('sel');
  });

  it('drops comments, so a comment cannot add a clause or a property', () => {
    const clauses = parseAuthClauses('mx.example; dmarc=fail (because dmarc=pass header.from=x.com) header.from=y.com');
    expect(clauses).toHaveLength(1);
    expect(clauses[0]!.result).toBe('fail');
    expect(clauses[0]!.props.get('header.from')).toBe('y.com');
  });

  it('drops a comment holding a ;', () => {
    expect(parseAuthClauses('mx.example; dmarc=fail (because; dmarc=pass header.from=x.com) header.from=y.com').map((c) => c.result)).toEqual(['fail']);
  });

  it('keeps a property repeated with the same value, and nulls one repeated with a different value', () => {
    expect(parseAuthClauses('id; dmarc=pass header.from=x.com header.from=X.com')[0]!.props.get('header.from')).toBe('x.com');
    expect(parseAuthClauses('id; dmarc=pass header.from=x.com header.from=y.com')[0]!.props.get('header.from')).toBeNull();
  });

  it('returns nothing for an empty or verdict-less value', () => {
    expect(parseAuthClauses(undefined)).toEqual([]);
    expect(parseAuthClauses('mx.example; none')).toEqual([]);
  });
});

describe('buildSenderAuth authenticated domain', () => {
  it('records the From domain a DMARC pass is for', () => {
    expect(buildSenderAuth('mx.example; dmarc=pass header.from=X.com', 'cust@x.com').authenticatedDomain).toBe('x.com');
  });

  it('uses the From domain when the DMARC clause names no header.from', () => {
    expect(buildSenderAuth('mx.example; dmarc=pass', 'cust@x.com').authenticatedDomain).toBe('x.com');
  });

  it('records no domain when the DMARC pass names a different header.from', () => {
    const auth = buildSenderAuth('mx.example; dmarc=pass header.from=other.example', 'cust@x.com');
    expect(auth.verified).toBe(true);
    expect(auth.authenticatedDomain).toBeNull();
  });

  it('records no domain for a conflicting duplicate header.from', () => {
    expect(buildSenderAuth('mx.example; dmarc=pass header.from=x.com header.from=y.com', 'cust@x.com').authenticatedDomain).toBeNull();
  });

  it('is not verified when a value holds more than one DMARC clause', () => {
    expect(buildSenderAuth('mx.example; dmarc=pass header.from=x.com; dmarc=pass header.from=y.com', 'cust@x.com').verified).toBe(false);
  });

  it('records no domain without a usable From address or without a pass', () => {
    expect(buildSenderAuth('mx.example; dmarc=pass').authenticatedDomain).toBeNull();
    for (const from of ['', 'no-at-sign', 'a@b@x.com', '@x.com', 'cust@']) {
      expect(buildSenderAuth('mx.example; dmarc=pass', from).authenticatedDomain, from).toBeNull();
    }
    expect(buildSenderAuth('mx.example; dmarc=fail header.from=x.com', 'cust@x.com').authenticatedDomain).toBeUndefined();
  });
});

describe('dmarcAuthenticatedDomain with the raw From header', () => {
  const PASS = ['mx.example; dmarc=pass'];

  it('binds when every address in the From header is on the From domain', () => {
    expect(dmarcAuthenticatedDomain(PASS, 'jane@x.com', 'Jane <jane@x.com>')).toBe('x.com');
    expect(dmarcAuthenticatedDomain(PASS, 'jane@x.com', '"jane@X.com" <jane@x.com>')).toBe('x.com');
  });

  it('does not bind when the From header holds addresses on another domain', () => {
    expect(dmarcAuthenticatedDomain(PASS, 'jane@x.com', 'jane@x.com other@y.example')).toBeNull();
    expect(dmarcAuthenticatedDomain(PASS, 'jane@x.com', '"n" <jane@x.com> <other@y.example>')).toBeNull();
    expect(dmarcAuthenticatedDomain(PASS, 'jane@x.com', '"other@y.example" <jane@x.com>')).toBeNull();
  });

  it('checks the From header even when the verdict names header.from', () => {
    expect(dmarcAuthenticatedDomain(['mx.example; dmarc=pass header.from=x.com'], 'jane@x.com', 'Jane <jane@x.com>')).toBe('x.com');
    expect(dmarcAuthenticatedDomain(['mx.example; dmarc=pass header.from=x.com'], 'jane@x.com', '"other@y.example" <jane@x.com>')).toBeNull();
  });

  it.each([
    '"x"@y.example <jane@x.com>',
    '<jane@x.com>@y.example',
    '"V" <jane@x.com> "x"@y.example',
    '(c)@y.example <jane@x.com>',
    'jane@x.com @',
    'jane@x.com x@[192.0.2.1]',
    'Jane <jane@x.com.>',
  ])('does not bind when any @ in the From header is not on the From domain: %s', (fromHeader) => {
    expect(dmarcAuthenticatedDomain(['mx.example; dmarc=pass'], 'jane@x.com', fromHeader)).toBeNull();
  });

  it('does not bind when a supplied From value is not a string', () => {
    expect(dmarcAuthenticatedDomain(['mx.example; dmarc=pass'], 'jane@x.com', ['jane@x.com', 42 as unknown as string])).toBeNull();
    expect(dmarcAuthenticatedDomain(['mx.example; dmarc=pass'], 'jane@x.com', ['jane@x.com', null])).toBeNull();
  });

  it('checks every From header value given', () => {
    expect(dmarcAuthenticatedDomain(['mx.example; dmarc=pass'], 'jane@x.com', ['Jane <jane@x.com>', 'jane@x.com'])).toBe('x.com');
    expect(dmarcAuthenticatedDomain(['mx.example; dmarc=pass'], 'jane@x.com', ['Jane <jane@x.com>', 'x@y.example'])).toBeNull();
  });
});

describe('splitAuthClauses', () => {
  it('splits on ; outside quoted-strings and comments, dropping comments', () => {
    expect(splitAuthClauses('mx.example; spf=pass (a b) smtp.mailfrom=x@z.example; dmarc=pass'))
      .toEqual(['mx.example', ' spf=pass   smtp.mailfrom=x@z.example', ' dmarc=pass']);
  });

  it('keeps ; ( and = inside a quoted-string, with quoted-pairs', () => {
    expect(splitAuthClauses('id; x=y reason="a;(b=\\"c"; dmarc=fail'))
      .toEqual(['id', ' x=y reason="a;(b=\\"c"', ' dmarc=fail']);
  });

  it('handles nested comments', () => {
    expect(splitAuthClauses('id; dkim=pass (outer (inner x) more) header.d=a.example')).toEqual(['id', ' dkim=pass   header.d=a.example']);
  });

  it.each([
    'id; spf=pass smtp.mailfrom="unterminated; dmarc=pass',
    'id; spf=pass (unterminated dmarc=pass',
    'id; spf=pass smtp.mailfrom="a\\',
    'id; spf=pass (a "b") smtp.mailfrom=x@z.example',
    'id; spf=pass (a \\) b) smtp.mailfrom=x@z.example',
    'id; spf=pass smtp.mailfrom=x@z.example)',
  ])('is null for input that does not read one way: %s', (value) => {
    expect(splitAuthClauses(value)).toBeNull();
  });
});

describe('quoted values in Authentication-Results', () => {
  it('keeps a quoted smtp.mailfrom whole and refuses a quoted header.i', () => {
    const value = 'mx.example; spf=pass smtp.mailfrom="a; dmarc=pass header.from=customer.example; ("@other.example; dmarc=fail header.from=customer.example';
    expect(parseAuthClauses(value).map((c) => [c.method, c.result])).toEqual([['spf', 'pass'], ['dmarc', 'fail']]);
    expect(mechanism(value, 'dmarc')).toBe('fail');
    expect(buildSenderAuth(value, 'ceo@customer.example').verified).toBe(false);
    expect(parseAuthClausesOrNull('mx.example; dkim=pass header.i="a\\" header.d=customer.example \\""@other.example')).toBeNull();
  });

  it('reads nothing from a malformed value', () => {
    expect(parseAuthClauses('mx.example; dmarc=pass header.from=x.com; spf=pass smtp.mailfrom="open')).toEqual([]);
    expect(buildSenderAuth('mx.example; dmarc=pass header.from=x.com; spf=pass smtp.mailfrom="open', 'a@x.com').verified).toBe(false);
  });

  it('is not verified when one value holds both a passing and a failing DMARC clause', () => {
    expect(buildSenderAuth('mx.example; dmarc=pass header.from=x.com; dmarc=fail header.from=x.com', 'a@x.com').verified).toBe(false);
  });
});

describe('Authentication-Results property values', () => {
  it('unquotes a value that is one whole quoted-string', () => {
    expect(parseAuthClauses('mx.example; dkim=pass reason="Good Signature" header.d=x.com')[0]!.props.get('reason')).toBe('good signature');
    expect(parseAuthClauses('mx.example; spf=pass policy.x="a\\"b"')[0]!.props.get('policy.x')).toBe('a"b');
  });

  it('accepts spaces around = and comments between properties', () => {
    const [clause] = parseAuthClauses('mx.example; dkim=pass (good sig) header.d = x.com (k) header.s=sel');
    expect(clause!.props.get('header.d')).toBe('x.com');
    expect(clause!.props.get('header.s')).toBe('sel');
  });
});

// Samples in the format each writer uses (values changed).
const REALISTIC: Record<string, string> = {
  google: 'mx.google.com; dkim=pass header.i=@example.com header.s=20230601 header.b=Xy7+/abc=; arc=pass (i=1 spf=pass spfdomain=example.com dkim=pass dkdomain=example.com dmarc=pass fromdomain=example.com); spf=pass (google.com: domain of jane@example.com designates 209.85.220.41 as permitted sender) smtp.mailfrom=jane@example.com; dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com; dara=pass header.i=@example.com',
  google_folded: 'mx.google.com;\r\n       dkim=pass header.i=@example.com header.s=s1 header.b="AbC+/x=";\r\n       spf=pass (google.com: domain of bounces+123-abc=example.com@esp.example designates 192.0.2.1 as permitted sender) smtp.mailfrom="bounces+123-abc=example.com@esp.example";\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com',
  google_two_dkim: 'mx.google.com; dkim=pass header.i=@example.com header.s=s1 header.b=AAA; dkim=pass header.i=@example-com.20230601.gappssmtp.com header.s=20230601 header.b=BBB; spf=pass (google.com: domain of jane@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=jane@example.com; dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=example.com',
  eop: 'mx.microsoft.com 1; spf=pass (sender IP is 209.85.220.41) smtp.mailfrom=example.com; dkim=pass (signature was verified) header.d=example.com;dmarc=pass action=none header.from=example.com;compauth=pass reason=100',
  eop_comment_semicolon: 'mx.microsoft.com 1; spf=pass (sender IP is 192.0.2.1; helo=x) smtp.mailfrom=example.com; dkim=pass (2048-bit key; unprotected) header.d=example.com header.s=sel header.b=Ab+=;dmarc=pass action=none header.from=example.com',
  rfc8601_ex: 'mx.example.org; dkim=pass reason="good signature" header.i=@mail-router.example.net; dkim=fail reason="bad signature" header.i=@newyork.example.com; dmarc=pass policy.published-domain-policy=reject header.from="example.com"',
  mailgun: 'mxa.mailgun.org; dkim=pass header.d=example.com header.s=s1 header.b=abc; spf=pass (mxa.mailgun.org: domain of jane@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=jane@example.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com',
};
const GMAIL_FAIL = 'mx.google.com; spf=softfail (google.com: domain of transitioning jane@example.com does not designate 192.0.2.7 as permitted sender) '
  + 'smtp.mailfrom=jane@example.com; dmarc=fail (p=REJECT sp=REJECT dis=REJECT) header.from=example.com';
const EXCHANGE_FAIL = 'mx.microsoft.com 1; spf=softfail (sender IP is 192.0.2.7) smtp.mailfrom=example.com; dkim=none (message not signed) '
  + 'header.d=none;dmarc=fail action=quarantine header.from=example.com;compauth=fail reason=000';

describe('writer samples', () => {
  it.each(Object.entries(REALISTIC))('%s verifies', (_w, value) => {
    expect(buildSenderAuth(value, 'jane@example.com', ['Jane <jane@example.com>'])).toMatchObject({ dmarc: 'pass', verified: true, authenticatedDomain: 'example.com' });
  });

  it.each([['Gmail', GMAIL_FAIL], ['Exchange Online', EXCHANGE_FAIL]])('%s fail does not verify', (_w, value) => {
    expect(buildSenderAuth(value, 'jane@example.com')).toMatchObject({ dmarc: 'fail', verified: false });
  });

  it('a quoted local part with ; in the envelope is not read (envelope refused)', () => {
    expect(envelopeAllowsStamps('<"j.doe;x"@example.com>')).toBe(false);
  });
});

// A stamp for a From domain with no DMARC record has no DMARC clause of its own,
// so text echoed from the envelope sender is the only candidate. Gmail's form:
const gmailNoDmarc = (envInComment: string, mailfrom: string) =>
  `mx.google.com; dkim=pass header.i=@other.example header.s=s1 header.b=AbC+1/x=; spf=pass (google.com: domain of ${envInComment} designates 192.0.2.1 as permitted sender) smtp.mailfrom=${mailfrom}`;
const NO_DMARC_ROWS: [string, string][] = [
  ['quoted', gmailNoDmarc('"a);dmarc=pass header.from=customer.example;(b"@other.example', '"a);dmarc=pass header.from=customer.example;(b"@other.example')],
  ['unquoted, balanced', gmailNoDmarc('a);dmarc=pass header.from=customer.example;x=(b@other.example', '"a);dmarc=pass header.from=customer.example;x=(b"@other.example')],
  ['quoted, made to look normal', gmailNoDmarc('"a) smtp.mailfrom=a@other.example;dmarc=pass header.from=customer.example;x=(b"@other.example', '"a) smtp.mailfrom=a@other.example;dmarc=pass header.from=customer.example;x=(b"@other.example')],
];

describe('stamps for a domain with no DMARC record', () => {
  it.each(NO_DMARC_ROWS)('%s: not verified even when the envelope is unknown', (_l, value) => {
    expect(buildSenderAuth(value, 'ceo@customer.example', ['ceo@customer.example']).verified).toBe(false);
  });

  it('refuses a stamp that repeats spf', () => {
    expect(parseAuthClausesOrNull('mx.example; spf=pass smtp.mailfrom=a@b.example; spf=fail smtp.mailfrom=a@b.example; dmarc=pass header.from=b.example')).toBeNull();
  });

  it.each([
    ['(', 'a(b@x.example'], [')', 'a)b@x.example'], ['"', '"a b"@x.example'], [';', 'a;b@x.example'], ['\\', 'a\\b@x.example'],
  ])('refuses stamps when the envelope sender holds %s', (_c, envelope) => {
    expect(envelopeAllowsStamps(envelope)).toBe(false);
    expect(envelopeAllowsStamps(`<${envelope}>`)).toBe(false);
  });

  it('reads stamps for an ordinary, a null or an unknown envelope sender', () => {
    for (const e of ['jane@example.com', '<jane@example.com>', 'bounces+1-a=b.example@esp.example', '<>', '', undefined, null]) {
      expect(envelopeAllowsStamps(e), String(e)).toBe(true);
    }
    expect(envelopeAllowsStamps(42)).toBe(false);
  });
});

describe('Authentication-Results that cannot be read unambiguously', () => {
  // Gmail writes the envelope sender unescaped inside the spf comment and again
  // as smtp.mailfrom. A local part holding ), ;, (, " and dmarc=pass:
  const local = '"x)smtp.mailfrom=a; dmarc=pass header.from=customer.example; (y"';
  const gmailWith = (mailfrom: string) => `mx.google.com; spf=pass (google.com: domain of ${local}@sender.example designates 192.0.2.7 as permitted sender) `
    + `smtp.mailfrom=${mailfrom}; dmarc=fail (p=REJECT sp=REJECT dis=REJECT) header.from=customer.example`;

  it.each([
    ['quoted smtp.mailfrom', gmailWith(`${local}@sender.example`)],
    ['bare smtp.mailfrom', gmailWith(`${local.slice(1, -1)}@sender.example`)],
  ])('rejects the Gmail form with that local part (%s)', (_l, value) => {
    expect(parseAuthClausesOrNull(value)).toBeNull();
    expect(buildSenderAuth(value, 'ceo@customer.example').verified).toBe(false);
  });

  it.each([
    ['a ) outside any comment', 'mx.example; spf=pass smtp.mailfrom=a@b.example) ; dmarc=pass header.from=b.example'],
    ['a comment holding "', 'mx.example; spf=pass (say "hi") smtp.mailfrom=a@b.example; dmarc=pass header.from=b.example'],
    ['text after a comment that is not a property', 'mx.example; spf=pass (note) stray smtp.mailfrom=a@b.example; dmarc=pass header.from=b.example'],
    ['a clause that is not method=result', 'mx.example; spf; dmarc=pass header.from=b.example'],
    ['a bad authserv-id', 'mx example!; dmarc=pass header.from=b.example'],
    ['two DMARC clauses', 'mx.example; dmarc=pass header.from=b.example; dmarc=pass header.from=b.example'],
    ['a quoted header.i', 'mx.example; dkim=pass header.i="a b"@b.example header.d=b.example; dmarc=pass header.from=b.example'],
    ['a quoted header.d', 'mx.example; dkim=pass header.d="b.example"; dmarc=pass header.from=b.example'],
    ['a header.i holding a backslash', 'mx.example; dkim=pass header.i=a\\b@b.example header.d=b.example; dmarc=pass header.from=b.example'],
  ])('rejects the whole value for %s', (_l, value) => {
    expect(parseAuthClausesOrNull(value)).toBeNull();
    expect(buildSenderAuth(value, 'a@b.example').verified).toBe(false);
  });

  it('allows empty clauses and comments holding = (writer formats)', () => {
    expect(parseAuthClausesOrNull('mx.example; dmarc=pass (p=NONE sp=NONE) header.from=b.example;')!.map((c) => c.method)).toEqual(['dmarc']);
  });
});

describe('DMARC clause position and properties', () => {
  // V1: a DKIM identity (i=) written out unquoted with a decoded `;`.
  const v1 = 'mx.google.com; dkim=pass header.i=a;dmarc=pass header.from=customer.example;x=y p.q=r@other.example header.s=s1 header.b=AbC; '
    + 'spf=pass (google.com: domain of b@other.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=b@other.example';
  // V3: a HELO name in Exchange's spf comment, rebalanced, with no DMARC clause of Exchange's own.
  const v3 = 'mx.microsoft.com 1; spf=pass (sender IP is 192.0.2.1; helo=a) smtp.helo=x;dmarc=pass header.from=customer.example;y=z (b) smtp.mailfrom=other.example; '
    + 'dkim=none (message not signed) header.d=none;compauth=softpass reason=201';
  // V5 (structural): the echo ends in the last clause, so the writer's own smtp.mailfrom lands on it.
  const v5 = 'mx.google.com; spf=pass (google.com: domain of a);x=y;dmarc=pass header.from=customer.example (b@other.example designates 192.0.2.1 as permitted sender) smtp.mailfrom=b@other.example';

  it.each([['V1', v1], ['V3', v3], ['V5', v5]])('%s: not verified', (_l, value) => {
    expect(parseAuthClausesOrNull(value)).toBeNull();
    expect(buildSenderAuth(value, 'ceo@customer.example', ['ceo@customer.example']).verified).toBe(false);
  });

  it('refuses a DMARC clause followed by anything but compauth or dara', () => {
    expect(parseAuthClausesOrNull('mx.example; dmarc=pass header.from=b.example; spf=pass smtp.mailfrom=b.example')).toBeNull();
    expect(parseAuthClausesOrNull('mx.example; dmarc=pass header.from=b.example; compauth=pass reason=100')).not.toBeNull();
    expect(parseAuthClausesOrNull('mx.example; dmarc=pass header.from=b.example; dara=pass header.i=@b.example')).not.toBeNull();
  });

  it('refuses a DMARC clause carrying a property DMARC writers do not write', () => {
    expect(parseAuthClausesOrNull('mx.example; dmarc=pass header.from=b.example smtp.mailfrom=b.example')).toBeNull();
    expect(parseAuthClausesOrNull('mx.example; dmarc=pass action=none policy.dmarc=reject reason=x header.from=b.example')).not.toBeNull();
  });
});

describe('dkimIdentitiesAllowStamps', () => {
  it.each([
    ['a decoded ;', 'v=1; a=rsa-sha256; d=other.example; s=s1; i=a=3Bdmarc=3Dpass@other.example; bh=x; b=y'],
    ['a decoded space', 'v=1; d=other.example; i=a=20b@other.example; b=y'],
    ['a (', 'v=1; d=other.example; i=a(b@other.example; b=y'],
    ['a decoded "', 'v=1; d=other.example; i==22a=22@other.example; b=y'],
    ['a \\', 'v=1; d=other.example; i=a\\b@other.example; b=y'],
  ])('refuses a signature whose i= holds %s', (_l, sig) => {
    expect(dkimIdentitiesAllowStamps([sig])).toBe(false);
  });

  it('allows ordinary signatures, folded whitespace and no signature', () => {
    expect(dkimIdentitiesAllowStamps([])).toBe(true);
    expect(dkimIdentitiesAllowStamps(['v=1; a=rsa-sha256; d=example.com; s=s1; b=abc'])).toBe(true);
    expect(dkimIdentitiesAllowStamps(['v=1; d=example.com; i=jane.doe+x@example.com;\r\n\tbh=x; b=y', 'v=1; d=example.com; i=@example.com; b=y'])).toBe(true);
    expect(dkimIdentitiesAllowStamps(['v=1; d=example.com; i=jane\r\n =40example.com; b=y'])).toBe(true);
  });

  it('refuses a signature value that is not text', () => {
    expect(dkimIdentitiesAllowStamps([42])).toBe(false);
  });

  it.each(['a=3@x.example', 'a=G1@x.example', 'a=@x.example'])('refuses an i= with a malformed escape: %s', (identity) => {
    expect(dkimIdentitiesAllowStamps([`v=1; d=x.example; i=${identity}; b=y`])).toBe(false);
  });
});
