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
      triggered_at timestamp NOT NULL, resolved_at timestamp, resolution_note text
    )`);
    const rule = randomUUID(), device = randomUUID(), old = randomUUID(), newest = randomUUID();
    await sql`INSERT INTO alerts VALUES
      (${old}, ${rule}, ${device}, 'acknowledged', '2026-09-22', NULL, NULL),
      (${newest}, ${rule}, ${device}, 'suppressed', '2026-09-23', NULL, NULL),
      (${randomUUID()}, NULL, ${device}, 'active', '2026-09-23', NULL, NULL),
      (${randomUUID()}, NULL, ${device}, 'active', '2026-09-23', NULL, NULL)`;
    await sql.begin((tx) => tx.unsafe(migration));
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
    expect((await sql`SELECT count(*)::int n FROM alerts WHERE status <> 'resolved'`)[0]!.n).toBe(5);
    await expect(sql`INSERT INTO alerts (id,rule_id,device_id,status,triggered_at,subject_key)
      VALUES (${randomUUID()},${rule},${device},'active',now(),'')`).rejects.toMatchObject({ code: '23514' });
    await expect(sql`INSERT INTO alerts (id,rule_id,device_id,status,triggered_at,subject_key)
      VALUES (${randomUUID()},${rule},${device},'active',now(),'storcli:c0:e1:s3')`).rejects.toMatchObject({ code: '23505' });
  });
});
