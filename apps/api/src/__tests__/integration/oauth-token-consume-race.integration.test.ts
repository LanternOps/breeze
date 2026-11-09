/**
 * OAuth single-use token consumption against the real provider and PostgreSQL.
 *
 * The holder transaction locks the exact token row before either request
 * starts. Ordinary provider reads remain non-blocking under MVCC, so both
 * exchanges reach their consume UPDATE and queue behind the holder. Observing
 * both blocked backends makes the security interleaving deterministic: after
 * release, exactly one compare-and-set may claim the artifact. For refresh
 * tokens the loser then finishes with the winner's successor (#10301 grace
 * window), so both succeed and the family still has one live token.
 */
import './setup';
import './loadEnv';

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
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

// Listens on port 0 BEFORE the oauth routes are imported: OAUTH_ISSUER embeds
// the port and is read when those modules load, so the OS-assigned port must
// be known first. A test-picked port can collide with an ephemeral port
// already in use on the runner (EADDRINUSE, #10735/#10879).
async function listenEphemeral(app: Hono<{ Bindings: HttpBindings }>): Promise<LiveServer> {
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => {
    if ((server.address() as AddressInfo | null)?.port) return resolve();
    server.once('listening', () => resolve());
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

function configureOauthEnv(url: string): void {
  process.env.OAUTH_ISSUER = url;
  process.env.OAUTH_RESOURCE_URL = `${url}/api/v1/mcp/message`;
  process.env.OAUTH_CONSENT_URL_BASE = url;
  vi.resetModules();
}

async function startApi(): Promise<LiveServer> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  const live = await listenEphemeral(app);
  try {
    configureOauthEnv(live.url);

    const { oauthRoutes } = await import('../../routes/oauth');
    const { oauthInteractionRoutes } = await import('../../routes/oauthInteraction');
    app.route('/oauth', oauthRoutes);
    app.route('/api/v1/oauth', oauthInteractionRoutes);
    return live;
  } catch (err) {
    await stopApi(live);
    throw err;
  }
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

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function grantIdOfRow(rowId: string): Promise<string> {
  const [row] = await getTestDb()
    .select({ payload: oauthRefreshTokens.payload })
    .from(oauthRefreshTokens)
    .where(eq(oauthRefreshTokens.id, rowId));
  const grantId = (row?.payload as { grantId?: string } | null)?.grantId;
  if (!grantId) throw new Error(`refresh token row ${rowId} carries no grantId`);
  return grantId;
}

async function grantRevocation(grantId: string) {
  const [grant] = await getTestDb()
    .select({ revokedAt: oauthGrants.revokedAt, revokedReason: oauthGrants.revokedReason })
    .from(oauthGrants)
    .where(eq(oauthGrants.id, grantId));
  return grant;
}

// Push a rotation back in time instead of sleeping past the window.
async function ageRotation(rowId: string, ms: number): Promise<void> {
  const aged = await getTestDb().execute(sql`
    UPDATE oauth_refresh_tokens
       SET rotated_at = rotated_at - make_interval(secs => ${ms / 1000}),
           revoked_at = revoked_at - make_interval(secs => ${ms / 1000})
     WHERE id = ${rowId} AND rotated_at IS NOT NULL
     RETURNING id
  `);
  expect(aged).toHaveLength(1);
}

async function registerClient(baseUrl: string, label: string): Promise<string> {
  const registration = await fetch(`${baseUrl}/oauth/reg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: `consume-race-${label}`,
      redirect_uris: [`https://example.com/oauth/${label}/callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'openid offline_access mcp:read',
      id_token_signed_response_alg: 'EdDSA',
    }),
  });
  expect(registration.status).toBe(201);
  return (await registration.json() as { client_id: string }).client_id;
}

describe.skipIf(!SHOULD_RUN)('OAuth token consume is atomic across concurrent exchanges', () => {
  let live: LiveServer;

  beforeAll(async () => {
    live = await startApi();
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

  it('lets both racing rotating refreshes succeed with ONE successor and leaves the family alive (#10301)', async () => {
    // Both requests read the fresh token, then queue behind the row lock at
    // the consume UPDATE. The winner consumes it and seals its successor onto
    // the row in the same statement; the loser's compare-and-set misses, finds
    // that seal inside the grace window and finishes with the same successor.
    // Before #10301 the loser got invalid_grant, and the client's retry with
    // the old token then revoked the whole family.
    const issued = await issueAuthorizationCode(live.url, 'refresh');
    const initial = await exchangeCode(live.url, issued);
    expect(initial.status).toBe(200);
    const initialBody = await initial.json() as { refresh_token: string };
    const refreshRowId = sha256Hex(initialBody.refresh_token);
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
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json() as Promise<{
      access_token: string;
      refresh_token: string;
    }>));
    expect(bodies[0]!.refresh_token).toEqual(expect.any(String));
    expect(bodies[0]!.refresh_token).not.toBe(initialBody.refresh_token);
    expect(bodies[1]!.refresh_token).toBe(bodies[0]!.refresh_token);
    expect(bodies[0]!.access_token).toEqual(expect.any(String));
    expect(bodies[1]!.access_token).toEqual(expect.any(String));

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
    expect(activeFamilyRows).toEqual([{ id: sha256Hex(bodies[0]!.refresh_token) }]);
    expect(await grantRevocation(await grantIdOfRow(sha256Hex(bodies[0]!.refresh_token))))
      .toEqual({ revokedAt: null, revokedReason: null });

    // The shared successor is a normal live refresh token.
    const next = await exchangeRefresh(live.url, issued.clientId, bodies[0]!.refresh_token);
    expect(next.status).toBe(200);
  }, 30_000);

  it('returns the same successor to the same client re-presenting a just-rotated token (#10301)', async () => {
    const issued = await issueAuthorizationCode(live.url, 'grace-replay');
    const initial = await exchangeCode(live.url, issued);
    expect(initial.status).toBe(200);
    const first = await initial.json() as { refresh_token: string };

    const rotated = await exchangeRefresh(live.url, issued.clientId, first.refresh_token);
    expect(rotated.status).toBe(200);
    const second = await rotated.json() as { refresh_token: string };

    const retry = await exchangeRefresh(live.url, issued.clientId, first.refresh_token);
    expect(retry.status).toBe(200);
    const retried = await retry.json() as { refresh_token: string; access_token: string };
    expect(retried.refresh_token).toBe(second.refresh_token);
    expect(retried.access_token).toEqual(expect.any(String));

    const grantId = await grantIdOfRow(sha256Hex(second.refresh_token));
    expect(await grantRevocation(grantId)).toEqual({ revokedAt: null, revokedReason: null });
    const active = await getTestDb().select({ id: oauthRefreshTokens.id })
      .from(oauthRefreshTokens)
      .where(and(eq(oauthRefreshTokens.clientId, issued.clientId), isNull(oauthRefreshTokens.revokedAt)));
    expect(active).toEqual([{ id: sha256Hex(second.refresh_token) }]);
  }, 30_000);

  it('treats a just-rotated token presented by a DIFFERENT client as reuse (#10301)', async () => {
    const issued = await issueAuthorizationCode(live.url, 'grace-other-client');
    const initial = await exchangeCode(live.url, issued);
    expect(initial.status).toBe(200);
    const first = await initial.json() as { refresh_token: string };
    const rotated = await exchangeRefresh(live.url, issued.clientId, first.refresh_token);
    expect(rotated.status).toBe(200);
    const second = await rotated.json() as { refresh_token: string };
    const grantId = await grantIdOfRow(sha256Hex(second.refresh_token));

    const other = await registerClient(live.url, 'grace-other-client-2');
    const replay = await exchangeRefresh(live.url, other, first.refresh_token);
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: 'invalid_grant' });
    expect(await grantRevocation(grantId)).toEqual({
      revokedAt: expect.any(Date),
      revokedReason: 'refresh-token-reuse',
    });
  }, 30_000);

  it('clears only the rotating client\'s seals older than the cap (#10301)', async () => {
    const issued = await issueAuthorizationCode(live.url, 'grace-scrub');
    const initial = await exchangeCode(live.url, issued);
    expect(initial.status).toBe(200);
    const first = await initial.json() as { refresh_token: string };
    const [template] = await getTestDb()
      .select({ userId: oauthRefreshTokens.userId, partnerId: oauthRefreshTokens.partnerId, payload: oauthRefreshTokens.payload })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.id, sha256Hex(first.refresh_token)));
    if (!template) throw new Error('initial refresh token row missing');
    const otherClient = await registerClient(live.url, 'grace-scrub-other');

    const now = Date.now();
    const seeded = {
      stale: sha256Hex(`seed-stale-${randomUUID()}`),
      recent: sha256Hex(`seed-recent-${randomUUID()}`),
      foreign: sha256Hex(`seed-foreign-${randomUUID()}`),
    };
    const seedRow = (id: string, clientId: string, ageMs: number, sealed: string) => ({
      id,
      userId: template.userId,
      clientId,
      partnerId: template.partnerId,
      payload: template.payload,
      expiresAt: new Date(now + 3_600_000),
      revokedAt: new Date(now - ageMs),
      rotatedAt: new Date(now - ageMs),
      successorSealed: sealed,
    });
    await getTestDb().insert(oauthRefreshTokens).values([
      seedRow(seeded.stale, issued.clientId, 31_000, 'v1.stale'),
      seedRow(seeded.recent, issued.clientId, 5_000, 'v1.recent'),
      seedRow(seeded.foreign, otherClient, 31_000, 'v1.foreign'),
    ]);

    const rotated = await exchangeRefresh(live.url, issued.clientId, first.refresh_token);
    expect(rotated.status).toBe(200);

    const sealOf = async (id: string) => (await getTestDb()
      .select({ sealed: oauthRefreshTokens.successorSealed })
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.id, id)))[0]?.sealed;
    expect(await sealOf(seeded.stale)).toBeNull();
    expect(await sealOf(seeded.recent)).toBe('v1.recent');
    expect(await sealOf(seeded.foreign)).toBe('v1.foreign');
    expect(await sealOf(sha256Hex(first.refresh_token))).toMatch(/^v1\./);
  }, 30_000);

  it('keeps the strict reuse path end to end when OAUTH_REFRESH_ROTATION_GRACE_MS=0 (#10301)', async () => {
    const issued = await issueAuthorizationCode(live.url, 'grace-off');
    const initial = await exchangeCode(live.url, issued);
    expect(initial.status).toBe(200);
    const first = await initial.json() as { refresh_token: string };

    const previous = process.env.OAUTH_REFRESH_ROTATION_GRACE_MS;
    process.env.OAUTH_REFRESH_ROTATION_GRACE_MS = '0';
    try {
      const rotated = await exchangeRefresh(live.url, issued.clientId, first.refresh_token);
      expect(rotated.status).toBe(200);
      const second = await rotated.json() as { refresh_token: string };
      const [parent] = await getTestDb()
        .select({ rotatedAt: oauthRefreshTokens.rotatedAt, sealed: oauthRefreshTokens.successorSealed })
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.id, sha256Hex(first.refresh_token)));
      expect(parent).toEqual({ rotatedAt: null, sealed: null });
      const grantId = await grantIdOfRow(sha256Hex(second.refresh_token));

      const replay = await exchangeRefresh(live.url, issued.clientId, first.refresh_token);
      expect(replay.status).toBe(400);
      expect(await grantRevocation(grantId)).toEqual({
        revokedAt: expect.any(Date),
        revokedReason: 'refresh-token-reuse',
      });
    } finally {
      if (previous === undefined) delete process.env.OAUTH_REFRESH_ROTATION_GRACE_MS;
      else process.env.OAUTH_REFRESH_ROTATION_GRACE_MS = previous;
    }
  }, 30_000);

  it('refresh-token reuse durably revokes the Grant and its whole family, not just a Redis marker', async () => {
    // Steal-and-replay, sequentially (no lock needed): rotate once legitimately,
    // then present the burned RT again once the grace window has passed. The
    // eager Redis grant marker expires
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

    // Move the rotation outside the #10301 grace window, then replay the
    // burned token: from here on it is reuse, exactly as before.
    await ageRotation(sha256Hex(first.refresh_token), 11_000);
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
