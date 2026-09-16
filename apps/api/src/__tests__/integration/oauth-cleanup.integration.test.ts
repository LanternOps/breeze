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
import { createHash } from 'node:crypto';
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

const digestId = (raw: string) => createHash('sha256').update(raw).digest('hex');

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

  // #5610: before this, the age test was `last_used_at IS NULL` only, so a DCR
  // client that authenticated once and was then abandoned could never be
  // garbage-collected — it kept its client_id forever with no grants, tokens
  // or partner binding.
  it('cleanupStaleOauthClients ages out an abandoned once-used client but keeps a recently-used one', async () => {
    const veryOld = new Date(Date.now() - DCR_STALE_CLIENT_TTL_MS - 24 * 60 * 60 * 1000);
    const recently = new Date(Date.now() - 60 * 60 * 1000);

    await getTestDb().insert(oauthClients).values([
      {
        id: 'abandoned-once-used',
        partnerId: null,
        metadata: { client_name: 'used once, then abandoned' },
        createdAt: veryOld,
        lastUsedAt: veryOld,
      },
      {
        id: 'recently-used',
        partnerId: null,
        metadata: { client_name: 'old registration, still in use' },
        createdAt: veryOld,
        lastUsedAt: recently,
      },
    ]);

    await withSystemDbAccessContext(() => cleanupStaleOauthClients());

    const remaining = await getTestDb().select({ id: oauthClients.id }).from(oauthClients);
    expect(remaining.map((c) => c.id).sort()).toEqual(['recently-used']);
  });

  // The last_used_at age branch (#5610) widens what the delete CAN match, so
  // the interaction with the no-live-credential guards needs direct proof:
  // a client whose stamp went stale between authorizations but which still
  // holds a live refresh token or unexpired grant must survive. Only real
  // Postgres can validate the AND/OR grouping here.
  it('cleanupStaleOauthClients keeps a stale-stamped client that still holds a live credential', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `oauth-cleanup-live-cred-${Date.now()}@example.test`,
    });

    const veryOld = new Date(Date.now() - DCR_STALE_CLIENT_TTL_MS - 24 * 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);

    await getTestDb().insert(oauthClients).values([
      {
        id: 'stale-stamp-live-refresh',
        partnerId: null,
        metadata: { client_name: 'stale stamp, live refresh token' },
        createdAt: veryOld,
        lastUsedAt: veryOld,
      },
      {
        id: 'stale-stamp-live-grant',
        partnerId: null,
        metadata: { client_name: 'stale stamp, unexpired grant' },
        createdAt: veryOld,
        lastUsedAt: veryOld,
      },
      {
        id: 'stale-stamp-no-credential',
        partnerId: null,
        metadata: { client_name: 'stale stamp, nothing live' },
        createdAt: veryOld,
        lastUsedAt: veryOld,
      },
    ]);

    await getTestDb().insert(oauthGrants).values({
      id: 'live-grant-for-stale-stamp',
      accountId: user.id,
      clientId: 'stale-stamp-live-grant',
      partnerId: partner.id,
      orgId: org.id,
      payload: { accountId: user.id },
      expiresAt: future,
    });
    await getTestDb().insert(oauthRefreshTokens).values({
      id: digestId('live-refresh-for-stale-stamp'),
      userId: user.id,
      clientId: 'stale-stamp-live-refresh',
      partnerId: partner.id,
      orgId: org.id,
      payload: { sub: user.id, grantId: 'live-grant-for-stale-stamp' },
      expiresAt: future,
    });

    await withSystemDbAccessContext(() => cleanupStaleOauthClients());

    const remaining = await getTestDb().select({ id: oauthClients.id }).from(oauthClients);
    expect(remaining.map((c) => c.id).sort()).toEqual([
      'stale-stamp-live-grant',
      'stale-stamp-live-refresh',
    ]);
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
    // Refresh-token ids must be sha256 digests and payloads must omit `jti`
    // (oauth_refresh_tokens_id_digest_chk / oauth_refresh_tokens_no_jti_chk).
    const expiredRefreshId = digestId('expired-refresh');
    const liveRefreshId = digestId('live-refresh');
    await getTestDb().insert(oauthRefreshTokens).values([
      { id: expiredRefreshId, userId: user.id, clientId: 'lifecycle-client', partnerId: partner.id, orgId: org.id, payload: { sub: user.id, grantId: 'expired-grant' }, expiresAt: longAgo },
      { id: liveRefreshId,    userId: user.id, clientId: 'lifecycle-client', partnerId: partner.id, orgId: org.id, payload: { sub: user.id, grantId: 'live-grant'    }, expiresAt: future },
    ]);

    const counts = await withSystemDbAccessContext(() => cleanupExpiredOauthLifecycleRows());

    expect(counts.refreshTokens).toBeGreaterThanOrEqual(1);
    const remainingRefresh = await getTestDb().select({ id: oauthRefreshTokens.id }).from(oauthRefreshTokens);
    expect(remainingRefresh.map((r) => r.id).sort()).toEqual([liveRefreshId]);
    const remainingGrants = await getTestDb().select({ id: oauthGrants.id }).from(oauthGrants);
    expect(remainingGrants.map((g) => g.id).sort()).toEqual(['live-grant']);
  });
});
