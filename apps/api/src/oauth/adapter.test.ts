import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Provider } from 'oidc-provider';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthAuthorizationCodes, oauthClients, oauthInteractions, oauthRefreshTokens } from '../db/schema';
import {
  BreezeOidcAdapter,
  refreshTokenStorageId,
  restoreRefreshTokenPayload,
  sanitizeRefreshTokenPayload,
} from './adapter';
import { revokeGrant, revokeJti } from './revocationCache';
import { metricsRegistry } from '../services/metricsRegistry';
import {
  configureRotationSealKey,
  markRotationGraceHit,
  openRotationSuccessor,
  rotationGraceHit,
  sealRotationSuccessor,
  takePendingRotationSuccessor,
} from './refreshRotationGrace';
import { assertActiveTenantContext, TenantInactiveError } from '../services/tenantStatus';
import {
  isOAuthGrantActiveInCurrentDbContext,
  revokeGrantsDurablyInCurrentDbContext,
} from './grantStatus';

vi.mock('../db', () => ({
  db: { insert: vi.fn(), update: vi.fn(), select: vi.fn() },
  runOutsideDbContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./revocationCache', () => ({
  revokeJti: vi.fn(async () => undefined),
  revokeGrant: vi.fn(async () => undefined),
}));

vi.mock('../services/tenantStatus', () => ({
  TenantInactiveError: class TenantInactiveError extends Error {},
  assertActiveTenantContext: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./grantStatus', () => ({
  isOAuthGrantActiveInCurrentDbContext: vi.fn(async () => true),
  revokeGrantsDurablyInCurrentDbContext: vi.fn(async () => undefined),
}));

const insertMock = vi.mocked(db.insert);
const updateMock = vi.mocked(db.update);
const selectMock = vi.mocked(db.select);
const runOutsideDbContextMock = vi.mocked(runOutsideDbContext);
const withSystemDbAccessContextMock = vi.mocked(withSystemDbAccessContext);

function mockInsertChain(returnedRows: unknown[] = [{ id: 'inserted' }]) {
  // RefreshToken upserts read back the row they inserted or matched (#10301);
  // the other models await onConflictDoUpdate() directly.
  const returning = vi.fn(async () => returnedRows);
  const onConflictDoUpdate = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  insertMock.mockReturnValue({ values } as unknown as ReturnType<typeof db.insert>);
  return { values, onConflictDoUpdate, returning };
}

function mockRetryInsertChain(userId: string) {
  const returning = vi.fn(async () => [{ userId }]);
  const onConflictDoUpdate = vi.fn(() => ({ returning }));
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  insertMock.mockReturnValue({ values } as unknown as ReturnType<typeof db.insert>);
  return { values, onConflictDoUpdate, returning };
}

function mockUpdateChain(rows: unknown[] = [{ id: 'updated' }]) {
  const returning = vi.fn(async () => rows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  updateMock.mockReturnValue({ set } as unknown as ReturnType<typeof db.update>);
  return { set, where, returning };
}

function mockUpdateChainRejecting(err: Error) {
  const where = vi.fn(() => Promise.reject(err));
  const set = vi.fn(() => ({ where }));
  updateMock.mockReturnValue({ set } as unknown as ReturnType<typeof db.update>);
  return { set, where };
}

function collectSqlStrings(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks;
  const stringValue = (value as { value?: unknown }).value;
  let out = '';
  if (Array.isArray(stringValue)) {
    out += stringValue.join('');
  }
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      out += collectSqlStrings(chunk);
    }
  }
  return out;
}

// Recursively collect every string reachable from a value. Used to prove that
// a Drizzle `eq(column, value)` where-clause carries the digest (as a bound
// Param.value) rather than the raw refresh-token id.
function collectAllStrings(value: unknown, acc = new Set<string>(), seen = new WeakSet<object>()): Set<string> {
  if (typeof value === 'string') {
    acc.add(value);
    return acc;
  }
  if (!value || typeof value !== 'object') return acc;
  if (seen.has(value)) return acc;
  seen.add(value);
  for (const v of Object.values(value as Record<string, unknown>)) {
    collectAllStrings(v, acc, seen);
  }
  return acc;
}

function collectDates(value: unknown, acc: Date[] = [], seen = new WeakSet<object>()): Date[] {
  if (value instanceof Date) {
    acc.push(value);
    return acc;
  }
  if (!value || typeof value !== 'object') return acc;
  if (seen.has(value)) return acc;
  seen.add(value);
  for (const v of Object.values(value as Record<string, unknown>)) collectDates(v, acc, seen);
  return acc;
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
    vi.mocked(isOAuthGrantActiveInCurrentDbContext).mockResolvedValue(true);
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

  // B-W03 (#6157, D-B20): a CIMD client is resolved through oidc-provider's
  // metadata-document path (its cache + allowClient) on every use, never from
  // stored metadata; the oauth_clients row exists only so FKs and blocks work.
  it('adapter.find(Client) returns undefined for a CIMD id even when a row exists', async () => {
    const { where } = mockSelectRows([{ metadata: { client_id: 'https://client.example.com/m.json' }, disabledAt: null }]);
    await expect(new BreezeOidcAdapter('Client').find('https://client.example.com/m.json')).resolves.toBeUndefined();
    expect(where).not.toHaveBeenCalled();
  });

  it('adapter.upsert(Client) refuses a CIMD id', async () => {
    const chain = mockInsertChain();
    await expect(new BreezeOidcAdapter('Client').upsert('https://client.example.com/m.json', { client_id: 'https://client.example.com/m.json' }, undefined))
      .rejects.toThrow(/metadata document/i);
    expect(chain.values).not.toHaveBeenCalled();
  });

  it('upserts AuthorizationCode rows using tenant ids from payload.extra', async () => {
    const chain = mockInsertChain();
    mockUpdateChain();
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

  // DCR GC (provider.cleanupStaleOauthClients) deletes clients whose
  // `last_used_at` is NULL once they age past 7 days with no live grant.
  // Before this stamp existed, `last_used_at` was only written on
  // re-registration, so every actively used Claude / Claude Code client was
  // GC'd the moment its refresh token lapsed and the client kept replaying a
  // dead client_id (`invalid_client`, 2026-09-10).
  it('stamps oauth_clients.last_used_at when an AuthorizationCode is issued for the client', async () => {
    mockInsertChain();
    const update = mockUpdateChain();
    const payload = {
      accountId: '00000000-0000-4000-8000-000000000001',
      clientId: 'client_abc',
      extra: { partner_id: '00000000-0000-4000-8000-000000000002' },
    };

    await new BreezeOidcAdapter('AuthorizationCode').upsert('code_abc', payload, 60);

    expect(updateMock).toHaveBeenCalledWith(oauthClients);
    expect(update.set).toHaveBeenCalledWith({ lastUsedAt: expect.any(Date) });
    const whereArg = (update.where.mock.calls[0] as unknown[])[0];
    expect(collectAllStrings(whereArg)).toContain('client_abc');
  });

  it('stamps oauth_clients.last_used_at when a RefreshToken is issued for the client', async () => {
    mockInsertChain();
    const update = mockUpdateChain();
    const payload = {
      accountId: '00000000-0000-4000-8000-000000000001',
      clientId: 'client_abc',
      extra: { partner_id: '00000000-0000-4000-8000-000000000002' },
    };

    await new BreezeOidcAdapter('RefreshToken').upsert('raw_rt', payload, 3600);

    expect(updateMock).toHaveBeenCalledWith(oauthClients);
    expect(update.set).toHaveBeenCalledWith({ lastUsedAt: expect.any(Date) });
    expect(collectAllStrings((update.where.mock.calls[0] as unknown[])[0])).toContain('client_abc');
  });

  // The last_used_at stamp is advisory bookkeeping for the DCR GC. A failure
  // of that UPDATE must never abort token issuance — before #5610 the
  // rejection propagated out of upsert() and the whole AuthorizationCode /
  // RefreshToken grant failed.
  it('still issues an AuthorizationCode when the last_used_at stamp UPDATE fails', async () => {
    const chain = mockInsertChain();
    mockUpdateChainRejecting(new Error('stamp update exploded'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const payload = {
      accountId: '00000000-0000-4000-8000-000000000001',
      clientId: 'client_abc',
      extra: { partner_id: '00000000-0000-4000-8000-000000000002' },
    };

    await expect(new BreezeOidcAdapter('AuthorizationCode').upsert('code_abc', payload, 60))
      .resolves.toBeUndefined();

    expect(insertMock).toHaveBeenCalledWith(oauthAuthorizationCodes);
    expect(chain.onConflictDoUpdate).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain('OAUTH_CLIENT_LAST_USED_STAMP_FAILED');
    warn.mockRestore();
  });

  it('still issues a RefreshToken when the last_used_at stamp UPDATE fails', async () => {
    const chain = mockInsertChain();
    mockUpdateChainRejecting(new Error('stamp update exploded'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const payload = {
      accountId: '00000000-0000-4000-8000-000000000001',
      clientId: 'client_abc',
      extra: { partner_id: '00000000-0000-4000-8000-000000000002' },
    };

    await expect(new BreezeOidcAdapter('RefreshToken').upsert('raw_rt', payload, 3600))
      .resolves.toBeUndefined();

    expect(insertMock).toHaveBeenCalledWith(oauthRefreshTokens);
    expect(chain.onConflictDoUpdate).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('marks AuthorizationCode rows consumed and stamps payload.consumed for the library', async () => {
    const chain = mockUpdateChain();

    await new BreezeOidcAdapter('AuthorizationCode').consume('code_abc');

    expect(updateMock).toHaveBeenCalledWith(oauthAuthorizationCodes);
    // Both the row-level guard (consumedAt) AND the oidc-provider consumable
    // payload field must be written: find() returns the payload on replay and
    // the library reads `code.consumed` from it to fire the grant-wide revoke.
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({
      consumedAt: expect.any(Date),
      payload: expect.anything(),
    }));
    // Tighten: the `payload` update must be the jsonb_set that stamps the
    // '{consumed}' key (an epoch int). expect.anything() above would pass even
    // if the consumed stamp were dropped — a refactor that drops it re-opens the
    // replay-revoke gap (find() would surface a payload with no `consumed`, so
    // oidc-provider's `if (code.consumed)` revoke branch never fires). Assert
    // the SQL fragment so that regression fails here.
    const consumeSetArg = (chain.set.mock.calls[0] as unknown[])[0] as { payload?: unknown };
    const payloadSql = collectSqlStrings(consumeSetArg.payload);
    expect(payloadSql).toContain('jsonb_set');
    expect(payloadSql).toContain('{consumed}');
    expect(chain.where).toHaveBeenCalled();
    expect(chain.returning).toHaveBeenCalled();
  });

  it('rejects an AuthorizationCode consume that loses the atomic single-use claim', async () => {
    const chain = mockUpdateChain([]);

    await expect(new BreezeOidcAdapter('AuthorizationCode').consume('code_abc'))
      .rejects.toMatchObject({ error: 'invalid_grant' });

    expect(chain.returning).toHaveBeenCalled();
  });

  it('consume() on RefreshToken only revokes (no payload.consumed stamp) — unchanged by the auth-code fix', async () => {
    const chain = mockUpdateChain();

    await new BreezeOidcAdapter('RefreshToken').consume('refresh_abc');

    expect(updateMock).toHaveBeenCalledWith(oauthRefreshTokens);
    expect(chain.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    expect(chain.where).toHaveBeenCalled();
    expect(chain.returning).toHaveBeenCalled();
  });

  it('rejects a RefreshToken consume that loses the atomic single-use claim', async () => {
    const chain = mockUpdateChain([]);

    await expect(new BreezeOidcAdapter('RefreshToken').consume('refresh_abc'))
      .rejects.toMatchObject({ error: 'invalid_grant' });

    expect(chain.returning).toHaveBeenCalled();
  });

  it('consume() on AccessToken is a no-op DB-wise (in-memory model)', async () => {
    // AccessToken isn't a consumable/DB-backed model in this adapter; consume()
    // must not switch into the AuthorizationCode/RefreshToken branches.
    await new BreezeOidcAdapter('AccessToken').consume('access_abc');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('revokes RefreshToken rows on destroy', async () => {
    mockSelectRows([]);
    const chain = mockUpdateChain();

    await new BreezeOidcAdapter('RefreshToken').destroy('refresh_abc');

    expect(updateMock).toHaveBeenCalledWith(oauthRefreshTokens);
    expect(chain.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    expect(chain.where).toHaveBeenCalled();
  });

  it('revokeByGrantId durably revokes the Grant, its codes and its refresh family', async () => {
    // oidc-provider fires revokeGrant on authorization-code replay. Revoking
    // only the refresh rows (what this used to do) left oauth_grants.revoked_at
    // NULL, so once the 1800s Redis marker lapsed the replayed code's Grant
    // read as live again and could restart the family.
    mockSelectRows([{ accountId: '00000000-0000-4000-8000-000000000001' }]);

    await new BreezeOidcAdapter('RefreshToken').revokeByGrantId('grant_abc');

    expect(vi.mocked(revokeGrantsDurablyInCurrentDbContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        grantIds: ['grant_abc'],
        reason: 'provider-revoke-grant',
        cascadeRefreshTokens: true,
      }),
    );
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

  it('returns the payload for a fresh (unconsumed) AuthorizationCode so the first exchange succeeds', async () => {
    const payload = { accountId: 'user_abc', grantId: 'grant_abc' };
    mockSelectRows([{
      payload,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    }]);

    await expect(new BreezeOidcAdapter('AuthorizationCode').find('code_abc')).resolves.toBe(payload);
  });

  it('rejects a still-live AuthorizationCode after its durable Grant is revoked', async () => {
    vi.mocked(isOAuthGrantActiveInCurrentDbContext).mockResolvedValueOnce(false);
    mockSelectRows([{
      payload: { accountId: 'user_abc', grantId: 'grant_revoked' },
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    }]);

    await expect(new BreezeOidcAdapter('AuthorizationCode').find('code_abc')).resolves.toBeUndefined();
    expect(isOAuthGrantActiveInCurrentDbContext).toHaveBeenCalledWith('grant_revoked');
  });

  it('surfaces a consumed AuthorizationCode payload on replay and logs OAUTH_AUTH_CODE_REUSE', async () => {
    // On replay the adapter MUST return the (consumed-stamped) payload rather
    // than undefined: oidc-provider calls find() with ignoreExpiration:true and
    // relies on its own `if (code.consumed) { revoke(grantId); throw }` branch
    // to revoke the whole grant family. Hiding the row surfaced replays as a
    // generic "authorization code not found" and left that revoke branch dead.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const payload = { accountId: 'user_abc', grantId: 'grant_abc', consumed: 1_700_000_000 };
    mockSelectRows([{
      payload,
      consumedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    }]);

    await expect(new BreezeOidcAdapter('AuthorizationCode').find('code_abc')).resolves.toBe(payload);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('OAUTH_AUTH_CODE_REUSE'),
      expect.objectContaining({ grant_id: 'grant_abc' }),
    );
    consoleError.mockRestore();
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

  it('refresh-token reuse revokes the Grant durably, not just with an expiring Redis marker', async () => {
    // The Redis grant marker lives GRANT_REVOCATION_TTL_SECONDS (1800s). If the
    // durable half never runs, a stolen sibling refresh token starts passing
    // the active-Grant predicate again the moment the marker lapses and the
    // thief regains the whole family.
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

    expect(vi.mocked(revokeGrantsDurablyInCurrentDbContext)).toHaveBeenCalledWith(
      expect.objectContaining({
        grantIds: ['grant_abc'],
        reason: 'refresh-token-reuse',
        cascadeRefreshTokens: true,
      }),
    );
    consoleError.mockRestore();
  });

  it('does not attempt a durable grant sweep when the reused token carries no grantId', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockSelectRows([{
      id: 'refresh_abc',
      userId: '00000000-0000-4000-8000-000000000001',
      clientId: 'client_abc',
      partnerId: '00000000-0000-4000-8000-000000000002',
      payload: { accountId: 'user_abc' },
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    }]);

    await expect(new BreezeOidcAdapter('RefreshToken').find('refresh_abc')).resolves.toBeUndefined();

    expect(vi.mocked(revokeGrantsDurablyInCurrentDbContext)).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('rejects an otherwise-live RefreshToken after its durable Grant is revoked', async () => {
    vi.mocked(isOAuthGrantActiveInCurrentDbContext).mockResolvedValueOnce(false);
    mockSelectRows([{
      id: 'refresh_abc',
      userId: '00000000-0000-4000-8000-000000000001',
      clientId: 'client_abc',
      partnerId: '00000000-0000-4000-8000-000000000002',
      orgId: null,
      payload: { accountId: 'user_abc', grantId: 'grant_revoked' },
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    }]);

    await expect(new BreezeOidcAdapter('RefreshToken').find('refresh_abc')).resolves.toBeUndefined();
    expect(assertActiveTenantContext).not.toHaveBeenCalled();
  });

  it('durably records refresh-token replay cleanup before returning the invalid-token result', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    mockSelectRows([{
      id: 'refresh-digest',
      userId,
      clientId: 'client_abc',
      partnerId: '00000000-0000-4000-8000-000000000002',
      orgId: null,
      payload: { accountId: userId, grantId: 'grant-replay' },
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    }]);
    const retry = mockRetryInsertChain(userId);
    vi.mocked(revokeGrant).mockRejectedValueOnce(new Error('Redis unavailable'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(new BreezeOidcAdapter('RefreshToken').find('refresh-raw')).resolves.toBeUndefined();

    expect(retry.values).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      markerType: 'grant',
      markerId: 'grant-replay',
    }));
  });

  it('durably records AccessToken destroy cleanup before throwing fail closed', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    const adapter = new BreezeOidcAdapter('AccessToken');
    await adapter.upsert('access-jti', {
      accountId: userId,
      exp: Math.floor(Date.now() / 1000) + 60,
    }, 60);
    const retry = mockRetryInsertChain(userId);
    vi.mocked(revokeJti).mockRejectedValueOnce(new Error('Redis unavailable'));

    await expect(adapter.destroy('access-jti')).rejects.toThrow();

    expect(retry.values).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      markerType: 'jti',
      markerId: 'access-jti',
    }));
  });

  it('resolves grant ownership and durably records revokeByGrantId cleanup before throwing', async () => {
    const userId = '00000000-0000-4000-8000-000000000001';
    mockSelectRows([{ accountId: userId }]);
    const retry = mockRetryInsertChain(userId);
    vi.mocked(revokeGrant).mockRejectedValueOnce(new Error('Redis unavailable'));

    await expect(new BreezeOidcAdapter('RefreshToken').revokeByGrantId('grant-owned')).rejects.toThrow();

    expect(retry.values).toHaveBeenCalledWith(expect.objectContaining({
      userId,
      markerType: 'grant',
      markerId: 'grant-owned',
    }));
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

describe('refresh-token storage helpers', () => {
  it('refreshTokenStorageId returns the lowercase sha256 hex of the raw id', () => {
    const rawId = 'refresh_raw_token_value';
    const expected = createHash('sha256').update(rawId).digest('hex');
    const digest = refreshTokenStorageId(rawId);
    expect(digest).toBe(expected);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sanitizeRefreshTokenPayload deep-copies and drops jti while keeping other fields', () => {
    const payload = {
      jti: 'refresh_raw_token_value',
      grantId: 'grant_abc',
      accountId: 'user_abc',
      clientId: 'client_abc',
      exp: 1_900_000_000,
      nested: { keep: true },
    };
    const sanitized = sanitizeRefreshTokenPayload(payload);
    expect(sanitized).not.toHaveProperty('jti');
    expect(sanitized).toMatchObject({
      grantId: 'grant_abc',
      accountId: 'user_abc',
      clientId: 'client_abc',
      exp: 1_900_000_000,
      nested: { keep: true },
    });
    // Deep copy: original untouched, nested not shared by reference.
    expect(payload).toHaveProperty('jti');
    expect((sanitized as { nested: unknown }).nested).not.toBe(payload.nested);
  });

  it('restoreRefreshTokenPayload re-adds jti from the raw id without mutating the stored payload', () => {
    const rawId = 'refresh_raw_token_value';
    const stored = { grantId: 'grant_abc', accountId: 'user_abc' };
    const restored = restoreRefreshTokenPayload(rawId, stored);
    expect(restored).toMatchObject({ grantId: 'grant_abc', accountId: 'user_abc', jti: rawId });
    expect(stored).not.toHaveProperty('jti');
  });
});

describe('BreezeOidcAdapter RefreshToken digest storage', () => {
  const uuid1 = '00000000-0000-4000-8000-000000000001';
  const uuid2 = '00000000-0000-4000-8000-000000000002';
  const uuid3 = '00000000-0000-4000-8000-000000000003';
  const rawId = 'refresh_raw_token_value';
  const digest = createHash('sha256').update(rawId).digest('hex');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertActiveTenantContext).mockResolvedValue(undefined);
  });

  it('upsert persists the digest as the row id and strips jti from the stored payload', async () => {
    const chain = mockInsertChain();
    const payload = {
      accountId: uuid1,
      clientId: 'client_abc',
      grantId: 'grant_abc',
      jti: rawId,
      exp: 1_900_000_000,
      extra: { partner_id: uuid2, org_id: uuid3 },
    };

    await new BreezeOidcAdapter('RefreshToken').upsert(rawId, payload, 3600);

    expect(insertMock).toHaveBeenCalledWith(oauthRefreshTokens);
    const values = (chain.values.mock.calls[0] as unknown[])[0] as { id: string; payload: Record<string, unknown> };
    expect(values.id).toBe(digest);
    expect(values.payload).not.toHaveProperty('jti');
    expect(values.payload).toMatchObject({ grantId: 'grant_abc', accountId: uuid1, clientId: 'client_abc' });
    // A conflict keeps the first successor's stored payload untouched (#10301),
    // so no payload (and therefore no jti) is written on that branch at all.
    const conflict = (chain.onConflictDoUpdate.mock.calls[0] as unknown[])[0] as { set: Record<string, unknown> };
    expect(conflict.set).toEqual({ lastUsedAt: expect.any(Date) });
  });

  it('find looks up by digest and restores jti to the raw id in memory', async () => {
    const { where } = mockSelectRows([{
      id: digest,
      userId: uuid1,
      clientId: 'client_abc',
      partnerId: uuid2,
      orgId: null,
      payload: { accountId: 'user_abc', grantId: 'grant_abc' },
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    }]);

    const result = await new BreezeOidcAdapter('RefreshToken').find(rawId);

    expect(result).toMatchObject({ accountId: 'user_abc', grantId: 'grant_abc', jti: rawId });
    const strings = collectAllStrings((where.mock.calls[0] as unknown[])[0]);
    expect(strings.has(digest)).toBe(true);
    expect(strings.has(rawId)).toBe(false);
  });

  it('consume revokes the row addressed by the digest', async () => {
    const chain = mockUpdateChain();

    await new BreezeOidcAdapter('RefreshToken').consume(rawId);

    expect(updateMock).toHaveBeenCalledWith(oauthRefreshTokens);
    expect(chain.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    const strings = collectAllStrings((chain.where.mock.calls[0] as unknown[])[0]);
    expect(strings.has(digest)).toBe(true);
    expect(strings.has(rawId)).toBe(false);
  });

  it('destroy caches the jti marker under the digest and revokes the row by digest', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 600;
    mockSelectRows([{
      id: digest,
      userId: uuid1,
      payload: { grantId: 'grant_abc', exp: futureExp },
      expiresAt: new Date(futureExp * 1000),
    }]);
    const chain = mockUpdateChain();

    await new BreezeOidcAdapter('RefreshToken').destroy(rawId);

    // Revocation-cache jti lookup for refresh tokens keys on the digest.
    expect(revokeJti).toHaveBeenCalledWith(digest, expect.any(Number));
    expect(revokeGrant).toHaveBeenCalledWith('grant_abc', expect.any(Number));
    const strings = collectAllStrings((chain.where.mock.calls[0] as unknown[])[0]);
    expect(strings.has(digest)).toBe(true);
    expect(strings.has(rawId)).toBe(false);
  });

  it('reuse detection on a revoked row still fires revokeGrant through the digest lookup', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { where } = mockSelectRows([{
      id: digest,
      userId: uuid1,
      clientId: 'client_abc',
      partnerId: uuid2,
      orgId: null,
      payload: { accountId: 'user_abc', grantId: 'grant_abc' },
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    }]);

    await expect(new BreezeOidcAdapter('RefreshToken').find(rawId)).resolves.toBeUndefined();

    expect(vi.mocked(revokeGrant)).toHaveBeenCalledWith('grant_abc', expect.any(Number));
    const strings = collectAllStrings((where.mock.calls[0] as unknown[])[0]);
    expect(strings.has(digest)).toBe(true);
    expect(strings.has(rawId)).toBe(false);
    consoleError.mockRestore();
  });
});

// #10301: a rotated refresh token re-presented by the same client inside the
// grace window gets the successor the winner was issued; everything else keeps
// the fatal reuse path.
describe('BreezeOidcAdapter refresh rotation grace window (#10301)', () => {
  const SECRET = 'adapter-grace-secret-at-least-32-characters';
  const USER = '00000000-0000-4000-8000-000000000001';
  const PARTNER = '00000000-0000-4000-8000-000000000002';
  const CLIENT = 'client_abc';
  const GRANT = 'grant_abc';
  const PARENT_RAW = 'raw-parent-refresh-token';
  const PARENT_DIGEST = createHash('sha256').update(PARENT_RAW).digest('hex');
  const SUCCESSOR_RAW = 'raw-successor-refresh-token-0000000000000';
  const NOW = new Date('2026-11-09T12:00:00.000Z').getTime();
  let consoleError: { mock: { calls: unknown[][] } };
  let consoleWarn: { mock: { calls: unknown[][] } };

  function grantCtx(presented = PARENT_RAW, clientId: string | null = CLIENT) {
    return {
      oidc: {
        client: clientId ? { clientId } : undefined,
        params: { grant_type: 'refresh_token', refresh_token: presented, client_id: clientId ?? undefined },
      },
      get: () => 'Example-Agent/1.0',
    };
  }

  function useCtx(ctx: unknown) {
    vi.spyOn(Provider, 'ctx', 'get').mockReturnValue(ctx as never);
    return ctx as object;
  }

  function seal(successorRaw = SUCCESSOR_RAW, parentRaw = PARENT_RAW) {
    return sealRotationSuccessor({ parentRaw, parentStorageId: PARENT_DIGEST, successorRaw })!;
  }

  function parentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: PARENT_DIGEST,
      userId: USER,
      clientId: CLIENT,
      partnerId: PARTNER,
      orgId: null,
      payload: { accountId: USER, clientId: CLIENT, grantId: GRANT, scope: 'openid mcp:read' },
      expiresAt: new Date(NOW + 14 * 24 * 3600 * 1000),
      revokedAt: new Date(NOW - 32),
      rotatedAt: new Date(NOW - 32),
      successorSealed: seal(),
      ...overrides,
    };
  }

  function successorRow(overrides: Record<string, unknown> = {}) {
    return {
      revokedAt: null,
      clientId: CLIENT,
      payload: { grantId: GRANT },
      ...overrides,
    };
  }

  // Each select() call gets the next row set.
  function mockSelectSequence(...rowSets: unknown[][]) {
    for (const rows of rowSets) {
      const where = vi.fn(async () => rows);
      selectMock.mockReturnValueOnce({ from: vi.fn(() => ({ where })) } as unknown as ReturnType<typeof db.select>);
    }
  }

  function reuseLogged(): boolean {
    return consoleError.mock.calls.some((call) => String(call[0]).includes('OAUTH_REFRESH_TOKEN_REUSE'));
  }

  function graceHitLog(): Record<string, unknown> | undefined {
    const call = consoleWarn.mock.calls.find((c) => String(c[0]).includes('OAUTH_REFRESH_GRACE_HIT'));
    return call?.[1] as Record<string, unknown> | undefined;
  }

  function reuseLogContext(): Record<string, unknown> | undefined {
    const call = consoleError.mock.calls.find((c) => String(c[0]).includes('OAUTH_REFRESH_TOKEN_REUSE'));
    return call?.[1] as Record<string, unknown> | undefined;
  }

  async function graceCount(outcome: string): Promise<number> {
    const metric = await metricsRegistry.getSingleMetric('oauth_refresh_rotation_grace_total')?.get();
    return metric?.values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
  }

  function expectFamilyRevoked() {
    expect(reuseLogged()).toBe(true);
    expect(vi.mocked(revokeGrantsDurablyInCurrentDbContext)).toHaveBeenCalledWith({
      grantIds: [GRANT],
      reason: 'refresh-token-reuse',
      cascadeRefreshTokens: true,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // mockReturnValueOnce queues survive clearAllMocks; start each case clean.
    selectMock.mockReset();
    updateMock.mockReset();
    insertMock.mockReset();
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    delete process.env.OAUTH_REFRESH_ROTATION_GRACE_MS;
    configureRotationSealKey(SECRET);
    vi.mocked(assertActiveTenantContext).mockResolvedValue(undefined);
    vi.mocked(isOAuthGrantActiveInCurrentDbContext).mockResolvedValue(true);
    mockRetryInsertChain(USER);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    selectMock.mockReset();
    updateMock.mockReset();
    insertMock.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
    configureRotationSealKey(null);
    delete process.env.OAUTH_REFRESH_ROTATION_GRACE_MS;
  });

  describe('find() on a rotated token', () => {
    it('returns the parent as live to the same client inside the window and revokes nothing', async () => {
      // The hit log is throttled per client by a process-wide logger; a client
      // id of its own keeps this assertion independent of test order.
      const client = 'client_replay_log';
      const ctx = useCtx(grantCtx(PARENT_RAW, client));
      mockSelectSequence([parentRow({ clientId: client })], [successorRow({ clientId: client })]);

      const result = await new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW);

      expect(result).toMatchObject({ grantId: GRANT, jti: PARENT_RAW });
      expect(result).not.toHaveProperty('consumed');
      expect(reuseLogged()).toBe(false);
      expect(vi.mocked(revokeGrant)).not.toHaveBeenCalled();
      expect(vi.mocked(revokeGrantsDurablyInCurrentDbContext)).not.toHaveBeenCalled();
      expect(graceHitLog()).toMatchObject({ client_id: client, grant_id: GRANT, reuse_ms: 32, path: 'replay' });
      expect(rotationGraceHit(ctx, PARENT_DIGEST)).toBe(SUCCESSOR_RAW);
    });

    it('counts a replay hit under outcome="hit"', async () => {
      useCtx(grantCtx());
      mockSelectSequence([parentRow()], [successorRow()]);
      const before = await graceCount('hit');

      await new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW);

      expect(await graceCount('hit')).toBe(before + 1);
    });

    it('still grants when the winner has not saved the successor row yet (consume→save gap)', async () => {
      useCtx(grantCtx());
      mockSelectSequence([parentRow()], []);

      await expect(new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW)).resolves.toMatchObject({ jti: PARENT_RAW });
      expect(reuseLogged()).toBe(false);
    });

    it('grants at exactly the window boundary', async () => {
      useCtx(grantCtx());
      mockSelectSequence([parentRow({ rotatedAt: new Date(NOW - 10_000) })], [successorRow()]);

      await expect(new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW)).resolves.toMatchObject({ jti: PARENT_RAW });
      expect(reuseLogged()).toBe(false);
    });

    it.each([
      ['1 ms past the window', 10_001],
      ['well past the window', 60 * 60 * 1000],
    ])('revokes the family %s', async (_label, ageMs) => {
      useCtx(grantCtx());
      mockSelectSequence([parentRow({ rotatedAt: new Date(NOW - ageMs) })], [successorRow()]);

      await expect(new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW)).resolves.toBeUndefined();
      expectFamilyRevoked();
      expect(graceHitLog()).toBeUndefined();
    });

    it('revokes the family when a different client presents a token rotated 1 s ago', async () => {
      useCtx(grantCtx(PARENT_RAW, 'client_other'));
      mockSelectSequence([parentRow({ rotatedAt: new Date(NOW - 1000) })], [successorRow()]);

      await expect(new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW)).resolves.toBeUndefined();
      expectFamilyRevoked();
    });

    it('keeps the fatal path for a token revoked without rotation (destroy / family revocation)', async () => {
      useCtx(grantCtx());
      mockSelectSequence([parentRow({ rotatedAt: null, successorSealed: null })]);

      await expect(new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW)).resolves.toBeUndefined();
      expectFamilyRevoked();
    });

    it('revokes the family when the successor is no longer live', async () => {
      useCtx(grantCtx());
      mockSelectSequence([parentRow()], [successorRow({ revokedAt: new Date(NOW - 5) })]);

      await expect(new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW)).resolves.toBeUndefined();
      expectFamilyRevoked();
    });

    it('revokes the family when the seal does not open (wrong parent, rotated server secret)', async () => {
      useCtx(grantCtx());
      mockSelectSequence([parentRow({ successorSealed: seal(SUCCESSOR_RAW, 'some-other-parent') })]);

      await expect(new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW)).resolves.toBeUndefined();
      expectFamilyRevoked();
    });

    it('never applies outside a refresh_token grant (introspection / revocation lookups)', async () => {
      useCtx(undefined);
      mockSelectSequence([parentRow()], [successorRow()]);

      await expect(new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW)).resolves.toBeUndefined();
      expectFamilyRevoked();
    });

    it('is off when OAUTH_REFRESH_ROTATION_GRACE_MS=0', async () => {
      process.env.OAUTH_REFRESH_ROTATION_GRACE_MS = '0';
      useCtx(grantCtx());
      mockSelectSequence([parentRow()], [successorRow()]);

      await expect(new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW)).resolves.toBeUndefined();
      expectFamilyRevoked();
    });

    it.each([
      ['outside_window', { rotatedAt: new Date(NOW - 10_001) }, {}, CLIENT],
      ['outside_window', { rotatedAt: new Date(NOW + 10_001) }, {}, CLIENT],
      ['client_mismatch', {}, {}, 'client_other'],
      ['successor_inactive', {}, { revokedAt: new Date(NOW - 5) }, CLIENT],
      ['successor_inactive', {}, { clientId: 'client_other' }, CLIENT],
      ['successor_inactive', {}, { payload: { grantId: 'grant_other' } }, CLIENT],
    ])('records why a rotated token missed the window (%s) on the metric and the reuse log', async (
      outcome,
      parentOverrides,
      successorOverrides,
      presentingClient,
    ) => {
      useCtx(grantCtx(PARENT_RAW, presentingClient as string));
      mockSelectSequence(
        [parentRow(parentOverrides as Record<string, unknown>)],
        [successorRow(successorOverrides as Record<string, unknown>)],
      );
      const before = await graceCount(outcome as string);

      await expect(new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW)).resolves.toBeUndefined();

      expectFamilyRevoked();
      expect(await graceCount(outcome as string)).toBe(before + 1);
      expect(reuseLogContext()).toMatchObject({ rotation_grace: outcome, rotated_ms_ago: expect.any(Number) });
    });

    it('records an unopenable seal as outcome="unsealable"', async () => {
      useCtx(grantCtx());
      mockSelectSequence([parentRow({ successorSealed: 'v1.not-a-real-seal' })]);
      const before = await graceCount('unsealable');

      await expect(new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW)).resolves.toBeUndefined();

      expect(await graceCount('unsealable')).toBe(before + 1);
      expect(reuseLogContext()).toMatchObject({ rotation_grace: 'unsealable' });
    });

    it('logs rotation_grace=null for a token that was never rotated', async () => {
      useCtx(grantCtx());
      mockSelectSequence([parentRow({ rotatedAt: null, successorSealed: null })]);

      await new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW);

      expect(reuseLogContext()).toMatchObject({ rotation_grace: null, rotated_ms_ago: null });
    });

    it('treats a client the provider did not authenticate as a different client', async () => {
      useCtx(grantCtx(PARENT_RAW, null));
      mockSelectSequence([parentRow()], [successorRow()]);

      await expect(new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW)).resolves.toBeUndefined();
      expectFamilyRevoked();
    });

    it('returns nothing (and revokes nothing) for an expired parent inside the window', async () => {
      useCtx(grantCtx());
      mockSelectSequence([parentRow({ expiresAt: new Date(NOW - 1) })], [successorRow()]);

      await expect(new BreezeOidcAdapter('RefreshToken').find(PARENT_RAW)).resolves.toBeUndefined();
      expect(reuseLogged()).toBe(false);
      expect(vi.mocked(revokeGrantsDurablyInCurrentDbContext)).not.toHaveBeenCalled();
    });
  });

  describe('consume()', () => {
    it('publishes a sealed successor atomically with the consume and hands it to the provider', async () => {
      const ctx = useCtx(grantCtx());
      const chain = mockUpdateChain([{ id: PARENT_DIGEST, clientId: CLIENT }]);

      await new BreezeOidcAdapter('RefreshToken').consume(PARENT_RAW);

      const set = (chain.set.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
      expect(set).toEqual({
        revokedAt: new Date(NOW),
        rotatedAt: new Date(NOW),
        successorSealed: expect.any(String),
      });
      const published = takePendingRotationSuccessor(ctx);
      expect(published).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(openRotationSuccessor({
        parentRaw: PARENT_RAW,
        parentStorageId: PARENT_DIGEST,
        sealed: set.successorSealed as string,
      })).toBe(published);
      // Seals older than the cap are scrubbed for the client on the same rotation.
      expect(chain.set).toHaveBeenCalledWith({ successorSealed: null });
    });

    it('consumes exactly as before when the window is off', async () => {
      process.env.OAUTH_REFRESH_ROTATION_GRACE_MS = '0';
      const ctx = useCtx(grantCtx());
      const chain = mockUpdateChain([{ id: PARENT_DIGEST, clientId: CLIENT }]);

      await new BreezeOidcAdapter('RefreshToken').consume(PARENT_RAW);

      expect(chain.set).toHaveBeenCalledTimes(1);
      expect(chain.set).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
      expect(takePendingRotationSuccessor(ctx)).toBeNull();
    });

    it('tolerates the expected CAS miss after find() granted the window, handing over that successor', async () => {
      const ctx = useCtx(grantCtx());
      markRotationGraceHit(ctx, PARENT_DIGEST, SUCCESSOR_RAW);
      mockUpdateChain([]);

      await expect(new BreezeOidcAdapter('RefreshToken').consume(PARENT_RAW)).resolves.toBeUndefined();
      expect(takePendingRotationSuccessor(ctx)).toBe(SUCCESSOR_RAW);
    });

    it('lets the loser of a concurrent rotation finish with the winner\'s successor', async () => {
      const client = 'client_concurrent_log';
      const ctx = useCtx(grantCtx(PARENT_RAW, client));
      mockUpdateChain([]);
      mockSelectSequence(
        [parentRow({ clientId: client, revokedAt: new Date(NOW - 3), rotatedAt: new Date(NOW - 3) })],
        [],
      );

      await expect(new BreezeOidcAdapter('RefreshToken').consume(PARENT_RAW)).resolves.toBeUndefined();
      expect(takePendingRotationSuccessor(ctx)).toBe(SUCCESSOR_RAW);
      expect(vi.mocked(isOAuthGrantActiveInCurrentDbContext)).toHaveBeenCalledWith(GRANT);
      expect(graceHitLog()).toMatchObject({ path: 'concurrent', client_id: client, reuse_ms: 3 });
    });

    it.each([
      ['the rotation is older than the window', { rotatedAt: new Date(NOW - 10_001) }, true],
      ['the token was revoked without rotation', { rotatedAt: null, successorSealed: null }, true],
      ['the grant is no longer active', {}, false],
    ])('rejects a lost CAS when %s', async (_label, overrides, grantActive) => {
      useCtx(grantCtx());
      vi.mocked(isOAuthGrantActiveInCurrentDbContext).mockResolvedValue(grantActive as boolean);
      mockUpdateChain([]);
      mockSelectSequence([parentRow(overrides as Record<string, unknown>)], [successorRow()]);

      await expect(new BreezeOidcAdapter('RefreshToken').consume(PARENT_RAW))
        .rejects.toMatchObject({ error: 'invalid_grant' });
    });

    it('scopes the seal scrub to the presenting client and to seals older than the cap', async () => {
      useCtx(grantCtx());
      const chain = mockUpdateChain([{ id: PARENT_DIGEST, clientId: CLIENT }]);

      await new BreezeOidcAdapter('RefreshToken').consume(PARENT_RAW);

      const scrubCall = chain.set.mock.calls.findIndex((c) => (c as unknown[])[0] && 'successorSealed' in ((c as unknown[])[0] as object)
        && ((c as unknown[])[0] as { successorSealed: unknown }).successorSealed === null);
      expect(scrubCall).toBeGreaterThan(-1);
      const where = (chain.where.mock.calls[scrubCall] as unknown[])[0];
      const strings = collectAllStrings(where);
      expect(strings.has(CLIENT)).toBe(true);
      // The cutoff is the 30 s cap before the rotation, never the live seal.
      const dates = collectDates(where);
      expect(dates.map((d) => d.getTime())).toContain(NOW - 30_000);
    });

    it('still completes the rotation when the seal scrub fails', async () => {
      const ctx = useCtx(grantCtx());
      const returning = vi.fn(async () => [{ id: PARENT_DIGEST, clientId: CLIENT }]);
      const where = vi.fn()
        .mockImplementationOnce(() => ({ returning }))
        .mockImplementationOnce(() => Promise.reject(new Error('lock timeout')));
      const set = vi.fn(() => ({ where }));
      updateMock.mockReturnValue({ set } as unknown as ReturnType<typeof db.update>);

      await expect(new BreezeOidcAdapter('RefreshToken').consume(PARENT_RAW)).resolves.toBeUndefined();

      expect(takePendingRotationSuccessor(ctx)).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(consoleWarn.mock.calls.some((c) => String(c[0]).includes('OAUTH_REFRESH_SEAL_SCRUB_FAILED'))).toBe(true);
    });

    it('counts a concurrent loser under outcome="concurrent_hit"', async () => {
      useCtx(grantCtx());
      mockUpdateChain([]);
      mockSelectSequence([parentRow({ revokedAt: new Date(NOW - 3), rotatedAt: new Date(NOW - 3) })], []);
      const before = await graceCount('concurrent_hit');

      await new BreezeOidcAdapter('RefreshToken').consume(PARENT_RAW);

      expect(await graceCount('concurrent_hit')).toBe(before + 1);
    });

    it.each([
      ['the parent row is gone', []],
      ['the parent carries no grantId', [parentRow({ payload: { accountId: USER, clientId: CLIENT } })]],
    ])('rejects a lost CAS when %s', async (_label, parentRows) => {
      useCtx(grantCtx());
      mockUpdateChain([]);
      mockSelectSequence(parentRows as unknown[], [successorRow()]);

      await expect(new BreezeOidcAdapter('RefreshToken').consume(PARENT_RAW))
        .rejects.toMatchObject({ error: 'invalid_grant' });
    });

    it('rejects a lost CAS presented by a different client', async () => {
      useCtx(grantCtx(PARENT_RAW, 'client_other'));
      mockUpdateChain([]);
      mockSelectSequence([parentRow()], [successorRow()]);

      await expect(new BreezeOidcAdapter('RefreshToken').consume(PARENT_RAW))
        .rejects.toMatchObject({ error: 'invalid_grant' });
    });
  });

  describe('upsert() of the successor', () => {
    const payload = {
      accountId: USER,
      clientId: CLIENT,
      grantId: GRANT,
      extra: { partner_id: PARTNER, org_id: '00000000-0000-4000-8000-000000000003' },
    };

    it('keeps the first save when both racers save the same successor', async () => {
      const chain = mockInsertChain([{ id: 'existing' }]);
      mockUpdateChain();

      await new BreezeOidcAdapter('RefreshToken').upsert(SUCCESSOR_RAW, payload, 3600);

      const conflict = (chain.onConflictDoUpdate.mock.calls[0] as unknown[])[0] as { set: Record<string, unknown>; setWhere?: unknown };
      expect(conflict.set).toEqual({ lastUsedAt: expect.any(Date) });
      expect(conflict.setWhere).toBeDefined();
    });

    it('never hands out a successor whose row was already revoked or belongs to another family', async () => {
      mockInsertChain([]);
      mockUpdateChain();

      await expect(new BreezeOidcAdapter('RefreshToken').upsert(SUCCESSOR_RAW, payload, 3600))
        .rejects.toMatchObject({ error: 'invalid_grant' });
    });
  });
});
