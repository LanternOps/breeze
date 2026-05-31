import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sentry', () => ({
  captureException: vi.fn(),
}));

import {
  M365_TENANT_ID_REGEX,
  acquireClientCredentialsToken,
  ensureFreshToken,
  testGraphAccess,
} from './c2cM365';


describe('M365_TENANT_ID_REGEX', () => {
  it('accepts a canonical Entra tenant GUID', () => {
    expect(M365_TENANT_ID_REGEX.test('11111111-1111-1111-1111-111111111111')).toBe(true);
    expect(M365_TENANT_ID_REGEX.test('72f988bf-86f1-41af-91ab-2d7cd011db47')).toBe(true);
  });

  it('rejects the well-known aliases (invalid for client_credentials)', () => {
    expect(M365_TENANT_ID_REGEX.test('common')).toBe(false);
    expect(M365_TENANT_ID_REGEX.test('organizations')).toBe(false);
    expect(M365_TENANT_ID_REGEX.test('consumers')).toBe(false);
  });

  it('rejects path-injection / malformed values', () => {
    expect(M365_TENANT_ID_REGEX.test('not-a-guid')).toBe(false);
    expect(M365_TENANT_ID_REGEX.test('../../evil')).toBe(false);
    expect(M365_TENANT_ID_REGEX.test('11111111-1111-1111-1111-111111111111/extra')).toBe(false);
    expect(M365_TENANT_ID_REGEX.test('')).toBe(false);
  });
});

describe('acquireClientCredentialsToken', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws on a non-GUID tenantId before performing any fetch', async () => {
    await expect(
      acquireClientCredentialsToken({
        tenantId: 'not-a-guid',
        clientId: 'client',
        clientSecret: 'secret',
      })
    ).rejects.toThrow('Invalid M365 tenant id');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to follow redirects on the token fetch for a valid tenant', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ access_token: 'tok', expires_in: 3600 }),
    });

    const result = await acquireClientCredentialsToken({
      tenantId: '11111111-1111-1111-1111-111111111111',
      clientId: 'client',
      clientSecret: 'secret',
    });

    expect(result).toEqual({ accessToken: 'tok', expiresIn: 3600 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe(
      'https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/oauth2/v2.0/token'
    );
    expect(call[1]).toMatchObject({ redirect: 'error' });
  });
});

describe('testGraphAccess', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes redirect:error and the bearer header to the Graph fetch', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ value: [{ displayName: 'Contoso Ltd.' }] }),
    });

    const result = await testGraphAccess('access-token-abc');

    expect(result).toEqual({ ok: true, orgDisplayName: 'Contoso Ltd.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe('https://graph.microsoft.com/v1.0/organization');
    expect(call[1]).toMatchObject({ redirect: 'error' });
    expect(call[1].headers).toMatchObject({ Authorization: 'Bearer access-token-abc' });
  });

  it('does not leak the upstream Graph error body into the returned error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'UPSTREAM_GRAPH_BODY_MARKER: detailed Azure AD failure',
    });

    const result = await testGraphAccess('access-token-abc');

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).not.toContain('UPSTREAM_GRAPH_BODY_MARKER');
  });
});

describe('ensureFreshToken', () => {
  const fetchMock = vi.fn();
  const ORIGINAL_CLIENT_ID = process.env.C2C_M365_CLIENT_ID;
  const ORIGINAL_CLIENT_SECRET = process.env.C2C_M365_CLIENT_SECRET;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    // Platform config must be present so ensureFreshToken proceeds to the
    // refresh branch (it returns null early when these are unset).
    process.env.C2C_M365_CLIENT_ID = 'platform-client-id';
    process.env.C2C_M365_CLIENT_SECRET = 'platform-client-secret';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (ORIGINAL_CLIENT_ID === undefined) delete process.env.C2C_M365_CLIENT_ID;
    else process.env.C2C_M365_CLIENT_ID = ORIGINAL_CLIENT_ID;
    if (ORIGINAL_CLIENT_SECRET === undefined) delete process.env.C2C_M365_CLIENT_SECRET;
    else process.env.C2C_M365_CLIENT_SECRET = ORIGINAL_CLIENT_SECRET;
  });

  it('rejects a non-GUID tenantId on the refresh path before any fetch', async () => {
    // currentToken: null forces the refresh branch, which delegates to
    // acquireClientCredentialsToken — where the GUID guard lives.
    await expect(
      ensureFreshToken({
        tenantId: 'not-a-guid',
        currentToken: null,
        tokenExpiresAt: null,
      })
    ).rejects.toThrow('Invalid M365 tenant id');

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
