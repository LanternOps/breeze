/**
 * #4342 W3 — closed-alert retention guards against real Postgres, through the
 * production `db` pool (unprivileged `breeze_app`, forced RLS): a batch that
 * forgot to elect system scope matches zero rows here and fails these tests.
 *
 * Pins: open alerts survive at any age; the newest closed alert per
 * (rule, device, subject) survives, including a NULL device (Review Focus 3);
 * alerts linked by any of the three ticket link tables survive; deleted alerts
 * cascade their notifications and clear nullable back-pointers; orphaned
 * correlation groups go, and report mode deletes nothing while counting
 * exactly what enforce removes.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inArray, sql } from 'drizzle-orm';

import {
  alertCorrelationGroups,
  alertCorrelationMembers,
  alertNotifications,
  alertRules,
  alerts,
  alertTemplates,
  notificationChannels,
  psaConnections,
  psaTicketMappings,
  remediationSuggestions,
  ticketAlertLinks,
  tickets,
} from '../../db/schema';
import { readClosedCursors } from '../../services/alertLifecycle/cursor';
import { insertAlertRef, seedAlertRefFixture } from './alertExternalRefsFixtures';
import { withSystemDbAccessContext } from '../../db';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS);
const JOB = { retentionDays: 30, batchSize: 2, maxBatches: 50 };

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed() {
  const db = getTestDb();
  const f = await seedAlertRefFixture();
  const orgId = f.orgA.id;
  const [template] = await db.insert(alertTemplates).values({
    orgId, name: 'retention tpl', conditions: {}, severity: 'medium', titleTemplate: 't', messageTemplate: 'm',
  }).returning();
  const [rule] = await db.insert(alertRules).values({
    orgId, templateId: template!.id, name: 'retention rule', targetType: 'organization', targetId: orgId,
  }).returning();

  type AlertOpts = {
    status?: 'active' | 'acknowledged' | 'suppressed' | 'resolved' | 'dismissed';
    closedDaysAgo?: number; ruleId?: string | null; deviceId?: string | null; subjectKey?: string | null;
    dismissed?: boolean;
  };
  const insertAlert = async (o: AlertOpts = {}): Promise<string> => {
    const status = o.status ?? 'resolved';
    const closedAt = o.closedDaysAgo === undefined ? null : daysAgo(o.closedDaysAgo);
    const deviceId = o.deviceId === undefined ? f.device.id : o.deviceId;
    const [row] = await db.insert(alerts).values({
      orgId,
      ruleId: o.ruleId === undefined ? null : o.ruleId,
      deviceId,
      ownerKind: deviceId ? 'device' : 'backup_workload',
      ownerRef: deviceId ? null : `workload-${randomUUID().slice(0, 8)}`,
      subjectKey: o.subjectKey ?? null,
      status,
      severity: 'medium',
      title: 'retention fixture',
      triggeredAt: daysAgo(400),
      resolvedAt: status === 'resolved' ? closedAt : null,
      dismissedAt: status === 'dismissed' ? closedAt : null,
    }).returning({ id: alerts.id });
    return row!.id;
  };

  return { ...f, orgId, ruleId: rule!.id, insertAlert };
}

async function liveAlertIds(ids: string[]): Promise<Set<string>> {
  const rows = await getTestDb().select({ id: alerts.id }).from(alerts).where(inArray(alerts.id, ids));
  return new Set(rows.map((r) => r.id));
}

/** Import the job fresh with ALERT_RETENTION_ENFORCE set, as a deployment would. */
async function loadJob(enforce: 'true' | undefined) {
  if (enforce) vi.stubEnv('ALERT_RETENTION_ENFORCE', enforce);
  else vi.stubEnv('ALERT_RETENTION_ENFORCE', '');
  vi.resetModules();
  return import('../../jobs/alertRetention');
}

describe('closed-alert retention (#4342 W3)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('every FK into alerts and alert_correlation_groups clears or cascades (none blocks a delete)', async () => {
    const rows = await getTestDb().execute<{ child: string; conname: string; confdeltype: string }>(sql`
      SELECT conrelid::regclass::text AS child, conname, confdeltype::text AS confdeltype
        FROM pg_constraint
       WHERE contype = 'f'
         AND confrelid IN ('public.alerts'::regclass, 'public.alert_correlation_groups'::regclass)
         AND confdeltype NOT IN ('c', 'n')`);
    expect([...rows]).toEqual([]);
  });

  it('keeps the newest closed alert per (rule, device, subject); the cursor reader still finds it', async () => {
    const f = await seed();
    const oldest = await f.insertAlert({ ruleId: f.ruleId, closedDaysAgo: 300 });
    const older = await f.insertAlert({ ruleId: f.ruleId, closedDaysAgo: 200, status: 'dismissed' });
    const newest = await f.insertAlert({ ruleId: f.ruleId, closedDaysAgo: 100 });
    const cursors = () => withSystemDbAccessContext(() => readClosedCursors(f.device.id, [f.ruleId]));
    const before = await cursors();
    expect(before.has(f.ruleId)).toBe(true);

    const job = await loadJob('true');
    await job.runAlertRetention(JOB);

    expect(await liveAlertIds([oldest, older, newest])).toEqual(new Set([newest]));
    const after = await cursors();
    expect(after.get(f.ruleId)).toEqual(before.get(f.ruleId));
  });

  it('a NULL device still ages out, except the newest per key (IS NOT DISTINCT FROM)', async () => {
    const f = await seed();
    const older = await f.insertAlert({ ruleId: f.ruleId, deviceId: null, subjectKey: 'x', closedDaysAgo: 200 });
    const newer = await f.insertAlert({ ruleId: f.ruleId, deviceId: null, subjectKey: 'x', closedDaysAgo: 100 });
    // A different subject is a different key: its only row is its newest.
    const otherSubject = await f.insertAlert({ ruleId: f.ruleId, deviceId: null, subjectKey: 'y', closedDaysAgo: 250 });

    const job = await loadJob('true');
    await job.runAlertRetention(JOB);

    expect(await liveAlertIds([older, newer, otherSubject])).toEqual(new Set([newer, otherSubject]));
  });

  it('never deletes an open alert, a closed alert inside the window, or a ticket-linked one', async () => {
    const f = await seed();
    const db = getTestDb();
    const open = await Promise.all((['active', 'acknowledged', 'suppressed'] as const).map((status) =>
      f.insertAlert({ status, ruleId: null, deviceId: null })));
    const recent = await f.insertAlert({ closedDaysAgo: 5 });

    const linkedTicket = await f.insertAlert({ closedDaysAgo: 200 });
    const [ticket] = await db.insert(tickets).values({
      orgId: f.orgId, partnerId: f.partner.id, ticketNumber: `RET-${randomUUID().slice(0, 8)}`,
      subject: 'linked', source: 'manual', priority: 'normal',
    }).returning();
    await db.insert(ticketAlertLinks).values({ ticketId: ticket!.id, orgId: f.orgId, alertId: linkedTicket });

    const linkedPsa = await f.insertAlert({ closedDaysAgo: 200 });
    const [connection] = await db.insert(psaConnections).values({
      partnerId: f.partner.id, provider: 'connectwise', name: 'ret-psa', credentials: {},
    }).returning();
    await db.insert(psaTicketMappings).values({
      connectionId: connection!.id, alertId: linkedPsa, deviceId: f.device.id, externalTicketId: 'ret-psa-1',
    });

    // The fixture's own alert, closed and old, carries a partner-principal ref.
    await db.execute(sql`UPDATE alerts SET status = 'resolved', resolved_at = ${daysAgo(200).toISOString()}::timestamp
      WHERE id = ${f.alert.id}`);
    await db.execute(insertAlertRef(f));

    const plain = await f.insertAlert({ closedDaysAgo: 200 });

    const job = await loadJob('true');
    await job.runAlertRetention(JOB);

    const kept = [...open, recent, linkedTicket, linkedPsa, f.alert.id];
    expect(await liveAlertIds([...kept, plain])).toEqual(new Set(kept));
  });

  it('a deleted alert takes its notifications and clears nullable back-pointers', async () => {
    const f = await seed();
    const db = getTestDb();
    const doomed = await f.insertAlert({ closedDaysAgo: 200 });
    const [channel] = await db.insert(notificationChannels).values({
      orgId: f.orgId, name: 'ret-mail', type: 'email',
    }).returning();
    await db.insert(alertNotifications).values({ alertId: doomed, channelId: channel!.id, status: 'sent' });
    const [suggestion] = await db.insert(remediationSuggestions).values({
      orgId: f.orgId, alertId: doomed, deviceId: f.device.id, sourceType: 'alert', sourceId: doomed, targetType: 'manual_steps',
      title: 'fix', rationale: 'r', expectedAction: 'a',
    }).returning();
    const [lcRule] = await db.execute<{ id: string }>(sql`
      INSERT INTO log_correlation_rules (org_id, name, pattern) VALUES (${f.orgId}, 'ret rule', 'boom') RETURNING id`);
    const [correlation] = await db.execute<{ id: string }>(sql`
      INSERT INTO log_correlations (org_id, rule_id, pattern, first_seen, last_seen, occurrences, affected_devices, alert_id)
      VALUES (${f.orgId}, ${lcRule!.id}, 'boom', now(), now(), 3, '[]'::jsonb, ${doomed}) RETURNING id`);

    const job = await loadJob('true');
    await job.runAlertRetention(JOB);

    expect(await liveAlertIds([doomed])).toEqual(new Set());
    expect(await db.select().from(alertNotifications).where(inArray(alertNotifications.alertId, [doomed]))).toHaveLength(0);
    const [s] = await db.select({ alertId: remediationSuggestions.alertId }).from(remediationSuggestions)
      .where(inArray(remediationSuggestions.id, [suggestion!.id]));
    expect(s).toEqual({ alertId: null });
    const [lc] = await db.execute<{ alert_id: string | null }>(sql`SELECT alert_id FROM log_correlations WHERE id = ${correlation!.id}`);
    expect(lc).toEqual({ alert_id: null });
  });

  it('deletes an orphaned stale correlation group and keeps one with a member or a recent one', async () => {
    const f = await seed();
    const db = getTestDb();
    const memberAlert = await f.insertAlert({ status: 'active' });
    const group = (key: string, lastSeenDaysAgo: number) => db.insert(alertCorrelationGroups).values({
      orgId: f.orgId, groupKey: key, firstSeenAt: daysAgo(lastSeenDaysAgo + 1), lastSeenAt: daysAgo(lastSeenDaysAgo),
    }).returning({ id: alertCorrelationGroups.id }).then((r) => r[0]!.id);
    const orphan = await group('orphan', 200);
    const withMember = await group('member', 200);
    const recent = await group('recent', 5);
    await db.insert(alertCorrelationMembers).values({ orgId: f.orgId, groupId: withMember, alertId: memberAlert });

    const job = await loadJob('true');
    await job.runAlertRetention(JOB);

    const left = await db.select({ id: alertCorrelationGroups.id }).from(alertCorrelationGroups)
      .where(inArray(alertCorrelationGroups.id, [orphan, withMember, recent]));
    expect(new Set(left.map((r) => r.id))).toEqual(new Set([withMember, recent]));
  });

  it('report mode deletes nothing and counts exactly what enforce removes', async () => {
    const f = await seed();
    const ids = [
      await f.insertAlert({ ruleId: f.ruleId, closedDaysAgo: 300 }),
      await f.insertAlert({ ruleId: f.ruleId, closedDaysAgo: 100 }),
      await f.insertAlert({ closedDaysAgo: 200 }),
      await f.insertAlert({ closedDaysAgo: 210 }),
      await f.insertAlert({ status: 'active' }),
      await f.insertAlert({ closedDaysAgo: 3 }),
    ];
    await getTestDb().insert(alertCorrelationGroups).values({
      orgId: f.orgId, groupKey: 'orphan', firstSeenAt: daysAgo(201), lastSeenAt: daysAgo(200),
    });

    const reportJob = await loadJob(undefined);
    expect(reportJob.__testOnly.ENFORCE).toBe(false);
    const report = await reportJob.runAlertRetention(JOB);
    expect(await liveAlertIds(ids)).toEqual(new Set(ids));
    expect(await getTestDb().select().from(alertCorrelationGroups)).toHaveLength(1);

    // forceReport overrides an enforcing deployment.
    const enforceJob = await loadJob('true');
    await enforceJob.runAlertRetention({ ...JOB, forceReport: true });
    expect(await liveAlertIds(ids)).toEqual(new Set(ids));

    const enforced = await enforceJob.runAlertRetention(JOB);
    expect(report.map((r) => r.mode)).toEqual(['report', 'report']);
    expect(enforced.map((r) => r.mode)).toEqual(['enforce', 'enforce']);
    const eligible = report.map((r) => (r.mode === 'report' ? r.eligible : -1));
    const affected = enforced.map((r) => (r.mode === 'enforce' ? r.affected : -1));
    expect(eligible).toEqual([3, 1]);
    expect(affected).toEqual(eligible);
  });
});
