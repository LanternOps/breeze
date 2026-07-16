/**
 * SR2-21 email-first partner registration — REAL DATABASE.
 *
 * Two properties can only be proven against real Postgres:
 *
 * 1. Step 1 (`POST /auth/register-partner`) creates NO tenant. The request
 *    parks a pending record in Redis and returns a fixed generic body; there is
 *    no user / partner / role / org row until the verification link is clicked.
 *
 * 2. The MFA-policy assurance at the auto-login mint. That mint now happens in
 *    step 2 (`POST /auth/verify-email`), after `createPartner` COMMITS its own
 *    transaction. The re-fetch of the partner/role rows therefore runs on a
 *    fresh system-context connection that SEES the committed rows — so the
 *    Task-2 fail-open (reading still-uncommitted signup rows on a second
 *    connection → policy always "not required" → vacuous `mfa: true`) cannot
 *    recur. A MOCKED resolver can never prove that: the whole point is "the
 *    resolver reads real committed rows at mint time". This file exercises the
 *    real resolver path against real Postgres, with the policy facts written by
 *    the real signup transaction.
 *
 * Constructing the required-policy condition:
 *   `partnerCreate.ts` seeds new "Partner Admin" roles with force_mfa = false.
 *   So these tests install a BEFORE INSERT trigger for the duration of one test
 *   to produce, explicitly, the row state a corrected seed would produce — a
 *   force_mfa admin role, or a partner whose security settings require MFA.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { getTestDb, getTestRedis } from './setup';

import './setup';

let app: Hono;
let createPendingRegistration: typeof import('../../services/pendingRegistration')['createPendingRegistration'];

interface MintedRegistration {
  status: number;
  body: any;
  accessClaims: Record<string, unknown>;
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('access token has no payload segment');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/** Seed the system "Partner Admin" role that `createPartner` copies permissions from. */
async function seedSystemPartnerAdminRole(): Promise<void> {
  const db = getTestDb();
  await db.execute(sql`
    INSERT INTO roles (partner_id, scope, name, description, is_system, force_mfa)
    VALUES (NULL, 'partner', 'Partner Admin', 'System partner admin', true, true)
  `);
}

async function installTrigger(name: string, body: string): Promise<void> {
  const db = getTestDb();
  await db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION ${name}_fn() RETURNS trigger AS $$
    BEGIN
      ${body}
      RETURN NEW;
    END $$ LANGUAGE plpgsql;
  `));
}

async function attachTrigger(name: string, table: string): Promise<void> {
  const db = getTestDb();
  await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON ${table}`));
  await db.execute(sql.raw(
    `CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}_fn()`,
  ));
}

async function dropTriggers(): Promise<void> {
  const db = getTestDb();
  await db.execute(sql.raw('DROP TRIGGER IF EXISTS breeze_test_role_force_mfa ON roles'));
  await db.execute(sql.raw('DROP TRIGGER IF EXISTS breeze_test_partner_require_mfa ON partners'));
}

function emailFor(companyName: string): string {
  return `admin@${companyName.toLowerCase().replace(/[^a-z0-9]/g, '')}.test`;
}

/** Step 1 as a real HTTP request — parks a pending record, creates no tenant. */
async function registerPartnerStep1(companyName: string) {
  return app.request('/auth/register-partner', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'integration-test/1.0' },
    body: JSON.stringify({
      companyName,
      email: emailFor(companyName),
      password: 'Sup3rSecure!Passw0rd',
      name: 'New Admin',
      acceptTerms: true,
    }),
  });
}

/**
 * Park a pending registration directly (step-1 attribution baked in) and then
 * drive step 2 (`/auth/verify-email`) — the ONLY registration mint site now.
 */
async function parkAndVerify(companyName: string): Promise<MintedRegistration> {
  const { rawToken } = await createPendingRegistration({
    email: emailFor(companyName),
    companyName,
    name: 'New Admin',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$dGVzdHNhbHR0ZXN0$Zm9vYmFyYmF6Zm9vYmFyYmF6Zm9vYmFyYmF6',
    acceptTerms: true,
    termsVersion: 'v1',
    hostedExpectation: true,
    signupIp: '203.0.113.7',
    signupUserAgent: 'integration-signup/1.0',
  });

  const res = await app.request('/auth/verify-email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'mail-scanner/9.9 (link-prefetch)' },
    body: JSON.stringify({ token: rawToken }),
  });
  const body = await res.json();
  return {
    status: res.status,
    body,
    accessClaims: res.status === 200 && body.tokens ? decodeJwtClaims(body.tokens.accessToken) : {},
  };
}

describe('SR2-21 email-first partner registration (real DB)', () => {
  beforeAll(async () => {
    // Module-level consts in routes/auth/schemas.ts must be set BEFORE the route
    // modules are first evaluated — hence dynamic import here.
    process.env.ENABLE_REGISTRATION = 'true';
    process.env.ENABLE_2FA = 'true';
    process.env.IS_HOSTED = 'true';
    process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'true';

    // The step-2 hook dispatch calls getConfig(), which throws unless
    // validateConfig() ran at "startup" — do it here (throwaway key material).
    process.env.APP_ENCRYPTION_KEY ||= 'integration-test-app-encryption-key-not-a-real-secret';
    process.env.MFA_ENCRYPTION_KEY ||= 'integration-test-mfa-encryption-key-not-a-real-secret';
    const { validateConfig } = await import('../../config/validate');
    validateConfig();

    ({ createPendingRegistration } = await import('../../services/pendingRegistration'));
    const { registerRoutes } = await import('../../routes/auth/register');
    const { verifyEmailRoutes } = await import('../../routes/auth/verifyEmail');
    app = new Hono();
    app.route('/auth', registerRoutes);
    app.route('/auth', verifyEmailRoutes);
  });

  beforeEach(async () => {
    await dropTriggers();
    await seedSystemPartnerAdminRole();
    // register-partner is rate-limited 3/hour and verify-email 10/300 per client
    // fingerprint; every test posts from the same fingerprint.
    await getTestRedis().flushall();
  });

  afterEach(async () => {
    await dropTriggers();
  });

  it('step 1 creates NO user and NO partner (email-first — nothing until the click)', async () => {
    const res = await registerPartnerStep1('NoTenantYetCo');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      message: 'If registration can proceed, you will receive next steps shortly.',
    });

    const db = getTestDb();
    const users = await db.execute(sql`SELECT COUNT(*)::int AS n FROM users`);
    const partners = await db.execute(sql`SELECT COUNT(*)::int AS n FROM partners`);
    expect(users[0]?.n).toBe(0);
    expect(partners[0]?.n).toBe(0);
  });

  it('step 2 creates the partner and stamps email_verified_at (the click proves the address)', async () => {
    const { status, body } = await parkAndVerify('VerifiedCo');
    expect(status).toBe(200);
    expect(body.verified).toBe(true);
    expect(body.partner?.id).toBeTruthy();

    const db = getTestDb();
    const rows = await db.execute(sql`
      SELECT u.email_verified_at AS u_verified, p.email_verified_at AS p_verified
      FROM users u JOIN partners p ON p.id = ${body.partner.id}
      WHERE u.id = ${body.user.id}
    `);
    expect(rows[0]?.u_verified).not.toBeNull();
    expect(rows[0]?.p_verified).not.toBeNull();
  });

  it('does NOT mint mfa=true when the new admin role forces MFA (role axis)', async () => {
    await installTrigger(
      'breeze_test_role_force_mfa',
      `IF NEW.scope::text = 'partner' AND NEW.name = 'Partner Admin' THEN NEW.force_mfa := true; END IF;`,
    );
    await attachTrigger('breeze_test_role_force_mfa', 'roles');

    const { status, body, accessClaims } = await parkAndVerify('ForceMfaCo');
    expect(status).toBe(200);

    const db = getTestDb();
    const forced = await db.execute(sql`
      SELECT r.force_mfa FROM roles r
      JOIN partners p ON p.id = r.partner_id
      WHERE p.id = ${body.partner.id} AND r.name = 'Partner Admin'
    `);
    expect(forced[0]?.force_mfa).toBe(true);

    // The user holds NO factor and policy REQUIRES one → no MFA claim, and the
    // response must push them into enrollment.
    expect(body.user.mfaEnabled).toBe(false);
    expect(accessClaims.mfa).toBe(false);
    expect(body.mfaEnrollmentRequired).toBe(true);
    expect(body.enrollUrl).toBe('/auth/mfa/setup');
  });

  it('does NOT mint mfa=true when the new partner settings require MFA (settings axis)', async () => {
    await installTrigger(
      'breeze_test_partner_require_mfa',
      `NEW.settings := COALESCE(NEW.settings, '{}'::jsonb) || '{"security":{"requireMfa":true}}'::jsonb;`,
    );
    await attachTrigger('breeze_test_partner_require_mfa', 'partners');

    const { status, body, accessClaims } = await parkAndVerify('RequireMfaCo');
    expect(status).toBe(200);

    const db = getTestDb();
    const rows = await db.execute(sql`
      SELECT settings -> 'security' ->> 'requireMfa' AS require_mfa
      FROM partners WHERE id = ${body.partner.id}
    `);
    expect(rows[0]?.require_mfa).toBe('true');

    expect(accessClaims.mfa).toBe(false);
    expect(body.mfaEnrollmentRequired).toBe(true);
  });

  it('still mints mfa=true when nothing requires MFA (control — proves the assertions above are not vacuous)', async () => {
    const { status, accessClaims, body } = await parkAndVerify('NoPolicyCo');
    expect(status).toBe(200);
    expect(accessClaims.mfa).toBe(true);
    expect(body.mfaEnrollmentRequired).toBe(false);
  });

  it('a second click on the same token is a no-op — one winner, generic 400 on the loser', async () => {
    const { rawToken } = await createPendingRegistration({
      email: emailFor('SingleWinnerCo'),
      companyName: 'SingleWinnerCo',
      name: 'New Admin',
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$dGVzdHNhbHR0ZXN0$Zm9vYmFyYmF6Zm9vYmFyYmF6Zm9vYmFyYmF6',
      acceptTerms: true,
      termsVersion: 'v1',
      hostedExpectation: true,
      signupIp: '203.0.113.7',
      signupUserAgent: 'integration-signup/1.0',
    });

    const first = await app.request('/auth/verify-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: rawToken }),
    });
    expect(first.status).toBe(200);

    const second = await app.request('/auth/verify-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: rawToken }),
    });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: 'Invalid or expired verification link' });

    // Exactly one partner was created.
    const db = getTestDb();
    const rows = await db.execute(sql`SELECT COUNT(*)::int AS n FROM partners`);
    expect(rows[0]?.n).toBe(1);
  });
});
