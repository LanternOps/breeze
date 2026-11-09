import { describe, expect, it, vi } from 'vitest';
import {
  TENANT_HINT_LOOKUP_TIMEOUT_MS,
  parseTenantHint,
  resolveEntraTenantIdFromDomain,
} from './tenantHint';

const TID = 'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e5';
const CONSUMER_TID = '9188040d-6c67-4c5b-b112-36a304b66dad';

function openIdConfig(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchReturning(response: Response | (() => Promise<Response>)) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    typeof response === 'function' ? response() : response);
}

describe('parseTenantHint', () => {
  it('a tenant GUID is a guid hint, lowercased and trimmed', () => {
    expect(parseTenantHint(TID)).toEqual({ kind: 'guid', tid: TID });
    expect(parseTenantHint(`  ${TID.toUpperCase()} `)).toEqual({ kind: 'guid', tid: TID });
  });

  it('the consumer (MSA) tenant is never a hint', () => {
    expect(parseTenantHint(CONSUMER_TID)).toBeNull();
    expect(parseTenantHint(CONSUMER_TID.toUpperCase())).toBeNull();
  });

  it('a hostname-shaped domain is a domain hint, lowercased and trimmed', () => {
    expect(parseTenantHint('contoso.com')).toEqual({ kind: 'domain', domain: 'contoso.com' });
    expect(parseTenantHint(' Contoso.OnMicrosoft.com ')).toEqual({ kind: 'domain', domain: 'contoso.onmicrosoft.com' });
    expect(parseTenantHint('my-org.co.uk')).toEqual({ kind: 'domain', domain: 'my-org.co.uk' });
    expect(parseTenantHint('xn--bcher-kva.example')).toEqual({ kind: 'domain', domain: 'xn--bcher-kva.example' });
  });

  it.each([
    '',
    '   ',
    'contoso', // a single label: also covers the common / organizations / consumers aliases
    'common',
    'organizations',
    'consumers',
    'contoso.com/v2.0',
    'contoso.com/../common',
    '../common',
    'contoso.com?x=1',
    'contoso.com#frag',
    'contoso.com:443',
    'user@contoso.com',
    'admin:pw@contoso.com',
    'https://contoso.com',
    '//contoso.com',
    'contoso.com.',
    '.contoso.com',
    'contoso..com',
    '-contoso.com',
    'contoso-.com',
    'contoso.c',
    'contoso.123',
    '10.0.0.1',
    '[::1]',
    'con toso.com',
    'conto\nso.com',
    'contoso.com%2f',
    'bücher.example',
    `${'a'.repeat(64)}.com`,
    `${Array.from({ length: 50 }, () => 'abcde').join('.')}.com`, // > 253 characters
    'a1a1a1a1-b2b2-4c3c-8d4d-e5e5e5e5e5e', // a GUID one character short is not a domain either
  ])('refuses %j', (raw) => {
    expect(parseTenantHint(raw)).toBeNull();
  });

  it('a 63-character label and a 253-character name are still accepted', () => {
    const label63 = `${'a'.repeat(63)}.com`;
    expect(parseTenantHint(label63)).toEqual({ kind: 'domain', domain: label63 });
    // 61 labels of "abc" joined by dots = 243 characters, plus ".abcdefghi" = 253.
    const long = `${Array.from({ length: 61 }, () => 'abc').join('.')}.abcdefghi`;
    expect(long.length).toBe(253);
    expect(parseTenantHint(long)).toEqual({ kind: 'domain', domain: long });
  });

  it('a non-string is refused', () => {
    expect(parseTenantHint(undefined as unknown as string)).toBeNull();
    expect(parseTenantHint(null as unknown as string)).toBeNull();
    expect(parseTenantHint(42 as unknown as string)).toBeNull();
  });
});

describe('resolveEntraTenantIdFromDomain', () => {
  it("reads the tid from the issuer of Microsoft's public openid-configuration for the domain", async () => {
    const fetch = fetchReturning(openIdConfig({
      issuer: `https://login.microsoftonline.com/${TID.toUpperCase()}/v2.0`,
      token_endpoint: `https://login.microsoftonline.com/${TID}/oauth2/v2.0/token`,
    }));

    expect(await resolveEntraTenantIdFromDomain('Contoso.com', { fetch })).toEqual({ kind: 'tenant', tid: TID });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://login.microsoftonline.com/contoso.com/v2.0/.well-known/openid-configuration');
    expect(init?.method ?? 'GET').toBe('GET');
    // Never follow a redirect off Microsoft's host, and always bounded in time.
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(TENANT_HINT_LOOKUP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(TENANT_HINT_LOOKUP_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it('does not fetch at all for a value that is not hostname-shaped (SSRF surface)', async () => {
    const fetch = fetchReturning(openIdConfig({ issuer: `https://login.microsoftonline.com/${TID}/v2.0` }));
    for (const domain of ['common', 'contoso.com/../organizations', 'user@contoso.com', 'contoso.com?x', '10.0.0.1', '', TID]) {
      expect(await resolveEntraTenantIdFromDomain(domain, { fetch })).toEqual({ kind: 'unknown_domain' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a consumer (MSA) domain resolves to nothing', async () => {
    const fetch = fetchReturning(openIdConfig({ issuer: `https://login.microsoftonline.com/${CONSUMER_TID}/v2.0` }));
    expect(await resolveEntraTenantIdFromDomain('outlook.com', { fetch })).toEqual({ kind: 'unknown_domain' });
  });

  it('a 400 invalid_tenant answer is a definite unknown domain', async () => {
    const fetch = vi.fn(async () => openIdConfig({ error: 'invalid_tenant', error_description: 'AADSTS90002' }, { status: 400 }));
    expect(await resolveEntraTenantIdFromDomain('contoso.com', { fetch })).toEqual({ kind: 'unknown_domain' });
  });

  it.each([
    ['a 400 with another error', () => Promise.resolve(openIdConfig({ error: 'invalid_request' }, { status: 400 }))],
    ['a 400 with a non-JSON body', () => Promise.resolve(new Response('<html>', { status: 400 }))],
    ['a 503', () => Promise.resolve(openIdConfig({ error: 'invalid_tenant' }, { status: 503 }))],
    ['a 429', () => Promise.resolve(openIdConfig({}, { status: 429 }))],
    ['a network failure', () => Promise.reject(new Error('ECONNRESET'))],
    ['a timeout', () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))],
    ['a body that is not JSON', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['a JSON array', () => Promise.resolve(openIdConfig([]))],
    ['no issuer', () => Promise.resolve(openIdConfig({ token_endpoint: 'x' }))],
    ['a non-string issuer', () => Promise.resolve(openIdConfig({ issuer: 42 }))],
    ['the {tenantid} placeholder issuer', () => Promise.resolve(openIdConfig({ issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0' }))],
    ['a v1 STS issuer', () => Promise.resolve(openIdConfig({ issuer: `https://sts.windows.net/${TID}/` }))],
    ['an issuer on another host', () => Promise.resolve(openIdConfig({ issuer: `https://login.example.com/${TID}/v2.0` }))],
    ['an issuer with a trailing path', () => Promise.resolve(openIdConfig({ issuer: `https://login.microsoftonline.com/${TID}/v2.0/extra` }))],
    ['an http issuer', () => Promise.resolve(openIdConfig({ issuer: `http://login.microsoftonline.com/${TID}/v2.0` }))],
  ])('%s → lookup_failed (ambiguous, not a negative answer)', async (_label, respond) => {
    const fetch = vi.fn(async () => respond());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await resolveEntraTenantIdFromDomain('contoso.com', { fetch })).toEqual({ kind: 'lookup_failed' });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('contoso.com');
    } finally {
      warn.mockRestore();
    }
  });
});
