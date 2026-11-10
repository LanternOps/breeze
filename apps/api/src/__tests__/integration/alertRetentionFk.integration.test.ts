/**
 * #4342 W3 — `log_correlations.alert_id` and `network_change_events.alert_id`
 * become ON DELETE SET NULL (migration 2027-01-23-094000). Before it, both were
 * NO ACTION, so deleting a closed alert that a log correlation or a network
 * change event pointed at aborted with 23503 — the alert retention job could
 * never remove one. The rows themselves are history that outlives the alert,
 * so the pointer is cleared rather than the row deleted.
 */
import './setup';

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { splitSqlStatements } from '../../db/autoMigrate';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const MIGRATION = '2027-01-23-094000-alert-retention-fk-set-null.sql';
const CONSTRAINTS = ['log_correlations_alert_id_alerts_id_fk', 'network_change_events_alert_id_alerts_id_fk'];

async function seed() {
  const db = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });

  const [alert] = await db.execute<{ id: string }>(sql`
    INSERT INTO alerts (org_id, device_id, status, severity, title, resolved_at)
    VALUES (${org.id}, ${device.id}, 'resolved', 'medium', 'fk test', now())
    RETURNING id`);
  const [rule] = await db.execute<{ id: string }>(sql`
    INSERT INTO log_correlation_rules (org_id, name, pattern) VALUES (${org.id}, 'fk rule', 'boom')
    RETURNING id`);
  const [correlation] = await db.execute<{ id: string }>(sql`
    INSERT INTO log_correlations (org_id, rule_id, pattern, first_seen, last_seen, occurrences, affected_devices, alert_id)
    VALUES (${org.id}, ${rule!.id}, 'boom', now(), now(), 3, '[]'::jsonb, ${alert!.id})
    RETURNING id`);
  const [baseline] = await db.execute<{ id: string }>(sql`
    INSERT INTO network_baselines (org_id, site_id, subnet) VALUES (${org.id}, ${site.id}, '10.0.0.0/24')
    RETURNING id`);
  const [event] = await db.execute<{ id: string }>(sql`
    INSERT INTO network_change_events (org_id, site_id, baseline_id, event_type, ip_address, alert_id)
    VALUES (${org.id}, ${site.id}, ${baseline!.id}, 'new_device', '10.0.0.5', ${alert!.id})
    RETURNING id`);
  return { alertId: alert!.id, correlationId: correlation!.id, eventId: event!.id };
}

const constraintState = () => getTestDb().execute<{ conname: string; confdeltype: string; convalidated: boolean }>(sql`
  SELECT conname, confdeltype::text AS confdeltype, convalidated
    FROM pg_constraint
   WHERE contype = 'f' AND confrelid = 'public.alerts'::regclass
     AND conrelid IN ('public.log_correlations'::regclass, 'public.network_change_events'::regclass)
   ORDER BY conname`);

describe('alert FKs from log_correlations / network_change_events (#4342 W3)', () => {
  it('deleting an alert clears both pointers and keeps both rows', async () => {
    const { alertId, correlationId, eventId } = await seed();
    const db = getTestDb();

    await db.execute(sql`DELETE FROM alerts WHERE id = ${alertId}`);

    const [lc] = await db.execute<{ alert_id: string | null }>(sql`SELECT alert_id FROM log_correlations WHERE id = ${correlationId}`);
    const [ev] = await db.execute<{ alert_id: string | null }>(sql`SELECT alert_id FROM network_change_events WHERE id = ${eventId}`);
    expect(lc).toEqual({ alert_id: null });
    expect(ev).toEqual({ alert_id: null });
  });

  it('carries exactly one canonical, validated SET NULL constraint per column', async () => {
    expect([...await constraintState()]).toEqual(
      CONSTRAINTS.map((conname) => ({ conname, confdeltype: 'n', convalidated: true })),
    );
  });

  it('re-running the @no-transaction migration file is a no-op', async () => {
    const before = [...await constraintState()];
    const content = await readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');
    const admin = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      for (const statement of splitSqlStatements(content)) await admin.unsafe(statement);
    } finally {
      await admin.end();
    }
    expect([...await constraintState()]).toEqual(before);
    expect(before).toHaveLength(2);
  });
});
