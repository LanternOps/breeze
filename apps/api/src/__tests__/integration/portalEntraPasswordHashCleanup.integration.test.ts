/**
 * Replays 2026-11-11-100000-portal-entra-users-clear-password-hash.sql against
 * seeded portal logins.
 *
 * A portal login provisioned through AI for Office carries
 * auth_method = 'entra' and signs in through Entra only. Every password path
 * (login, password reset, invite acceptance, password change, browser-session
 * hydration) requires auth_method = 'password', so a password_hash stored on an
 * 'entra' row is never read. Rows written before that rule may still hold one;
 * the migration clears exactly those hashes and leaves every password login,
 * and every other column, alone.
 *
 * CI databases are migrated schema-fresh in globalSetup, so the migration's
 * UPDATE otherwise only ever runs against zero rows. This suite seeds both
 * shapes and replays the file from disk as the unprivileged `breeze_app` login
 * role, where forced RLS applies.
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalEntraPasswordHashCleanup.integration.test.ts
 */
import './setup';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { portalUsers } from '../../db/schema';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION_FILE = join(
  __dirname,
  '../../../migrations/2026-11-11-100000-portal-entra-users-clear-password-hash.sql',
);

const SYSTEM_SCOPE_LINE = "PERFORM set_config('breeze.scope', 'system', true);";
const STALE_UPDATED_AT = new Date('2026-08-01T00:00:00Z');

function migrationText(): string {
  return readFileSync(MIGRATION_FILE, 'utf8');
}

/**
 * Runs `statements` in one transaction on a connection that LOGS IN as
 * `breeze_app` (not a SET ROLE from the superuser), and returns every
 * notice/warning the server sent, as `SEVERITY: message`.
 */
async function replayAsAppRole(statements: string): Promise<string[]> {
  const notices: string[] = [];
  const client = postgres(process.env.DATABASE_URL_APP!, {
    max: 1,
    onnotice: (notice) => {
      notices.push(`${notice.severity}: ${notice.message}`);
    },
  });
  try {
    await client.begin(async (tx) => {
      const [who] = await tx<{ current_user: string }[]>`SELECT current_user`;
      expect(who!.current_user).toBe('breeze_app');
      await tx.unsafe(statements);
    });
  } finally {
    await client.end();
  }
  return notices;
}

type Row = {
  id: string;
  password_hash: string | null;
  auth_method: string;
  auth_epoch: number;
  status: string;
  entra_oid: string | null;
  // Raw text so equality is exact; drizzle's raw execute does not map dates.
  updated_at: string;
};

async function snapshot(): Promise<Map<string, Row>> {
  const rows = await getTestDb().execute<Row>(sql`
    SELECT id, password_hash, auth_method, auth_epoch, status, entra_oid, updated_at::text AS updated_at
      FROM portal_users
     ORDER BY id
  `);
  return new Map(rows.map((row) => [row.id, { ...row }]));
}

/**
 * One row of every shape the predicate must separate:
 *   entraWithHash         — 'entra' login holding a hash      → cleared
 *   entraDisabledWithHash — same, administratively disabled    → cleared
 *   entraWithoutHash      — 'entra' login, no hash (normal)    → untouched
 *   passwordActive        — password login with its hash       → untouched
 *   passwordInvited       — password login awaiting setup      → untouched
 */
async function seed() {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const tenantId = randomUUID();

  const insert = async (values: Partial<typeof portalUsers.$inferInsert>) => {
    const [row] = await db
      .insert(portalUsers)
      .values({
        orgId: org.id,
        email: `${randomUUID()}@cleanup.test`,
        updatedAt: STALE_UPDATED_AT,
        ...values,
      })
      .returning({ id: portalUsers.id });
    return row!.id;
  };

  const entraWithHash = await insert({
    authMethod: 'entra',
    entraTenantId: tenantId,
    entraOid: randomUUID(),
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$fixture-entra$fixture',
    status: 'active',
    authEpoch: 3,
  });
  const entraDisabledWithHash = await insert({
    authMethod: 'entra',
    entraTenantId: tenantId,
    entraOid: randomUUID(),
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$fixture-disabled$fixture',
    status: 'disabled',
  });
  const entraWithoutHash = await insert({
    authMethod: 'entra',
    entraTenantId: tenantId,
    entraOid: randomUUID(),
    passwordHash: null,
    status: 'active',
  });
  const passwordActive = await insert({
    authMethod: 'password',
    passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$fixture-password$fixture',
    status: 'active',
    authEpoch: 2,
  });
  const passwordInvited = await insert({
    authMethod: 'password',
    passwordHash: null,
    status: 'invited',
  });

  return { entraWithHash, entraDisabledWithHash, entraWithoutHash, passwordActive, passwordInvited };
}

describe('portal_users: clear password_hash on auth_method = entra rows', () => {
  it('clears only the entra rows\' hash when replayed as the unprivileged breeze_app role', async () => {
    const db = getTestDb();
    const [role] = await db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'breeze_app'`,
    );
    // If breeze_app ever stops being RLS-bound this test proves nothing.
    expect(role, 'breeze_app role missing from the test database').toBeDefined();
    expect(role!.rolsuper).toBe(false);
    expect(role!.rolbypassrls).toBe(false);

    const ids = await seed();
    const before = await snapshot();

    const notices = await replayAsAppRole(migrationText());
    const after = await snapshot();

    for (const id of [ids.entraWithHash, ids.entraDisabledWithHash]) {
      const was = before.get(id)!;
      const now = after.get(id)!;
      expect(now.password_hash).toBeNull();
      // Nothing but the hash (and updated_at) moves: sign-in method, the
      // Entra identity, account status and the session generation stay.
      expect(now.auth_method).toBe('entra');
      expect(now.entra_oid).toBe(was.entra_oid);
      expect(now.status).toBe(was.status);
      expect(now.auth_epoch).toBe(was.auth_epoch);
      expect(now.updated_at).not.toBe(was.updated_at);
    }
    expect(after.get(ids.entraWithHash)!.auth_epoch).toBe(3);

    // Rows outside the predicate are byte-for-byte unchanged, updated_at too.
    for (const id of [ids.entraWithoutHash, ids.passwordActive, ids.passwordInvited]) {
      expect(after.get(id)).toEqual(before.get(id));
    }
    expect(after.get(ids.passwordActive)!.password_hash).toBe(
      '$argon2id$v=19$m=65536,t=3,p=4$fixture-password$fixture',
    );

    expect(notices).toContain(
      'WARNING: portal_users: cleared an unused password_hash on 2 auth_method=entra row(s)',
    );
  });

  it('is a no-op on re-run and reports a zero count', async () => {
    const ids = await seed();
    await replayAsAppRole(migrationText());
    const afterFirst = await snapshot();
    expect(afterFirst.get(ids.entraWithHash)!.password_hash).toBeNull();

    const notices = await replayAsAppRole(migrationText());
    const afterSecond = await snapshot();

    expect(afterSecond).toEqual(afterFirst);
    expect(notices).toContain(
      'NOTICE: portal_users: cleared an unused password_hash on 0 auth_method=entra row(s)',
    );
    expect(notices.some((n) => n.startsWith('WARNING:'))).toBe(false);
  });

  // The system-scope line is load-bearing and invisible to a superuser replay:
  // portal_users has forced RLS, so without it the UPDATE matches
  // zero rows as breeze_app, raises no error, and the migration records as
  // applied with every hash still in place.
  it('clears nothing as breeze_app once the system-scope line is removed', async () => {
    const ids = await seed();
    const text = migrationText();
    expect(text).toContain(SYSTEM_SCOPE_LINE);
    const withoutScope = text.replace(SYSTEM_SCOPE_LINE, '-- system scope removed for this negative control');

    const before = await snapshot();
    const notices = await replayAsAppRole(withoutScope);
    const after = await snapshot();

    expect(after).toEqual(before);
    expect(after.get(ids.entraWithHash)!.password_hash).not.toBeNull();
    expect(notices).toContain(
      'NOTICE: portal_users: cleared an unused password_hash on 0 auth_method=entra row(s)',
    );
  });
});
