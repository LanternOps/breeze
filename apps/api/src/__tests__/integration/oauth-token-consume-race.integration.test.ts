/**
 * OAuth single-use token consumption against the real provider and PostgreSQL.
 *
 * The holder transaction locks the exact token row before either request
 * starts. Ordinary provider reads remain non-blocking under MVCC, so both
 * exchanges reach their consume UPDATE and queue behind the holder. Observing
 * both blocked backends makes the security interleaving deterministic: after
 * release, exactly one compare-and-set may claim the artifact.
 */
import './setup';
import './loadEnv';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { oauthAuthorizationCodes, oauthGrants, oauthRefreshTokens } from '../../db/schema';
import { createAccessToken } from '../../services/jwt';
import { assignUserToPartner, createPartner, createRole, createUser } from './db-utils';
import { getTestDb } from './setup';

const SHOULD_RUN = Boolean(process.env.DATABASE_URL);
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

type LiveServer = { server: ServerType; url: string };
type IssuedCode = {
  clientId: string;
  code: string;
  codeRowId: string;
  verifier: string;
  redirectUri: string;
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function b64url(bytes: Buffer | Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function startApi(port: number): Promise<LiveServer> {
  const { oauthRoutes } = await import('../../routes/oauth');
  const { oauthInteractionRoutes } = await import('../../routes/oauthInteraction');
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.route('/oauth', oauthRoutes);
  app.route('/api/v1/oauth', oauthInteractionRoutes);
  return {
    server: serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }),
    url: `http://127.0.0.1:${port}`,
  };
}

async function stopApi(live: LiveServer): Promise<void> {
  await new Promise<void>((resolve) => live.server.close(() => resolve()));
}

async function issueAuthorizationCode(baseUrl: string, label: string): Promise<IssuedCode> {
  const partner = await createPartner({ name: `OAuth consume race ${label} ${randomUUID()}` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  const user = await createUser({
    partnerId: partner.id,
    email: `oauth-consume-${label}-${randomUUID()}@example.test`,
  });
  await assignUserToPartner(user.id, partner.id, role.id, 'all');
  const dashboardJwt = await createAccessToken({
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: null,
    partnerId: partner.id,
    scope: 'partner',
    mfa: false,
    aep: 1,
    mep: 1,
    sid: `oauth-consume-${label}`,
  });

  const redirectUri = `https://example.com/oauth/${label}/callback`;
  const registration = await fetch(`${baseUrl}/oauth/reg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: `consume-race-${label}`,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid offline_access mcp:read',
      id_token_signed_response_alg: 'EdDSA',
    }),
  });
  expect(registration.status).toBe(201);
  const { client_id: clientId } = await registration.json() as { client_id: string };

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const auth = await fetch(`${baseUrl}/oauth/auth?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid offline_access mcp:read',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: process.env.OAUTH_RESOURCE_URL!,
    state: `consume-${label}`,
  })}`, { redirect: 'manual' });
  expect([302, 303]).toContain(auth.status);
  const interactionUrl = new URL(auth.headers.get('location') ?? '', baseUrl);
  const uid = interactionUrl.searchParams.get('uid');
  expect(uid).toBeTruthy();
  const cookies = (auth.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ');

  const consent = await fetch(`${baseUrl}/api/v1/oauth/interaction/${uid}/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${dashboardJwt}` },
    body: JSON.stringify({ partner_id: partner.id, approve: true }),
  });
  expect(consent.status).toBe(200);
  const { redirectTo } = await consent.json() as { redirectTo: string };
  const resume = await fetch(redirectTo, { redirect: 'manual', headers: { cookie: cookies } });
  expect([302, 303]).toContain(resume.status);
  const code = new URL(resume.headers.get('location') ?? '').searchParams.get('code');
  expect(code).toBeTruthy();

  const [stored] = await getTestDb()
    .select({ id: oauthAuthorizationCodes.id })
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.clientId, clientId))
    .orderBy(desc(oauthAuthorizationCodes.createdAt))
    .limit(1);
  if (!stored) throw new Error('provider did not persist the authorization code');
  return { clientId, code: code!, codeRowId: stored.id, verifier, redirectUri };
}

function exchangeCode(baseUrl: string, issued: IssuedCode): Promise<Response> {
  return fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: issued.code,
      client_id: issued.clientId,
      code_verifier: issued.verifier,
      redirect_uri: issued.redirectUri,
      resource: process.env.OAUTH_RESOURCE_URL!,
    }),
  });
}

function exchangeRefresh(baseUrl: string, clientId: string, refreshToken: string): Promise<Response> {
  return fetch(`${baseUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      resource: process.env.OAUTH_RESOURCE_URL!,
    }),
  });
}

async function waitForBlockedBackends(blockerPid: number, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    // Recursive traversal includes the second exchange waiting behind the
    // first exchange, which itself waits directly behind the holder.
    const rows = await getTestDb().execute<{ waiting: number }>(sql`
        WITH RECURSIVE wait_chain(pid) AS (
          SELECT pid
          FROM pg_catalog.pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active'
            AND ${blockerPid} = ANY(pg_catalog.pg_blocking_pids(pid))
          UNION
          SELECT activity.pid
          FROM pg_catalog.pg_stat_activity activity
          JOIN wait_chain blocker
            ON blocker.pid = ANY(pg_catalog.pg_blocking_pids(activity.pid))
          WHERE activity.datname = current_database()
            AND activity.state = 'active'
        )
        SELECT count(*)::int AS waiting FROM wait_chain
      `);
    if ((rows[0]?.waiting ?? 0) >= expected) return;
    if (Date.now() >= deadline) throw new Error('OAuth exchanges did not reach the consume-row barrier');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function raceBehindRowLock(
  lock: (tx: Sql) => Promise<unknown>,
  racers: () => [Promise<Response>, Promise<Response>],
): Promise<Response[]> {
  const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  const held = deferred();
  const release = deferred();
  let holderPid = 0;
  let holderWork: Promise<void> | undefined;
  try {
    holderWork = holder.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      holderPid = backend!.pid;
      await lock(tx as unknown as Sql);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const started = racers();
    await waitForBlockedBackends(holderPid, 2);
    release.resolve();
    await holderWork;
    return await Promise.all(started);
  } finally {
    release.resolve();
    if (holderWork) await Promise.allSettled([holderWork]);
    await holder.end({ timeout: 1 });
  }
}

async function expectSingleWinner(responses: Response[]): Promise<Record<string, unknown>> {
  const winners = responses.filter((response) => response.status === 200);
  const losers = responses.filter((response) => response.status !== 200);
  expect(winners).toHaveLength(1);
  expect(losers).toHaveLength(1);
  expect(losers[0]!.status).toBe(400);
  await expect(losers[0]!.json()).resolves.toMatchObject({ error: 'invalid_grant' });
  return await winners[0]!.json() as Record<string, unknown>;
}

describe.skipIf(!SHOULD_RUN)('OAuth token consume is atomic across concurrent exchanges', () => {
  let live: LiveServer;

  beforeAll(async () => {
    const port = 35000 + Math.floor(Math.random() * 2000);
    process.env.OAUTH_ISSUER = `http://127.0.0.1:${port}`;
    process.env.OAUTH_RESOURCE_URL = `${process.env.OAUTH_ISSUER}/api/v1/mcp/message`;
    process.env.OAUTH_CONSENT_URL_BASE = process.env.OAUTH_ISSUER;
    vi.resetModules();
    live = await startApi(port);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }, 30_000);

  afterAll(async () => {
    if (live) await stopApi(live);
  });

  it('allows exactly one authorization-code exchange after both requests read the fresh code', async () => {
    const issued = await issueAuthorizationCode(live.url, 'code');
    const responses = await raceBehindRowLock(
      (tx) => tx`SELECT id FROM oauth_authorization_codes WHERE id = ${issued.codeRowId} FOR UPDATE`,
      () => [exchangeCode(live.url, issued), exchangeCode(live.url, issued)],
    );
    const winner = await expectSingleWinner(responses);
    expect(winner.access_token).toEqual(expect.any(String));
    expect(winner.refresh_token).toEqual(expect.any(String));
    const successors = await getTestDb().select({ id: oauthRefreshTokens.id })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.clientId, issued.clientId));
    expect(successors).toHaveLength(1);
  }, 30_000);

  it('allows exactly one rotating refresh exchange after both requests read the fresh token', async () => {
    const issued = await issueAuthorizationCode(live.url, 'refresh');
    const initial = await exchangeCode(live.url, issued);
    expect(initial.status).toBe(200);
    const initialBody = await initial.json() as { refresh_token: string };
    const refreshRowId = createHash('sha256').update(initialBody.refresh_token).digest('hex');
    const [stored] = await getTestDb().select({ id: oauthRefreshTokens.id })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.id, refreshRowId));
    expect(stored).toEqual({ id: refreshRowId });

    const responses = await raceBehindRowLock(
      (tx) => tx`SELECT id FROM oauth_refresh_tokens WHERE id = ${refreshRowId} FOR UPDATE`,
      () => [
        exchangeRefresh(live.url, issued.clientId, initialBody.refresh_token),
        exchangeRefresh(live.url, issued.clientId, initialBody.refresh_token),
      ],
    );
    const winner = await expectSingleWinner(responses);
    expect(winner.access_token).toEqual(expect.any(String));
    expect(winner.refresh_token).toEqual(expect.any(String));
    expect(winner.refresh_token).not.toBe(initialBody.refresh_token);
    const allFamilyRows = await getTestDb().select({ id: oauthRefreshTokens.id })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.clientId, issued.clientId));
    const activeFamilyRows = await getTestDb().select({ id: oauthRefreshTokens.id })
      .from(oauthRefreshTokens)
      .where(and(
        eq(oauthRefreshTokens.clientId, issued.clientId),
        isNull(oauthRefreshTokens.revokedAt),
      ));
    expect(allFamilyRows).toHaveLength(2);
    expect(activeFamilyRows).toHaveLength(1);
  }, 30_000);

  it('refresh-token reuse durably revokes the Grant and its whole family, not just a Redis marker', async () => {
    // Steal-and-replay, sequentially (no lock needed): rotate once legitimately,
    // then present the burned RT again. The eager Redis grant marker expires
    // after GRANT_REVOCATION_TTL_SECONDS; if that is the only thing recording
    // the compromise, the surviving sibling starts working again when it
    // lapses. Assert the DURABLE half landed.
    const issued = await issueAuthorizationCode(live.url, 'reuse');
    const initial = await exchangeCode(live.url, issued);
    expect(initial.status).toBe(200);
    const first = await initial.json() as { refresh_token: string };

    const rotated = await exchangeRefresh(live.url, issued.clientId, first.refresh_token);
    expect(rotated.status).toBe(200);
    const second = await rotated.json() as { refresh_token: string };

    const rotatedRowId = createHash('sha256').update(second.refresh_token).digest('hex');
    const [rotatedRow] = await getTestDb()
      .select({ payload: oauthRefreshTokens.payload })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.id, rotatedRowId));
    const grantId = (rotatedRow?.payload as { grantId?: string } | null)?.grantId;
    expect(grantId).toEqual(expect.any(String));

    // Precondition: the surviving sibling is live right now.
    const [beforeGrant] = await getTestDb()
      .select({ revokedAt: oauthGrants.revokedAt })
      .from(oauthGrants)
      .where(eq(oauthGrants.id, grantId!));
    expect(beforeGrant?.revokedAt).toBeNull();

    // Replay the burned token.
    const replay = await exchangeRefresh(live.url, issued.clientId, first.refresh_token);
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: 'invalid_grant' });

    const [afterGrant] = await getTestDb()
      .select({ revokedAt: oauthGrants.revokedAt, revokedReason: oauthGrants.revokedReason })
      .from(oauthGrants)
      .where(eq(oauthGrants.id, grantId!));
    expect(afterGrant?.revokedAt).toBeInstanceOf(Date);
    expect(afterGrant?.revokedReason).toBe('refresh-token-reuse');

    const activeSiblings = await getTestDb()
      .select({ id: oauthRefreshTokens.id })
      .from(oauthRefreshTokens)
      .where(and(
        eq(oauthRefreshTokens.clientId, issued.clientId),
        isNull(oauthRefreshTokens.revokedAt),
      ));
    expect(activeSiblings).toHaveLength(0);

    // And the surviving sibling is dead on the wire too, not merely flagged.
    const siblingUse = await exchangeRefresh(live.url, issued.clientId, second.refresh_token);
    expect(siblingUse.status).toBe(400);
  }, 30_000);
});
