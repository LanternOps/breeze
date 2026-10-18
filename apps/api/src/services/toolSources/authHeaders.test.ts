import { describe, expect, it, vi } from 'vitest';
import { buildToolSourceAuthHeaders, ToolSourceAuthError } from './authHeaders';

const ORIGIN = 'https://api.example.com';
const URL_ON_ORIGIN = 'https://api.example.com/v1/pets';
const URL_OFF_ORIGIN = 'https://docs.example.net/openapi.json';

function tokenResponse(token: string) {
  return new Response(JSON.stringify({ access_token: token, expires_in: 3600 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildToolSourceAuthHeaders', () => {
  it('returns no headers for authKind none, on or off origin', async () => {
    expect(await buildToolSourceAuthHeaders({ authKind: 'none' }, URL_ON_ORIGIN, ORIGIN)).toEqual({});
    expect(await buildToolSourceAuthHeaders({ authKind: 'none' }, URL_OFF_ORIGIN, ORIGIN)).toEqual({});
  });

  it('builds bearer, api-key-header and basic headers on a matching origin', async () => {
    expect(await buildToolSourceAuthHeaders({ authKind: 'bearer', token: 't' }, URL_ON_ORIGIN, ORIGIN))
      .toEqual({ Authorization: 'Bearer t' });
    expect(
      await buildToolSourceAuthHeaders({ authKind: 'api_key_header', headerName: 'X-Api-Key', value: 'k' }, URL_ON_ORIGIN, ORIGIN),
    ).toEqual({ 'X-Api-Key': 'k' });
    expect(await buildToolSourceAuthHeaders({ authKind: 'basic', username: 'u', password: 'p' }, URL_ON_ORIGIN, ORIGIN))
      .toEqual({ Authorization: `Basic ${Buffer.from('u:p').toString('base64')}` });
  });

  it('throws origin_mismatch by default when the target is off-origin', async () => {
    const err = await buildToolSourceAuthHeaders({ authKind: 'bearer', token: 't' }, URL_OFF_ORIGIN, ORIGIN).catch((e) => e);
    expect(err).toBeInstanceOf(ToolSourceAuthError);
    expect(err.code).toBe('origin_mismatch');
    expect(String(err.message)).not.toContain('t\'');
  });

  it('omits the credential instead of throwing when asked to', async () => {
    expect(
      await buildToolSourceAuthHeaders({ authKind: 'bearer', token: 't' }, URL_OFF_ORIGIN, ORIGIN, { onOriginMismatch: 'omit' }),
    ).toEqual({});
  });

  it('treats a port or scheme difference as a different origin', async () => {
    await expect(
      buildToolSourceAuthHeaders({ authKind: 'bearer', token: 't' }, 'https://api.example.com:8443/v1', ORIGIN),
    ).rejects.toBeInstanceOf(ToolSourceAuthError);
    await expect(
      buildToolSourceAuthHeaders({ authKind: 'bearer', token: 't' }, 'http://api.example.com/v1', ORIGIN),
    ).rejects.toBeInstanceOf(ToolSourceAuthError);
  });

  it('refuses a userinfo-smuggled host (https://api.example.com@evil.example)', async () => {
    await expect(
      buildToolSourceAuthHeaders({ authKind: 'bearer', token: 't' }, 'https://api.example.com@evil.example/v1', ORIGIN),
    ).rejects.toBeInstanceOf(ToolSourceAuthError);
  });

  it('exchanges oauth2 client credentials and sends the access token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse('at-1'));
    const headers = await buildToolSourceAuthHeaders(
      { authKind: 'oauth2_client_credentials', tokenUrl: 'https://id.example.com/token', clientId: 'a-unique-1', clientSecret: 'b' },
      URL_ON_ORIGIN, ORIGIN, { fetchImpl },
    );
    expect(headers).toEqual({ Authorization: 'Bearer at-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never contacts the oauth2 token endpoint for an off-origin target in omit mode', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse('at-2'));
    const headers = await buildToolSourceAuthHeaders(
      { authKind: 'oauth2_client_credentials', tokenUrl: 'https://id.example.com/token', clientId: 'a-unique-2', clientSecret: 'b' },
      URL_OFF_ORIGIN, ORIGIN, { fetchImpl, onOriginMismatch: 'omit' },
    );
    expect(headers).toEqual({});
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws origin_mismatch for an off-origin oauth2 target WITHOUT contacting the token endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(tokenResponse('at-x'));
    const err = await buildToolSourceAuthHeaders(
      { authKind: 'oauth2_client_credentials', tokenUrl: 'https://id.example.com/token', clientId: 'a-unique-4', clientSecret: 'b' },
      URL_OFF_ORIGIN, ORIGIN, { fetchImpl },
    ).catch((e) => e);
    expect(err).toMatchObject({ code: 'origin_mismatch' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an auth kind it does not know rather than sending the request unauthenticated', async () => {
    await expect(buildToolSourceAuthHeaders({ authKind: 'mystery' } as any, URL_ON_ORIGIN, ORIGIN)).rejects.toMatchObject({ code: 'auth' });
  });

  it('reports an oauth2 token failure as ToolSourceAuthError code auth', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const err = await buildToolSourceAuthHeaders(
      { authKind: 'oauth2_client_credentials', tokenUrl: 'https://id.example.com/token', clientId: 'a-unique-3', clientSecret: 'b' },
      URL_ON_ORIGIN, ORIGIN, { fetchImpl },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ToolSourceAuthError);
    expect(err.code).toBe('auth');
  });
});
