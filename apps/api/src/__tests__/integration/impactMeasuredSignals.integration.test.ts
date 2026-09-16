/**
 * AI Scorecard W04 (#5761, refs #4182) — live-Postgres proof for the three
 * measured signals and the p95 read budget.
 *
 * Sibling of `impactMeasuredExposure.integration.test.ts`, which proves the
 * cohort PREDICATE. This file proves what the loaders do with the rows:
 *
 *  - arms split within one rule / one priority+category, never across;
 *  - the n >= 20 display gate withholds a cohort rather than showing a
 *    small-sample number;
 *  - a suppressed alert is NOT a resolution — counting one would make noise
 *    suppression look like fixing things;
 *  - a still-open alert is CENSORED, not dropped;
 *  - soft-deleted tickets are excluded;
 *  - a running timer (NULL duration_minutes) contributes no recorded minutes,
 *    and an unlogged ticket lowers coverage instead of counting as zero labour;
 *  - the whole 90-day read stays inside its p95 budget (spec OD-6 A). If it
 *    ever does not, the answer is the OD-6 B rollup table, NOT a looser budget.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  ALERT_EXPOSURE_AGE_MINUTES,
  MEASURED_MAX_WINDOW_DAYS,
  MEASURED_MIN_COHORT_N,
  TICKET_EXPOSURE_AGE_MINUTES,
} from '@breeze/shared';

import { withDbAccessContext } from '../../db';
import {
  aiAgentRuns,
  aiAgents,
  aiAlertVerdicts,
  alertRules,
  alertTemplates,
  alerts,
  devices,
  ticketDrafts,
  tickets,
  timeEntries,
} from '../../db/schema';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { lastCompleteUtcDay, shiftUtcDay, type UtcDay } from '../../services/aiAgents/impactRollup';
import {
  loadAlertResolutionSignal,
  loadTechnicianMinutes,
  loadTicketFirstResponseSignal,
  type MeasuredWindow,
} from '../../services/aiAgents/impactMeasuredSignals';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';

const THROUGH: UtcDay = lastCompleteUtcDay();
/** 90-day span, matching `MEASURED_MAX_WINDOW_DAYS` -- this file proves the whole read at the app's longest window. */
const FROM: UtcDay = shiftUtcDay(THROUGH, -89);
/** Comfortably inside the window so L + H always fits. */
const DAY: UtcDay = shiftUtcDay(THROUGH, -10);
/** A below-max window, used only to prove `insufficient_followup` still fires there (#5879). */
const SHORT_FROM: UtcDay = shiftUtcDay(THROUGH, -29);

const MINUTE_MS = 60_000;
const at = (day: UtcDay, hours: number, minutes = 0): Date =>
  new Date(`${day}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z`);
const plusMinutes = (base: Date, minutes: number): Date => new Date(base.getTime() + minutes * MINUTE_MS);

const N = MEASURED_MIN_COHORT_N + 5; // comfortably over the gate

type Admin = {
  insert: (table: unknown) => {
    values: (v: unknown) => Promise<unknown> & { returning: () => Promise<{ id: string }[]> };
  };
};
const admin = () => getTestDb() as never as Admin;

interface Tenant {
  partnerId: string;
  orgId: string;
  userId: string;
  deviceId: string;
  agentId: string;
  ruleA: string;
  ruleB: string;
  ruleSparse: string;
}

async function createRule(orgId: string, name: string): Promise<string> {
  const [template] = await admin().insert(alertTemplates).values({
    orgId,
    partnerId: null,
    name: `${name} template`,
    conditions: {},
    severity: 'medium',
    titleTemplate: name,
    messageTemplate: name,
  }).returning();
  const [rule] = await admin().insert(alertRules).values({
    orgId,
    templateId: template!.id,
    name,
    targetType: 'organization',
    targetId: orgId,
  }).returning();
  return rule!.id;
}

async function createTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `signals-${randomUUID().slice(0, 8)}@example.test`,
  });
  const [device] = await admin().insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: randomUUID(),
    hostname: `signals-${randomUUID().slice(0, 8)}`,
    osType: 'windows',
    osVersion: '11',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'offline',
  }).returning();
  const [agent] = await admin().insert(aiAgents).values({
    orgId: org.id,
    partnerId: null,
    kind: 'triage',
    name: 'Signals fixture agent',
    createdBy: user.id,
  }).returning();

  return {
    partnerId: partner.id,
    orgId: org.id,
    userId: user.id,
    deviceId: device!.id,
    agentId: agent!.id,
    ruleA: await createRule(org.id, 'Rule A'),
    ruleB: await createRule(org.id, 'Rule B'),
    ruleSparse: await createRule(org.id, 'Rule Sparse'),
  };
}

function orgAuth(t: Tenant): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([t.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: t.userId, email: 'signals@example.test', name: 'Signals Reader', isPlatformAdmin: false },
    token: null,
    partnerId: t.partnerId,
    orgId: t.orgId,
    scope: 'organization',
    accessibleOrgIds: [t.orgId],
    orgCondition,
    canAccessOrg,
  } as AuthContext;
}

/**
 * `time_entries` is a PARTNER-AXIS table: an organization-scoped RLS context has
 * `accessible_partner_ids = []` and reads ZERO rows from it — not an error, just
 * silence. That is precisely why `loadMeasuredImpact` requires partner scope for
 * the technician-minutes arm and omits it otherwise, and why this fixture must
 * use a partner context to see anything at all.
 */
function partnerAuth(t: Tenant): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([t.orgId]);
  return {
    principal: { kind: 'user_session' },
    user: { id: t.userId, email: 'signals@example.test', name: 'Signals Reader', isPlatformAdmin: false },
    token: null,
    partnerId: t.partnerId,
    orgId: null,
    scope: 'partner',
    accessibleOrgIds: [t.orgId],
    orgCondition,
    canAccessOrg,
  } as AuthContext;
}

const partnerDbContextFor = (t: Tenant) => ({
  scope: 'partner' as const,
  orgId: null,
  currentUserId: t.userId,
  currentPartnerId: t.partnerId,
  accessibleOrgIds: [t.orgId],
  accessiblePartnerIds: [t.partnerId],
});

const dbContextFor = (t: Tenant) => ({
  scope: 'organization' as const,
  orgId: t.orgId,
  currentUserId: t.userId,
  currentPartnerId: t.partnerId,
  accessibleOrgIds: [t.orgId],
  accessiblePartnerIds: [],
});

const windowFor = (t: Tenant): MeasuredWindow => ({
  orgIds: [t.orgId],
  from: FROM,
  through: THROUGH,
  windowDays: MEASURED_MAX_WINDOW_DAYS,
});

/** A below-max window over the same tenant, for the #5879 regression test. */
const shortWindowFor = (t: Tenant): MeasuredWindow => ({
  orgIds: [t.orgId],
  from: SHORT_FROM,
  through: THROUGH,
  windowDays: 30,
});

/** One alert, optionally exposed to the AI within the cohort-formation age. */
async function seedAlert(t: Tenant, opts: {
  ruleId: string;
  triggeredAt: Date;
  resolvedAt?: Date | null;
  status?: 'active' | 'acknowledged' | 'resolved' | 'suppressed' | 'dismissed';
  exposed: boolean;
}): Promise<string> {
  const [row] = await admin().insert(alerts).values({
    orgId: t.orgId,
    deviceId: t.deviceId,
    ruleId: opts.ruleId,
    severity: 'medium',
    title: 'Signals fixture alert',
    status: opts.status ?? (opts.resolvedAt ? 'resolved' : 'active'),
    triggeredAt: opts.triggeredAt,
    resolvedAt: opts.resolvedAt ?? null,
  }).returning();

  if (opts.exposed) {
    const contact = plusMinutes(opts.triggeredAt, 2);
    const [run] = await admin().insert(aiAgentRuns).values({
      orgId: t.orgId,
      agentId: t.agentId,
      profile: 'verdict',
      triggerKind: 'manual',
      dedupeKey: `signals-${randomUUID()}`,
      modeAtStart: 'shadow',
      policySnapshot: { schemaVersion: 1 },
      status: 'completed',
      alertId: row!.id,
      queuedAt: contact,
      startedAt: contact,
    }).returning();
    await admin().insert(aiAlertVerdicts).values({
      orgId: t.orgId,
      runId: run!.id,
      alertId: row!.id,
      classification: 'actionable',
      confidence: '0.90',
      rationale: 'fixture',
      createdAt: contact,
    });
  }
  return row!.id;
}

async function seedTicket(t: Tenant, opts: {
  priority: 'low' | 'normal' | 'high' | 'urgent';
  category: string;
  createdAt: Date;
  firstResponseAt?: Date | null;
  /** Exposure via a started agent run. */
  exposed: boolean;
  /** Exposure via an AI DRAFT alone, with no run attached to the ticket. */
  exposedByDraft?: boolean;
  deletedAt?: Date | null;
}): Promise<string> {
  const [row] = await admin().insert(tickets).values({
    orgId: t.orgId,
    partnerId: t.partnerId,
    ticketNumber: `SIG-${randomUUID().slice(0, 12)}`,
    subject: 'Signals fixture ticket',
    priority: opts.priority,
    category: opts.category,
    createdAt: opts.createdAt,
    firstResponseAt: opts.firstResponseAt ?? null,
    deletedAt: opts.deletedAt ?? null,
  }).returning();

  if (opts.exposed) {
    const contact = plusMinutes(opts.createdAt, 2);
    await admin().insert(aiAgentRuns).values({
      orgId: t.orgId,
      agentId: t.agentId,
      profile: 'triage',
      triggerKind: 'manual',
      dedupeKey: `signals-${randomUUID()}`,
      modeAtStart: 'shadow',
      policySnapshot: { schemaVersion: 1 },
      status: 'completed',
      ticketId: row!.id,
      queuedAt: contact,
      startedAt: contact,
    });
  }

  if (opts.exposedByDraft) {
    // No run attached to the ticket at all: a draft is exposure in its own
    // right, which is the whole reason ticketExposureCte has a second branch.
    await admin().insert(ticketDrafts).values({
      orgId: t.orgId,
      ticketId: row!.id,
      kind: 'reply',
      content: 'Signals fixture draft',
      state: 'active',
      createdAt: plusMinutes(opts.createdAt, 2),
    });
  }
  return row!.id;
}

describe('measured impact — alert resolution signal', () => {
  it('splits the arms WITHIN one rule and omits a rule whose smaller arm is below the gate', async () => {
    const t = await createTenant();
    const triggered = at(DAY, 9);
    for (let i = 0; i < N; i += 1) {
      await seedAlert(t, { ruleId: t.ruleA, triggeredAt: triggered, resolvedAt: plusMinutes(triggered, 60), exposed: true });
      await seedAlert(t, { ruleId: t.ruleA, triggeredAt: triggered, resolvedAt: plusMinutes(triggered, 600), exposed: false });
    }
    // Rule Sparse never reaches the gate on either side.
    for (let i = 0; i < 3; i += 1) {
      await seedAlert(t, { ruleId: t.ruleSparse, triggeredAt: triggered, resolvedAt: plusMinutes(triggered, 60), exposed: true });
      await seedAlert(t, { ruleId: t.ruleSparse, triggeredAt: triggered, resolvedAt: plusMinutes(triggered, 60), exposed: false });
    }

    const signal = await withDbAccessContext(dbContextFor(t), () =>
      loadAlertResolutionSignal(orgAuth(t), windowFor(t)));

    const a = signal.cohorts.find((c) => c.key === t.ruleA);
    expect(a).toBeDefined();
    expect(a!.aiTouched.n).toBe(N);
    expect(a!.untouched.n).toBe(N);
    expect(a!.label).toBe('Rule A');
    // Resolved in 60 min from trigger, i.e. 45 min after cohort entry -> inside 24 h.
    expect(a!.aiTouched.proportionWithinHorizon).toBe(1);
    expect(signal.cohorts.find((c) => c.key === t.ruleSparse)).toBeUndefined();
    expect(signal.omitted).toBeNull();
  });

  it('reports insufficient_data rather than an empty band when NO rule qualifies', async () => {
    const t = await createTenant();

    const signal = await withDbAccessContext(dbContextFor(t), () =>
      loadAlertResolutionSignal(orgAuth(t), windowFor(t)));

    expect(signal).toMatchObject({ cohorts: [], omitted: 'insufficient_data' });
    expect(signal.exposureAgeMinutes).toBe(ALERT_EXPOSURE_AGE_MINUTES);
    expect(signal.horizonHours).toBe(24);
  });

  it('does NOT treat a suppressed alert as resolved', async () => {
    const t = await createTenant();
    const triggered = at(DAY, 10);
    for (let i = 0; i < N; i += 1) {
      // Suppressed with no resolved_at: a suppression is not an outcome, and
      // counting one would make noise suppression look like resolution.
      await seedAlert(t, { ruleId: t.ruleB, triggeredAt: triggered, resolvedAt: null, status: 'suppressed', exposed: true });
      await seedAlert(t, { ruleId: t.ruleB, triggeredAt: triggered, resolvedAt: plusMinutes(triggered, 120), exposed: false });
    }

    const signal = await withDbAccessContext(dbContextFor(t), () =>
      loadAlertResolutionSignal(orgAuth(t), windowFor(t)));

    const b = signal.cohorts.find((c) => c.key === t.ruleB)!;
    expect(b.aiTouched.proportionWithinHorizon).toBe(0);
    expect(b.untouched.proportionWithinHorizon).toBe(1);
  });

  it('CENSORS a still-open alert instead of dropping it from the arm', async () => {
    const t = await createTenant();
    const triggered = at(DAY, 11);
    const openCount = 10;
    for (let i = 0; i < N; i += 1) {
      const stillOpen = i < openCount;
      await seedAlert(t, {
        ruleId: t.ruleA,
        triggeredAt: triggered,
        resolvedAt: stillOpen ? null : plusMinutes(triggered, 60),
        exposed: true,
      });
      await seedAlert(t, { ruleId: t.ruleA, triggeredAt: triggered, resolvedAt: plusMinutes(triggered, 60), exposed: false });
    }

    const signal = await withDbAccessContext(dbContextFor(t), () =>
      loadAlertResolutionSignal(orgAuth(t), windowFor(t)));

    const a = signal.cohorts.find((c) => c.key === t.ruleA)!;
    // The open ones are still IN the arm (dropping them would flatter it) and
    // count against the within-horizon proportion.
    expect(a.aiTouched.n).toBe(N);
    expect(a.aiTouched.proportionWithinHorizon).toBeCloseTo((N - openCount) / N, 5);
  });
});

describe('measured impact — ticket first-response signal', () => {
  it('a run attached only AFTER first response does not put the ticket in the AI arm', async () => {
    const t = await createTenant();
    const created = at(DAY, 9);
    for (let i = 0; i < N; i += 1) {
      // `ticketHelpdeskSubscriber` fires on toStatus === 'resolved', long after
      // first response, so a late link is no evidence of pre-response work.
      const id = await seedTicket(t, {
        priority: 'high',
        category: 'billing',
        createdAt: created,
        firstResponseAt: plusMinutes(created, 90),
        exposed: false,
      });
      await admin().insert(aiAgentRuns).values({
        orgId: t.orgId,
        agentId: t.agentId,
        profile: 'triage',
        triggerKind: 'manual',
        dedupeKey: `signals-${randomUUID()}`,
        modeAtStart: 'shadow',
        policySnapshot: { schemaVersion: 1 },
        status: 'completed',
        ticketId: id,
        queuedAt: plusMinutes(created, 600),
        startedAt: plusMinutes(created, 600),
      });
      await seedTicket(t, {
        priority: 'high',
        category: 'billing',
        createdAt: created,
        firstResponseAt: plusMinutes(created, 30),
        exposed: true,
      });
    }

    const signal = await withDbAccessContext(dbContextFor(t), () =>
      loadTicketFirstResponseSignal(orgAuth(t), windowFor(t)));

    const c = signal.cohorts.find((x) => x.key === 'high|billing')!;
    expect(c.untouched.n).toBe(N);
    expect(c.aiTouched.n).toBe(N);
    expect(signal.exposureAgeMinutes).toBe(TICKET_EXPOSURE_AGE_MINUTES);
    expect(signal.horizonHours).toBe(4);
  });

  it('counts an AI DRAFT as exposure even with no run attached to the ticket', async () => {
    const t = await createTenant();
    const created = at(DAY, 16);
    for (let i = 0; i < N; i += 1) {
      await seedTicket(t, {
        priority: 'urgent',
        category: 'drafted',
        createdAt: created,
        firstResponseAt: plusMinutes(created, 40),
        exposed: false,
        exposedByDraft: true,
      });
      await seedTicket(t, {
        priority: 'urgent',
        category: 'drafted',
        createdAt: created,
        firstResponseAt: plusMinutes(created, 40),
        exposed: false,
      });
    }

    const signal = await withDbAccessContext(dbContextFor(t), () =>
      loadTicketFirstResponseSignal(orgAuth(t), windowFor(t)));

    const c = signal.cohorts.find((x) => x.key === 'urgent|drafted')!;
    // Without the ticket_drafts branch the AI arm would be empty and the whole
    // cohort would vanish behind the display gate.
    expect(c.aiTouched.n).toBe(N);
    expect(c.untouched.n).toBe(N);
  });

  it('withholds a cohort whose OTHER arm is below the gate, however large this one is', async () => {
    const t = await createTenant();
    const created = at(DAY, 17);
    // Deliberately asymmetric: a big AI arm and a tiny untouched one. Showing
    // this cohort would invite a comparison of a solid number against noise.
    for (let i = 0; i < N * 2; i += 1) {
      await seedTicket(t, {
        priority: 'high',
        category: 'lopsided',
        createdAt: created,
        firstResponseAt: plusMinutes(created, 30),
        exposed: true,
      });
    }
    for (let i = 0; i < 3; i += 1) {
      await seedTicket(t, {
        priority: 'high',
        category: 'lopsided',
        createdAt: created,
        firstResponseAt: plusMinutes(created, 30),
        exposed: false,
      });
    }

    const signal = await withDbAccessContext(dbContextFor(t), () =>
      loadTicketFirstResponseSignal(orgAuth(t), windowFor(t)));

    expect(signal.cohorts.find((x) => x.key === 'high|lopsided')).toBeUndefined();
  });

  it('reports insufficient_followup below the max window, when the window cannot contain L + H', async () => {
    const t = await createTenant();
    // Triggered late on the LAST day of the window: created_at + L + 4h runs
    // past the window's exclusive upper bound, so no row has enough follow-up.
    const created = at(THROUGH, 23, 30);
    for (let i = 0; i < N; i += 1) {
      await seedTicket(t, {
        priority: 'low',
        category: 'latewindow',
        createdAt: created,
        firstResponseAt: null,
        exposed: i % 2 === 0,
      });
    }

    // shortWindowFor: a 30-day window, below MEASURED_MAX_WINDOW_DAYS -- "try a
    // longer window" has somewhere to go here.
    const signal = await withDbAccessContext(dbContextFor(t), () =>
      loadTicketFirstResponseSignal(orgAuth(t), shortWindowFor(t)));

    // NOT 'insufficient_data': there is plenty of data, the window is just too
    // short to answer the question yet. Conflating the two would tell a partner
    // their AI did nothing when the honest answer is "ask again later".
    expect(signal).toMatchObject({ cohorts: [], omitted: 'insufficient_followup' });
  });

  it('never suggests a longer window AT the max window (90 days) — reports insufficient_data instead (#5879)', async () => {
    const t = await createTenant();
    // Same "not enough follow-up time" shape as above, but at the app's LONGEST
    // window: there is no longer window to try, so `insufficient_followup`
    // (rendered as "Try a longer window") would be advice with nowhere to go.
    const created = at(THROUGH, 23, 30);
    for (let i = 0; i < N; i += 1) {
      await seedTicket(t, {
        priority: 'low',
        category: 'latewindow',
        createdAt: created,
        firstResponseAt: null,
        exposed: i % 2 === 0,
      });
    }

    const signal = await withDbAccessContext(dbContextFor(t), () =>
      loadTicketFirstResponseSignal(orgAuth(t), windowFor(t)));

    expect(signal).toMatchObject({ cohorts: [], omitted: 'insufficient_data' });
  });

  it('excludes soft-deleted tickets', async () => {
    const t = await createTenant();
    const created = at(DAY, 12);
    const deleted = 5;
    for (let i = 0; i < N + deleted; i += 1) {
      await seedTicket(t, {
        priority: 'low',
        category: 'access',
        createdAt: created,
        firstResponseAt: plusMinutes(created, 45),
        exposed: true,
        deletedAt: i < deleted ? new Date() : null,
      });
      await seedTicket(t, {
        priority: 'low',
        category: 'access',
        createdAt: created,
        firstResponseAt: plusMinutes(created, 45),
        exposed: false,
      });
    }

    const signal = await withDbAccessContext(dbContextFor(t), () =>
      loadTicketFirstResponseSignal(orgAuth(t), windowFor(t)));

    const c = signal.cohorts.find((x) => x.key === 'low|access')!;
    expect(c.aiTouched.n).toBe(N);
  });
});

describe('measured impact — technician minutes', () => {
  it('excludes a running timer and reports logging coverage instead of a zero', async () => {
    const t = await createTenant();
    const created = at(DAY, 13);
    const unlogged = 5;
    let runningTimerSeeded = false;

    for (let i = 0; i < N; i += 1) {
      for (const exposed of [true, false]) {
        const ticketId = await seedTicket(t, {
          priority: 'normal',
          category: 'hardware',
          createdAt: created,
          firstResponseAt: plusMinutes(created, 30),
          exposed,
        });
        if (i < unlogged) continue; // no entry at all: missing info, not zero labour
        await admin().insert(timeEntries).values({
          partnerId: t.partnerId,
          orgId: t.orgId,
          ticketId,
          userId: t.userId,
          startedAt: created,
          endedAt: plusMinutes(created, 30),
          durationMinutes: 30,
          currencyCode: 'USD',
        });
        // A RUNNING timer must contribute nothing. Exactly ONE, because
        // `time_entries_one_running_per_user_uq` allows a user only one -- which
        // is also why a running timer can never be more than a rounding error
        // here, and all the more reason it must not read as zero labour.
        if (!runningTimerSeeded) {
          runningTimerSeeded = true;
          await admin().insert(timeEntries).values({
            partnerId: t.partnerId,
            orgId: t.orgId,
            ticketId,
            userId: t.userId,
            startedAt: plusMinutes(created, 60),
            endedAt: null,
            durationMinutes: null,
            currencyCode: 'USD',
          });
        }
      }
    }

    const result = await withDbAccessContext(partnerDbContextFor(t), () =>
      loadTechnicianMinutes(partnerAuth(t), windowFor(t)));

    const c = result.cohorts.find((x) => x.key === 'normal|hardware')!;
    expect(c.aiTouched.n).toBe(N - unlogged);
    expect(c.untouched.n).toBe(N - unlogged);
    // 30, not 30 + a running timer counted as anything.
    expect(c.aiTouched.medianRecordedMinutes).toBe(30);
    expect(result.loggingCoverage.aiTouched).toBeCloseTo((N - unlogged) / N, 5);
    expect(result.loggingCoverage.untouched).toBeCloseTo((N - unlogged) / N, 5);
  });
});

describe('measured impact — read budget (spec OD-6 A)', () => {
  it('a 90-day read stays inside the p95 budget', async () => {
    const t = await createTenant();
    const created = at(DAY, 8);
    // A realistic-shaped fixture rather than a 50k-row one: this runs on every
    // CI shard, and the shape (three cohorts, both arms, exposure joins) is what
    // exercises the plan. The budget below is the guard; if a production-scale
    // read ever exceeds it, the answer is the OD-6 B rollup table, NOT a looser
    // budget here.
    for (let i = 0; i < N; i += 1) {
      for (const exposed of [true, false]) {
        await seedAlert(t, { ruleId: t.ruleA, triggeredAt: created, resolvedAt: plusMinutes(created, 60), exposed });
        await seedTicket(t, {
          priority: 'normal',
          category: 'software',
          createdAt: created,
          firstResponseAt: plusMinutes(created, 45),
          exposed,
        });
      }
    }

    const timings: number[] = [];
    await withDbAccessContext(partnerDbContextFor(t), async () => {
      const auth = partnerAuth(t);
      const w = windowFor(t);
      for (let i = 0; i < 10; i += 1) {
        const t0 = performance.now();
        await loadAlertResolutionSignal(auth, w);
        await loadTicketFirstResponseSignal(auth, w);
        await loadTechnicianMinutes(auth, w);
        timings.push(performance.now() - t0);
      }
    });

    timings.sort((a, b) => a - b);
    const p95 = timings[Math.ceil(0.95 * timings.length) - 1]!;
    expect(
      p95,
      `p95 ${p95.toFixed(0)}ms exceeds the 2500ms budget — see spec OD-6 B (rollup escape hatch)`,
    ).toBeLessThan(2500);
  }, 300_000);
});
