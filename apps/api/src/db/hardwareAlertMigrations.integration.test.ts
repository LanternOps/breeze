/**
 * Hardware & RAID monitoring (W03): disposable-database replay proof for the
 * monitor-kind enum and alert subject-identity migrations. Follows the
 * existing disposable-database pattern from
 * `installerBootstrapCredentialGeneration.migration.integration.test.ts`.
 */
import '../__tests__/integration/setup';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { expect, it } from 'vitest';

async function isolated(run: (sql: Sql, notices: string[]) => Promise<void>) {
  const url = new URL(process.env.DATABASE_URL!);
  const name = `hardware_alert_${randomUUID().replaceAll('-', '')}`;
  const admin = postgres(url.toString(), { max: 1 });
  let connection: Sql | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    const notices: string[] = [];
    connection = postgres(url.toString(), { max: 1, onnotice: (n) => notices.push(n.message ?? '') });
    await run(connection, notices);
  } finally {
    await connection?.end();
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${name}`;
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
  }
}

it('adds only hardware_health, idempotently and last', async () => {
  const migration = await readFile(
    new URL('../../migrations/2026-10-30-110200-monitor-kind-hardware-health.sql', import.meta.url),
    'utf8',
  );
  expect(migration.replace(/--[^\n]*/g, '').trim()).toBe(
    "ALTER TYPE monitor_kind ADD VALUE IF NOT EXISTS 'hardware_health';",
  );
  await isolated(async (sql) => {
    await sql.unsafe("CREATE TYPE monitor_kind AS ENUM ('cpu', 'composite')");
    await sql.begin((tx) => tx.unsafe(migration));
    await sql.begin((tx) => tx.unsafe(migration));
    const labels = await sql`SELECT enumlabel FROM pg_enum WHERE enumtypid = 'monitor_kind'::regtype ORDER BY enumsortorder`;
    expect(labels.map((r) => r.enumlabel)).toEqual(['cpu', 'composite', 'hardware_health']);
  });
});

it('deduplicates NULL subjects once, keeps newest, and preserves distinct subjects on replay', async () => {
  const migration = await readFile(
    new URL('../../migrations/2026-10-30-110300-alert-subject-key.sql', import.meta.url),
    'utf8',
  );
  expect(migration.trimStart().startsWith("SELECT set_config('breeze.scope', 'system', true);")).toBe(true);
  await isolated(async (sql, notices) => {
    await sql.unsafe(`CREATE TABLE alerts (
      id uuid PRIMARY KEY, rule_id uuid, device_id uuid NOT NULL, status text NOT NULL,
      triggered_at timestamp NOT NULL, resolved_at timestamp, resolution_note text,
      context jsonb NOT NULL DEFAULT '{}'::jsonb
    )`);
    // Task 10 — the 110300 migration also extends the ALREADY-SHIPPED
    // monitor_episodes table with the response-admission columns. A skeletal
    // stand-in proves that ADD COLUMN IF NOT EXISTS lands (and replays
    // idempotently) without depending on the full real table shape here.
    await sql.unsafe('CREATE TABLE monitor_episodes (id uuid PRIMARY KEY)');
    // Task 12 prerequisites: the retirement outbox FK and its RLS policy
    // helper. The disposable database has neither the real `organizations`
    // table nor the real breeze_has_org_access() function.
    await sql.unsafe('CREATE TABLE organizations (id uuid PRIMARY KEY)');
    await sql.unsafe("CREATE FUNCTION public.breeze_has_org_access(uuid) RETURNS boolean LANGUAGE sql AS 'SELECT true'");
    const rule = randomUUID(), device = randomUUID(), old = randomUUID(), newest = randomUUID();
    await sql`INSERT INTO alerts VALUES
      (${old}, ${rule}, ${device}, 'acknowledged', '2026-09-22', NULL, NULL),
      (${newest}, ${rule}, ${device}, 'suppressed', '2026-09-23', NULL, NULL),
      (${randomUUID()}, NULL, ${device}, 'active', '2026-09-23', NULL, NULL),
      (${randomUUID()}, NULL, ${device}, 'active', '2026-09-23', NULL, NULL)`;
    // Automation create_alert actions all share one synthetic per-org rule, so
    // several can legitimately be open on one device. They must be keyed, not
    // deduplicated.
    const automationRule = randomUUID(), autoA = randomUUID(), autoB = randomUUID();
    await sql`INSERT INTO alerts (id,rule_id,device_id,status,triggered_at,context) VALUES
      (${autoA}, ${automationRule}, ${device}, 'active', '2026-09-22', ${sql.json({ automationId: 'a1', automationRunId: 'r1' })}),
      (${autoB}, ${automationRule}, ${device}, 'active', '2026-09-23', ${sql.json({ automationId: 'a2', automationRunId: 'r2' })})`;
    await sql.begin((tx) => tx.unsafe(migration));
    expect(notices).toContain('keyed 2 automation action alerts');
    expect(await sql`SELECT id, status, subject_key FROM alerts WHERE rule_id = ${automationRule} ORDER BY triggered_at`).toEqual([
      { id: autoA, status: 'active', subject_key: `automation-alert:${autoA}` },
      { id: autoB, status: 'active', subject_key: `automation-alert:${autoB}` },
    ]);
    expect((await sql`SELECT status,resolution_note FROM alerts WHERE id=${old}`)[0]).toMatchObject({
      status: 'resolved', resolution_note: 'deduplicated by migration',
    });
    expect((await sql`SELECT status FROM alerts WHERE id=${newest}`)[0]!.status).toBe('suppressed');
    expect(notices).toContain('resolved 1 duplicate open alerts');
    await sql`INSERT INTO alerts (id,rule_id,device_id,status,triggered_at,subject_key) VALUES
      (${randomUUID()},${rule},${device},'active',now(),'storcli:c0:e1:s3'),
      (${randomUUID()},${rule},${device},'active',now(),'storcli:c0:e1:s5')`;
    await sql.begin((tx) => tx.unsafe(migration));
    expect(notices).toContain('resolved 0 duplicate open alerts');
    expect(notices).toContain('keyed 0 automation action alerts');
    expect((await sql`SELECT count(*)::int n FROM alerts WHERE status <> 'resolved'`)[0]!.n).toBe(7);
    await expect(sql`INSERT INTO alerts (id,rule_id,device_id,status,triggered_at,subject_key)
      VALUES (${randomUUID()},${rule},${device},'active',now(),'')`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`INSERT INTO alerts (id,rule_id,device_id,status,triggered_at,subject_key)
      VALUES (${randomUUID()},${rule},${device},'active',now(),'storcli:c0:e1:s3')`).rejects.toMatchObject({ code: '23505' });
    const columns = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_name = 'monitor_episodes' ORDER BY column_name`;
    expect(columns.map((row) => row.column_name)).toEqual(['id', 'response_dispatch', 'responses_admitted_at']);
    expect((await sql`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid = 'hardware_alert_retirement_outbox'::regclass`)[0])
      .toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    expect(await sql`SELECT policyname FROM pg_policies WHERE tablename = 'hardware_alert_retirement_outbox'`).toHaveLength(4);
  });
});
