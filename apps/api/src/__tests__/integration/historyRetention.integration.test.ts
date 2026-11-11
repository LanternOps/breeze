/**
 * #4342 W5 (#11592) — history retention guards against real Postgres, through
 * the unprivileged `breeze_app` pool (forced RLS): a batch that forgot to
 * elect system scope matches zero rows here and fails these tests.
 *
 * Every target is loaded with its `_ENFORCE=true` (set before import, hoisted),
 * so the enforce path deletes. The report path is the same run with
 * `forceReport: true`, which must delete nothing and count exactly the rows the
 * enforcing run then removes (one predicate, two modes). `setup.ts` truncates
 * the tenant roots between tests, so a table a test did not seed has nothing
 * eligible and its report/enforce counts are both zero.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  process.env.AI_AGENT_RUN_RETENTION_ENFORCE = 'true';
  process.env.PATCH_JOB_RESULT_RETENTION_ENFORCE = 'true';
  process.env.SECURITY_POSTURE_SNAPSHOT_RETENTION_ENFORCE = 'true';
  process.env.CIS_BASELINE_RESULT_RETENTION_ENFORCE = 'true';
  process.env.AUTOMATION_RUN_RETENTION_ENFORCE = 'true';
  process.env.REPORT_RUN_RETENTION_ENFORCE = 'true';
  process.env.USER_NOTIFICATION_READ_RETENTION_ENFORCE = 'true';
  process.env.USER_NOTIFICATION_RETENTION_ENFORCE = 'true';
  process.env.REMOTE_SESSION_RETENTION_ENFORCE = 'true';
  process.env.SUPPORT_SESSION_RETENTION_ENFORCE = 'true';
  process.env.AUTH_SESSION_RETENTION_ENFORCE = 'true';
  process.env.NETWORK_CHANGE_EVENT_RETENTION_ENFORCE = 'true';
});

import './setup';

import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';

import { withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  aiAgentRuns,
  aiAgents,
  aiAlertVerdicts,
  aiRunArtifacts,
  alertCorrelationGroups,
  automationRunDeviceResults,
  automationRuns,
  automations,
  cisBaselineResults,
  cisBaselines,
  discoveryProfiles,
  networkBaselines,
  networkChangeEvents,
  patchJobResults,
  patchJobs,
  patches,
  remoteSessions,
  reportRunDeliveries,
  reportRuns,
  reports,
  securityPostureSnapshots,
  serviceDeliverableEvidence,
  serviceDeliverableOccurrences,
  serviceDeliverables,
  sessions,
  supportSessions,
  ticketDrafts,
  tickets,
  userNotifications,
} from '../../db/schema';
import { HISTORY_RETENTION_TARGETS, runHistoryRetention } from '../../jobs/historyRetention';
import type { RetentionTargetResult } from '../../jobs/retentionTarget';
import { loadOldestRebootRequiredSince } from '../../services/patchAlerts';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * DAY_MS);
/** One hour either side of a `days`-day cutoff: the strict `<` and the UTC wall-time compare. */
const justPast = (days: number) => new Date(NOW - days * DAY_MS - HOUR_MS);
const justInside = (days: number) => new Date(NOW - days * DAY_MS + HOUR_MS);
const KNOBS = { batchSize: 2, maxBatches: 50 };

/** Position of each target in the fixed run order (`index.ts`). */
const IDX = {
  aiAgentRuns: 0,
  patchJobResults: 1,
  securityPosture: 2,
  cisBaselineResults: 3,
  automationRuns: 4,
  reportRuns: 5,
  notificationsRead: 6,
  notificationsAll: 7,
  remoteSessions: 8,
  supportSessions: 9,
  authSessions: 10,
  networkChangeEvents: 11,
} as const;

function eligible(r: RetentionTargetResult | undefined): number {
  if (!r || r.mode !== 'report') throw new Error(`expected a report result, got ${r?.mode}`);
  return r.eligible;
}
function affected(r: RetentionTargetResult | undefined): number {
  if (!r || r.mode !== 'enforce') throw new Error(`expected an enforce result, got ${r?.mode}`);
  return r.affected;
}

/** For every one of the twelve targets, the report count equals the enforce count. */
function expectParity(report: RetentionTargetResult[], enforce: RetentionTargetResult[]) {
  expect(report).toHaveLength(12);
  expect(enforce).toHaveLength(12);
  for (let i = 0; i < 12; i++) {
    expect(eligible(report[i]), `eligible(report) === affected(enforce) for target #${i}`).toBe(affected(enforce[i]));
  }
}

async function surviving(table: AnyPgTable, idCol: AnyPgColumn, ids: string[]): Promise<Set<string>> {
  const rows = await getTestDb()
    .select({ id: idCol })
    .from(table)
    .where(inArray(idCol, ids)) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

describe('history retention (#4342 W5, real Postgres)', () => {
  let partnerId: string;
  let orgId: string;
  let siteId: string;
  let userId: string;
  let deviceId: string;

  beforeEach(async () => {
    const partner = await createPartner();
    partnerId = partner.id;
    orgId = (await createOrganization({ partnerId, name: 'History Retention Org' })).id;
    siteId = (await createSite({ orgId })).id;
    userId = (await createUser({ partnerId, orgId })).id;
    deviceId = (await createDevice({ orgId, siteId })).id;
  });

  /** Report run, then enforce run; asserts the report deleted nothing and parity across all targets. */
  async function reportThenEnforce(
    expectAllStillPresent: () => Promise<void>,
  ): Promise<RetentionTargetResult[]> {
    const report = await runHistoryRetention({ ...KNOBS, forceReport: true });
    await expectAllStillPresent();
    const enforce = await runHistoryRetention(KNOBS);
    expectParity(report, enforce);
    return enforce;
  }

  it('runs the twelve targets in the documented order', () => {
    expect(HISTORY_RETENTION_TARGETS.map((e) => e.target.table)).toEqual([
      'ai_agent_runs',
      'patch_job_results',
      'security_posture_snapshots',
      'cis_baseline_results',
      'automation_runs',
      'report_runs',
      'user_notifications',
      'user_notifications',
      'remote_sessions',
      'support_sessions',
      'sessions',
      'network_change_events',
    ]);
  });

  // -------------------------------------------------------------------------
  describe('ai_agent_runs', () => {
    it('keeps referenced, non-terminal and recent runs; deletes the rest and cascades its verdicts', async () => {
      const db = getTestDb();
      const [agent] = await db.insert(aiAgents)
        .values({ orgId, partnerId: null, kind: 'triage', name: 'Triage', createdBy: userId })
        .returning({ id: aiAgents.id });
      const agentId = agent!.id;

      async function run(status: string, finishedAt: Date | null): Promise<string> {
        const [row] = await db.insert(aiAgentRuns).values({
          agentId,
          orgId,
          triggerKind: 'alert',
          dedupeKey: `hist-ret-${randomUUID()}`,
          modeAtStart: 'shadow',
          policySnapshot: { schemaVersion: 1 } as never,
          status: status as never,
          finishedAt,
        }).returning({ id: aiAgentRuns.id });
        return row!.id;
      }

      const ids = {
        intentRun: await run('completed', daysAgo(500)),
        draftRun: await run('completed', daysAgo(500)),
        artifactRun: await run('completed', daysAgo(500)),
        deletedRun: await run('completed', daysAgo(500)),
        deletedFailed: await run('failed', daysAgo(450)),
        deletedThird: await run('cancelled', daysAgo(450)),
        runningFinished: await run('running', daysAgo(500)),
        runningNoFinish: await run('running', null),
        recent: await run('completed', daysAgo(10)),
      };
      const all = Object.values(ids);

      await db.insert(actionIntents).values({
        orgId,
        partnerId,
        requestedByUserId: null,
        requestingApiKeyId: null,
        requestingAgentRunId: ids.intentRun,
        source: 'ai_agent',
        originPrincipalKind: 'ai_agent',
        originPrincipalId: agentId,
        actionName: 'm365.mailbox.disable',
        actionVersion: 1,
        arguments: { mailbox: 'user@example.com' },
        argumentDigest: 'a'.repeat(64),
        targetSummary: 'Disable mailbox',
        impactSummary: 'User loses mailbox access',
        reason: 'Offboarding',
        riskTier: 3,
        idempotencyKey: `idem-${randomUUID()}`,
        correlationId: randomUUID(),
        expiresAt: new Date(Date.now() + HOUR_MS),
      });

      const [ticket] = await db.insert(tickets).values({
        orgId, partnerId, ticketNumber: `HR-${randomUUID().slice(0, 8)}`, subject: 'Retention ticket',
      }).returning({ id: tickets.id });
      await db.insert(ticketDrafts).values({
        ticketId: ticket!.id, orgId, kind: 'reply', content: 'Draft', runId: ids.draftRun,
      });

      await db.insert(aiRunArtifacts).values({
        orgId,
        runId: ids.artifactRun,
        kind: 'input_capture' as const,
        name: 'search_logs.json',
        contentType: 'application/json',
        bytes: 12_345,
        sha256: 'a'.repeat(64),
        blobKey: `us/2026/10/${randomUUID()}`,
        headPreview: '{"rows":[',
        tailPreview: ']}',
        createdByTool: 'search_logs',
      });

      // A verdict of the doomed run must cascade away with it.
      const [group] = await db.insert(alertCorrelationGroups).values({
        orgId, groupKey: `hist-ret-group-${randomUUID()}`, firstSeenAt: daysAgo(500), lastSeenAt: daysAgo(500),
      }).returning({ id: alertCorrelationGroups.id });
      await db.insert(aiAlertVerdicts).values({
        orgId,
        runId: ids.deletedRun,
        correlationGroupId: group!.id,
        classification: 'actionable',
        confidence: '0.90',
        rationale: 'retention cascade fixture',
      });

      const enforce = await reportThenEnforce(async () => {
        expect((await surviving(aiAgentRuns, aiAgentRuns.id, all)).size).toBe(all.length);
      });

      const left = await surviving(aiAgentRuns, aiAgentRuns.id, all);
      for (const k of ['deletedRun', 'deletedFailed', 'deletedThird'] as const) {
        expect(left.has(ids[k]), `${k} should be deleted`).toBe(false);
      }
      for (const k of ['intentRun', 'draftRun', 'artifactRun', 'runningFinished', 'runningNoFinish', 'recent'] as const) {
        expect(left.has(ids[k]), `${k} should survive`).toBe(true);
      }
      expect(affected(enforce[IDX.aiAgentRuns])).toBe(3);

      const verdicts = await db.select({ id: aiAlertVerdicts.id }).from(aiAlertVerdicts)
        .where(eq(aiAlertVerdicts.runId, ids.deletedRun));
      expect(verdicts).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('patch_job_results', () => {
    it('keeps the newest per (device, patch), pending-reboot evidence and non-terminal rows', async () => {
      const db = getTestDb();

      async function device(pendingReboot: boolean): Promise<string> {
        const id = (await createDevice({ orgId, siteId })).id;
        if (pendingReboot) {
          await getTestDb().execute(sql`UPDATE devices SET pending_reboot = true WHERE id = ${id}::uuid`);
        }
        return id;
      }
      async function patch(): Promise<string> {
        const [row] = await db.insert(patches).values({
          source: 'microsoft', externalId: `KB-${randomUUID()}`, title: 'Retention patch',
        }).returning({ id: patches.id });
        return row!.id;
      }
      async function job(status: 'completed' | 'running'): Promise<string> {
        const [row] = await db.insert(patchJobs).values({
          orgId, name: `job-${randomUUID().slice(0, 8)}`, status,
        }).returning({ id: patchJobs.id });
        return row!.id;
      }
      const doneJob = await job('completed');
      const runningJob = await job('running');
      const patchA = await patch();

      async function result(o: {
        jobId?: string; deviceId: string; patchId: string | null; ago: Date;
        status?: 'completed' | 'pending' | 'failed'; rebootRequired?: boolean;
      }): Promise<string> {
        const [row] = await db.insert(patchJobResults).values({
          jobId: o.jobId ?? doneJob,
          deviceId: o.deviceId,
          patchId: o.patchId,
          status: o.status ?? 'completed',
          rebootRequired: o.rebootRequired ?? false,
          createdAt: o.ago,
          completedAt: o.status === 'pending' ? null : o.ago,
        }).returning({ id: patchJobResults.id });
        return row!.id;
      }

      const d1 = await device(false); // three attempts at one patch
      const d2 = await device(false); // NULL patch_id summary rows
      const d3 = await device(true); // pending reboot
      const d4 = await device(false); // same shape, no pending reboot
      const d5 = await device(false); // running parent job
      const d6 = await device(false); // pending row
      const d7 = await device(false); // window edge

      const ids = {
        c1: await result({ deviceId: d1, patchId: patchA, ago: daysAgo(500) }),
        c2: await result({ deviceId: d1, patchId: patchA, ago: daysAgo(450) }),
        c3: await result({ deviceId: d1, patchId: patchA, ago: daysAgo(400) }),
        nullOld: await result({ deviceId: d2, patchId: null, ago: daysAgo(500) }),
        nullNew: await result({ deviceId: d2, patchId: null, ago: daysAgo(450) }),
        rebootKept: await result({ deviceId: d3, patchId: patchA, ago: daysAgo(500), rebootRequired: true }),
        rebootNewest: await result({ deviceId: d3, patchId: patchA, ago: daysAgo(450) }),
        noRebootDeleted: await result({ deviceId: d4, patchId: patchA, ago: daysAgo(500), rebootRequired: true }),
        noRebootNewest: await result({ deviceId: d4, patchId: patchA, ago: daysAgo(450) }),
        runningParent: await result({ deviceId: d5, patchId: patchA, ago: daysAgo(500), jobId: runningJob }),
        runningParentNewest: await result({ deviceId: d5, patchId: patchA, ago: daysAgo(450) }),
        pendingRow: await result({ deviceId: d6, patchId: patchA, ago: daysAgo(500), status: 'pending' }),
        pendingNewest: await result({ deviceId: d6, patchId: patchA, ago: daysAgo(450) }),
        edgeOld: await result({ deviceId: d7, patchId: patchA, ago: justPast(365) }),
        edgeNew: await result({ deviceId: d7, patchId: patchA, ago: justInside(365) }),
      };
      const all = Object.values(ids);

      const oldestBefore = await withSystemDbAccessContext(() => loadOldestRebootRequiredSince(d3, orgId));
      expect(oldestBefore).not.toBeNull();

      const enforce = await reportThenEnforce(async () => {
        expect((await surviving(patchJobResults, patchJobResults.id, all)).size).toBe(all.length);
      });

      const left = await surviving(patchJobResults, patchJobResults.id, all);
      const deleted = ['c1', 'c2', 'nullOld', 'noRebootDeleted', 'edgeOld'] as const;
      for (const k of deleted) expect(left.has(ids[k]), `${k} should be deleted`).toBe(false);
      const kept = [
        'c3', 'nullNew', 'rebootKept', 'rebootNewest', 'noRebootNewest',
        'runningParent', 'runningParentNewest', 'pendingRow', 'pendingNewest', 'edgeNew',
      ] as const;
      for (const k of kept) expect(left.has(ids[k]), `${k} should survive`).toBe(true);
      expect(affected(enforce[IDX.patchJobResults])).toBe(deleted.length);

      const oldestAfter = await withSystemDbAccessContext(() => loadOldestRebootRequiredSince(d3, orgId));
      expect(oldestAfter?.getTime()).toBe(oldestBefore?.getTime());
    });
  });

  // -------------------------------------------------------------------------
  describe('security_posture_snapshots and cis_baseline_results', () => {
    it('keeps the newest snapshot per device and the newest result per (device, baseline)', async () => {
      const db = getTestDb();

      async function snapshot(ago: Date, forDevice = deviceId): Promise<string> {
        const [row] = await db.insert(securityPostureSnapshots).values({
          orgId, deviceId: forDevice, capturedAt: ago, overallScore: 80, riskLevel: 'low',
          patchComplianceScore: 80, encryptionScore: 80, avHealthScore: 80, firewallScore: 80,
          openPortsScore: 80, passwordPolicyScore: 80, osCurrencyScore: 80, adminExposureScore: 80,
        }).returning({ id: securityPostureSnapshots.id });
        return row!.id;
      }
      const snaps = {
        s1: await snapshot(daysAgo(500)),
        s2: await snapshot(daysAgo(450)),
        s3: await snapshot(daysAgo(400)),
      };

      async function baseline(name: string): Promise<string> {
        const [row] = await db.insert(cisBaselines).values({
          orgId, name, osType: 'windows', benchmarkVersion: '1.0', level: 'l1',
        }).returning({ id: cisBaselines.id });
        return row!.id;
      }
      const baselineA = await baseline('A');
      const baselineB = await baseline('B');
      async function cis(baselineId: string, ago: Date): Promise<string> {
        const [row] = await db.insert(cisBaselineResults).values({
          orgId, deviceId, baselineId, checkedAt: ago,
          totalChecks: 10, passedChecks: 8, failedChecks: 2, score: 80,
        }).returning({ id: cisBaselineResults.id });
        return row!.id;
      }
      const results = {
        a1: await cis(baselineA, daysAgo(500)),
        a2: await cis(baselineA, daysAgo(450)),
        a3: await cis(baselineA, daysAgo(400)),
        bOnly: await cis(baselineB, daysAgo(500)),
      };
      const snapIds = Object.values(snaps);
      const cisIds = Object.values(results);

      const enforce = await reportThenEnforce(async () => {
        expect((await surviving(securityPostureSnapshots, securityPostureSnapshots.id, snapIds)).size).toBe(3);
        expect((await surviving(cisBaselineResults, cisBaselineResults.id, cisIds)).size).toBe(4);
      });

      const snapLeft = await surviving(securityPostureSnapshots, securityPostureSnapshots.id, snapIds);
      expect([...snapLeft]).toEqual([snaps.s3]);
      expect(affected(enforce[IDX.securityPosture])).toBe(2);

      const cisLeft = await surviving(cisBaselineResults, cisBaselineResults.id, cisIds);
      expect(cisLeft.has(results.a1)).toBe(false);
      expect(cisLeft.has(results.a2)).toBe(false);
      expect(cisLeft.has(results.a3)).toBe(true);
      expect(cisLeft.has(results.bOnly)).toBe(true);
      expect(affected(enforce[IDX.cisBaselineResults])).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('automation_runs', () => {
    it('deletes old terminal runs (cascading device results) and keeps running and recent ones', async () => {
      const db = getTestDb();
      const [automation] = await db.insert(automations).values({
        orgId, name: 'Retention automation', trigger: { type: 'manual' } as never, actions: [] as never,
      }).returning({ id: automations.id });

      async function run(status: 'completed' | 'failed' | 'running', completedAt: Date | null, startedAt: Date) {
        const [row] = await db.insert(automationRuns).values({
          automationId: automation!.id, triggeredBy: 'test', status, startedAt, completedAt,
        }).returning({ id: automationRuns.id });
        return row!.id;
      }
      const ids = {
        oldCompleted: await run('completed', daysAgo(200), daysAgo(200)),
        oldFailed: await run('failed', daysAgo(190), daysAgo(190)),
        oldRunning: await run('running', null, daysAgo(200)),
        recent: await run('completed', daysAgo(10), daysAgo(10)),
        edgeOld: await run('completed', justPast(180), justPast(180)),
        edgeNew: await run('completed', justInside(180), justInside(180)),
      };
      const all = Object.values(ids);
      const [child] = await db.insert(automationRunDeviceResults).values({
        runId: ids.oldCompleted, deviceId, orgId,
      }).returning({ id: automationRunDeviceResults.id });

      const enforce = await reportThenEnforce(async () => {
        expect((await surviving(automationRuns, automationRuns.id, all)).size).toBe(all.length);
      });

      const left = await surviving(automationRuns, automationRuns.id, all);
      for (const k of ['oldCompleted', 'oldFailed', 'edgeOld'] as const) {
        expect(left.has(ids[k]), `${k} should be deleted`).toBe(false);
      }
      for (const k of ['oldRunning', 'recent', 'edgeNew'] as const) {
        expect(left.has(ids[k]), `${k} should survive`).toBe(true);
      }
      expect(affected(enforce[IDX.automationRuns])).toBe(3);

      const childLeft = await db.select({ id: automationRunDeviceResults.id }).from(automationRunDeviceResults)
        .where(eq(automationRunDeviceResults.id, child!.id));
      expect(childLeft).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('report_runs', () => {
    it('keeps the newest run per report, cited runs and in-flight runs; cascades deliveries', async () => {
      const db = getTestDb();

      async function report(name: string): Promise<string> {
        const [row] = await db.insert(reports).values({
          orgId, name, type: 'device_inventory', createdBy: userId,
        }).returning({ id: reports.id });
        return row!.id;
      }
      async function run(
        reportId: string, status: 'completed' | 'failed' | 'running' | 'pending', ago: Date,
      ): Promise<string> {
        const [row] = await db.insert(reportRuns).values({
          reportId,
          status,
          createdAt: ago,
          completedAt: status === 'completed' || status === 'failed' ? ago : null,
        }).returning({ id: reportRuns.id });
        return row!.id;
      }

      const dormant = await report('Dormant');
      const busy = await report('Busy');
      const ids = {
        dormantOld: await run(dormant, 'completed', daysAgo(500)),
        dormantNewest: await run(dormant, 'completed', daysAgo(450)),
        cited: await run(busy, 'completed', daysAgo(500)),
        plain1: await run(busy, 'completed', daysAgo(480)),
        plain2: await run(busy, 'failed', daysAgo(470)),
        running: await run(busy, 'running', daysAgo(460)),
        pending: await run(busy, 'pending', daysAgo(440)),
        busyNewest: await run(busy, 'completed', daysAgo(400)),
      };
      const all = Object.values(ids);

      // `cited` is evidence for a service deliverable occurrence.
      const [deliverable] = await db.insert(serviceDeliverables).values({
        orgId, name: 'Retention deliverable', cadence: 'monthly',
        anchorDueDate: '2026-09-30', effectiveFrom: '2026-01-01',
      }).returning({ id: serviceDeliverables.id });
      const [occurrence] = await db.insert(serviceDeliverableOccurrences).values({
        orgId, deliverableId: deliverable!.id, nameSnapshot: 'Retention deliverable',
        periodStart: '2026-09-01', periodEnd: '2026-09-30', dueAt: '2026-09-30',
        originalDueAt: '2026-09-30', status: 'delivered', deliveredAt: new Date('2026-09-29T12:00:00Z'),
      }).returning({ id: serviceDeliverableOccurrences.id });
      await db.insert(serviceDeliverableEvidence).values({
        orgId, occurrenceId: occurrence!.id, kind: 'report_run', reportId: busy, reportRunId: ids.cited,
      });

      const [delivery] = await db.insert(reportRunDeliveries).values({
        reportRunId: ids.plain1, recipientUserId: userId, channel: 'email',
      }).returning({ id: reportRunDeliveries.id });

      const enforce = await reportThenEnforce(async () => {
        expect((await surviving(reportRuns, reportRuns.id, all)).size).toBe(all.length);
      });

      const left = await surviving(reportRuns, reportRuns.id, all);
      const deleted = ['dormantOld', 'plain1', 'plain2'] as const;
      for (const k of deleted) expect(left.has(ids[k]), `${k} should be deleted`).toBe(false);
      for (const k of ['dormantNewest', 'cited', 'running', 'pending', 'busyNewest'] as const) {
        expect(left.has(ids[k]), `${k} should survive`).toBe(true);
      }
      expect(affected(enforce[IDX.reportRuns])).toBe(deleted.length);

      const deliveryLeft = await db.select({ id: reportRunDeliveries.id }).from(reportRunDeliveries)
        .where(eq(reportRunDeliveries.id, delivery!.id));
      expect(deliveryLeft).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('user_notifications', () => {
    it('ages read rows by read_at and everything else by created_at, sparing unread approvals', async () => {
      const db = getTestDb();
      async function note(o: {
        type: 'approval' | 'system'; read: boolean; readAt?: Date | null; createdAt: Date;
      }): Promise<string> {
        const [row] = await db.insert(userNotifications).values({
          userId, orgId, type: o.type, title: 'n', read: o.read, readAt: o.readAt ?? null, createdAt: o.createdAt,
        }).returning({ id: userNotifications.id });
        return row!.id;
      }
      const ids = {
        readOld: await note({ type: 'system', read: true, readAt: daysAgo(91), createdAt: daysAgo(100) }),
        readFresh: await note({ type: 'system', read: true, readAt: daysAgo(89), createdAt: daysAgo(100) }),
        unreadApprovalOld: await note({ type: 'approval', read: false, createdAt: daysAgo(400) }),
        unreadSystemOld: await note({ type: 'system', read: false, createdAt: daysAgo(400) }),
        readApprovalOld: await note({ type: 'approval', read: true, readAt: daysAgo(10), createdAt: daysAgo(400) }),
      };
      const all = Object.values(ids);

      const enforce = await reportThenEnforce(async () => {
        expect((await surviving(userNotifications, userNotifications.id, all)).size).toBe(all.length);
      });

      const left = await surviving(userNotifications, userNotifications.id, all);
      for (const k of ['readOld', 'unreadSystemOld', 'readApprovalOld'] as const) {
        expect(left.has(ids[k]), `${k} should be deleted`).toBe(false);
      }
      for (const k of ['readFresh', 'unreadApprovalOld'] as const) {
        expect(left.has(ids[k]), `${k} should survive`).toBe(true);
      }
      expect(affected(enforce[IDX.notificationsRead])).toBe(1);
      expect(affected(enforce[IDX.notificationsAll])).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('remote_sessions and support_sessions', () => {
    it('deletes ended sessions past the window and keeps live or pending ones', async () => {
      const db = getTestDb();

      async function remote(status: 'disconnected' | 'active', endedAt: Date | null, createdAt: Date) {
        const [row] = await db.insert(remoteSessions).values({
          deviceId, orgId, userId, type: 'desktop', status, endedAt, createdAt,
        }).returning({ id: remoteSessions.id });
        return row!.id;
      }
      const remoteIds = {
        ended: await remote('disconnected', daysAgo(400), daysAgo(401)),
        active: await remote('active', null, daysAgo(400)),
        endedRecent: await remote('disconnected', daysAgo(10), daysAgo(11)),
      };

      async function support(status: 'ended' | 'pending', endedAt: Date | null, createdAt: Date) {
        const [row] = await db.insert(supportSessions).values({
          orgId,
          createdByUserId: userId,
          codeHash: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
          codeExpiresAt: new Date(createdAt.getTime() + HOUR_MS),
          hardExpiresAt: new Date(createdAt.getTime() + 2 * HOUR_MS),
          status,
          endedAt,
          createdAt,
        }).returning({ id: supportSessions.id });
        return row!.id;
      }
      const supportIds = {
        ended: await support('ended', daysAgo(400), daysAgo(401)),
        pending: await support('pending', null, daysAgo(400)),
        endedRecent: await support('ended', daysAgo(10), daysAgo(11)),
      };

      const enforce = await reportThenEnforce(async () => {
        expect((await surviving(remoteSessions, remoteSessions.id, Object.values(remoteIds))).size).toBe(3);
        expect((await surviving(supportSessions, supportSessions.id, Object.values(supportIds))).size).toBe(3);
      });

      const remoteLeft = await surviving(remoteSessions, remoteSessions.id, Object.values(remoteIds));
      expect(remoteLeft.has(remoteIds.ended)).toBe(false);
      expect(remoteLeft.has(remoteIds.active)).toBe(true);
      expect(remoteLeft.has(remoteIds.endedRecent)).toBe(true);
      expect(affected(enforce[IDX.remoteSessions])).toBe(1);

      const supportLeft = await surviving(supportSessions, supportSessions.id, Object.values(supportIds));
      expect(supportLeft.has(supportIds.ended)).toBe(false);
      expect(supportLeft.has(supportIds.pending)).toBe(true);
      expect(supportLeft.has(supportIds.endedRecent)).toBe(true);
      expect(affected(enforce[IDX.supportSessions])).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('sessions (auth)', () => {
    it('needs both an old row and an expired one, and honours the 30-day floor', async () => {
      const db = getTestDb();
      async function session(createdAt: Date, expiresAt: Date): Promise<string> {
        const [row] = await db.insert(sessions).values({
          userId, tokenHash: `hash-${randomUUID()}`, createdAt, expiresAt,
        }).returning({ id: sessions.id });
        return row!.id;
      }
      const ids = {
        youngExpired: await session(daysAgo(20), daysAgo(13)),
        oldExpired: await session(daysAgo(31), daysAgo(24)),
        oldStillValid: await session(daysAgo(31), new Date(NOW + 7 * DAY_MS)),
        oldExpiredB: await session(daysAgo(60), daysAgo(50)),
        oldExpiredC: await session(daysAgo(90), daysAgo(80)),
      };
      const all = Object.values(ids);

      const enforce = await reportThenEnforce(async () => {
        expect((await surviving(sessions, sessions.id, all)).size).toBe(all.length);
      });

      const left = await surviving(sessions, sessions.id, all);
      for (const k of ['oldExpired', 'oldExpiredB', 'oldExpiredC'] as const) {
        expect(left.has(ids[k]), `${k} should be deleted`).toBe(false);
      }
      for (const k of ['youngExpired', 'oldStillValid'] as const) {
        expect(left.has(ids[k]), `${k} should survive`).toBe(true);
      }
      expect(affected(enforce[IDX.authSessions])).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  describe('network_change_events', () => {
    it('uses each profile\'s changeRetentionDays, and the job window when it is missing or junk', async () => {
      const db = getTestDb();
      const [baseline] = await db.insert(networkBaselines).values({
        orgId, siteId, subnet: '10.0.0.0/24',
      }).returning({ id: networkBaselines.id });

      async function profile(name: string, alertSettings: Record<string, unknown>): Promise<string> {
        const [row] = await db.insert(discoveryProfiles).values({
          orgId, siteId, name, alertSettings: alertSettings as never,
        }).returning({ id: discoveryProfiles.id });
        return row!.id;
      }
      const thirty = await profile('thirty', { enabled: true, changeRetentionDays: 30 });
      const junk = await profile('junk', { enabled: true, changeRetentionDays: 'abc' });
      const disabled = await profile('disabled', { enabled: false, changeRetentionDays: 30 });

      let n = 0;
      async function event(profileId: string | null, ago: Date): Promise<string> {
        n += 1;
        const [row] = await db.insert(networkChangeEvents).values({
          orgId, siteId, baselineId: baseline!.id, profileId, eventType: 'new_device',
          ipAddress: `10.0.0.${n}`, detectedAt: ago,
        }).returning({ id: networkChangeEvents.id });
        return row!.id;
      }
      const ids = {
        thirtyOld: await event(thirty, daysAgo(31)),
        thirtyFresh: await event(thirty, daysAgo(29)),
        noProfileOld: await event(null, daysAgo(91)),
        noProfileFresh: await event(null, daysAgo(89)),
        junkOld: await event(junk, daysAgo(91)),
        junkFresh: await event(junk, daysAgo(89)),
        disabledOld: await event(disabled, daysAgo(31)),
      };
      const all = Object.values(ids);

      const enforce = await reportThenEnforce(async () => {
        expect((await surviving(networkChangeEvents, networkChangeEvents.id, all)).size).toBe(all.length);
      });

      const left = await surviving(networkChangeEvents, networkChangeEvents.id, all);
      const deleted = ['thirtyOld', 'noProfileOld', 'junkOld', 'disabledOld'] as const;
      for (const k of deleted) expect(left.has(ids[k]), `${k} should be deleted`).toBe(false);
      for (const k of ['thirtyFresh', 'noProfileFresh', 'junkFresh'] as const) {
        expect(left.has(ids[k]), `${k} should survive`).toBe(true);
      }
      expect(affected(enforce[IDX.networkChangeEvents])).toBe(deleted.length);
    });
  });
});
