/**
 * Integration test for the #915 audit-retention privilege-separation fix.
 *
 * Two things only a real Postgres can prove:
 *
 *   1. SECURE PATH — when AUDIT_ADMIN_DATABASE_URL points at a dedicated
 *      `breeze_audit_admin` login, `pruneExpiredAuditLogs` deletes expired
 *      rows end-to-end through that pool (no SET ROLE involved).
 *
 *   2. POST-REVOKE — after `REVOKE breeze_audit_admin FROM breeze_app`, a
 *      breeze_app connection can no longer `SET ROLE breeze_audit_admin`,
 *      so the legacy in-process bypass is dead. (The grant is restored in
 *      afterAll so other integration tests that exercise the legacy path
 *      keep working.)
 *
 * audit_logs is append-only: the trigger blocks DELETE/TRUNCATE. setup.ts
 * cleans it between tests via `session_replication_role = replica` + DELETE,
 * which is the same lever we'd use for manual cleanup here.
 */
import './setup';
import { describe, it, expect, beforeEach, afterAll, beforeAll } from 'vitest';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { getTestDb } from './setup';
import { createPartner, createOrganization } from './db-utils';
import { pruneExpiredAuditLogs } from '../../jobs/auditRetention';
import { closeAuditAdminPool, hasDedicatedAuditAdminPool } from '../../db/auditAdminPool';

// Derive the dedicated audit-admin URL from DATABASE_URL_APP (same host /
// port / db), swapping in the breeze_audit_admin role + a test password we
// set on the role below. Mirrors how an operator would build
// AUDIT_ADMIN_DATABASE_URL from their existing connection.
const APP_URL =
  process.env.DATABASE_URL_APP || 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
const AUDIT_ADMIN_PASSWORD = 'audit_admin_test_pw';

function buildAuditAdminUrl(): string {
  const u = new URL(APP_URL);
  u.username = 'breeze_audit_admin';
  u.password = AUDIT_ADMIN_PASSWORD;
  return u.toString();
}

const prevEnv = process.env.AUDIT_ADMIN_DATABASE_URL;

describe('#915 audit-retention privilege separation', () => {
  let orgId: string;

  beforeAll(async () => {
    // Make breeze_audit_admin a login role with a known password so the
    // dedicated pool can connect AS that role directly. Idempotent.
    await getTestDb().execute(sql`ALTER ROLE breeze_audit_admin WITH LOGIN`);
    await getTestDb().execute(
      sql.raw(`ALTER ROLE breeze_audit_admin PASSWORD '${AUDIT_ADMIN_PASSWORD}'`),
    );
  });

  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
  });

  afterAll(async () => {
    await closeAuditAdminPool();
    if (prevEnv === undefined) {
      delete process.env.AUDIT_ADMIN_DATABASE_URL;
    } else {
      process.env.AUDIT_ADMIN_DATABASE_URL = prevEnv;
    }
  });

  it('runs retention end-to-end through the dedicated audit-admin pool', async () => {
    process.env.AUDIT_ADMIN_DATABASE_URL = buildAuditAdminUrl();
    // Ensure the lazily-built pool picks up this URL fresh.
    await closeAuditAdminPool();
    expect(hasDedicatedAuditAdminPool()).toBe(true);

    await getTestDb().execute(sql`
      INSERT INTO audit_retention_policies (org_id, retention_days)
      VALUES (${orgId}, 30)
    `);
    await getTestDb().execute(sql`
      INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result, timestamp)
      VALUES (${orgId}, 'system', gen_random_uuid(), 'old.action', 'test', 'success', now() - interval '60 days')
    `);

    const stats = await pruneExpiredAuditLogs();
    expect(stats.errors).toBe(0);
    expect(stats.rowsDeleted).toBeGreaterThanOrEqual(1);

    const after = (await getTestDb().execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = ${orgId}`,
    )) as unknown as Array<{ n: number }>;
    expect(after[0]?.n).toBe(0);
  });

  it('after REVOKE, breeze_app can no longer SET ROLE breeze_audit_admin', async () => {
    // Open a short-lived breeze_app connection so we can prove the
    // privilege boundary directly, independent of the app pool.
    const appClient = postgres(APP_URL, { max: 1, idle_timeout: 5, connect_timeout: 10 });
    try {
      // Sanity: while the grant exists, SET ROLE succeeds.
      await appClient`SET ROLE breeze_audit_admin`;
      await appClient`RESET ROLE`;

      // Apply the #915 REVOKE (the documented manual follow-up).
      await getTestDb().execute(sql`REVOKE breeze_audit_admin FROM breeze_app`);

      // Reconnect: membership is checked at SET ROLE time; use a fresh
      // connection to avoid any cached session-role state.
      await appClient.end();
      const appClient2 = postgres(APP_URL, { max: 1, idle_timeout: 5, connect_timeout: 10 });
      try {
        let caught: unknown;
        try {
          await appClient2`SET ROLE breeze_audit_admin`;
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeDefined();
        expect((caught as { message?: string })?.message ?? '').toMatch(
          /permission denied|must be (?:a )?member/i,
        );
      } finally {
        await appClient2.end();
      }
    } finally {
      // Restore the grant so the legacy-path tests (audit-retention.integration)
      // and any other consumer keep working.
      await getTestDb().execute(sql`GRANT breeze_audit_admin TO breeze_app`);
      // appClient may already be ended above; guard.
      try {
        await appClient.end();
      } catch {
        /* already closed */
      }
    }
  });
});
