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
  aiAgentRuns,
  aiAgents,
  aiAlertVerdicts,
  alertCorrelationGroups,
  alertCorrelationMembers,
  alertCorrelations,
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
    /** Explicit close stamps (days ago, or null), regardless of status: reopened or legacy rows. */
    resolvedDaysAgo?: number | null; dismissedDaysAgo?: number | null;
    /** A topology-site-owned alert; `deviceId` is then provenance only. */
    topologySite?: boolean;
  };
  const insertAlert = async (o: AlertOpts = {}): Promise<string> => {
    const status = o.status ?? 'resolved';
    const closedAt = o.closedDaysAgo === undefined ? null : daysAgo(o.closedDaysAgo);
    const deviceId = o.deviceId === undefined ? f.device.id : o.deviceId;
    const stamp = (d: number | null | undefined, fallback: Date | null) =>
      d === undefined ? fallback : d === null ? null : daysAgo(d);
    const [row] = await db.insert(alerts).values({
      orgId,
      ruleId: o.ruleId === undefined ? null : o.ruleId,
      deviceId,
      ownerKind: o.topologySite ? 'topology_site' : deviceId ? 'device' : 'backup_workload',
      ownerRef: o.topologySite || deviceId ? null : `workload-${randomUUID().slice(0, 8)}`,
      topologySiteId: o.topologySite ? f.site.id : null,
      topologySourceKey: o.topologySite ? `topology:${randomUUID().replace(/-/g, '').repeat(2)}` : null,
      subjectKey: o.subjectKey ?? null,
      status,
      severity: 'medium',
      title: 'retention fixture',
      triggeredAt: daysAgo(400),
      resolvedAt: stamp(o.resolvedDaysAgo, status === 'resolved' ? closedAt : null),
      dismissedAt: stamp(o.dismissedDaysAgo, status === 'dismissed' ? closedAt : null),
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
    // Open alerts carrying a stale close stamp (reopened or legacy rows): only
    // the status filter keeps them, not a NULL close time.
    const open = await Promise.all((['active', 'acknowledged', 'suppressed'] as const).map((status) =>
      f.insertAlert({ status, ruleId: null, deviceId: null, resolvedDaysAgo: 300, dismissedDaysAgo: 300 })));
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

    const [baseline] = await db.execute<{ id: string }>(sql`
      INSERT INTO network_baselines (org_id, site_id, subnet) VALUES (${f.orgId}, ${f.site.id}, '10.0.0.0/24') RETURNING id`);
    const [changeEvent] = await db.execute<{ id: string }>(sql`
      INSERT INTO network_change_events (org_id, site_id, baseline_id, event_type, ip_address, alert_id)
      VALUES (${f.orgId}, ${f.site.id}, ${baseline!.id}, 'new_device', '10.0.0.5', ${doomed}) RETURNING id`);
    const survivor = await f.insertAlert({ status: 'active' });
    await db.insert(alertCorrelations).values({ parentAlertId: survivor, childAlertId: doomed, correlationType: 'test' });
    const [agent] = await db.insert(aiAgents).values({
      orgId: f.orgId, partnerId: null, kind: 'triage', name: `ret-agent-${randomUUID().slice(0, 8)}`, createdBy: f.actor.id,
    }).returning();
    const [run] = await db.insert(aiAgentRuns).values({
      agentId: agent!.id, orgId: f.orgId, triggerKind: 'alert', dedupeKey: `ret-${randomUUID()}`,
      modeAtStart: 'shadow', policySnapshot: { schemaVersion: 1 } as never,
    }).returning();
    await db.insert(aiAlertVerdicts).values({
      orgId: f.orgId, runId: run!.id, alertId: doomed, classification: 'actionable', confidence: '0.80', rationale: 'fixture',
    });

    const job = await loadJob('true');
    await job.runAlertRetention(JOB);

    expect(await liveAlertIds([doomed, survivor])).toEqual(new Set([survivor]));
    expect(await db.select().from(aiAlertVerdicts).where(inArray(aiAlertVerdicts.alertId, [doomed]))).toHaveLength(0);
    expect(await db.select().from(alertCorrelations).where(inArray(alertCorrelations.childAlertId, [doomed]))).toHaveLength(0);
    const [ce] = await db.execute<{ alert_id: string | null }>(sql`SELECT alert_id FROM network_change_events WHERE id = ${changeEvent!.id}`);
    expect(ce).toEqual({ alert_id: null });
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
    const group = (key: string, lastSeenDaysAgo: number, rootAlertId: string | null = null) => db.insert(alertCorrelationGroups).values({
      orgId: f.orgId, groupKey: key, rootAlertId, firstSeenAt: daysAgo(lastSeenDaysAgo + 1), lastSeenAt: daysAgo(lastSeenDaysAgo),
    }).returning({ id: alertCorrelationGroups.id }).then((r) => r[0]!.id);
    const orphan = await group('orphan', 200);
    const withMember = await group('member', 200);
    const recent = await group('recent', 5);
    // Root set, no member: kept while its root alert survives.
    const rooted = await group('rooted', 200, memberAlert);
    // Root and only member are a closed alert the first target deletes: the FK
    // clears the root and cascades the member, so the second target takes the
    // group in the same run.
    const doomedAlert = await f.insertAlert({ closedDaysAgo: 200 });
    const sameRun = await group('same-run', 200, doomedAlert);
    await db.insert(alertCorrelationMembers).values([
      { orgId: f.orgId, groupId: withMember, alertId: memberAlert },
      { orgId: f.orgId, groupId: sameRun, alertId: doomedAlert },
    ]);

    const job = await loadJob('true');
    await job.runAlertRetention(JOB);

    expect(await liveAlertIds([doomedAlert])).toEqual(new Set());
    const left = await db.select({ id: alertCorrelationGroups.id }).from(alertCorrelationGroups)
      .where(inArray(alertCorrelationGroups.id, [orphan, withMember, recent, rooted, sameRun]));
    expect(new Set(left.map((r) => r.id))).toEqual(new Set([withMember, recent, rooted]));
  });

  it('keep-newest is per rule and per device: another key never shields a row', async () => {
    const f = await seed();
    const db = getTestDb();
    const [otherRule] = await db.insert(alertRules).values({
      orgId: f.orgId, templateId: (await db.select({ t: alertRules.templateId }).from(alertRules)
        .where(inArray(alertRules.id, [f.ruleId])))[0]!.t,
      name: 'other rule', targetType: 'organization', targetId: f.orgId,
    }).returning();
    const [otherDevice] = await db.execute<{ id: string }>(sql`
      INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version)
      VALUES (${f.orgId}, ${f.site.id}, ${randomUUID()}, 'ret-other', 'linux', '1', 'amd64', '1') RETURNING id`);
    // Only closed alert of (rule R, device D): its own newest, kept even though
    // another device and another rule each have a newer closed alert.
    const onlyForKey = await f.insertAlert({ ruleId: f.ruleId, closedDaysAgo: 300 });
    const newerOtherDevice = await f.insertAlert({ ruleId: f.ruleId, deviceId: otherDevice!.id, closedDaysAgo: 100 });
    const newerOtherRule = await f.insertAlert({ ruleId: otherRule!.id, closedDaysAgo: 100 });

    const job = await loadJob('true');
    await job.runAlertRetention(JOB);

    expect(await liveAlertIds([onlyForKey, newerOtherDevice, newerOtherRule]))
      .toEqual(new Set([onlyForKey, newerOtherDevice, newerOtherRule]));
  });

  it('only a newer CLOSED alert of the same owner kind supersedes; ties and a dismissed newest are kept', async () => {
    const f = await seed();
    // An open alert with a newer stale close stamp is not what the cursor reader picks.
    const shieldedByOpen = await f.insertAlert({ ruleId: f.ruleId, subjectKey: 'open', closedDaysAgo: 300 });
    const openNewer = await f.insertAlert({ ruleId: f.ruleId, subjectKey: 'open', status: 'active', resolvedDaysAgo: 100 });
    // A topology-site alert (device_id is provenance) is not a device-owned cursor row.
    const deviceOwned = await f.insertAlert({ ruleId: f.ruleId, subjectKey: 'topo', closedDaysAgo: 300 });
    const topoNewer = await f.insertAlert({ ruleId: f.ruleId, subjectKey: 'topo', closedDaysAgo: 100, topologySite: true });
    // Newest is dismissed, older is resolved: the dismissed one is the newest.
    const olderResolved = await f.insertAlert({ ruleId: f.ruleId, subjectKey: 'dis', closedDaysAgo: 300 });
    const newestDismissed = await f.insertAlert({ ruleId: f.ruleId, subjectKey: 'dis', status: 'dismissed', closedDaysAgo: 100 });
    // Two rows tied on the newest close time are both kept; the older goes.
    const tieOlder = await f.insertAlert({ ruleId: f.ruleId, subjectKey: 'tie', closedDaysAgo: 300 });
    const tiedAt = daysAgo(100);
    const tieA = await f.insertAlert({ ruleId: f.ruleId, subjectKey: 'tie', closedDaysAgo: 100 });
    const tieB = await f.insertAlert({ ruleId: f.ruleId, subjectKey: 'tie', closedDaysAgo: 100 });
    await getTestDb().update(alerts).set({ resolvedAt: tiedAt }).where(inArray(alerts.id, [tieA, tieB]));
    // A closed alert with no close stamp is never eligible, and never shields an older one.
    const noStamp = await f.insertAlert({ ruleId: null, resolvedDaysAgo: null });
    const olderThanNoStamp = await f.insertAlert({ ruleId: f.ruleId, subjectKey: 'nostamp', closedDaysAgo: 300 });
    const noStampKeyed = await f.insertAlert({ ruleId: f.ruleId, subjectKey: 'nostamp', resolvedDaysAgo: null });

    const job = await loadJob('true');
    await job.runAlertRetention(JOB);

    const all = [shieldedByOpen, openNewer, deviceOwned, topoNewer, olderResolved, newestDismissed,
      tieOlder, tieA, tieB, noStamp, olderThanNoStamp, noStampKeyed];
    expect(await liveAlertIds(all)).toEqual(new Set([
      shieldedByOpen, openNewer, deviceOwned, topoNewer, newestDismissed, tieA, tieB, noStamp, olderThanNoStamp, noStampKeyed,
    ]));
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
