/**
 * Backfill contract for
 * `apps/api/migrations/2026-12-07-110000-network-monitor-alert-endpoint-display.sql`.
 *
 * Network-monitor alerts stored before #7920 hold the full endpoint URL in
 * `message`, `context.target` and `context.error`. The migration rewrites them
 * the way the monitor worker writes alerts today (scheme + host), leaves
 * alerts from other sources alone, and is a no-op on a second run.
 *
 * The migration is database-wide, so every assertion is scoped to the alert
 * ids this suite seeds.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { describe, it, expect, afterAll } from 'vitest';
import { createOrganization, createPartner, createSite } from './db-utils';

const RUN = !!process.env.DATABASE_URL;
const runDb = it.runIf(RUN);

const MIGRATION = '2026-12-07-110000-network-monitor-alert-endpoint-display.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');

// Superuser client (the role autoMigrate runs as), capturing RAISE WARNING
// row counts.
const notices: string[] = [];
const adminSql = postgres(process.env.DATABASE_URL ?? '', {
  max: 1,
  onnotice: (n) => { notices.push(String(n.message)); },
});
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

async function runBackfill(): Promise<number> {
  notices.length = 0;
  await adminSql.unsafe(migrationSql);
  const line = notices.find((n) => n.includes('network-monitor alert endpoint display'));
  const match = line?.match(/: (\d+) alert rows updated/);
  if (!match) throw new Error(`row-count notice missing: ${JSON.stringify(notices)}`);
  return Number(match[1]);
}

async function seedDevice(): Promise<{ orgId: string; deviceId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminSql<{ id: string }[]>`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status)
    VALUES (${org.id}, ${site.id}, ${`endpoint-backfill-${unique}`}, ${`WS-${unique}`},
            'windows', '10', 'x86_64', '0.0.0-test', 'online')
    RETURNING id`;
  return { orgId: org.id, deviceId: device!.id };
}

async function insertAlert(
  f: { orgId: string; deviceId: string },
  message: string,
  context: Record<string, unknown>,
): Promise<string> {
  const [row] = await adminSql<{ id: string }[]>`
    INSERT INTO alerts (org_id, device_id, severity, title, message, context)
    VALUES (${f.orgId}, ${f.deviceId}, 'high', 'API offline', ${message}, ${adminSql.json(context as never)})
    RETURNING id`;
  return row!.id;
}

async function readAlert(id: string) {
  const [row] = await adminSql<{ message: string; context: Record<string, unknown> }[]>`
    SELECT message, context FROM alerts WHERE id = ${id}`;
  return row!;
}

describe('network-monitor alert endpoint display backfill', () => {
  runDb('reduces stored endpoints to scheme + host, skips other sources, and is idempotent', async () => {
    const f = await seedDevice();

    const fullUrl = 'https://u:p@w@api.example.com:8443/v1/health?key=k1';
    const fullUrlId = await insertAlert(
      f,
      `Monitor API is offline. Target: ${fullUrl}. Status: offline.`,
      { source: 'network_monitor', target: fullUrl, error: `Get "${fullUrl}": EOF`, status: 'offline' },
    );

    const userinfoTarget = 'admin:pw@db.example.com/status?k=1';
    const userinfoId = await insertAlert(
      f,
      `Monitor DB is offline. Target: ${userinfoTarget}. Status: offline.`,
      { source: 'network_monitor', target: userinfoTarget, error: null },
    );

    // A target with no host part must not cause unrelated characters of the
    // message to be rewritten.
    const degenerateId = await insertAlert(
      f,
      'Custom note: page ops@example.org / on-call. Target: @.',
      { source: 'network_monitor', target: '@' },
    );

    const reducedMessage = 'Monitor API is offline. Target: https://api.example.com. Status: offline.';
    const reducedId = await insertAlert(
      f,
      reducedMessage,
      { source: 'network_monitor', target: 'https://api.example.com', error: null },
    );

    const otherMessage = 'Agent reported: see https://kb.example.com/article?t=1';
    const otherContext = { source: 'agent', target: 'admin:pw@db.example.com/status' };
    const otherId = await insertAlert(f, otherMessage, otherContext);

    const firstRunCount = await runBackfill();
    // Database-wide: at least the three seeded rows that need a change.
    expect(firstRunCount).toBeGreaterThanOrEqual(3);

    const fullUrlRow = await readAlert(fullUrlId);
    expect(fullUrlRow.message).toBe('Monitor API is offline. Target: https://api.example.com:8443. Status: offline.');
    expect(fullUrlRow.context.target).toBe('https://api.example.com:8443');
    expect(fullUrlRow.context.error).toBe('Get "https://api.example.com:8443": EOF');
    expect(fullUrlRow.context.status).toBe('offline');

    const userinfoRow = await readAlert(userinfoId);
    expect(userinfoRow.message).toBe('Monitor DB is offline. Target: db.example.com. Status: offline.');
    expect(userinfoRow.context.target).toBe('db.example.com');
    expect(userinfoRow.context.error).toBeNull();

    const degenerateRow = await readAlert(degenerateId);
    expect(degenerateRow.message).toBe('Custom note: page ops@example.org / on-call. Target: @.');
    expect(degenerateRow.context.target).toBe('[invalid-url]');

    const reducedRow = await readAlert(reducedId);
    expect(reducedRow.message).toBe(reducedMessage);
    expect(reducedRow.context.target).toBe('https://api.example.com');

    const otherRow = await readAlert(otherId);
    expect(otherRow.message).toBe(otherMessage);
    expect(otherRow.context).toEqual(otherContext);

    expect(await runBackfill()).toBe(0);
  });
});
