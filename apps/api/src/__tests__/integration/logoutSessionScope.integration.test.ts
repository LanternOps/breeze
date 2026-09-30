/**
 * Real-Postgres + real-Redis proof that logout ends exactly one sign-in
 * session: every access and refresh token of that session stops working, the
 * user's other sessions keep working, and the result survives Redis losing
 * every marker logout wrote (flush / restart / restore from an older snapshot).
 *
 * Drives the real routes end to end: POST /auth/login, /auth/refresh,
 * /auth/logout, an authMiddleware-protected probe, and POST /events/ws-ticket
 * (a WebSocket ticket issuer behind authMiddleware).
 */
import './setup';
import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { authRoutes } from '../../routes/auth';
import { authMiddleware } from '../../middleware/auth';
import { createEventWsTicketRoute } from '../../routes/eventWs';
import { refreshTokenFamilies, users } from '../../db/schema';
import {
  bootstrapAuthBinding,
  createOrganization,
  createPartner,
  createUser,
} from './db-utils';
import { getTestDb, getTestRedis } from './setup';

interface BrowserSession {
  binding: string;
  accessToken: string;
  refreshCookie: string;
  csrfCookie: string;
  csrfHeader: string;
}

function readCookies(setCookie: string): Pick<BrowserSession, 'refreshCookie' | 'csrfCookie' | 'csrfHeader'> {
  const parts = setCookie.split(',').map((part) => part.trim());
  const refreshCookie = parts.find((part) => part.startsWith('breeze_refresh_token='))?.split(';')[0];
  const csrfCookie = parts.find((part) => part.startsWith('breeze_csrf_token='))?.split(';')[0];
  if (!refreshCookie || !csrfCookie) throw new Error(`missing refresh/csrf cookies: ${setCookie}`);
  return {
    refreshCookie,
    csrfCookie,
    csrfHeader: decodeURIComponent(csrfCookie.split('=')[1] ?? ''),
  };
}

function familyOf(session: Pick<BrowserSession, 'refreshCookie'>): string {
  const jwt = decodeURIComponent(session.refreshCookie.split('=')[1] ?? '');
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { fam?: string };
  if (!claims.fam) throw new Error('refresh token carries no family');
  return claims.fam;
}

describe('logout ends exactly the sign-in session it is called from', () => {
  let app: Hono;
  const password = 'LogoutScopePass123!';
  let email: string;

  async function signIn(): Promise<BrowserSession> {
    const binding = (await bootstrapAuthBinding()).cookie;
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: binding },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { tokens: { accessToken: string } };
    return { binding, accessToken: body.tokens.accessToken, ...readCookies(res.headers.get('set-cookie') ?? '') };
  }

  function cookieHeader(session: BrowserSession): string {
    return `${session.refreshCookie}; ${session.csrfCookie}; ${session.binding}`;
  }

  async function refresh(session: BrowserSession): Promise<{ status: number; next: BrowserSession | null }> {
    const res = await app.request('/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-breeze-csrf': session.csrfHeader,
        Cookie: cookieHeader(session),
      },
      body: JSON.stringify({}),
    });
    if (res.status !== 200) return { status: res.status, next: null };
    const body = await res.json() as { tokens: { accessToken: string } };
    return {
      status: 200,
      next: {
        binding: session.binding,
        accessToken: body.tokens.accessToken,
        ...readCookies(res.headers.get('set-cookie') ?? ''),
      },
    };
  }

  async function logout(session: BrowserSession): Promise<number> {
    const res = await app.request('http://localhost/auth/logout', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Origin: 'http://localhost',
        'x-breeze-csrf': session.csrfHeader,
        Cookie: cookieHeader(session),
      },
    });
    return res.status;
  }

  async function probe(accessToken: string): Promise<number> {
    return (await app.request('/probe', { headers: { Authorization: `Bearer ${accessToken}` } })).status;
  }

  async function wsTicket(accessToken: string): Promise<number> {
    return (await app.request('/events/ws-ticket', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
    })).status;
  }

  beforeEach(async () => {
    app = new Hono();
    app.route('/auth', authRoutes);
    app.get('/probe', authMiddleware, (c) => c.json({ ok: true }));
    app.route('/events', createEventWsTicketRoute());
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id });
    email = `logout-scope-${Date.now()}@example.com`;
    await createUser({ partnerId: partner.id, withMembership: true, email, password });
  });

  it('refuses every token of the ended session after Redis loses its markers, while the other session keeps working', async () => {
    const first = await signIn();
    const rotated = await refresh(first);
    expect(rotated.status).toBe(200);
    const firstRotated = rotated.next!;
    const other = await signIn();
    const [user] = await getTestDb().select({ id: users.id, authEpoch: users.authEpoch })
      .from(users).where(eq(users.email, email)).limit(1);

    // Two access tokens of the first sign-in (original + post-rotation) and
    // one of the second sign-in all work before logout.
    expect(await probe(first.accessToken)).toBe(200);
    expect(await probe(firstRotated.accessToken)).toBe(200);
    expect(await probe(other.accessToken)).toBe(200);

    expect(await logout(firstRotated)).toBe(200);

    // Drop every Redis marker logout (and login/refresh) wrote. Postgres alone
    // must keep the ended session closed and the other session open.
    await getTestRedis().flushdb();

    expect(await probe(first.accessToken)).toBe(401);
    expect(await probe(firstRotated.accessToken)).toBe(401);
    expect(await wsTicket(first.accessToken)).toBe(401);
    expect((await refresh(firstRotated)).status).toBe(401);

    expect(await probe(other.accessToken)).toBe(200);
    expect(await wsTicket(other.accessToken)).toBe(200);
    const otherRotated = await refresh(other);
    expect(otherRotated.status).toBe(200);
    expect(await probe(otherRotated.next!.accessToken)).toBe(200);

    const [ended] = await getTestDb().select({ revokedAt: refreshTokenFamilies.revokedAt })
      .from(refreshTokenFamilies).where(eq(refreshTokenFamilies.familyId, familyOf(firstRotated))).limit(1);
    const [kept] = await getTestDb().select({ revokedAt: refreshTokenFamilies.revokedAt })
      .from(refreshTokenFamilies).where(eq(refreshTokenFamilies.familyId, familyOf(other))).limit(1);
    const [after] = await getTestDb().select({ authEpoch: users.authEpoch })
      .from(users).where(eq(users.id, user!.id)).limit(1);
    expect(ended?.revokedAt).toBeInstanceOf(Date);
    expect(kept?.revokedAt).toBeNull();
    expect(after?.authEpoch).toBe(user!.authEpoch);
  });
});
