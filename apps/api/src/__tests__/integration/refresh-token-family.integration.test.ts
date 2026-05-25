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
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authRoutes } from '../../routes/auth';
import { createPartner, createUser } from './db-utils';

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

async function loginAndExtractCookies(
  app: Hono,
  email: string,
  password: string
): Promise<RefreshCookies> {
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookies = extractCookies(setCookie);
  if (!cookies) {
    throw new Error(`Failed to extract refresh/csrf cookies from login: ${setCookie}`);
  }
  return cookies;
}

async function refreshWithCookies(
  app: Hono,
  cookies: RefreshCookies
): Promise<{ status: number; nextCookies: RefreshCookies | null }> {
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
  const nextCookies = res.status === 200 ? extractCookies(setCookie) : null;
  return { status: res.status, nextCookies };
}

describe('Refresh-Token Family Revocation (Task 7)', () => {
  let app: Hono;
  let testPartnerId: string;

  beforeEach(async () => {
    app = new Hono();
    app.route('/auth', authRoutes);
    const partner = await createPartner();
    testPartnerId = partner.id;
  });

  it('revokes the entire family when a revoked jti is replayed (reuse detected)', async () => {
    // Seed
    await createUser({
      partnerId: testPartnerId,
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

    // Step 3: attacker replays cookie A (jti is already revoked).
    // Replay must:
    //   - reject the replay (401)
    //   - mark the family as compromised — so subsequent refreshes from ANY
    //     derived token are dead, not just the replayed one.
    const replay = await refreshWithCookies(app, cookiesA);
    expect(replay.status).toBe(401);

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

  it('issues a new family on each /login (independent revocation scope)', async () => {
    await createUser({
      partnerId: testPartnerId,
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
