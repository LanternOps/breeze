/**
 * AI Scorecard W04 (#5761, refs #4182) — live-Postgres proof for the
 * EXPOSURE-TIME cohort predicate.
 *
 * The whole honesty of the measured band rests on one question: did the AI
 * actually look at this item *before* the outcome it is being credited with?
 * The unit/contract suites can only assert the SHAPE of the generated SQL.
 * These cases assert what Postgres does with it — and each one corresponds to a
 * defect verified on `main` that a linkage-based join would reintroduce:
 *
 *  1. **Reverse temporal attribution.** `UNGROUPED_VERDICT_DELAY_MINUTES = 10`
 *     means an alert must stay open ten minutes before it gets its own verdict
 *     run. An alert that self-resolves in five minutes and is analysed
 *     afterwards would enter a linkage cohort with a five-minute MTTR.
 *  2. **Group verdicts carry `alert_id = NULL` by design**, so a
 *     `WHERE v.alert_id = a.id` predicate silently drops every grouped alert.
 *  3. **A never-started run is not exposure** — `ai_agent_runs` has no
 *     `created_at`, and `queued_at` is deliberately not a fallback.
 *  4. **The timestamp trap.** `alerts.triggered_at` is `timestamp` WITHOUT time
 *     zone; `ai_alert_verdicts.created_at` IS `timestamptz`. A 23:30 UTC verdict
 *     must not be sorted into the wrong day.
 *  5. **Org isolation** under a real RLS context as `breeze_app`.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { ALERT_EXPOSURE_AGE_MINUTES } from '@breeze/shared';

import { db, withDbAccessContext } from '../../db';
import {
  aiAgentRuns,
  aiAgents,
  aiAlertVerdicts,
  alertCorrelationGroups,
  alertCorrelationMembers,
  alertRules,
  alertTemplates,
  alerts,
  devices,
} from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { lastCompleteUtcDay, shiftUtcDay, type UtcDay } from '../../services/aiAgents/impactRollup';
import { alertCohortQuery } from '../../services/aiAgents/impactMeasuredCohorts';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

const THROUGH: UtcDay = lastCompleteUtcDay();
const FROM: UtcDay = shiftUtcDay(THROUGH, -29);
/** A day comfortably inside the window, so L + H always fits. */
const DAY: UtcDay = shiftUtcDay(THROUGH, -10);

const MINUTE_MS = 60_000;
const at = (day: UtcDay, hours: number, minutes = 0): Date =>
  new Date(`${day}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z`);
const plusMinutes = (base: Date, minutes: number): Date => new Date(base.getTime() + minutes * MINUTE_MS);

interface Tenant {
  partnerId: string;
  orgId: string;
  userId: string;
  siteId: string;
  deviceId: string;
  agentId: string;
  ruleId: string;
}

async function createTenant(partnerId?: string): Promise<Tenant> {
  const adminDb = getTestDb() as never as {
    insert: (table: unknown) => { values: (v: unknown) => { returning: () => Promise<{ id: string }[]> } };
  };
  const owner = partnerId ?? (await createPartner()).id;
  const org = await createOrganization({ partnerId: owner });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({
    partnerId: owner,
    orgId: org.id,
    email: `measured-${randomUUID().slice(0, 8)}@example.test`,
  });
  const [device] = await adminDb.insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: randomUUID(),
    hostname: `measured-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'offline',
  }).returning();
  const [template] = await adminDb.insert(alertTemplates).values({
    orgId: org.id,
    partnerId: null,
    name: 'Measured fixture template',
    conditions: {},
    severity: 'medium',
    titleTemplate: 'Measured fixture alert',
    messageTemplate: 'Measured fixture alert',
  }).returning();
  const [rule] = await adminDb.insert(alertRules).values({
    orgId: org.id,
    templateId: template!.id,
    name: 'Measured fixture rule',
    targetType: 'organization',
    targetId: org.id,
  }).returning();
  const [agent] = await adminDb.insert(aiAgents).values({
    orgId: org.id,
    partnerId: null,
    kind: 'triage',
    name: 'Measured fixture agent',
    createdBy: user.id,
  }).returning();

  return {
    partnerId: owner,
    orgId: org.id,
    userId: user.id,
    siteId: site.id,
    deviceId: device!.id,
    agentId: agent!.id,
    ruleId: rule!.id,
  };
}

function orgAuth(t: Tenant): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([t.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: t.userId, email: 'measured@example.test', name: 'Measured Reader', isPlatformAdmin: false },
    token: null,
    partnerId: t.partnerId,
    orgId: t.orgId,
    scope: 'organization',
    accessibleOrgIds: [t.orgId],
    orgCondition,
    canAccessOrg,
  } as AuthContext;
}

const dbContextFor = (t: Tenant) => ({
  scope: 'organization' as const,
  orgId: t.orgId,
  currentUserId: t.userId,
  currentPartnerId: t.partnerId,
  accessibleOrgIds: [t.orgId],
  accessiblePartnerIds: [],
});

async function insertAlert(t: Tenant, opts: {
  triggeredAt: Date;
  resolvedAt?: Date | null;
  status?: 'active' | 'acknowledged' | 'resolved' | 'suppressed' | 'dismissed';
  ruleId?: string;
}): Promise<string> {
  const adminDb = getTestDb() as never as {
    insert: (table: unknown) => { values: (v: unknown) => { returning: () => Promise<{ id: string }[]> } };
  };
  const [row] = await adminDb.insert(alerts).values({
    orgId: t.orgId,
    deviceId: t.deviceId,
    ruleId: opts.ruleId ?? t.ruleId,
    severity: 'medium',
    title: 'Measured fixture alert',
    status: opts.status ?? (opts.resolvedAt ? 'resolved' : 'active'),
    triggeredAt: opts.triggeredAt,
    resolvedAt: opts.resolvedAt ?? null,
  }).returning();
  return row!.id;
}

async function insertRun(t: Tenant, opts: { alertId?: string | null; startedAt: Date | null; queuedAt: Date }): Promise<string> {
  const adminDb = getTestDb() as never as {
    insert: (table: unknown) => { values: (v: unknown) => { returning: () => Promise<{ id: string }[]> } };
  };
  const [row] = await adminDb.insert(aiAgentRuns).values({
    orgId: t.orgId,
    agentId: t.agentId,
    profile: 'verdict',
    triggerKind: 'manual',
    dedupeKey: `measured-${randomUUID()}`,
    modeAtStart: 'shadow',
    policySnapshot: { schemaVersion: 1 },
    status: opts.startedAt ? 'completed' : 'queued',
    alertId: opts.alertId ?? null,
    queuedAt: opts.queuedAt,
    startedAt: opts.startedAt,
  }).returning();
  return row!.id;
}

async function insertVerdict(t: Tenant, opts: {
  runId: string;
  alertId?: string | null;
  correlationGroupId?: string | null;
  createdAt: Date;
}): Promise<void> {
  const adminDb = getTestDb() as never as {
    insert: (table: unknown) => { values: (v: unknown) => Promise<unknown> };
  };
  await adminDb.insert(aiAlertVerdicts).values({
    orgId: t.orgId,
    runId: opts.runId,
    alertId: opts.alertId ?? null,
    correlationGroupId: opts.correlationGroupId ?? null,
    classification: 'actionable',
    confidence: '0.90',
    rationale: 'fixture',
    createdAt: opts.createdAt,
  });
}

async function insertGroupWithMember(t: Tenant, alertId: string): Promise<string> {
  const adminDb = getTestDb() as never as {
    insert: (table: unknown) => { values: (v: unknown) => { returning: () => Promise<{ id: string }[]> } };
  };
  const [group] = await adminDb.insert(alertCorrelationGroups).values({
    orgId: t.orgId,
    groupKey: `measured-${randomUUID().slice(0, 8)}`,
    rootAlertId: alertId,
    status: 'open',
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  }).returning();
  const insertMember = getTestDb() as never as {
    insert: (table: unknown) => { values: (v: unknown) => Promise<unknown> };
  };
  await insertMember.insert(alertCorrelationMembers).values({
    orgId: t.orgId,
    groupId: group!.id,
    alertId,
  });
  return group!.id;
}

/**
 * `exposure_at` comes back as a NAIVE timestamp (the SQL applies
 * `AT TIME ZONE 'UTC'` to the timestamptz sources, which is what makes it
 * comparable to `alerts.triggered_at`). postgres.js parses a naive timestamp
 * using the NODE process's local zone, so the Date it hands back carries the
 * right wall clock in the wrong zone. Re-read its LOCAL components as UTC to
 * recover the instant. Storage and the in-SQL comparisons are unaffected --
 * this is purely a read-back artefact of asserting from JS.
 */
function naiveUtcToInstant(value: Date): Date {
  return new Date(Date.UTC(
    value.getFullYear(), value.getMonth(), value.getDate(),
    value.getHours(), value.getMinutes(), value.getSeconds(), value.getMilliseconds(),
  ));
}

interface ExposureRow {
  alertId: string;
  orgId: string;
  exposureAt: Date | null;
  aiTouched: boolean;
}

/**
 * The cohort rows that carry an AI exposure, read as `breeze_app` under the
 * caller's own org-scoped access context — so RLS is genuinely in play.
 */
async function loadAlertExposure(t: Tenant, from: UtcDay, through: UtcDay): Promise<ExposureRow[]> {
  const auth = orgAuth(t);
  return withDbAccessContext(dbContextFor(t), async () => {
    const rows = (await db.execute(
      alertCohortQuery([t.orgId], from, through, auth.orgCondition(alerts.orgId)),
    )) as unknown as Record<string, unknown>[];
    return rows
      .filter((r) => r.exposure_at !== null && r.exposure_at !== undefined)
      .map((r) => ({
        alertId: String(r.alert_id),
        orgId: String(r.org_id),
        exposureAt: naiveUtcToInstant(
          r.exposure_at instanceof Date ? r.exposure_at : new Date(String(r.exposure_at)),
        ),
        aiTouched: r.ai_touched === true,
      }));
  });
}

describe('measured impact — exposure-time cohort formation', () => {
  it('EXCLUDES a self-resolving alert that was only analysed afterwards', async () => {
    const t = await createTenant();
    const triggered = at(DAY, 9);
    // Resolved at +5 min; the scheduler cannot even have looked before +10.
    const alertId = await insertAlert(t, { triggeredAt: triggered, resolvedAt: plusMinutes(triggered, 5) });
    const runId = await insertRun(t, { alertId, queuedAt: plusMinutes(triggered, 11), startedAt: plusMinutes(triggered, 11) });
    await insertVerdict(t, { runId, alertId, createdAt: plusMinutes(triggered, 11) });

    const rows = await loadAlertExposure(t, FROM, THROUGH);

    // Not merely in the untouched arm: not in the cohort at all, because it was
    // already closed before the cohort-formation age.
    expect(rows.find((r) => r.alertId === alertId)).toBeUndefined();
  });

  it('INCLUDES a group-verdict alert exactly once, even though the verdict has alert_id NULL', async () => {
    const t = await createTenant();
    const triggered = at(DAY, 10);
    const alertId = await insertAlert(t, { triggeredAt: triggered, resolvedAt: plusMinutes(triggered, 120) });
    const groupId = await insertGroupWithMember(t, alertId);
    const runId = await insertRun(t, { alertId: null, queuedAt: plusMinutes(triggered, 2), startedAt: plusMinutes(triggered, 2) });
    const groupVerdictAt = plusMinutes(triggered, 3);
    await insertVerdict(t, { runId, alertId: null, correlationGroupId: groupId, createdAt: groupVerdictAt });

    const rows = await loadAlertExposure(t, FROM, THROUGH);

    const hits = rows.filter((r) => r.alertId === alertId);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.exposureAt!.toISOString()).toBe(groupVerdictAt.toISOString());
    expect(hits[0]!.aiTouched).toBe(true);
  });

  it('takes the EARLIEST contact when an alert has both a direct verdict and a group verdict', async () => {
    const t = await createTenant();
    const triggered = at(DAY, 11);
    const alertId = await insertAlert(t, { triggeredAt: triggered, resolvedAt: plusMinutes(triggered, 240) });
    const groupId = await insertGroupWithMember(t, alertId);
    const earlier = plusMinutes(triggered, 2);
    const later = plusMinutes(triggered, 8);

    const groupRunId = await insertRun(t, { alertId: null, queuedAt: earlier, startedAt: earlier });
    await insertVerdict(t, { runId: groupRunId, alertId: null, correlationGroupId: groupId, createdAt: earlier });
    const directRunId = await insertRun(t, { alertId, queuedAt: later, startedAt: later });
    await insertVerdict(t, { runId: directRunId, alertId, createdAt: later });

    const rows = await loadAlertExposure(t, FROM, THROUGH);

    expect(rows.find((r) => r.alertId === alertId)!.exposureAt!.toISOString()).toBe(earlier.toISOString());
  });

  it('ignores a run that never started — a queued run is not exposure', async () => {
    const t = await createTenant();
    const triggered = at(DAY, 12);
    const alertId = await insertAlert(t, { triggeredAt: triggered, resolvedAt: plusMinutes(triggered, 90) });
    await insertRun(t, { alertId, queuedAt: plusMinutes(triggered, 1), startedAt: null });

    const rows = await loadAlertExposure(t, FROM, THROUGH);

    expect(rows.find((r) => r.alertId === alertId)).toBeUndefined();
  });

  it('does not shift a 23:30 UTC verdict into the next day (timestamp vs timestamptz)', async () => {
    const t = await createTenant();
    // Triggered late on DAY; the verdict lands minutes later, still on DAY.
    const triggered = at(DAY, 23, 30);
    const alertId = await insertAlert(t, { triggeredAt: triggered, resolvedAt: plusMinutes(triggered, 60) });
    const contact = plusMinutes(triggered, 2);
    const runId = await insertRun(t, { alertId, queuedAt: contact, startedAt: contact });
    await insertVerdict(t, { runId, alertId, createdAt: contact });

    // A single-day window: an AT TIME ZONE applied to the naive alerts columns
    // (or omitted from the timestamptz ones) pushes this row out of range.
    const rows = await loadAlertExposure(t, DAY, DAY);

    const hit = rows.find((r) => r.alertId === alertId);
    expect(hit).toBeDefined();
    expect(hit!.exposureAt!.toISOString()).toBe(contact.toISOString());
  });

  it('puts a LATE contact in the untouched arm rather than the AI arm', async () => {
    const t = await createTenant();
    const triggered = at(DAY, 13);
    const alertId = await insertAlert(t, { triggeredAt: triggered, resolvedAt: plusMinutes(triggered, 300) });
    // One minute past the exposure age: the AI looked, but too late to be
    // credited with the outcome.
    const contact = plusMinutes(triggered, ALERT_EXPOSURE_AGE_MINUTES + 1);
    const runId = await insertRun(t, { alertId, queuedAt: contact, startedAt: contact });
    await insertVerdict(t, { runId, alertId, createdAt: contact });

    const rows = await loadAlertExposure(t, FROM, THROUGH);

    expect(rows.find((r) => r.alertId === alertId)!.aiTouched).toBe(false);
  });

  it('never crosses an org boundary', async () => {
    const a = await createTenant();
    const b = await createTenant(a.partnerId);
    for (const t of [a, b]) {
      const triggered = at(DAY, 14);
      const alertId = await insertAlert(t, { triggeredAt: triggered, resolvedAt: plusMinutes(triggered, 90) });
      const contact = plusMinutes(triggered, 2);
      const runId = await insertRun(t, { alertId, queuedAt: contact, startedAt: contact });
      await insertVerdict(t, { runId, alertId, createdAt: contact });
    }

    const rows = await loadAlertExposure(a, FROM, THROUGH);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.orgId === a.orgId)).toBe(true);
    expect(rows.some((r) => r.orgId === b.orgId)).toBe(false);
  });

  it('the cohort scan uses alerts_org_rule_triggered_idx rather than a sequential scan', async () => {
    const t = await createTenant();
    const auth = orgAuth(t);

    const plan = await withDbAccessContext(dbContextFor(t), async () => {
      await db.execute(sql`SET LOCAL enable_seqscan = off`);
      const rows = (await db.execute(
        sql`EXPLAIN ${alertCohortQuery([t.orgId], FROM, THROUGH, auth.orgCondition(alerts.orgId))}`,
      )) as unknown as Record<string, unknown>[];
      return rows.map((r) => String(Object.values(r)[0])).join('\n');
    });

    expect(plan).toContain('alerts_org_rule_triggered_idx');
  });
});
