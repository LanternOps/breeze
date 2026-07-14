/**
 * /register-partner MFA-policy assurance — REAL DATABASE.
 *
 * Why this must be a real-DB test (and why the mocked sibling in
 * `routes/auth/register.test.ts` is not enough):
 *
 * /register-partner auto-logs the brand-new admin in. The mint must not claim
 * `mfa: true` for a user who holds no factor when the effective policy REQUIRES
 * MFA. The first attempt at that fix called `getEffectiveMfaPolicy()` at the
 * mint — and was completely INERT, failing OPEN:
 *
 *   - the whole handler runs inside `runWithSystemDbAccess`, which is an open
 *     `baseDb.transaction`;
 *   - `createPartner` writes the partner / role / user / partner_users rows
 *     into that same still-UNCOMMITTED transaction;
 *   - `getEffectiveMfaPolicy` exits the ALS context (`runOutsideDbContext`) and
 *     opens a NEW transaction on a SECOND pooled connection, which under READ
 *     COMMITTED cannot see any of those rows.
 *
 * So the role join came back empty (roleForceMfa=false), the partner row read
 * as absent (settingsRequireMfa=false), nothing threw — `policy.required` was
 * ALWAYS false and `mfa: true` was still a constant. A MOCKED resolver returns
 * whatever the test says, so no mocked test can ever see that: the bug is
 * exactly "the resolver was asked, on a connection that could not see the
 * rows". That is what this file exercises — the real resolver path against real
 * Postgres, with the policy facts written by the real signup transaction.
 *
 * Constructing the required-policy condition:
 *   `partnerCreate.ts` seeds new "Partner Admin" roles with force_mfa = false,
 *   even though 2026-05-25-f's own comment says system "Partner Admin" roles
 *   SHOULD force MFA. That latent seeding gap (a separate issue — deliberately
 *   NOT fixed here) is the only reason the hole isn't exploitable today. So
 *   these tests install a BEFORE INSERT trigger for the duration of one test to
 *   produce, explicitly, the row state the corrected seed would produce — a
 *   force_mfa admin role, or a partner whose security settings require MFA.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { getTestDb, getTestRedis } from './setup';

import './setup';

let app: Hono;

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

/**
 * Install a BEFORE INSERT trigger for the duration of one test, so the rows the
 * signup transaction creates carry the policy facts under test. This is the
 * only way to make a BRAND-NEW partner's own role/settings require MFA: every
 * one of those rows is created inside the request itself.
 */
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

async function registerPartner(companyName: string): Promise<MintedRegistration> {
  const res = await app.request('/auth/register-partner', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'integration-test/1.0' },
    body: JSON.stringify({
      companyName,
      email: `admin@${companyName.toLowerCase().replace(/[^a-z0-9]/g, '')}.test`,
      password: 'Sup3rSecure!Passw0rd',
      name: 'New Admin',
      acceptTerms: true,
    }),
  });
  const body = await res.json();
  return {
    status: res.status,
    body,
    accessClaims: res.status === 200 ? decodeJwtClaims(body.tokens.accessToken) : {},
  };
}

describe('POST /auth/register-partner — effective MFA policy at the auto-login mint (real DB)', () => {
  beforeAll(async () => {
    // ENABLE_REGISTRATION / ENABLE_2FA are module-level consts in
    // routes/auth/schemas.ts, so they must be set BEFORE the route module is
    // first evaluated — hence the dynamic import here rather than a top-level
    // one. IS_HOSTED skips the setup-admin gate (read per-request).
    process.env.ENABLE_REGISTRATION = 'true';
    process.env.ENABLE_2FA = 'true';
    process.env.IS_HOSTED = 'true';
    process.env.MFA_FORCE_FOR_PARTNER_ADMIN = 'true';

    // The handler's post-mint hook dispatch calls getConfig(), which throws
    // unless validateConfig() ran at "startup" — this test process has no
    // startup, so do it here. Without it the request 500s AFTER a successful
    // mint, which would mask the very claim under test. Throwaway key material,
    // required only to get validateConfig() past its schema.
    process.env.APP_ENCRYPTION_KEY ||= 'integration-test-app-encryption-key-not-a-real-secret';
    process.env.MFA_ENCRYPTION_KEY ||= 'integration-test-mfa-encryption-key-not-a-real-secret';
    const { validateConfig } = await import('../../config/validate');
    validateConfig();

    const { registerRoutes } = await import('../../routes/auth/register');
    app = new Hono();
    app.route('/auth', registerRoutes);
  });

  beforeEach(async () => {
    await dropTriggers();
    await seedSystemPartnerAdminRole();
    // Registration is rate-limited 3/hour per client fingerprint; every test in
    // this file posts from the same fingerprint.
    await getTestRedis().flushall();
  });

  afterEach(async () => {
    await dropTriggers();
  });

  it('does NOT mint mfa=true when the new admin role forces MFA (role axis)', async () => {
    await installTrigger(
      'breeze_test_role_force_mfa',
      `IF NEW.scope::text = 'partner' AND NEW.name = 'Partner Admin' THEN NEW.force_mfa := true; END IF;`,
    );
    await attachTrigger('breeze_test_role_force_mfa', 'roles');

    const { status, body, accessClaims } = await registerPartner('ForceMfaCo');
    expect(status).toBe(200);

    // The fixture really did fire — the partner's own admin role forces MFA.
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

    const { status, body, accessClaims } = await registerPartner('RequireMfaCo');
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
    const { status, body, accessClaims } = await registerPartner('NoPolicyCo');
    expect(status).toBe(200);
    expect(accessClaims.mfa).toBe(true);
    expect(body.mfaEnrollmentRequired).toBe(false);
  });
});
