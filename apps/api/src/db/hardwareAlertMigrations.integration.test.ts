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
