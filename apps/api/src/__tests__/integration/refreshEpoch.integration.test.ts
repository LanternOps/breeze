/**
 * Real-Postgres + real-Redis integration coverage for the /refresh epoch gate
 * and durable refresh-family checks (Task 13; carries Task 4/6 gaps that were
 * deferred to integration).
 *
 * Mocked unit tests (login.test.ts) stub `getRefreshFamily` and the epoch
 * read — they cannot prove:
 *
 *   1. A refresh minted with `aep=1` is genuinely rejected once a COMMITTED
 *      lifecycle call (advanceUserEpochs, run exactly as production mutation
 *      sites run it) bumps the live row to `authEpoch=2`, and that the
 *      rejection mints no descendant token/family.
 *   2. `getRefreshFamily`'s real query — not a mock — actually rejects a
 *      family whose `revoked_at` was set directly in Postgres by
 *      `revokeAllRefreshFamilies` (no Redis sentinel involved: that helper
 *      never touches Redis, unlike the reuse-detection path in login.ts, so
 *      this is the ONE test proving the durable Postgres read alone is
 *      sufficient — "belt and braces" for real).
 *   3. The same real query rejects a family past its absolute expiry.
 *   4. Two genuinely concurrent /refresh calls sharing one cookie, racing
 *      against real Redis's atomic NX claim, produce exactly one winner —
 *      and a subsequent durable revoke kills both the winner's new cookie
 *      and the loser's stale one.
 *
 * Run:
 *   export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
 *   cd apps/api && pnpm vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/refreshEpoch.integration.test.ts
 */
import './setup';
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { authRoutes } from '../../routes/auth';
import { db, withSystemDbAccessContext } from '../../db';
import { users, refreshTokenFamilies } from '../../db/schema';
import { advanceUserEpochs, revokeAllRefreshFamilies } from '../../services/authLifecycle';
import { createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

interface RefreshCookies {
  refreshCookieValue: string;
  csrfCookieValue: string;
  csrfHeaderValue: string;
}

function extractCookies(setCookieHeader: string): RefreshCookies | null {
  const parts = setCookieHeader.split(',').map((part) => part.trim());
  const refreshCookie = parts.find((part) => part.startsWith('breeze_refresh_token='));
  const csrfCookie = parts.find((part) => part.startsWith('breeze_csrf_token='));
  if (!refreshCookie || !csrfCookie) return null;

  const refreshCookieValue = refreshCookie.split(';')[0];
  const csrfCookieValue = csrfCookie.split(';')[0];
  if (!refreshCookieValue || !csrfCookieValue) return null;

  const csrfHeaderValue = decodeURIComponent(csrfCookieValue.split('=')[1] ?? '');
  return { refreshCookieValue, csrfCookieValue, csrfHeaderValue };
}

async function loginAndExtractCookies(app: Hono, email: string, password: string): Promise<RefreshCookies> {
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookies = extractCookies(setCookie);
  if (!cookies) throw new Error(`Failed to extract refresh/csrf cookies from login: ${setCookie}`);
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
      Cookie: `${cookies.refreshCookieValue}; ${cookies.csrfCookieValue}`,
    },
    body: JSON.stringify({}),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const nextCookies = res.status === 200 ? extractCookies(setCookie) : null;
  return { status: res.status, nextCookies };
}

async function findUserId(email: string): Promise<string> {
  const [row] = await getTestDb().select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!row) throw new Error(`user ${email} not found`);
  return row.id;
}

describe('POST /refresh — real-DB epoch + durable family gates (Task 13)', () => {
  let app: Hono;
  let testPartnerId: string;

  beforeEach(async () => {
    app = new Hono();
    app.route('/auth', authRoutes);
    const partner = await createPartner();
    testPartnerId = partner.id;
  });

  it('rejects a refresh minted with the old auth_epoch once a committed advanceUserEpochs call bumps the live row, and mints no descendant', async () => {
    const email = 'epochgate@example.com';
    await createUser({ partnerId: testPartnerId, withMembership: true, email, password: 'EpochGatePass123!' });
    const cookiesA = await loginAndExtractCookies(app, email, 'EpochGatePass123!');
    const userId = await findUserId(email);

    const familiesBefore = await getTestDb()
      .select()
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, userId));
    expect(familiesBefore).toHaveLength(1);

    // Committed lifecycle call — advance auth_epoch WITHOUT revoking the
    // family, so a 401 here is provably the epoch-mismatch branch and not
    // the family-revoked branch tested separately below.
    await withSystemDbAccessContext(() => db.transaction((tx) => advanceUserEpochs(tx, userId, { auth: true })));

    const res = await refreshWithCookies(app, cookiesA);
    expect(res.status).toBe(401);
    expect(res.nextCookies).toBeNull();

    // No descendant minted: still exactly the one family row from login, and
    // it was never touched by this rejection.
    const familiesAfter = await getTestDb()
      .select()
      .from(refreshTokenFamilies)
      .where(eq(refreshTokenFamilies.userId, userId));
    expect(familiesAfter).toHaveLength(1);
    expect(familiesAfter[0]!.revokedAt).toBeNull();
  });

  it('rejects a refresh once revokeAllRefreshFamilies has durably committed — exercised via the real getRefreshFamily Postgres read (no Redis sentinel involved)', async () => {
    const email = 'famgate@example.com';
    await createUser({ partnerId: testPartnerId, withMembership: true, email, password: 'FamGatePass123!' });
    const cookiesA = await loginAndExtractCookies(app, email, 'FamGatePass123!');
    const userId = await findUserId(email);

    await withSystemDbAccessContext(() =>
      db.transaction((tx) => revokeAllRefreshFamilies(tx, userId, 'lifecycle-test-revoke'))
    );

    const res = await refreshWithCookies(app, cookiesA);
    expect(res.status).toBe(401);
    expect(res.nextCookies).toBeNull();
  });

  it('rejects a refresh once the family has passed its absolute expiry — exercised via the real getRefreshFamily Postgres read', async () => {
    const email = 'absexpiry@example.com';
    await createUser({ partnerId: testPartnerId, withMembership: true, email, password: 'AbsExpiryPass123!' });
    const cookiesA = await loginAndExtractCookies(app, email, 'AbsExpiryPass123!');
    const userId = await findUserId(email);

    await getTestDb()
      .update(refreshTokenFamilies)
      .set({ absoluteExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(refreshTokenFamilies.userId, userId));

    const res = await refreshWithCookies(app, cookiesA);
    expect(res.status).toBe(401);
    expect(res.nextCookies).toBeNull();
  });

  it('a true concurrent /refresh race on the same cookie yields exactly one winner; a subsequent durable revoke then blocks BOTH the winner\'s new cookie and the loser\'s stale one', async () => {
    const email = 'race@example.com';
    await createUser({ partnerId: testPartnerId, withMembership: true, email, password: 'RacePass123!' });
    const cookiesA = await loginAndExtractCookies(app, email, 'RacePass123!');

    // Fire both requests without awaiting in between — real Redis's atomic
    // SET NX (revokeRefreshTokenJti) decides the winner, not test ordering.
    const [r1, r2] = await Promise.all([refreshWithCookies(app, cookiesA), refreshWithCookies(app, cookiesA)]);

    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 401]);
    const winner = r1.status === 200 ? r1 : r2;
    expect(winner.nextCookies).not.toBeNull();

    const userId = await findUserId(email);
    await withSystemDbAccessContext(() =>
      db.transaction((tx) => revokeAllRefreshFamilies(tx, userId, 'post-race-revoke'))
    );

    const followupWinner = await refreshWithCookies(app, winner.nextCookies!);
    expect(followupWinner.status).toBe(401);

    const followupLoser = await refreshWithCookies(app, cookiesA);
    expect(followupLoser.status).toBe(401);
  });
});
