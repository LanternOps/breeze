/**
 * #11929: after a database-only dump/restore into a new Postgres cluster,
 * breeze_app is no longer a member of breeze_audit_admin (role memberships are
 * cluster-level), so permanent device delete failed with 42501 on
 * `SET LOCAL ROLE breeze_audit_admin` and nothing at boot put it back.
 *
 * Proves, on real Postgres:
 *  - the failure itself (CONTROL), and that ensureClusterRoles() repairs it;
 *  - a deliberate revoke is left alone when AUDIT_ADMIN_DATABASE_URL is set;
 *  - with that URL set, org erasure and AI-ledger retention use the dedicated
 *    connection and work with the membership revoked, while permanent device
 *    delete stays in the caller's transaction (no evidence destroyed by a
 *    delete that is refused later);
 *  - object privileges a role-less restore drops are re-granted;
 *  - a migration role that is NOT a superuser gets a warning, never a throw,
 *    and a managed-Postgres-shaped one (CREATEROLE + ADMIN OPTION) repairs it.
 *
 * The request pool here is breeze_app (DATABASE_URL_APP), a non-superuser, so
 * the privilege errors are real rather than hidden by a superuser connection.
 */
import './setup';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { db, getRequestDatabaseRole, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { closeAuditAdminPool } from '../../db/auditAdminPool';
import {
  AUDIT_ADMIN_FUNCTION_PRIVILEGES,
  AUDIT_ADMIN_TABLE_PRIVILEGES,
  ensureClusterRoles,
} from '../../db/ensureClusterRoles';
import { deleteDeviceCascade, type DeviceDeletionTx } from '../../services/deviceDeletion';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { pruneAiInvocations } from '../../jobs/aiInvocationRetention';
import { pgErrorCode } from '../../utils/pgErrors';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';

const ADMIN_URL = process.env.DATABASE_URL ?? '';
const APP_URL = process.env.DATABASE_URL_APP ?? '';
const AUDIT_ADMIN_PASSWORD = 'audit_admin_11929_pw';
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

function urlAs(base: string, user: string, password: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  return u.toString();
}

async function adminExec(statement: string): Promise<void> {
  await getTestDb().execute(sql.raw(statement));
}

async function isAppMember(): Promise<boolean> {
  const rows = (await getTestDb().execute(
    sql`SELECT pg_has_role('breeze_app', 'breeze_audit_admin', 'MEMBER') AS m`,
  )) as unknown as Array<{ m: boolean }>;
  return Boolean(rows[0]?.m);
}

async function seedDeviceWithEvidence(): Promise<{ orgId: string; deviceId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const rows = (await getTestDb().execute(sql`
    WITH s AS (INSERT INTO sites (org_id, name) VALUES (${org.id}, ${`site-${randomUUID()}`}) RETURNING id)
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status)
    SELECT ${org.id}, id, ${`agent-${randomUUID()}`}, ${`host-${randomUUID().slice(0, 8)}`},
           'windows', '11', 'x64', '1.0.0', 'decommissioned'
    FROM s RETURNING id
  `)) as unknown as Array<{ id: string }>;
  const deviceId = rows[0]!.id;
  // An append-only row breeze_app may not delete (DEVICE_CASCADE_AUDIT_ADMIN_TABLES).
  await getTestDb().execute(sql`
    INSERT INTO peripheral_policy_delivery_events (
      org_id, device_id, command_id, event_kind, phase, revision, digest, outcome, evidence, occurred_at
    ) VALUES (
      ${org.id}, ${deviceId}, ${randomUUID()}, 'requested', 'clear_legacy', 1,
      ${`sha256:${'1'.repeat(64)}`}, NULL, '{}'::jsonb, now()
    )
  `);
  return { orgId: org.id, deviceId };
}

function permanentlyDelete(deviceId: string): Promise<void> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() =>
    db.transaction(async (tx) => {
      await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, deviceId);
    })));
}

async function evidenceCount(deviceId: string): Promise<number> {
  const rows = (await getTestDb().execute(sql`
    SELECT (SELECT count(*) FROM peripheral_policy_delivery_events WHERE device_id = ${deviceId})
         + (SELECT count(*) FROM devices WHERE id = ${deviceId}) AS n
  `)) as unknown as Array<{ n: string | number }>;
  return Number(rows[0]?.n);
}

async function withClient<T>(url: string, fn: (client: postgres.Sql) => Promise<T>): Promise<T> {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await fn(client);
  } finally {
    await client.end({ timeout: 5 });
  }
}

const prevAuditUrl = process.env.AUDIT_ADMIN_DATABASE_URL;

// Never leave the shared test database without the membership other suites
// rely on, whatever a test (or a killed earlier run) did to it.
beforeAll(async () => {
  await adminExec('GRANT breeze_audit_admin TO breeze_app');
});

afterEach(async () => {
  if (prevAuditUrl === undefined) delete process.env.AUDIT_ADMIN_DATABASE_URL;
  else process.env.AUDIT_ADMIN_DATABASE_URL = prevAuditUrl;
  try {
    await closeAuditAdminPool();
  } finally {
    await adminExec('GRANT breeze_audit_admin TO breeze_app');
  }
});

describe('#11929 breeze_app membership lost by a database-only restore', () => {
  it('CONTROL: without the membership, permanent delete fails with 42501', async () => {
    const { deviceId } = await seedDeviceWithEvidence();
    await adminExec('REVOKE breeze_audit_admin FROM breeze_app');
    expect(await isAppMember()).toBe(false);

    let err: unknown = null;
    try {
      await permanentlyDelete(deviceId);
    } catch (e) {
      err = e;
    }
    expect(pgErrorCode(err)).toBe('42501');
    expect(await evidenceCount(deviceId)).toBe(2);
  });

  it('the boot role probe sees the missing membership on the request pool', async () => {
    expect((await getRequestDatabaseRole()).auditAdminMember).toBe(true);
    await adminExec('REVOKE breeze_audit_admin FROM breeze_app');
    expect(await getRequestDatabaseRole()).toMatchObject({ currentUser: 'breeze_app', auditAdminMember: false });
  });

  it('boot restores the membership (AUDIT_ADMIN_DATABASE_URL unset) and the delete then works', async () => {
    const { deviceId } = await seedDeviceWithEvidence();
    await adminExec('REVOKE breeze_audit_admin FROM breeze_app');

    const report = await withClient(ADMIN_URL, (client) =>
      ensureClusterRoles(client, { phase: 'post-migration', env: {}, logger: quiet }));

    expect(report.warnings).toEqual([]);
    expect(report.applied.some((line) => line.startsWith('Granted breeze_audit_admin to breeze_app'))).toBe(true);
    expect(await isAppMember()).toBe(true);
    await permanentlyDelete(deviceId);
    expect(await evidenceCount(deviceId)).toBe(0);
  });

  it('a healthy database gets no changes', async () => {
    const report = await withClient(ADMIN_URL, (client) =>
      ensureClusterRoles(client, { phase: 'post-migration', env: {}, logger: quiet }));
    expect(report).toEqual({ applied: [], warnings: [] });
  });

  it('never re-grants the membership when AUDIT_ADMIN_DATABASE_URL is set', async () => {
    await adminExec('REVOKE breeze_audit_admin FROM breeze_app');
    const report = await withClient(ADMIN_URL, (client) => ensureClusterRoles(client, {
      phase: 'post-migration',
      env: { AUDIT_ADMIN_DATABASE_URL: 'postgresql://breeze_audit_admin:x@localhost:5432/breeze' },
      logger: quiet,
    }));
    expect(report.applied.some((line) => line.startsWith('Granted breeze_audit_admin to breeze_app'))).toBe(false);
    expect(await isAppMember()).toBe(false);
  });
});

describe('#11929 dedicated audit-admin connection with the membership revoked', () => {
  let couldLogin = false;
  beforeAll(async () => {
    const rows = (await getTestDb().execute(
      sql`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'breeze_audit_admin'`,
    )) as unknown as Array<{ rolcanlogin: boolean }>;
    couldLogin = Boolean(rows[0]?.rolcanlogin);
    await adminExec('ALTER ROLE breeze_audit_admin WITH LOGIN');
    await adminExec(`ALTER ROLE breeze_audit_admin PASSWORD '${AUDIT_ADMIN_PASSWORD}'`);
  });
  afterAll(async () => {
    // Put the login attribute back the way this file found it.
    if (!couldLogin) await adminExec('ALTER ROLE breeze_audit_admin WITH NOLOGIN PASSWORD NULL');
  });

  async function useDedicatedConnection({ revoke = true } = {}): Promise<void> {
    process.env.AUDIT_ADMIN_DATABASE_URL = urlAs(APP_URL, 'breeze_audit_admin', AUDIT_ADMIN_PASSWORD);
    await closeAuditAdminPool();
    if (!revoke) return;
    await adminExec('REVOKE breeze_audit_admin FROM breeze_app');
    expect(await isAppMember()).toBe(false);
  }

  function deleteThenFail(deviceId: string): Promise<void> {
    return runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        await deleteDeviceCascade(tx as unknown as DeviceDeletionTx, deviceId);
        // Stands in for a refusal after the cascade (purgeRemovedDevice's
        // link-group site-access check).
        throw new Error('refused after the cascade');
      })));
  }

  it('permanent device delete stays in the caller transaction: a later refusal destroys no evidence', async () => {
    const { deviceId } = await seedDeviceWithEvidence();
    await useDedicatedConnection({ revoke: false });
    await expect(deleteThenFail(deviceId)).rejects.toThrow('refused after the cascade');
    expect(await evidenceCount(deviceId)).toBe(2);
    await permanentlyDelete(deviceId);
    expect(await evidenceCount(deviceId)).toBe(0);
  });

  it('permanent device delete still needs the membership, and fails whole without it', async () => {
    const { deviceId } = await seedDeviceWithEvidence();
    await useDedicatedConnection();
    let err: unknown = null;
    try {
      await permanentlyDelete(deviceId);
    } catch (e) {
      err = e;
    }
    expect(pgErrorCode(err)).toBe('42501');
    expect(await evidenceCount(deviceId)).toBe(2);
  });

  it('org erasure removes the append-only evidence and audit rows through it', async () => {
    const { orgId, deviceId } = await seedDeviceWithEvidence();
    await getTestDb().execute(sql`
      INSERT INTO audit_logs (org_id, actor_type, actor_id, action, resource_type, result)
      VALUES (${orgId}, 'system', gen_random_uuid(), 'test.action', 'test', 'success')
    `);
    await useDedicatedConnection();
    await cascadeDeleteOrg(orgId, randomUUID());
    expect(await evidenceCount(deviceId)).toBe(0);
    const audit = (await getTestDb().execute(
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE org_id = ${orgId}`,
    )) as unknown as Array<{ n: number }>;
    expect(audit[0]?.n).toBe(0);
  });

  it('AI invocation retention deletes expired rows through it', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const inserted = (await getTestDb().execute(sql`
      INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, chargeable, created_at)
      VALUES (${org.id}, 'chat', 'platform', 'm', 'm', false, now() - interval '400 days')
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    await useDedicatedConnection();
    const result = await pruneAiInvocations({ retentionDays: 30 });
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    const left = (await getTestDb().execute(
      sql`SELECT count(*)::int AS n FROM ai_invocations WHERE id = ${inserted[0]!.id}`,
    )) as unknown as Array<{ n: number }>;
    expect(left[0]?.n).toBe(0);
  });
});

describe('#11929 object privileges a role-less restore drops', () => {
  it('pins every migration grant to breeze_audit_admin in the boot manifest', async () => {
    const tables = (await getTestDb().execute(sql`
      SELECT table_name AS t, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
        FROM information_schema.role_table_grants
       WHERE grantee = 'breeze_audit_admin' AND table_schema = 'public'
       GROUP BY table_name ORDER BY table_name
    `)) as unknown as Array<{ t: string; p: string }>;
    const live = Object.fromEntries(tables.map((r) => [r.t, r.p]));
    const manifest = Object.fromEntries(Object.entries(AUDIT_ADMIN_TABLE_PRIVILEGES)
      .map(([t, privileges]) => [t, [...privileges].sort().join(',')]));
    // A failure here means a migration granted breeze_audit_admin something the
    // boot manifest (ensureClusterRoles.ts) does not re-assert after a restore.
    expect(live).toEqual(manifest);

    const fns = (await getTestDb().execute(sql`
      SELECT p.oid::regprocedure::text AS fn
        FROM pg_proc p, aclexplode(p.proacl) a
       WHERE p.pronamespace = 'public'::regnamespace
         AND a.grantee = 'breeze_audit_admin'::regrole AND a.privilege_type = 'EXECUTE'
       ORDER BY 1
    `)) as unknown as Array<{ fn: string }>;
    expect(fns.map((r) => `public.${r.fn}`).sort()).toEqual([...AUDIT_ADMIN_FUNCTION_PRIVILEGES].sort());
  });

  it('re-grants lost breeze_audit_admin and breeze_search privileges', async () => {
    const fn = 'public.breeze_search_td_synnex_pa(text[], boolean, integer, integer)';
    // What a restore into a cluster without the roles leaves behind.
    await adminExec('REVOKE SELECT, DELETE ON pam_actuation_results FROM breeze_audit_admin');
    await adminExec('REVOKE EXECUTE ON FUNCTION public.breeze_merged_lineage_org_ids() FROM breeze_audit_admin');
    await adminExec('REVOKE SELECT ON td_synnex_price_availability FROM breeze_search');
    await adminExec('DROP POLICY td_synnex_pa_search_fn ON td_synnex_price_availability');
    await adminExec(`ALTER FUNCTION ${fn} OWNER TO CURRENT_USER`);
    await adminExec(`GRANT EXECUTE ON FUNCTION ${fn} TO PUBLIC`);

    let report: Awaited<ReturnType<typeof ensureClusterRoles>>;
    try {
      report = await withClient(ADMIN_URL, (client) =>
        ensureClusterRoles(client, { phase: 'post-migration', env: {}, logger: quiet }));
    } finally {
      // Repair directly, not through the code under test, so a regression here
      // cannot leave the shared database broken for later suites.
      await adminExec('GRANT SELECT, DELETE ON pam_actuation_results TO breeze_audit_admin');
      await adminExec('GRANT EXECUTE ON FUNCTION public.breeze_merged_lineage_org_ids() TO breeze_audit_admin');
      await adminExec('GRANT SELECT ON td_synnex_price_availability TO breeze_search');
      await adminExec(`DO $$ BEGIN
        CREATE POLICY td_synnex_pa_search_fn ON td_synnex_price_availability FOR SELECT TO breeze_search USING (true);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
      await adminExec(`ALTER FUNCTION ${fn} OWNER TO breeze_search`);
      await adminExec(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
      await adminExec(`GRANT EXECUTE ON FUNCTION ${fn} TO breeze_app`);
    }
    expect(report.warnings).toEqual([]);

    const rows = (await getTestDb().execute(sql`
      SELECT
        has_table_privilege('breeze_audit_admin', 'pam_actuation_results', 'DELETE') AS "pamDelete",
        has_function_privilege('breeze_audit_admin', 'public.breeze_merged_lineage_org_ids()', 'EXECUTE') AS "lineage",
        has_table_privilege('breeze_search', 'td_synnex_price_availability', 'SELECT') AS "searchSelect",
        EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'td_synnex_pa_search_fn') AS "policy",
        (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = to_regprocedure(${fn})) AS owner,
        (SELECT EXISTS (SELECT 1 FROM aclexplode(proacl) a WHERE a.grantee = 0)
           FROM pg_proc WHERE oid = to_regprocedure(${fn})) AS "publicExecute",
        has_function_privilege('breeze_app', ${fn}, 'EXECUTE') AS "appExecute"
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rows[0]).toEqual({
      pamDelete: true,
      lineage: true,
      searchSelect: true,
      policy: true,
      owner: 'breeze_search',
      publicExecute: false,
      appExecute: true,
    });
  });
});

describe('#11929 non-superuser migration role', () => {
  const migrator = `t11929_migrator_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const migratorUrl = urlAs(ADMIN_URL, migrator, 'migrator_pw');

  beforeAll(async () => {
    await adminExec(`CREATE ROLE ${migrator} LOGIN PASSWORD 'migrator_pw' NOSUPERUSER NOCREATEROLE NOBYPASSRLS`);
  });
  afterAll(async () => {
    await adminExec('GRANT breeze_audit_admin TO breeze_app');
    await adminExec(`DROP OWNED BY ${migrator}`);
    await adminExec(`DROP ROLE IF EXISTS ${migrator}`);
    await adminExec('GRANT breeze_audit_admin TO breeze_app');
  });

  it('warns with the exact statement and does not throw when it cannot grant', async () => {
    await adminExec('REVOKE breeze_audit_admin FROM breeze_app');
    await adminExec('REVOKE DELETE ON peripheral_policy_delivery_events FROM breeze_audit_admin');
    try {
      const report = await withClient(migratorUrl, (client) =>
        ensureClusterRoles(client, { phase: 'post-migration', env: {}, logger: quiet }));
      expect(await isAppMember()).toBe(false);
      expect(report.applied).toEqual([]);
      expect(report.warnings.join('\n')).toContain('SQLSTATE 42501');
      expect(report.warnings.join('\n')).toContain('GRANT breeze_audit_admin TO breeze_app;');
      expect(report.warnings.join('\n')).toContain(
        'GRANT DELETE ON TABLE public.peripheral_policy_delivery_events TO breeze_audit_admin;');
    } finally {
      await adminExec('GRANT DELETE ON peripheral_policy_delivery_events TO breeze_audit_admin');
    }
  });

  it('repairs the membership as a managed-Postgres admin (CREATEROLE + ADMIN OPTION)', async () => {
    await adminExec(`ALTER ROLE ${migrator} CREATEROLE`);
    await adminExec(`GRANT breeze_audit_admin TO ${migrator} WITH ADMIN OPTION`);
    await adminExec('REVOKE breeze_audit_admin FROM breeze_app');

    const report = await withClient(migratorUrl, (client) =>
      ensureClusterRoles(client, { phase: 'pre-migration', env: {}, logger: quiet }));

    expect(report.warnings).toEqual([]);
    expect(await isAppMember()).toBe(true);
    const { deviceId } = await seedDeviceWithEvidence();
    await permanentlyDelete(deviceId);
    expect(await evidenceCount(deviceId)).toBe(0);
  });
});
