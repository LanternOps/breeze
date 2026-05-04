import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthAuthorizationCodes, oauthClients, oauthInteractions, oauthRefreshTokens } from '../db/schema';
import { BreezeOidcAdapter } from './adapter';
import { revokeGrant } from './revocationCache';
import { assertActiveTenantContext, TenantInactiveError } from '../services/tenantStatus';

vi.mock('../db', () => ({
  db: { insert: vi.fn(), update: vi.fn(), select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./revocationCache', () => ({
  revokeJti: vi.fn(async () => undefined),
  revokeGrant: vi.fn(async () => undefined),
}));

vi.mock('../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
  assertActiveTenantContext: vi.fn().mockResolvedValue(undefined),
}));

const insertMock = vi.mocked(db.insert);
const updateMock = vi.mocked(db.update);
const selectMock = vi.mocked(db.select);
const runOutsideDbContextMock = vi.mocked(runOutsideDbContext);
const withSystemDbAccessContextMock = vi.mocked(withSystemDbAccessContext);

function mockInsertChain() {
  const onConflictDoUpdate = vi.fn();
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  insertMock.mockReturnValue({ values } as unknown as ReturnType<typeof db.insert>);
  return { values, onConflictDoUpdate };
}

function mockUpdateChain() {
  const where = vi.fn();
  const set = vi.fn(() => ({ where }));
  updateMock.mockReturnValue({ set } as unknown as ReturnType<typeof db.update>);
  return { set, where };
}

function mockSelectRows(rows: unknown[]) {
  const where = vi.fn(async () => rows);
  const from = vi.fn(() => ({ where }));
  selectMock.mockReturnValue({ from } as unknown as ReturnType<typeof db.select>);
  return { from, where };
}

describe('BreezeOidcAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertActiveTenantContext).mockResolvedValue(undefined);
  });

  it('upserts Client rows with null partner, metadata payload, and hashed secret', async () => {
    const chain = mockInsertChain();
    const payload = {
      client_id: 'client_abc',
      client_name: 'Claude',
      client_secret: 'secret-value',
    };

    await new BreezeOidcAdapter('Client').upsert('client_abc', payload, undefined);

    expect(insertMock).toHaveBeenCalledWith(oauthClients);
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({
      id: 'client_abc',
      partnerId: null,
      metadata: payload,
      clientSecretHash: '31160254d1297393d2ad00e1c01851aec834361e02c524b89fe06aff2879ce6a',
    }));
    expect(chain.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      target: oauthClients.id,
      set: expect.objectContaining({ metadata: payload, lastUsedAt: expect.any(Date) }),
    }));
  });

  it('exits request DB context before opening system DB context', async () => {
    mockInsertChain();

    await new BreezeOidcAdapter('Client').upsert('client_abc', { client_id: 'client_abc' }, undefined);

    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
    expect(runOutsideDbContextMock.mock.invocationCallOrder[0]!)
      .toBeLessThan(withSystemDbAccessContextMock.mock.invocationCallOrder[0]!);
  });

  it('finds Client metadata when enabled', async () => {
    const payload = { client_id: 'client_abc' };
    mockSelectRows([{ metadata: payload, disabledAt: null }]);

    await expect(new BreezeOidcAdapter('Client').find('client_abc')).resolves.toBe(payload);
  });

  it('returns undefined for disabled Client rows', async () => {
    mockSelectRows([{ metadata: { client_id: 'client_abc' }, disabledAt: new Date() }]);

    await expect(new BreezeOidcAdapter('Client').find('client_abc')).resolves.toBeUndefined();
  });

  it('upserts AuthorizationCode rows using tenant ids from payload.extra', async () => {
    const chain = mockInsertChain();
    const payload = {
      accountId: '00000000-0000-4000-8000-000000000001',
      clientId: 'client_abc',
      extra: {
        partner_id: '00000000-0000-4000-8000-000000000002',
        org_id: '00000000-0000-4000-8000-000000000003',
      },
    };

    await new BreezeOidcAdapter('AuthorizationCode').upsert('code_abc', payload, 60);

    expect(insertMock).toHaveBeenCalledWith(oauthAuthorizationCodes);
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({
      id: 'code_abc',
      userId: payload.accountId,
      clientId: payload.clientId,
      partnerId: payload.extra.partner_id,
      orgId: payload.extra.org_id,
      payload,
      expiresAt: expect.any(Date),
    }));
    expect(chain.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      target: oauthAuthorizationCodes.id,
      set: expect.objectContaining({ payload, expiresAt: expect.any(Date) }),
    }));
  });

  it('marks AuthorizationCode rows consumed', async () => {
    const chain = mockUpdateChain();

    await new BreezeOidcAdapter('AuthorizationCode').consume('code_abc');

    expect(updateMock).toHaveBeenCalledWith(oauthAuthorizationCodes);
    expect(chain.set).toHaveBeenCalledWith({ consumedAt: expect.any(Date) });
    expect(chain.where).toHaveBeenCalled();
  });

  it('revokes RefreshToken rows on destroy', async () => {
    const chain = mockUpdateChain();

    await new BreezeOidcAdapter('RefreshToken').destroy('refresh_abc');

    expect(updateMock).toHaveBeenCalledWith(oauthRefreshTokens);
    expect(chain.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    expect(chain.where).toHaveBeenCalled();
  });

  it('revokes refresh tokens by grantId with one JSON predicate update', async () => {
    const chain = mockUpdateChain();

    await new BreezeOidcAdapter('RefreshToken').revokeByGrantId('grant_abc');

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(oauthRefreshTokens);
    expect(chain.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    expect(chain.where).toHaveBeenCalledTimes(1);
  });

  it('persists Interaction rows so consent flows survive API restart', async () => {
    // Interaction was originally in-memory, which meant a deploy mid-flow
    // would 404 the user the moment they clicked Approve. 2026-04-24-oauth-interactions
    // migrated it to a DB-backed model — the upsert below is the hot path that
    // runs on every interaction.save() during /authorize and consent resume.
    const chain = mockInsertChain();
    const payload = { uid: 'interaction_abc', params: { client_id: 'client_abc' } };

    await new BreezeOidcAdapter('Interaction').upsert('interaction_abc', payload, 3600);

    expect(insertMock).toHaveBeenCalledWith(oauthInteractions);
    expect(chain.values).toHaveBeenCalledWith(expect.objectContaining({
      id: 'interaction_abc',
      payload,
      expiresAt: expect.any(Date),
    }));
    expect(chain.onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      target: oauthInteractions.id,
      set: expect.objectContaining({ payload, expiresAt: expect.any(Date) }),
    }));
  });

  it('round-trips non-persistent models through in-memory fallback', async () => {
    // Interaction was migrated to DB persistence in 2026-04-24-oauth-interactions.
    // The in-memory fallback now covers the remaining oidc-provider models we
    // don't write to Postgres (e.g. AccessToken — JWTs are self-validating
    // with revocation cached separately, and ReplayDetection — short-lived
    // nonce dedupe whose only requirement is process-local memory).
    const payload = { jti: 'access_abc', accountId: 'user_abc' };
    const adapter = new BreezeOidcAdapter('AccessToken');

    await adapter.upsert('access_abc', payload, 60);

    await expect(adapter.find('access_abc')).resolves.toBe(payload);
  });

  it('returns undefined for unknown ids under DB-backed models', async () => {
    mockSelectRows([]);

    await expect(new BreezeOidcAdapter('RefreshToken').find('missing')).resolves.toBeUndefined();
  });

  it('returns undefined for refresh tokens whose tenant is inactive or deleted', async () => {
    vi.mocked(assertActiveTenantContext).mockRejectedValue(new TenantInactiveError('Partner is not active'));
    mockSelectRows([{
      id: 'refresh_abc',
      userId: '00000000-0000-4000-8000-000000000001',
      clientId: 'client_abc',
      partnerId: '00000000-0000-4000-8000-000000000002',
      orgId: null,
      payload: { accountId: 'user_abc', grantId: 'grant_abc' },
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    }]);

    await expect(new BreezeOidcAdapter('RefreshToken').find('refresh_abc')).resolves.toBeUndefined();
    expect(revokeGrant).not.toHaveBeenCalled();
  });

  it('returns undefined for consumed AuthorizationCode rows', async () => {
    mockSelectRows([{
      payload: { accountId: 'user_abc' },
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    }]);

    await expect(new BreezeOidcAdapter('AuthorizationCode').find('code_abc')).resolves.toBeUndefined();
  });

  it('returns undefined for expired AuthorizationCode rows', async () => {
    mockSelectRows([{
      payload: { accountId: 'user_abc' },
      consumedAt: null,
      expiresAt: new Date(Date.now() - 1_000),
    }]);

    await expect(new BreezeOidcAdapter('AuthorizationCode').find('code_abc')).resolves.toBeUndefined();
  });

  it('returns undefined for revoked RefreshToken rows and revokes the whole grant family', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockSelectRows([{
      id: 'refresh_abc',
      userId: '00000000-0000-4000-8000-000000000001',
      clientId: 'client_abc',
      partnerId: '00000000-0000-4000-8000-000000000002',
      payload: { accountId: 'user_abc', grantId: 'grant_abc' },
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    }]);

    await expect(new BreezeOidcAdapter('RefreshToken').find('refresh_abc')).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('OAUTH_REFRESH_TOKEN_REUSE'),
      expect.objectContaining({
        client_id: 'client_abc',
        partner_id: '00000000-0000-4000-8000-000000000002',
        user_id: '00000000-0000-4000-8000-000000000001',
        grant_id: 'grant_abc',
      }),
    );
    // Refresh-token reuse must revoke the entire grant family — without
    // this, sibling access JWTs minted from the same grant would survive
    // until natural expiry. See finding #5.
    expect(vi.mocked(revokeGrant)).toHaveBeenCalledWith('grant_abc', expect.any(Number));
    consoleError.mockRestore();
  });

  it('returns undefined for expired RefreshToken rows', async () => {
    mockSelectRows([{
      payload: { accountId: 'user_abc' },
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1_000),
    }]);

    await expect(new BreezeOidcAdapter('RefreshToken').find('refresh_abc')).resolves.toBeUndefined();
  });
});
