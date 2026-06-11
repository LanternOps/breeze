/**
 * OAuth cleanup integration test — guards against postgres-js raw-sql Date
 * binding regressions.
 *
 * `cleanupStaleOauthClients` and `cleanupExpiredOauthLifecycleRows` interpolate
 * Date values inside raw `sql\`\`` template fragments. postgres-js can't infer
 * the column type for such bindings and throws ERR_INVALID_ARG_TYPE at runtime
 * — a failure mode that mocked unit tests cannot catch. This test exercises
 * both functions against the real driver so any future regression (dropping
 * the .toISOString() conversion, or introducing a new ${someDate} in a raw
 * sql chunk) blows up here.
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthGrants,
  oauthInteractions,
  oauthRefreshTokens,
  oauthSessions,
} from '../../db/schema';
import { withSystemDbAccessContext } from '../../db';
import { cleanupStaleOauthClients, cleanupExpiredOauthLifecycleRows, DCR_STALE_CLIENT_TTL_MS } from '../../oauth/provider';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

describe('OAuth cleanup raw-sql Date binding', () => {
  beforeEach(async () => {
    // setup.ts truncates core tables on beforeEach, but not all oauth_* tables.
    // Clear them defensively so this file's seeded rows aren't affected by
    // unrelated tests bleeding through.
    await getTestDb().delete(oauthRefreshTokens);
    await getTestDb().delete(oauthAuthorizationCodes);
    await getTestDb().delete(oauthGrants);
    await getTestDb().delete(oauthSessions);
    await getTestDb().delete(oauthInteractions);
    await getTestDb().delete(oauthClients);
  });

  it('cleanupStaleOauthClients runs without ERR_INVALID_ARG_TYPE on real postgres-js', async () => {
    // Seed a stale (created long ago, no last_used, no partner) client that
    // qualifies for deletion, plus an active client with a current grant so
    // the NOT EXISTS subqueries with `>= ${nowIso}` bindings have real rows
    // to evaluate.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `oauth-cleanup-stale-${Date.now()}@example.test`,
    });

    const veryOld = new Date(Date.now() - DCR_STALE_CLIENT_TTL_MS - 24 * 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);

    await getTestDb().insert(oauthClients).values([
      {
        id: 'stale-client-no-grants',
        partnerId: null,
        metadata: { client_name: 'stale DCR client' },
        createdAt: veryOld,
      },
      {
        id: 'active-client-with-grant',
        partnerId: null,
        metadata: { client_name: 'active DCR client' },
        createdAt: veryOld,
      },
    ]);

    await getTestDb().insert(oauthGrants).values({
      id: 'grant-keeps-active-client-alive',
      accountId: user.id,
      clientId: 'active-client-with-grant',
      partnerId: partner.id,
      orgId: org.id,
      payload: { accountId: user.id },
      expiresAt: future,
    });

    const deleted = await withSystemDbAccessContext(() => cleanupStaleOauthClients());

    // The stale client (no grants) is gone; the active one stays.
    expect(deleted).toBeGreaterThanOrEqual(1);
    const remaining = await getTestDb()
      .select({ id: oauthClients.id })
      .from(oauthClients)
      .where(eq(oauthClients.id, 'active-client-with-grant'));
    expect(remaining).toHaveLength(1);
    const stale = await getTestDb()
      .select({ id: oauthClients.id })
      .from(oauthClients)
      .where(eq(oauthClients.id, 'stale-client-no-grants'));
    expect(stale).toHaveLength(0);
  });

  it('cleanupExpiredOauthLifecycleRows runs without ERR_INVALID_ARG_TYPE on real postgres-js', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `oauth-cleanup-lifecycle-${Date.now()}@example.test`,
    });

    await getTestDb().insert(oauthClients).values({
      id: 'lifecycle-client',
      partnerId: partner.id,
      metadata: { client_name: 'lifecycle test client' },
    });

    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);

    // One expired refresh token (should be deleted) and one live grant
    // protected by an unrevoked refresh token (should stay) — exercises both
    // the `< ${cutoffIso}` and `>= ${nowIso}` raw-sql bindings.
    await getTestDb().insert(oauthGrants).values([
      { id: 'expired-grant', accountId: user.id, clientId: 'lifecycle-client', partnerId: partner.id, orgId: org.id, payload: { accountId: user.id }, expiresAt: longAgo },
      { id: 'live-grant',    accountId: user.id, clientId: 'lifecycle-client', partnerId: partner.id, orgId: org.id, payload: { accountId: user.id }, expiresAt: future },
    ]);
    await getTestDb().insert(oauthRefreshTokens).values([
      { id: 'expired-refresh', userId: user.id, clientId: 'lifecycle-client', partnerId: partner.id, orgId: org.id, payload: { sub: user.id, jti: 'jti-expired', grantId: 'expired-grant' }, expiresAt: longAgo },
      { id: 'live-refresh',    userId: user.id, clientId: 'lifecycle-client', partnerId: partner.id, orgId: org.id, payload: { sub: user.id, jti: 'jti-live',    grantId: 'live-grant'    }, expiresAt: future },
    ]);

    const counts = await withSystemDbAccessContext(() => cleanupExpiredOauthLifecycleRows());

    expect(counts.refreshTokens).toBeGreaterThanOrEqual(1);
    const remainingRefresh = await getTestDb().select({ id: oauthRefreshTokens.id }).from(oauthRefreshTokens);
    expect(remainingRefresh.map((r) => r.id).sort()).toEqual(['live-refresh']);
    const remainingGrants = await getTestDb().select({ id: oauthGrants.id }).from(oauthGrants);
    expect(remainingGrants.map((g) => g.id).sort()).toEqual(['live-grant']);
  });
});
