/**
 * PR4 Task 11 — Real-DB atomicity + single-winner concurrency proofs for the
 * whole email-recovery / email-first-registration / async-forgot-password /
 * login-lockout epic (SR2-17 / SR2-21 / SR2-22 / SR2-23).
 *
 * These properties are un-provable against a mock: they are about what a REAL
 * Postgres transaction commits or rolls back as one unit, what a UNIQUE index
 * arbitrates under a genuine race, and what an out-of-request worker can see
 * through FORCE-RLS. Everything here runs against real Postgres + real Redis.
 *
 * PRIVATE DB (the shared :5433 rig is routinely contaminated by other worktrees
 * and its docker-compose.test.yml ships an UNSIZED tmpfs that fabricates 53100 /
 * spurious deadlocks). Stand up private containers with a SIZED tmpfs:
 *
 *   export PATH="$HOME/.nvm/versions/node/v22.20.0/bin:$PATH"
 *   docker rm -f pr4-pg pr4-redis 2>/dev/null || true
 *   docker run -d --name pr4-pg -e POSTGRES_USER=breeze -e POSTGRES_PASSWORD=breeze \
 *     -e POSTGRES_DB=breeze_test -p 5455:5432 \
 *     --tmpfs /var/lib/postgresql/data:rw,size=2g postgres:16-alpine
 *   docker run -d --name pr4-redis -p 6399:6379 redis:7-alpine
 *   until docker exec pr4-pg pg_isready -U breeze >/dev/null 2>&1; do sleep 1; done
 *
 *   cd apps/api && \
 *   DATABASE_URL=postgresql://breeze:breeze@localhost:5455/breeze_test \
 *   DATABASE_URL_APP=postgresql://breeze_app:breeze_test@localhost:5455/breeze_test \
 *   BREEZE_APP_DB_PASSWORD=breeze_test REDIS_URL=redis://localhost:6399 NODE_ENV=test \
 *   pnpm vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/emailRecoveryRegistration.integration.test.ts
 *
 * The integration harness (globalSetup.ts) runs autoMigrate() — which creates
 * the unprivileged `breeze_app` RLS role — off DATABASE_URL/DATABASE_URL_APP.
 */
import './setup';

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { createHash } from 'crypto';

import { withSystemDbAccessContext } from '../../db';
import {
  users,
  emailVerificationTokens,
  refreshTokenFamilies,
  partners,
  organizations,
  sites,
} from '../../db/schema';
import { consumeVerificationToken, generateVerificationToken } from '../../services/emailVerification';
import { requestPendingEmailChange } from '../../services/pendingEmail';
import { mintRefreshTokenFamily } from '../../services/refreshTokenFamily';
import { createPendingRegistration } from '../../services/pendingRegistration';
import { handleAuthEmailJob } from '../../jobs/authEmailWorker';
import { recordAccountFailure } from '../../services/rate-limit';
import { createPartner, createUser } from './db-utils';
import { getTestDb, getTestRedis } from './setup';

// Only the email BOUNDARY is stubbed (no SMTP in CI); DB + Redis are real. The
// real module's other exports are preserved via importOriginal so nothing in
// the wider route graph loses a named export.
vi.mock('../../services/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/email')>();
  return {
    ...actual,
    getEmailService: () => ({
      sendPasswordReset: async () => {},
      sendVerificationEmail: async () => {},
      sendSignupAttemptOnExistingAccount: async () => {},
      sendEmailChanged: async () => {},
      sendAccountLocked: async () => {},
    }),
  };
});

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// requestPendingEmailChange runs in the CALLER's request context in production
// (PATCH /users/me establishes it). These suites drive the initiation under a
// system context to write the pending state past FORCE-RLS — a contextless call
// is silently filtered to 0 rows.
function initiate(userId: string, partnerId: string, newEmail: string) {
  return withSystemDbAccessContext(() =>
    requestPendingEmailChange({ userId, partnerId, newEmail }),
  );
}

async function readUser(userId: string) {
  const [row] = await getTestDb()
    .select({
      email: users.email,
      pendingEmail: users.pendingEmail,
      pendingEmailRequestedAt: users.pendingEmailRequestedAt,
      emailEpoch: users.emailEpoch,
      authEpoch: users.authEpoch,
      emailVerifiedAt: users.emailVerifiedAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`user ${userId} not found`);
  return row;
}

async function tokenFor(userId: string) {
  const [row] = await getTestDb()
    .select({
      consumedAt: emailVerificationTokens.consumedAt,
      purpose: emailVerificationTokens.purpose,
      email: emailVerificationTokens.email,
      emailEpoch: emailVerificationTokens.emailEpoch,
    })
    .from(emailVerificationTokens)
    .where(eq(emailVerificationTokens.userId, userId))
    .limit(1);
  return row;
}

async function familyRow(familyId: string) {
  const [row] = await getTestDb()
    .select({ revokedAt: refreshTokenFamilies.revokedAt, reason: refreshTokenFamilies.revokedReason })
    .from(refreshTokenFamilies)
    .where(eq(refreshTokenFamilies.familyId, familyId))
    .limit(1);
  return row;
}

async function resetEpoch(userId: string): Promise<number> {
  const [row] = await getTestDb()
    .select({ passwordResetEpoch: users.passwordResetEpoch })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`user ${userId} not found`);
  return row.passwordResetEpoch;
}

describe('SR2-17 pending email — real Postgres', () => {
  it('initiation writes pending_email and advances email_epoch, and users.email is UNCHANGED', async () => {
    const partner = await createPartner();
    const oldEmail = `pe-old-${uniq()}@example.com`;
    const user = await createUser({ partnerId: partner.id, email: oldEmail, withMembership: true });

    const before = await readUser(user.id);
    const newEmail = `pe-new-${uniq()}@example.com`;
    await initiate(user.id, partner.id, newEmail);

    const after = await readUser(user.id);
    // pending recorded; email_epoch advanced by exactly one at initiation.
    expect(after.pendingEmail).toBe(newEmail);
    expect(after.emailEpoch).toBe(before.emailEpoch + 1);
    // The VERIFIED address is authoritative until the commit — it has NOT moved,
    // and auth_epoch has NOT advanced (the user keeps their live session to go
    // click the link).
    expect(after.email).toBe(oldEmail);
    expect(after.authEpoch).toBe(before.authEpoch);

    // The minted token proves the PENDING address at the NEW generation.
    const tok = await tokenFor(user.id);
    expect(tok?.purpose).toBe('email_change');
    expect(tok?.email).toBe(newEmail);
    expect(tok?.emailEpoch).toBe(after.emailEpoch);
  });

  it('commit swaps the address, clears pending, advances auth_epoch + email_epoch, and revokes every family — atomically', async () => {
    const partner = await createPartner();
    const oldEmail = `cm-old-${uniq()}@example.com`;
    const user = await createUser({ partnerId: partner.id, email: oldEmail, withMembership: true });

    // TWO families — prove "revokes EVERY family", not just one.
    const famA = await mintRefreshTokenFamily(user.id);
    const famB = await mintRefreshTokenFamily(user.id);
    const before = await readUser(user.id);

    const newEmail = `cm-new-${uniq()}@example.com`;
    const { rawToken } = await initiate(user.id, partner.id, newEmail);

    const result = await consumeVerificationToken(rawToken);
    expect(result).toMatchObject({
      ok: true,
      purpose: 'email_change',
      email: newEmail,
      previousEmail: oldEmail,
    });

    const after = await readUser(user.id);
    expect(after.email).toBe(newEmail);
    expect(after.pendingEmail).toBeNull();
    expect(after.pendingEmailRequestedAt).toBeNull();
    expect(after.emailVerifiedAt).not.toBeNull();
    // email advanced twice (request + commit); auth once (the deferred sign-out).
    expect(after.emailEpoch).toBe(before.emailEpoch + 2);
    expect(after.authEpoch).toBe(before.authEpoch + 1);

    for (const fam of [famA, famB]) {
      const row = await familyRow(fam);
      expect(row?.revokedAt).not.toBeNull();
      expect(row?.reason).toBe('email-change-committed');
    }

    expect((await tokenFor(user.id))?.consumedAt).not.toBeNull();
  });

  it('a commit that throws mid-transaction leaves NOTHING applied (no swap, no epoch bump, no revoked family)', async () => {
    const partner = await createPartner();
    // A DETERMINISTIC mid-transaction failure: a second account already OWNS the
    // target address, so the swap UPDATE raises 23505 (users_email_unique) and
    // the whole db.transaction — token claim + swap + epoch advance + family
    // revoke — rolls back as one unit.
    const taken = `taken-${uniq()}@example.com`;
    await createUser({ partnerId: partner.id, email: taken, withMembership: true });

    const oldEmail = `mover-${uniq()}@example.com`;
    const mover = await createUser({ partnerId: partner.id, email: oldEmail, withMembership: true });
    const fam = await mintRefreshTokenFamily(mover.id);

    const { rawToken } = await initiate(mover.id, partner.id, taken);
    const before = await readUser(mover.id);

    const result = await consumeVerificationToken(rawToken);
    expect(result).toEqual({ ok: false, error: 'email_taken' });

    // NOTHING applied: address not swapped, pending not cleared, no epoch bump at
    // commit, no sign-out, token NOT consumed, family NOT revoked.
    const after = await readUser(mover.id);
    expect(after.email).toBe(oldEmail);
    expect(after.pendingEmail).toBe(taken);
    expect(after.emailEpoch).toBe(before.emailEpoch);
    expect(after.authEpoch).toBe(before.authEpoch);
    expect((await tokenFor(mover.id))?.consumedAt).toBeNull();
    expect((await familyRow(fam))?.revokedAt).toBeNull();
  });

  it('CONCURRENCY: two users with the SAME pending_email — exactly one commit wins; the loser gets email_taken and its token is NOT left consumed', async () => {
    const partner = await createPartner();
    const shared = `shared-${uniq()}@example.com`;
    const aOld = `race-a-${uniq()}@example.com`;
    const bOld = `race-b-${uniq()}@example.com`;
    const a = await createUser({ partnerId: partner.id, email: aOld, withMembership: true });
    const b = await createUser({ partnerId: partner.id, email: bOld, withMembership: true });

    const ra = await initiate(a.id, partner.id, shared);
    const rb = await initiate(b.id, partner.id, shared);

    // Actually RACE: fire both commits without awaiting the first. users_email_unique
    // is the single arbiter — exactly one INSERT of `shared` survives.
    const [resA, resB] = await Promise.all([
      consumeVerificationToken(ra.rawToken),
      consumeVerificationToken(rb.rawToken),
    ]);

    const results = [resA, resB];
    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toEqual({ ok: false, error: 'email_taken' });

    // Ground-truth by DB: exactly one of the two accounts now holds `shared`.
    const holders = await getTestDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, shared));
    expect(holders).toHaveLength(1);

    // THE Task-8 savepoint question, settled against real Postgres: the loser's
    // token-claim UPDATE ran INSIDE the same transaction as the swap, so the
    // 23505 rolled BOTH back together. Its token must still be unconsumed —
    // if postgres.js had committed the claim while only the swap rolled back,
    // this would be non-null and Task 8 would be wrong.
    const loserId = holders[0]!.id === a.id ? b.id : a.id;
    const loser = await readUser(loserId);
    expect(loser.email).toBe(loserId === a.id ? aOld : bOld); // email NOT moved
    expect(loser.pendingEmail).toBe(shared); // pending NOT cleared
    expect((await tokenFor(loserId))?.consumedAt).toBeNull(); // token NOT consumed
  });

  it('CONCURRENCY: two clicks on the same email_change token — exactly one wins', async () => {
    const partner = await createPartner();
    const user = await createUser({
      partnerId: partner.id,
      email: `dbl-${uniq()}@example.com`,
      withMembership: true,
    });
    const newEmail = `dbl-new-${uniq()}@example.com`;
    const { rawToken } = await initiate(user.id, partner.id, newEmail);

    // Same raw token, fired twice concurrently — the single-claim guard
    // (consumed_at IS NULL) + FOR UPDATE serialize them to one winner.
    const [r1, r2] = await Promise.all([
      consumeVerificationToken(rawToken),
      consumeVerificationToken(rawToken),
    ]);

    const results = [r1, r2];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect((await readUser(user.id)).email).toBe(newEmail);
  });

  it('a stale link issued for the OLD address cannot verify the NEW one (email_epoch moved)', async () => {
    const partner = await createPartner();
    const oldEmail = `stale-old-${uniq()}@example.com`;
    const user = await createUser({ partnerId: partner.id, email: oldEmail, withMembership: true });

    // A signup-style verification token issued for the OLD address at the live
    // generation, BEFORE any change.
    const staleRaw = await generateVerificationToken({
      partnerId: partner.id,
      userId: user.id,
      email: oldEmail,
      purpose: 'signup',
    });

    // Commit an email change old -> new. This advances email_epoch and moves the
    // authoritative address.
    const newEmail = `stale-new-${uniq()}@example.com`;
    const { rawToken } = await initiate(user.id, partner.id, newEmail);
    // initiate() supersedes open tokens (incl. the stale signup token). Consume
    // the change token to actually MOVE the address + advance the epoch.
    expect((await consumeVerificationToken(rawToken)).ok).toBe(true);
    expect((await readUser(user.id)).email).toBe(newEmail);

    // The stale OLD-address link cannot now verify the NEW address: its email +
    // epoch no longer match the live row. Fails closed; the address is NOT
    // resurrected and email_verified stays on the new address.
    const staleResult = await consumeVerificationToken(staleRaw);
    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok) {
      expect(['address_changed', 'superseded']).toContain(staleResult.error);
    }
    expect((await readUser(user.id)).email).toBe(newEmail);
  });

  it('after commit, /auth/login with the OLD address fails and with the NEW address succeeds', async () => {
    const partner = await createPartner();
    const oldEmail = `login-old-${uniq()}@example.com`;
    const password = 'Sup3rSecure!Passw0rd';
    const user = await createUser({
      partnerId: partner.id,
      email: oldEmail,
      password,
      status: 'active',
      withMembership: true,
    });

    const newEmail = `login-new-${uniq()}@example.com`;
    const { rawToken } = await initiate(user.id, partner.id, newEmail);
    expect((await consumeVerificationToken(rawToken)).ok).toBe(true);

    // OLD address is no longer an account -> generic 401.
    const oldRes = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: oldEmail, password }),
    });
    expect(oldRes.status).toBe(401);

    // NEW address is the live account -> success with tokens.
    const newRes = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: newEmail, password }),
    });
    expect(newRes.status).toBe(200);
    const body = await newRes.json();
    expect(body.tokens?.accessToken).toBeTruthy();
    expect(body.user?.email).toBe(newEmail);
  });

  it('a pending (unverified) address does NOT authenticate: users.email lookup returns no row for it', async () => {
    const partner = await createPartner();
    const oldEmail = `unv-old-${uniq()}@example.com`;
    const password = 'Sup3rSecure!Passw0rd';
    const user = await createUser({
      partnerId: partner.id,
      email: oldEmail,
      password,
      status: 'active',
      withMembership: true,
    });

    const pendingAddr = `unv-pending-${uniq()}@example.com`;
    await initiate(user.id, partner.id, pendingAddr);

    // The pending (unverified) address is NOT in users.email — every auth path
    // keys on users.email, so nothing can resolve this account by it.
    const byPending = await getTestDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, pendingAddr));
    expect(byPending).toHaveLength(0);
    // The live verified address is unchanged.
    expect((await readUser(user.id)).email).toBe(oldEmail);

    // And login with the pending address is a generic 401.
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: pendingAddr, password }),
    });
    expect(res.status).toBe(401);
  });
});

describe('SR2-21 pending registration — real Postgres + real Redis', () => {
  // Deterministic step-1 attribution baked into the parked record.
  const STEP1_IP = '203.0.113.7';
  const STEP1_UA = 'integration-signup/1.0';
  const CLICK_UA = 'mail-scanner/9.9 (link-prefetch)';

  function park(companyName: string, email: string) {
    return createPendingRegistration({
      email,
      companyName,
      name: 'New Admin',
      passwordHash:
        '$argon2id$v=19$m=65536,t=3,p=4$dGVzdHNhbHR0ZXN0$Zm9vYmFyYmF6Zm9vYmFyYmF6Zm9vYmFyYmF6',
      acceptTerms: true,
      termsVersion: 'v1',
      hostedExpectation: true,
      signupIp: STEP1_IP,
      signupUserAgent: STEP1_UA,
    });
  }

  function verify(token: string, userAgent = CLICK_UA) {
    return app.request('/auth/verify-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': userAgent },
      body: JSON.stringify({ token }),
    });
  }

  // Per-test SCOPED counters — never global COUNT(*) (which false-reds under any
  // cross-test contamination). Task-9's step-1 assertion used global counts;
  // these are pinned to this test's own markers.
  async function countUsersByEmail(email: string): Promise<number> {
    const [r] = await getTestDb().execute(
      sql`SELECT COUNT(*)::int AS n FROM users WHERE email = ${email}`,
    );
    return (r as { n: number }).n;
  }
  async function countPartnersByName(name: string): Promise<number> {
    const [r] = await getTestDb().execute(
      sql`SELECT COUNT(*)::int AS n FROM partners WHERE name = ${name}`,
    );
    return (r as { n: number }).n;
  }
  async function countOrgsForPartnerName(name: string): Promise<number> {
    const [r] = await getTestDb().execute(sql`
      SELECT COUNT(*)::int AS n FROM organizations
      WHERE partner_id IN (SELECT id FROM partners WHERE name = ${name})
    `);
    return (r as { n: number }).n;
  }
  async function countSitesForPartnerName(name: string): Promise<number> {
    const [r] = await getTestDb().execute(sql`
      SELECT COUNT(*)::int AS n FROM sites
      WHERE org_id IN (
        SELECT o.id FROM organizations o
        JOIN partners p ON p.id = o.partner_id
        WHERE p.name = ${name}
      )
    `);
    return (r as { n: number }).n;
  }

  it('step 1 creates NO rows in users, partners, organizations or sites', async () => {
    const marker = uniq();
    const companyName = `Step1Co-${marker}`;
    const email = `step1-${marker}@example.com`;

    const res = await app.request('/auth/register-partner', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'integration-test/1.0' },
      body: JSON.stringify({
        companyName,
        email,
        password: 'Sup3rSecure!Passw0rd',
        name: 'New Admin',
        acceptTerms: true,
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      message: 'If registration can proceed, you will receive next steps shortly.',
    });

    // SCOPED to this test's markers — nothing was created.
    expect(await countUsersByEmail(email)).toBe(0);
    expect(await countPartnersByName(companyName)).toBe(0);
    expect(await countOrgsForPartnerName(companyName)).toBe(0);
    expect(await countSitesForPartnerName(companyName)).toBe(0);
  });

  it('step 2 creates the tenant and stamps partners.signup_ip / user_agent with the STEP-1 values, not the click values', async () => {
    const marker = uniq();
    const companyName = `Step2Co-${marker}`;
    const email = `step2-${marker}@example.com`;

    const { rawToken } = await park(companyName, email);
    const res = await verify(rawToken); // click carries CLICK_UA
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.verified).toBe(true);
    expect(body.partner?.id).toBeTruthy();

    // The tenant now exists (scoped) and the abuse attribution is the STEP-1
    // request's IP/UA — never the verification click's (a mail scanner).
    expect(await countPartnersByName(companyName)).toBe(1);
    const [row] = await getTestDb().execute(sql`
      SELECT signup_ip, signup_user_agent FROM partners WHERE id = ${body.partner.id}
    `);
    expect((row as { signup_ip: string }).signup_ip).toBe(STEP1_IP);
    expect((row as { signup_user_agent: string }).signup_user_agent).toBe(STEP1_UA);
    expect((row as { signup_user_agent: string }).signup_user_agent).not.toBe(CLICK_UA);
  });

  it('CONCURRENCY: two clicks on the same pending-registration token — exactly one partner is created', async () => {
    const marker = uniq();
    const companyName = `RaceRegCo-${marker}`;
    const email = `racereg-${marker}@example.com`;
    const { rawToken } = await park(companyName, email);

    // Actually RACE the two clicks — consumePendingRegistration is a single-winner
    // GETDEL, so exactly one click builds the tenant.
    const [r1, r2] = await Promise.all([verify(rawToken), verify(rawToken)]);
    const statuses = [r1.status, r2.status].sort();
    // One 200 (created), one 400 (loser fell through to an invalid token).
    expect(statuses).toEqual([200, 400]);

    // Exactly ONE partner for this company — scoped, not a global count.
    expect(await countPartnersByName(companyName)).toBe(1);
    expect(await countUsersByEmail(email)).toBe(1);
  });

  it('an address registered between step 1 and step 2 yields sign_in and creates no duplicate tenant', async () => {
    const marker = uniq();
    const pendingCompany = `PendingCo-${marker}`;
    const email = `between-${marker}@example.com`;

    // Park the pending registration for `email`...
    const { rawToken } = await park(pendingCompany, email);

    // ...then the address gets registered by some OTHER flow before the click
    // (a different partner + user holding the same address).
    const otherPartner = await createPartner({ name: `OtherCo-${marker}` });
    await createUser({ partnerId: otherPartner.id, email, withMembership: true });

    const res = await verify(rawToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ verified: false, status: 'sign_in' });

    // No DUPLICATE tenant: the pending company was never created, and the address
    // still resolves to exactly the one pre-existing account.
    expect(await countPartnersByName(pendingCompany)).toBe(0);
    expect(await countUsersByEmail(email)).toBe(1);
  });
});

describe('SR2-22 forgot-password — real Postgres', () => {
  it('the REQUEST advances no epoch and writes no reset key; the WORKER does both', async () => {
    const partner = await createPartner({ status: 'active' });
    const email = `fp-${uniq()}@example.com`;
    const user = await createUser({ partnerId: partner.id, status: 'active', email, withMembership: true });

    const epochBefore = await resetEpoch(user.id);

    // THE REQUEST: does no conditional work — it enqueues an opaque job and
    // returns a fixed body. No epoch advance, no reset:<hash> envelope.
    const res = await app.request('/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      message: 'If this email exists, a reset link will be sent.',
    });
    expect(await resetEpoch(user.id)).toBe(epochBefore);
    expect(await getTestRedis().keys('reset:*')).toHaveLength(0);

    // THE WORKER (out of the observable path) does BOTH: advances the generation
    // and writes exactly one generation-bound reset envelope.
    await handleAuthEmailJob({ kind: 'password-reset', email });

    expect(await resetEpoch(user.id)).toBe(epochBefore + 1);
    const keys = await getTestRedis().keys('reset:*');
    expect(keys).toHaveLength(1);
    const envelope = JSON.parse((await getTestRedis().get(keys[0]!)) as string);
    expect(envelope).toEqual({
      userId: user.id,
      passwordResetEpoch: epochBefore + 1,
      email,
    });
  });

  it('an unknown address leaves password_reset_epoch untouched everywhere', async () => {
    // A bystander whose generation must not move.
    const partner = await createPartner({ status: 'active' });
    const bystander = await createUser({
      partnerId: partner.id,
      status: 'active',
      email: `bystander-${uniq()}@example.com`,
      withMembership: true,
    });
    const epochBefore = await resetEpoch(bystander.id);

    // Unknown address, through both the request AND the worker — neither may
    // touch any generation, and the worker must not throw.
    const unknown = `nobody-${uniq()}@nowhere.test`;
    const res = await app.request('/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: unknown }),
    });
    expect(res.status).toBe(200);
    await expect(handleAuthEmailJob({ kind: 'password-reset', email: unknown })).resolves.toBeUndefined();

    expect(await resetEpoch(bystander.id)).toBe(epochBefore);
    expect(await getTestRedis().keys('reset:*')).toHaveLength(0);
  });
});

describe('SR2-23 login lockout — real Postgres', () => {
  it('a locked account and an unknown account return identical status AND body', async () => {
    const partner = await createPartner({ status: 'active' });
    const email = `locked-${uniq()}@example.com`;
    const password = 'Sup3rSecure!Passw0rd';
    const user = await createUser({
      partnerId: partner.id,
      status: 'active',
      email,
      password,
      withMembership: true,
    });
    void user;

    // Lock the account by tripping the per-account failure counter over the
    // threshold (default 5). Uses the SAME Redis the login route reads.
    const redis = getTestRedis();
    let locked = false;
    for (let i = 0; i < 6 && !locked; i++) {
      const r = await recordAccountFailure(redis, email);
      locked = r.locked;
    }
    expect(locked).toBe(true);

    // A LOCKED account (correct password, but denied) and an UNKNOWN account must
    // be indistinguishable: same status AND same body.
    const lockedRes = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const unknownRes = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `ghost-${uniq()}@nowhere.test`, password }),
    });

    expect(lockedRes.status).toBe(401);
    expect(unknownRes.status).toBe(lockedRes.status);
    expect(await lockedRes.json()).toEqual(await unknownRes.json());
  });
});

// ---------------------------------------------------------------------------
// App bootstrap. routes/auth/schemas.ts freezes ENABLE_REGISTRATION / ENABLE_2FA
// as module-eval consts, so the env must be set BEFORE the route modules are
// first imported — hence dynamic import in beforeAll (the registerPartnerMfaPolicy
// pattern). getConfig() (hit by the step-2 registration hook) throws unless
// validateConfig() ran at "startup", so run it here with throwaway key material.
// ---------------------------------------------------------------------------
let app: Hono;

beforeAll(async () => {
  process.env.ENABLE_REGISTRATION = 'true';
  process.env.ENABLE_2FA = 'true';
  process.env.IS_HOSTED = 'true';
  process.env.APP_ENCRYPTION_KEY ||= 'integration-test-app-encryption-key-not-a-real-secret';
  process.env.MFA_ENCRYPTION_KEY ||= 'integration-test-mfa-encryption-key-not-a-real-secret';

  const { validateConfig } = await import('../../config/validate');
  validateConfig();

  const { Hono: HonoCtor } = await import('hono');
  const { authRoutes } = await import('../../routes/auth');
  app = new HonoCtor();
  app.route('/auth', authRoutes);
});

beforeEach(async () => {
  // createPartner copies its admin permissions from the system "Partner Admin"
  // role; the step-2 registration path needs it to exist. cleanupDatabase()
  // (global beforeEach) truncates roles, so re-seed each test. Redis is flushed
  // by cleanupDatabase() too, resetting all rate-limit + lockout + reset keys.
  await getTestDb().execute(sql`
    INSERT INTO roles (partner_id, scope, name, description, is_system, force_mfa)
    VALUES (NULL, 'partner', 'Partner Admin', 'System partner admin', true, false)
  `);
});
