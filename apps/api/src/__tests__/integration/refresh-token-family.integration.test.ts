/**
 * Refresh-Token Family Revocation Integration Tests
 *
 * Verifies that when a revoked refresh-token JTI is replayed (token-reuse
 * detection), the entire token family is revoked — so the legitimate user's
 * later refresh ALSO fails. This is the OAuth 2.1 "automatic reuse detection"
 * pattern (RFC 9700 / draft-ietf-oauth-security-topics §4.13.2).
 *
 * Without family revocation, an attacker who races the legitimate user could
 * hold a fully-valid parallel session: rotation only invalidates the *old*
 * jti, so whichever side gets there first establishes a new token pair and
 * the other side gets one rejection. Family revocation closes the race by
 * killing every token derived from the originally-stolen pair.
 *
 * See Task 7 of the launch-readiness fixes plan.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { generate, generateSecret } from 'otplib';
import { authRoutes } from '../../routes/auth';
import { encryptMfaTotpSecret } from '../../services/mfaSecretCrypto';
import { verifyToken } from '../../services/jwt';
import { getRedis } from '../../services/redis';
import {
  beginAuthIssuance,
  finishAuthIssuance,
  resolveAuthBinding,
  AuthBindingRotationRequiredError,
} from '../../services/authBrowserTransition';
import {
  digestRefreshTokenJti,
  RefreshTokenCurrentnessError,
} from '../../services/refreshTokenFamily';
import { issueUserSession, type UserSessionIdentity } from '../../services/userSession';
import {
  revokeUserSessionFamilyForLogout,
  withAuthLifecycleSystemTransaction,
} from '../../services/authLifecycle';
import { refreshTokenFamilies, users } from '../../db/schema';
import { createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

// Import setup to initialize database connection
import './setup';

interface RefreshCookies {
  refreshCookieValue: string;
  csrfCookieValue: string;
  csrfHeaderValue: string;
}

function extractCookies(setCookieHeader: string): RefreshCookies | null {
  const parts = setCookieHeader
    .split(',')
    .map((part) => part.trim());
  const refreshCookie = parts.find((part) => part.startsWith('breeze_refresh_token='));
  const csrfCookie = parts.find((part) => part.startsWith('breeze_csrf_token='));
  if (!refreshCookie || !csrfCookie) return null;

  const refreshCookieValue = refreshCookie.split(';')[0];
  const csrfCookieValue = csrfCookie.split(';')[0];
  if (!refreshCookieValue || !csrfCookieValue) return null;

  const csrfHeaderValue = decodeURIComponent(csrfCookieValue.split('=')[1] ?? '');
  return { refreshCookieValue, csrfCookieValue, csrfHeaderValue };
}

function extractCsrfCookie(setCookieHeader: string): Pick<RefreshCookies, 'csrfCookieValue' | 'csrfHeaderValue'> | null {
  const csrfCookie = setCookieHeader.split(',').map((part) => part.trim())
    .find((part) => part.startsWith('breeze_csrf_token='));
  const csrfCookieValue = csrfCookie?.split(';')[0];
  if (!csrfCookieValue) return null;
  return {
    csrfCookieValue,
    csrfHeaderValue: decodeURIComponent(csrfCookieValue.split('=')[1] ?? ''),
  };
}

async function loginAndExtractCookies(
  app: Hono,
  email: string,
  password: string
): Promise<RefreshCookies> {
  return (await loginAndExtractSession(app, email, password)).cookies;
}

async function loginAndExtractSession(
  app: Hono,
  email: string,
  password: string
): Promise<{ cookies: RefreshCookies; accessToken: string }> {
  const { response: res } = await requestLoginWithBindingBootstrap(app, email, password);
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookies = extractCookies(setCookie);
  if (!cookies) {
    throw new Error(`Failed to extract refresh/csrf cookies from login: ${setCookie}`);
  }
  const body = await res.json() as { tokens: { accessToken: string } };
  return { cookies, accessToken: body.tokens.accessToken };
}

async function requestLoginWithBindingBootstrap(
  app: Hono,
  email: string,
  password: string,
): Promise<{ response: Response; bindingCookie: string | null }> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  };
  const first = await app.request('/auth/login', init);
  if (first.status !== 428) return { response: first, bindingCookie: null };
  const replacement = extractCsrfCookie(first.headers.get('set-cookie') ?? '');
  if (!replacement) throw new Error('Login 428 omitted replacement binding cookie');
  const headers = new Headers(init.headers);
  headers.set('cookie', replacement.csrfCookieValue);
  return {
    response: await app.request('/auth/login', { ...init, headers }),
    bindingCookie: replacement.csrfCookieValue,
  };
}

async function refreshWithCookies(
  app: Hono,
  cookies: RefreshCookies,
  allowBindingBootstrap = true,
): Promise<{ status: number; nextCookies: RefreshCookies | null; accessToken: string | null }> {
  const res = await app.request('/auth/refresh', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-breeze-csrf': cookies.csrfHeaderValue,
      Cookie: `${cookies.refreshCookieValue}; ${cookies.csrfCookieValue}`
    },
    body: JSON.stringify({})
  });

  const setCookie = res.headers.get('set-cookie') ?? '';
  if (res.status === 428 && allowBindingBootstrap) {
    const replacement = extractCsrfCookie(setCookie);
    if (!replacement) throw new Error(`Refresh 428 omitted replacement binding: ${setCookie}`);
    return refreshWithCookies(app, {
      refreshCookieValue: cookies.refreshCookieValue,
      ...replacement,
    }, false);
  }
  const nextCookies = res.status === 200 ? extractCookies(setCookie) : null;
  const body = res.status === 200
    ? await res.json() as { tokens: { accessToken: string } }
    : null;
  return { status: res.status, nextCookies, accessToken: body?.tokens.accessToken ?? null };
}

function freshBrowserBinding(): string {
  try {
    resolveAuthBinding(null);
  } catch (error) {
    if (error instanceof AuthBindingRotationRequiredError) return error.replacement.value;
    throw error;
  }
  throw new Error('Missing binding unexpectedly resolved');
}

async function requestCurrentUser(app: Hono, accessToken: string): Promise<Response> {
  return app.request('/auth/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

async function logoutWithSession(
  app: Hono,
  accessToken: string,
  cookies: RefreshCookies,
): Promise<Response> {
  return app.request('/auth/logout', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Cookie: `${cookies.refreshCookieValue}; ${cookies.csrfCookieValue}`,
    },
  });
}

async function waitForBlockedFamilyRevocation(): Promise<void> {
  const db = getTestDb();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await db.execute(sql`
      SELECT count(*)::int AS blocked_count
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND position('refresh_token_families' in lower(query)) > 0
    `) as unknown as Array<{ blocked_count: number }>;
    if (Number(rows[0]?.blocked_count ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Logout never reached the blocked refresh-token-family revocation update');
}

describe('Refresh-Token Family Revocation (Task 7)', () => {
  let app: Hono;
  let testPartnerId: string;
  let prevGrace: string | undefined;

  beforeEach(async () => {
    // These tests assert the STRICT reuse-detection contract: an immediate
    // replay of a revoked jti kills the family. The #1107 rotation-leeway
    // (default 15s) would otherwise treat that immediate replay as a benign
    // race, so we pin leeway to 0 here. The benign-race behaviour is covered
    // separately below.
    prevGrace = process.env.REFRESH_ROTATION_GRACE_SECONDS;
    process.env.REFRESH_ROTATION_GRACE_SECONDS = '0';
    app = new Hono();
    app.route('/auth', authRoutes);
    const partner = await createPartner();
    testPartnerId = partner.id;
  });

  afterEach(() => {
    if (prevGrace === undefined) delete process.env.REFRESH_ROTATION_GRACE_SECONDS;
    else process.env.REFRESH_ROTATION_GRACE_SECONDS = prevGrace;
  });

  it('revokes the entire family when a revoked jti is replayed (reuse detected)', async () => {
    // Seed
    await createUser({
      partnerId: testPartnerId,
      withMembership: true,
      email: 'family@example.com',
      password: 'FamilyPass123!'
    });

    // Step 1: legitimate login → refresh-cookie A
    const cookiesA = await loginAndExtractCookies(
      app,
      'family@example.com',
      'FamilyPass123!'
    );

    // Step 2: legitimate first refresh → A revoked, cookie B issued
    const r2 = await refreshWithCookies(app, cookiesA);
    expect(r2.status).toBe(200);
    expect(r2.nextCookies).not.toBeNull();
    const cookiesB = r2.nextCookies!;

    // Prove PostgreSQL currentness, not the predecessor's Redis marker, is
    // sufficient to detect the stale replay and revoke the exact family.
    await getRedis()?.flushdb();

    // Step 3: attacker replays cookie A (jti is already revoked).
    // Replay must:
    //   - reject the replay (401)
    //   - mark the family as compromised — so subsequent refreshes from ANY
    //     derived token are dead, not just the replayed one.
    const replay = await refreshWithCookies(app, cookiesA);
    expect(replay.status).toBe(401);

    // The durable row remains authoritative after the post-revocation cache
    // sentinel is lost as well.
    await getRedis()?.flushdb();

    // Step 4: legitimate user's "valid" cookie B is now ALSO dead because
    // the family was revoked. This is the critical assertion that proves
    // family revocation (vs per-jti revocation) is active. Before Task 7
    // this would return 200 because cookie B's jti was never individually
    // revoked.
    const followup = await refreshWithCookies(app, cookiesB);
    expect(followup.status).toBe(401);
  });

  it('rejects a refresh whose family was revoked by an earlier reuse', async () => {
    await createUser({
      partnerId: testPartnerId,
      withMembership: true,
      email: 'famrevoke@example.com',
      password: 'FamilyPass123!'
    });

    const cookiesA = await loginAndExtractCookies(
      app,
      'famrevoke@example.com',
      'FamilyPass123!'
    );

    // Rotate twice — family is now A→B→C
    const r2 = await refreshWithCookies(app, cookiesA);
    expect(r2.status).toBe(200);
    const cookiesB = r2.nextCookies!;

    const r3 = await refreshWithCookies(app, cookiesB);
    expect(r3.status).toBe(200);
    const cookiesC = r3.nextCookies!;

    // Attacker holds cookie A. Replay triggers family-wide revocation.
    const replay = await refreshWithCookies(app, cookiesA);
    expect(replay.status).toBe(401);

    // Cookie C — the freshest legit token — must also be dead.
    const followup = await refreshWithCookies(app, cookiesC);
    expect(followup.status).toBe(401);
  });

  it('MFA verify path produces a family-tagged refresh token (reuse detection covers MFA cohort)', async () => {
    // Seed an MFA-enabled user with a known TOTP secret so we can drive
    // /mfa/verify deterministically. We then assert family revocation via
    // the same reuse-replay mechanism as the password-only test above —
    // proving the MFA branch attaches a `fam` claim without needing to
    // decode the JWT directly.
    const password = 'MfaFamilyPass123!';
    const email = 'mfafam@example.com';
    const user = await createUser({
      partnerId: testPartnerId,
      withMembership: true,
      email,
      password,
      mfaEnabled: true,
    });

    // Provision MFA secret + method directly. Uses the same encryption path
    // /mfa/enable writes through, so /mfa/verify's decryptMfaSecretForMigration
    // can read it back.
    const mfaSecret = generateSecret({ length: 20 });
    const db = getTestDb() as any;
    await db
      .update(users)
      .set({
        mfaSecret: encryptMfaTotpSecret(mfaSecret),
        mfaMethod: 'totp',
      })
      .where(eq(users.id, user.id));

    // Step 1: /login → mfaRequired=true + tempToken
    const { response: loginRes, bindingCookie } = await requestLoginWithBindingBootstrap(
      app,
      email,
      password,
    );
    expect(loginRes.status).toBe(200);
    const loginBody = (await loginRes.json()) as { mfaRequired: boolean; tempToken: string };
    expect(loginBody.mfaRequired).toBe(true);
    expect(loginBody.tempToken).toBeTruthy();

    // Step 2: /mfa/verify → emits the real refresh cookie
    const totpCode = await generate({ secret: mfaSecret });
    const mfaRes = await app.request('/auth/mfa/verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(bindingCookie ? { Cookie: bindingCookie } : {}),
      },
      body: JSON.stringify({ tempToken: loginBody.tempToken, code: totpCode }),
    });
    expect(mfaRes.status).toBe(200);
    const mfaSetCookie = mfaRes.headers.get('set-cookie') ?? '';
    const cookiesA = extractCookies(mfaSetCookie);
    expect(cookiesA).not.toBeNull();

    // Step 3: rotate once → cookie B issued, A revoked
    const r2 = await refreshWithCookies(app, cookiesA!);
    expect(r2.status).toBe(200);
    expect(r2.nextCookies).not.toBeNull();
    const cookiesB = r2.nextCookies!;

    // Step 4: replay A → reuse-detection must kill the entire family.
    // If /mfa/verify hadn't tagged the token with `fam`, this would only
    // revoke A's jti and B would survive — the exact bug this test guards
    // against.
    const replay = await refreshWithCookies(app, cookiesA!);
    expect(replay.status).toBe(401);

    // Step 5: B must now also be dead — proof that the MFA-minted token
    // carried a family id.
    const followup = await refreshWithCookies(app, cookiesB);
    expect(followup.status).toBe(401);
  });

  it('issues a new family on each /login (independent revocation scope)', async () => {
    await createUser({
      partnerId: testPartnerId,
      withMembership: true,
      email: 'twofam@example.com',
      password: 'FamilyPass123!'
    });

    // Two separate /login flows = two independent families.
    const cookiesFam1 = await loginAndExtractCookies(
      app,
      'twofam@example.com',
      'FamilyPass123!'
    );
    const cookiesFam2 = await loginAndExtractCookies(
      app,
      'twofam@example.com',
      'FamilyPass123!'
    );

    // Rotate family 1, then replay original → kills family 1.
    const r1 = await refreshWithCookies(app, cookiesFam1);
    expect(r1.status).toBe(200);
    const cookiesFam1B = r1.nextCookies!;

    const replay = await refreshWithCookies(app, cookiesFam1);
    expect(replay.status).toBe(401);

    // Family 1's derived token is dead…
    const dead = await refreshWithCookies(app, cookiesFam1B);
    expect(dead.status).toBe(401);

    // …but family 2 must still be alive — separate /login = separate family.
    const stillAlive = await refreshWithCookies(app, cookiesFam2);
    expect(stillAlive.status).toBe(200);
  });
});

describe('Refresh-Token Rotation Leeway (#1107)', () => {
  let app: Hono;
  let testPartnerId: string;
  let prevGrace: string | undefined;

  beforeEach(async () => {
    // Exercise the leeway path with a generous window so an immediate replay
    // lands inside it.
    prevGrace = process.env.REFRESH_ROTATION_GRACE_SECONDS;
    process.env.REFRESH_ROTATION_GRACE_SECONDS = '30';
    app = new Hono();
    app.route('/auth', authRoutes);
    const partner = await createPartner();
    testPartnerId = partner.id;
  });

  afterEach(() => {
    if (prevGrace === undefined) delete process.env.REFRESH_ROTATION_GRACE_SECONDS;
    else process.env.REFRESH_ROTATION_GRACE_SECONDS = prevGrace;
  });

  it('does NOT kill the family when a just-rotated jti is replayed within the leeway window', async () => {
    await createUser({
      partnerId: testPartnerId,
      withMembership: true,
      email: 'leeway@example.com',
      password: 'FamilyPass123!'
    });

    // login → A
    const cookiesA = await loginAndExtractCookies(app, 'leeway@example.com', 'FamilyPass123!');

    // rotate A → B (A revoked, grace marker dropped for A)
    const r2 = await refreshWithCookies(app, cookiesA);
    expect(r2.status).toBe(200);
    const cookiesB = r2.nextCookies!;

    // Replay A immediately (multi-tab / reload-mid-flight). Within the leeway
    // window this is a benign race: rejected (can't mint) but the family must
    // SURVIVE so the winning sibling's cookie B keeps working.
    const replay = await refreshWithCookies(app, cookiesA);
    expect(replay.status).toBe(401);

    // The critical assertion: B is still alive — the family was NOT revoked.
    const followup = await refreshWithCookies(app, cookiesB);
    expect(followup.status).toBe(200);
  });

  it('revokes the family when an older ancestor is replayed after a fresh successor rotation', async () => {
    await createUser({
      partnerId: testPartnerId,
      withMembership: true,
      email: 'leeway-ancestor@example.com',
      password: 'FamilyPass123!',
    });

    const cookiesA = await loginAndExtractCookies(app, 'leeway-ancestor@example.com', 'FamilyPass123!');
    const first = await refreshWithCookies(app, cookiesA);
    expect(first.status).toBe(200);
    const cookiesB = first.nextCookies!;
    const second = await refreshWithCookies(app, cookiesB);
    expect(second.status).toBe(200);
    const cookiesC = second.nextCookies!;

    // Only immediate predecessor B may receive durable race grace. A is an
    // older ancestor and must still trigger exact-family compromise handling.
    const ancestorReplay = await refreshWithCookies(app, cookiesA);
    expect(ancestorReplay.status).toBe(401);
    const currentAfterReplay = await refreshWithCookies(app, cookiesC);
    expect(currentAfterReplay.status).toBe(401);
  });
});

describe('Durable logout/refresh race (Task 6)', () => {
  let app: Hono;
  let testPartnerId: string;

  beforeEach(async () => {
    process.env.E2E_MODE = 'true';
    app = new Hono();
    app.route('/auth', authRoutes);
    const partner = await createPartner();
    testPartnerId = partner.id;
  });

  it('prevents every concurrent refresh descendant from continuing after logout commits', async () => {
    await createUser({
      partnerId: testPartnerId,
      withMembership: true,
      email: 'logout-race@example.com',
      password: 'FamilyPass123!',
    });

    const { response: loginRes } = await requestLoginWithBindingBootstrap(
      app,
      'logout-race@example.com',
      'FamilyPass123!',
    );
    expect(loginRes.status).toBe(200);
    const loginBody = await loginRes.json() as { tokens: { accessToken: string } };
    const originalCookies = extractCookies(loginRes.headers.get('set-cookie') ?? '');
    expect(originalCookies).not.toBeNull();
    const accessPayload = await verifyToken(loginBody.tokens.accessToken);
    expect(accessPayload?.sid).toBeTruthy();

    // A second login is a sibling family for the same user. Logout must not
    // globally revoke it while targeting the racing family above.
    const siblingSession = await loginAndExtractSession(
      app,
      'logout-race@example.com',
      'FamilyPass123!',
    );

    const db = getTestDb();
    let logoutSettled = false;
    let logoutPromise: Promise<Response> | undefined;
    let refreshPromise: ReturnType<typeof refreshWithCookies> | undefined;

    // Hold a row lock so logout's conditional UPDATE cannot commit. Start the
    // logout first, then start /refresh while both are forced behind the same
    // family lock. Durable currentness no longer permits a descendant to mint
    // while lifecycle revocation is waiting on that row.
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT family_id
        FROM refresh_token_families
        WHERE family_id = ${accessPayload!.sid}::uuid
        FOR UPDATE
      `);

      logoutPromise = logoutWithSession(app, loginBody.tokens.accessToken, originalCookies!);
      void logoutPromise.finally(() => {
        logoutSettled = true;
      });
      await waitForBlockedFamilyRevocation();

      refreshPromise = refreshWithCookies(app, originalCookies!);
      expect(logoutSettled).toBe(false);
    });

    const [logoutResult, refreshResult] = await Promise.all([logoutPromise!, refreshPromise!]);

    expect(logoutResult.status).toBe(200);
    expect(refreshResult.status).toBe(401);
    expect(logoutSettled).toBe(true);

    const familyRows = await db.select().from(refreshTokenFamilies);
    expect(familyRows).toHaveLength(2);
    const currentFamily = familyRows.find((row) => row.familyId === accessPayload?.sid);
    const siblingFamily = familyRows.find((row) => row.familyId !== accessPayload?.sid);
    expect(currentFamily?.revokedAt).not.toBeNull();
    expect(currentFamily?.revokedReason).toBe('logout');
    expect(siblingFamily?.revokedAt).toBeNull();

    const originalAfterCommit = await refreshWithCookies(app, originalCookies!);
    expect(originalAfterCommit.status).toBe(401);

    expect(await requestCurrentUser(app, loginBody.tokens.accessToken)).toMatchObject({ status: 401 });
    expect(await requestCurrentUser(app, siblingSession.accessToken)).toMatchObject({ status: 200 });

    const siblingAfterCommit = await refreshWithCookies(app, siblingSession.cookies);
    expect(siblingAfterCommit.status).toBe(200);
  });

  it('classifies concurrent revocation of one owned family as revoked plus already revoked', async () => {
    const user = await createUser({
      partnerId: testPartnerId,
      withMembership: true,
      email: 'logout-idempotent@example.com',
      password: 'FamilyPass123!',
    });
    const familyId = '60000000-0000-4000-8000-000000000006';
    await getTestDb().insert(refreshTokenFamilies).values({
      familyId,
      userId: user.id,
      absoluteExpiresAt: new Date(Date.now() + 86_400_000),
    });

    const outcomes = await Promise.all([
      withAuthLifecycleSystemTransaction((tx) =>
        revokeUserSessionFamilyForLogout(tx, user.id, familyId, 'logout')
      ),
      withAuthLifecycleSystemTransaction((tx) =>
        revokeUserSessionFamilyForLogout(tx, user.id, familyId, 'logout')
      ),
    ]);

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      'already_revoked',
      'revoked',
    ]);
  });
});

describe('Durable refresh currentness (browser transition Task 4)', () => {
  let app: Hono;
  let testPartnerId: string;

  beforeEach(async () => {
    process.env.E2E_MODE = 'true';
    app = new Hono();
    app.route('/auth', authRoutes);
    testPartnerId = (await createPartner()).id;
  });

  it('writes the initial login JTI digest into the family row', async () => {
    const user = await createUser({
      partnerId: testPartnerId,
      withMembership: true,
      email: 'durable-initial@example.com',
      password: 'FamilyPass123!',
    });
    const cookies = await loginAndExtractCookies(app, user.email, 'FamilyPass123!');
    const refreshToken = decodeURIComponent(cookies.refreshCookieValue.split('=')[1] ?? '');
    const payload = await verifyToken(refreshToken);
    expect(payload?.jti).toBeTruthy();
    expect(payload?.fam).toBeTruthy();

    const [family] = await getTestDb().select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, payload!.fam!));
    expect(family?.currentRefreshJtiDigest).toBe(digestRefreshTokenJti(payload!.jti!));
  });

  it('upgrades a live legacy-null family on the next exact-family refresh', async () => {
    const user = await createUser({
      partnerId: testPartnerId,
      withMembership: true,
      email: 'durable-legacy@example.com',
      password: 'FamilyPass123!',
    });
    const cookies = await loginAndExtractCookies(app, user.email, 'FamilyPass123!');
    const payload = await verifyToken(decodeURIComponent(cookies.refreshCookieValue.split('=')[1] ?? ''));
    await getTestDb().update(refreshTokenFamilies)
      .set({ currentRefreshJtiDigest: null })
      .where(eq(refreshTokenFamilies.familyId, payload!.fam!));

    const refreshed = await refreshWithCookies(app, cookies);
    expect(refreshed.status).toBe(200);
    const nextPayload = await verifyToken(decodeURIComponent(
      refreshed.nextCookies!.refreshCookieValue.split('=')[1] ?? '',
    ));
    const [family] = await getTestDb().select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, payload!.fam!));
    expect(family?.currentRefreshJtiDigest).toBe(digestRefreshTokenJti(nextPayload!.jti!));
  });

  it('uses the atomic rotation timestamp before the post-commit Redis marker exists', async () => {
    const previousGrace = process.env.REFRESH_ROTATION_GRACE_SECONDS;
    process.env.REFRESH_ROTATION_GRACE_SECONDS = '30';
    try {
      const user = await createUser({
        partnerId: testPartnerId,
        withMembership: true,
        email: 'durable-marker-gap@example.com',
        password: 'FamilyPass123!',
      });
      const cookies = await loginAndExtractCookies(app, user.email, 'FamilyPass123!');
      const predecessor = await verifyToken(decodeURIComponent(
        cookies.refreshCookieValue.split('=')[1] ?? '',
      ));
      if (!predecessor?.fam) throw new Error('Login did not mint a family refresh');

      // Force the exact state between winner commit and its Redis marker: the
      // durable digest/timestamp have advanced atomically, while Redis is empty.
      await getTestDb().update(refreshTokenFamilies).set({
        currentRefreshJtiDigest: digestRefreshTokenJti('forced-successor-jti'),
        previousRefreshJtiDigest: digestRefreshTokenJti(predecessor.jti!),
        lastUsedAt: sql`clock_timestamp()`,
      }).where(eq(refreshTokenFamilies.familyId, predecessor.fam));
      await getRedis()?.flushdb();

      const loser = await refreshWithCookies(app, cookies);
      expect(loser.status).toBe(401);
      const [family] = await getTestDb().select().from(refreshTokenFamilies)
        .where(eq(refreshTokenFamilies.familyId, predecessor.fam));
      expect(family?.revokedAt).toBeNull();
      expect(family?.currentRefreshJtiDigest).toBe(digestRefreshTokenJti('forced-successor-jti'));
    } finally {
      if (previousGrace === undefined) delete process.env.REFRESH_ROTATION_GRACE_SECONDS;
      else process.env.REFRESH_ROTATION_GRACE_SECONDS = previousGrace;
    }
  });

  it('starts predecessor grace at the rotation statement after a long family-lock wait', async () => {
    const previousGrace = process.env.REFRESH_ROTATION_GRACE_SECONDS;
    process.env.REFRESH_ROTATION_GRACE_SECONDS = '1';
    try {
      const user = await createUser({
        partnerId: testPartnerId,
        withMembership: true,
        email: 'durable-lock-wait@example.com',
        password: 'FamilyPass123!',
      });
      const cookiesA = await loginAndExtractCookies(app, user.email, 'FamilyPass123!');
      const predecessor = await verifyToken(decodeURIComponent(
        cookiesA.refreshCookieValue.split('=')[1] ?? '',
      ));
      if (!predecessor?.fam) throw new Error('Login did not mint a family refresh');

      let winnerPromise!: ReturnType<typeof refreshWithCookies>;
      await getTestDb().transaction(async (tx) => {
        await tx.execute(sql`
          SELECT family_id FROM refresh_token_families
          WHERE family_id = ${predecessor.fam}::uuid FOR UPDATE
        `);
        winnerPromise = refreshWithCookies(app, cookiesA);
        await waitForBlockedFamilyRevocation();
        // Exceed the configured grace while finalization's transaction waits.
        await new Promise((resolve) => setTimeout(resolve, 1_200));
      });

      const winner = await winnerPromise;
      expect(winner.status).toBe(200);
      const predecessorReplay = await refreshWithCookies(app, cookiesA);
      expect(predecessorReplay.status).toBe(401);
      const [family] = await getTestDb().select().from(refreshTokenFamilies)
        .where(eq(refreshTokenFamilies.familyId, predecessor.fam));
      expect(family?.revokedAt).toBeNull();
      const winnerFollowup = await refreshWithCookies(app, winner.nextCookies!);
      expect(winnerFollowup.status).toBe(200);
    } finally {
      if (previousGrace === undefined) delete process.env.REFRESH_ROTATION_GRACE_SECONDS;
      else process.env.REFRESH_ROTATION_GRACE_SECONDS = previousGrace;
    }
  });

  it('forces two rotations to one durable successor under the family lock', async () => {
    const user = await createUser({
      partnerId: testPartnerId,
      withMembership: true,
      email: 'durable-cas@example.com',
      password: 'FamilyPass123!',
    });
    const cookies = await loginAndExtractCookies(app, user.email, 'FamilyPass123!');
    const predecessor = await verifyToken(decodeURIComponent(cookies.refreshCookieValue.split('=')[1] ?? ''));
    if (!predecessor?.fam || !predecessor.jti) throw new Error('Login did not mint a family refresh');

    const capabilityA = await beginAuthIssuance({ kind: 'browser', value: freshBrowserBinding() });
    const capabilityB = await beginAuthIssuance({ kind: 'browser', value: freshBrowserBinding() });
    const identity: UserSessionIdentity = {
      userId: user.id,
      email: user.email,
      roleId: null,
      orgId: null,
      partnerId: testPartnerId,
      scope: 'partner',
      mfa: predecessor.mfa,
      amr: predecessor.amr,
    };
    const rotate = (capability: typeof capabilityA) => finishAuthIssuance(capability, (tx) =>
      issueUserSession(identity, {
        tx,
        capability,
        familyId: predecessor.fam!,
        refreshRotation: {
          presentedJti: predecessor.jti!,
          authEpoch: predecessor.ae,
          mfaEpoch: predecessor.me,
        },
      }));

    let pendingA!: ReturnType<typeof rotate>;
    let pendingB!: ReturnType<typeof rotate>;
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`
        SELECT family_id FROM refresh_token_families
        WHERE family_id = ${predecessor.fam}::uuid FOR UPDATE
      `);
      pendingA = rotate(capabilityA);
      pendingB = rotate(capabilityB);
      await waitForBlockedFamilyRevocation();
    });
    const rotations = await Promise.allSettled([pendingA, pendingB]);

    const fulfilled = rotations.filter((result) => result.status === 'fulfilled');
    const rejected = rotations.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(RefreshTokenCurrentnessError);
    const winner = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof issueUserSession>>>).value;
    const [family] = await getTestDb().select().from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.familyId, predecessor.fam));
    expect(family?.revokedAt).toBeNull();
    expect(family?.currentRefreshJtiDigest).toBe(digestRefreshTokenJti(winner.refreshJti));
  });
});
