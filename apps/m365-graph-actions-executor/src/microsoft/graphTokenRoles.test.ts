import { describe, expect, it } from 'vitest';
import { GraphTokenClaimsError, graphApplicationRolesFromToken } from './graphTokenRoles';
import type { OpaqueAccessToken } from './tokenClient';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-11-18T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

function base64url(value: unknown): string {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT' }) {
  return `${base64url(header)}.${base64url(claims)}.c2lnbmF0dXJl` as OpaqueAccessToken;
}

const VALID = {
  aud: 'https://graph.microsoft.com',
  tid: TENANT_ID,
  appid: CLIENT_ID,
  idtyp: 'app',
  exp: NOW_SECONDS + 3600,
  roles: ['User.ReadWrite.All', 'Organization.Read.All'],
};

function read(claims: Record<string, unknown>) {
  return graphApplicationRolesFromToken(token(claims), { tenantId: TENANT_ID, clientId: CLIENT_ID, now: NOW });
}

describe('graphApplicationRolesFromToken', () => {
  it('returns the sorted unique roles of a Graph app-only token for this tenant and client', () => {
    expect(read({ ...VALID, roles: ['User.ReadWrite.All', 'Organization.Read.All', 'User.ReadWrite.All'] }))
      .toEqual(['Organization.Read.All', 'User.ReadWrite.All']);
  });

  it('accepts every documented Graph audience form and a v2 azp in place of appid', () => {
    for (const aud of ['https://graph.microsoft.com', 'https://graph.microsoft.com/', '00000003-0000-0000-c000-000000000000']) {
      expect(read({ ...VALID, aud })).toHaveLength(2);
    }
    const { appid: _appid, ...v2 } = VALID;
    expect(read({ ...v2, azp: CLIENT_ID })).toHaveLength(2);
  });

  it('treats an absent roles claim as no application roles (Microsoft omits it when none are granted)', () => {
    const { roles: _roles, ...noRoles } = VALID;
    expect(read(noRoles)).toEqual([]);
  });

  it('accepts a token without idtyp (it is an optional claim)', () => {
    const { idtyp: _idtyp, ...noIdtyp } = VALID;
    expect(read(noIdtyp)).toHaveLength(2);
  });

  it.each([
    ['a non-Graph audience', { aud: 'https://outlook.office365.com' }],
    ['a missing audience', { aud: undefined }],
    ['another tenant', { tid: '66666666-6666-4666-8666-666666666666' }],
    ['a missing tenant', { tid: undefined }],
    ['another client (appid)', { appid: '88888888-8888-4888-8888-888888888888' }],
    ['another client (azp) beside a matching appid', { azp: '88888888-8888-4888-8888-888888888888' }],
    ['no client claim at all', { appid: undefined }],
    ['an expired token', { exp: NOW_SECONDS }],
    ['a missing exp', { exp: undefined }],
    ['a non-numeric exp', { exp: String(NOW_SECONDS + 3600) }],
    ['a delegated token type', { idtyp: 'user' }],
    ['a delegated scp claim', { scp: 'User.Read' }],
    ['roles that are not an array', { roles: 'User.ReadWrite.All' }],
    ['a non-string role', { roles: ['User.ReadWrite.All', 42] }],
    ['an empty role', { roles: [''] }],
    ['a role with unexpected characters', { roles: ['User.ReadWrite.All<script>'] }],
  ])('rejects %s', (_label, override) => {
    const claims: Record<string, unknown> = { ...VALID, ...override };
    for (const [key, value] of Object.entries(override)) if (value === undefined) delete claims[key];
    expect(() => read(claims)).toThrow(GraphTokenClaimsError);
  });

  it.each([
    ['an empty token', ''],
    ['a token without three segments', 'a.b'],
    ['an encrypted (five-segment) token', 'a.b.c.d.e'],
    ['a payload that is not base64url JSON', `${base64url({ alg: 'RS256' })}.!!!.sig`],
    ['a payload that is a JSON array', `${base64url({ alg: 'RS256' })}.${base64url([1, 2])}.sig`],
    ['an oversized token', `${base64url({ alg: 'RS256' })}.${'A'.repeat(20_000)}.sig`],
  ])('rejects %s', (_label, raw) => {
    expect(() => graphApplicationRolesFromToken(raw as OpaqueAccessToken, {
      tenantId: TENANT_ID,
      clientId: CLIENT_ID,
      now: NOW,
    })).toThrow(GraphTokenClaimsError);
  });

  it('never puts token material in the error', () => {
    try {
      read({ ...VALID, tid: 'secret-tenant-claim' });
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).toBe('graph_token_claims_invalid');
      expect(JSON.stringify(error)).not.toContain('secret-tenant-claim');
    }
  });
});
