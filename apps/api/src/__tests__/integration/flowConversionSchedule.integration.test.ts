/**
 * Tool Catalog W06 (#5221) Task B5 — converted-flow schedule mode on REAL
 * Postgres as `breeze_app` under FORCE RLS, through the real services:
 * createConversion → switchConversion (→ revertConversion), the legacy
 * worker's schedule admission, and the flow schedule tick. What only a
 * database can show:
 *
 *  - the tick's PARENT claim is one `automation_occurrence_claims` row
 *    (engine `flow`, no flow run) on the automation's owner axis, written
 *    before the per-org fan-out; children use W04's `schedule:<key>` dedupe
 *    and never claim;
 *  - an occurrence legacy already claimed is consumed without a flow run;
 *  - a retried tick reuses its own parent claim and fills only the org that
 *    failed;
 *  - an occurrence before switch_at runs exactly once, on legacy;
 *  - a reverted generation's flow attempts nothing (and legacy owns the
 *    occurrence again).
 *
 * Times are real: switch_at is the switch's own clock + 60 s, so each case
 * picks its occurrence relative to the ledger's switch_at and hands the tick
 * that `now`. Mocked: BullMQ producers, the automation.started publish and the
 * flow-run slice enqueue (no run executes here). createFlowRun is the real
 * service behind a spy that can fail one org. All tenants are synthetic.
 */
import './setup';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { occurrenceKey, type ConversionSwitchRequest } from '@breeze/shared';

const { failOrg, beforeChild } = vi.hoisted(() => ({
  failOrg: { id: null as string | null },
  /** Runs once, right before the `atCall`-th child run (1-based) is created: a revert landing mid-fan-out. */
  beforeChild: { atCall: 0, calls: 0, fn: null as null | (() => Promise<void>), orgId: null as string | null },
}));

vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    getJob = async () => undefined;
    add = async (_name: string, _data: Record<string, unknown>, opts?: { jobId?: string }) => ({ id: opts?.jobId ?? randomUUID() });
    close = async () => undefined;
  },
}));
vi.mock('../../services/redis', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/redis')>()),
  isRedisAvailable: () => true,
  getBullMQConnection: () => ({}),
}));
vi.mock('../../services/eventBus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/eventBus')>()),
  publishEvent: vi.fn(async () => randomUUID()),
}));
vi.mock('../../jobs/flowRunQueue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../jobs/flowRunQueue')>()),
  enqueueFlowRunSlice: vi.fn(async () => 'job'),
}));
vi.mock('../../services/flows/runService', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/flows/runService')>();
  return {
    ...real,
    createFlowRun: vi.fn(async (i: Parameters<typeof real.createFlowRun>[0]) => {
      beforeChild.calls += 1;
      if (beforeChild.fn && beforeChild.calls === beforeChild.atCall) {
        const fn = beforeChild.fn;
        beforeChild.fn = null;
        beforeChild.orgId = i.orgId;
        await fn();
      }
      if (failOrg.id && i.orgId === failOrg.id) throw new Error('injected: child run creation failed');
      return real.createFlowRun(i);
    }),
  };
});

import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { automationOccurrenceClaims, automationRuns, automations, flowAutomationConversions, flowRuns, flows } from '../../db/schema';
import { __testOnly as automationWorker } from '../../jobs/automationWorker';
import { processFlowScheduleTick } from '../../jobs/flowScheduleTick';
import { formatScheduleTriggerKey } from '../../services/automationRuntime';
import { automationSourceDigest } from '../../services/flows/conversion/convertAutomation';
import { revertConversion } from '../../services/flows/conversion/revert';
import { createConversion } from '../../services/flows/conversion/service';
import { switchConversion } from '../../services/flows/conversion/switch';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createDevice,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { interactiveOrgAuth, interactivePartnerAuth, orgContext, partnerContext } from './helpers/flowRls';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const ENV_KEYS = ['FLOWS_ENABLED'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.FLOWS_ENABLED = 'true';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

const PERMS = [
  { resource: 'automations', action: 'read' },
  { resource: 'automations', action: 'write' },
  { resource: 'scripts', action: 'read' },
  { resource: 'scripts', action: 'write' },
  { resource: 'scripts', action: 'execute' },
  { resource: 'devices', action: 'read' },
];

const HOURLY = { type: 'schedule', cronExpression: '0 * * * *', timezone: 'UTC' };
const HOUR_MS = 3_600_000;

async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const sibling = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const orgRole = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
  await grantRolePermissions(orgRole.id, PERMS);
  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, PERMS);

  const switcher = await createUser({ partnerId: partner.id, orgId: org.id, email: `sc-sw-${randomUUID()}@schedule.test` });
  await assignUserToOrganization(switcher.id, org.id, orgRole.id);
  const partnerSwitcher = await createUser({ partnerId: partner.id, email: `sc-psw-${randomUUID()}@schedule.test` });
  await assignUserToPartner(partnerSwitcher.id, partner.id, partnerRole.id, 'all');
  const device = await createDevice({ orgId: org.id, siteId: site!.id });
  const sw = { id: switcher.id, email: switcher.email };
  const psw = { id: partnerSwitcher.id, email: partnerSwitcher.email };

  return {
    partnerId: partner.id,
    orgId: org.id,
    siblingId: sibling.id,
    deviceId: device.id,
    orgAuth: () => interactiveOrgAuth(org.id, partner.id, sw, orgRole.id),
    partnerAuth: () => interactivePartnerAuth(partner.id, [org.id, sibling.id], psw, 'all', partnerRole.id),
    asOrg: <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(org.id, partner.id, sw.id), fn),
    asPartner: <T>(fn: () => Promise<T>) => withDbAccessContext(partnerContext(partner.id, [org.id, sibling.id], psw.id), fn),
  };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

async function job(t: Tenant, values: Partial<typeof automations.$inferInsert>) {
  const [row] = await system(() => db.insert(automations).values({
    orgId: t.orgId,
    name: `Schedule ${randomUUID().slice(0, 6)}`,
    trigger: HOURLY,
    conditions: { type: 'devices', deviceIds: [t.deviceId] },
    actions: [{ type: 'execute_command', command: 'Write-Output schedule', shell: 'powershell', whenOffline: 'queue' }],
    onFailure: 'stop',
    ...values,
  } as typeof automations.$inferInsert).returning());
  return row!;
}
type AutomationRow = Awaited<ReturnType<typeof job>>;

const SWITCH: ConversionSwitchRequest = {
  expectedFlowVersion: 1, preApprovals: [], acceptScopeWidening: false, acceptDelegatorLifecycle: true, acknowledgeDivergence: false,
};

/** Converted through the real createConversion, aged past the gate, and switched through the real switchConversion. */
async function switched(t: Tenant, row: AutomationRow) {
  const asOwner = <T>(fn: () => Promise<T>) => (row.orgId ? t.asOrg(fn) : t.asPartner(fn));
  const auth = () => (row.orgId ? t.orgAuth() : t.partnerAuth());
  const created = await asOwner(() => createConversion(auth(), row.id, { expectedSourceDigest: automationSourceDigest(row) }));
  if (!created.ok) throw new Error(`createConversion refused: ${JSON.stringify(created)}`);
  const conversionId = created.conversion.id;
  await system(() => db.update(flowAutomationConversions).set({
    shadowRuns: 5, shadowDivergences: 0, shadowStartedAt: new Date(Date.now() - 8 * 86_400_000),
  }).where(eq(flowAutomationConversions.id, conversionId)));
  const r = await asOwner(() => switchConversion(auth(), conversionId, SWITCH));
  if (!r.ok) throw new Error(`switchConversion refused: ${JSON.stringify(r)}`);
  const ledger = (await system(() => db.select().from(flowAutomationConversions).where(eq(flowAutomationConversions.id, conversionId))))[0]!;
  return { conversionId, flowId: created.conversion.flowId, switchAt: ledger.switchAt!, auth, asOwner };
}

/** The next minute boundary at least 15 s away (waits out the last 15 s of a minute). */
async function comingMinute(): Promise<Date> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 15_000) await new Promise((r) => setTimeout(r, left + 1_000));
  return new Date(Math.ceil(Date.now() / 60_000) * 60_000);
}

/** The first top of the hour at or after `at`. */
const nextHour = (at: Date) => new Date(Math.ceil(at.getTime() / HOUR_MS) * HOUR_MS);
const plus = (at: Date, ms: number) => new Date(at.getTime() + ms);

const claimsOf = (automationId: string) =>
  system(() => db.select().from(automationOccurrenceClaims).where(eq(automationOccurrenceClaims.automationId, automationId)));
const flowRunsOf = (flowId: string) => system(() => db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId)));
const legacyRunsOf = (automationId: string) => system(() => db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId)));
const cursorOf = async (flowId: string) =>
  (await system(() => db.select({ k: flows.scheduleLastOccurrenceKey }).from(flows).where(eq(flows.id, flowId))))[0]!.k;

function legacyAdmit(automationId: string, slot: Date, over: Record<string, unknown> = {}) {
  return automationWorker.processTriggerSchedule({
    type: 'trigger-schedule', automationId, slotKey: formatScheduleTriggerKey(slot), scanAt: plus(slot, 4_000).toISOString(), ...over,
  });
}

describe('converted-flow schedule mode (real Postgres, #5221 B5)', () => {
  runDb('occurrence claimed by legacy is consumed without a run', async () => {
    const t = await tenant();
    const row = await job(t, {});
    const s = await switched(t, row);
    const at = nextHour(s.switchAt);

    // A scan job enqueued before the switch that lands late: legacy admits and claims it.
    const legacy = await legacyAdmit(row.id, at, { enqueuedWhileUnswitched: true });
    expect(legacy, JSON.stringify(legacy)).toMatchObject({ runId: expect.any(String) });

    const tick = await processFlowScheduleTick(plus(at, 10_000));
    expect(tick.fired).toBe(0);
    expect(await flowRunsOf(s.flowId)).toEqual([]);
    expect(await claimsOf(row.id)).toMatchObject([{ engine: 'legacy', occurrenceKey: occurrenceKey.schedule(at) }]);
    // Consumed: the cursor holds the UTC key, and the next tick does nothing.
    expect(await cursorOf(s.flowId)).toBe(occurrenceKey.schedule(at).slice('schedule:'.length));
    expect(await processFlowScheduleTick(plus(at, 70_000))).toMatchObject({ fired: 0 });
    expect(await flowRunsOf(s.flowId)).toEqual([]);
    expect(await legacyRunsOf(row.id)).toHaveLength(1);
  });

  runDb('partner-wide parent claim lets every org\'s child run', async () => {
    const t = await tenant();
    const row = await job(t, { orgId: null, partnerId: t.partnerId, conditions: [], createdBy: null });
    const s = await switched(t, row);
    const at = nextHour(s.switchAt);
    const key = occurrenceKey.schedule(at);

    const tick = await processFlowScheduleTick(plus(at, 10_000));
    expect(tick.fired).toBe(2);
    const runs = await flowRunsOf(s.flowId);
    expect(runs.map((r) => r.orgId).sort()).toEqual([t.orgId, t.siblingId].sort());
    expect(runs.every((r) => r.dedupeKey === key && r.triggerKind === 'schedule')).toBe(true);
    // ONE parent claim on the automation's (partner) axis; the children never claimed.
    expect(await claimsOf(row.id)).toMatchObject([{
      engine: 'flow', occurrenceKey: key, conversionId: s.conversionId, flowRunId: null, legacyRunId: null,
      orgId: null, partnerId: t.partnerId, occurrenceAt: at,
    }]);
    expect(await cursorOf(s.flowId)).toBe(key.slice('schedule:'.length));

    // Legacy now loses that occurrence even if a stray job reaches it.
    expect(await legacyAdmit(row.id, at, { enqueuedWhileUnswitched: true })).toMatchObject({ skipped: 'occurrence_claimed' });
    expect(await legacyRunsOf(row.id)).toEqual([]);
  });

  runDb('a failed child org retries without a second parent claim', async () => {
    const t = await tenant();
    const row = await job(t, { orgId: null, partnerId: t.partnerId, conditions: [], createdBy: null });
    const s = await switched(t, row);
    const at = nextHour(s.switchAt);
    const key = occurrenceKey.schedule(at);

    failOrg.id = t.siblingId;
    try {
      await processFlowScheduleTick(plus(at, 10_000));
    } finally {
      failOrg.id = null;
    }
    expect((await flowRunsOf(s.flowId)).map((r) => r.orgId)).toEqual([t.orgId]);
    expect(await claimsOf(row.id)).toHaveLength(1);
    // Not consumed: the cursor is still what enable stamped.
    expect(await cursorOf(s.flowId)).not.toBe(key.slice('schedule:'.length));

    const retry = await processFlowScheduleTick(plus(at, 70_000));
    expect(retry.fired).toBe(1);
    const runs = await flowRunsOf(s.flowId);
    expect(runs.map((r) => r.orgId).sort()).toEqual([t.orgId, t.siblingId].sort());
    expect(runs.every((r) => r.dedupeKey === key)).toBe(true);
    const claims = await claimsOf(row.id);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ engine: 'flow', occurrenceKey: key, flowRunId: null });
    expect(await cursorOf(s.flowId)).toBe(key.slice('schedule:'.length));
  });

  runDb('occurrence before switch_at runs on legacy only', async () => {
    const t = await tenant();
    // A daily schedule at the coming minute M: the switch (well under 15 s)
    // lands before M, so M is after the enable and before switch_at (= +60 s).
    const at = await comingMinute();
    const row = await job(t, { trigger: { type: 'schedule', cronExpression: `${at.getUTCMinutes()} ${at.getUTCHours()} * * *`, timezone: 'UTC' } });
    const s = await switched(t, row);
    const flow = (await system(() => db.select().from(flows).where(eq(flows.id, s.flowId))))[0]!;
    expect(flow.enabledAt!.getTime()).toBeLessThanOrEqual(at.getTime());
    expect(at.getTime()).toBeLessThan(s.switchAt.getTime());

    // The tick runs at switch_at — its latest occurrence is that minute — and leaves it to legacy.
    expect(await processFlowScheduleTick(s.switchAt)).toMatchObject({ fired: 0 });
    expect(await claimsOf(row.id)).toEqual([]);

    // Legacy's scan job for that slot (read after the switch): admitted, claimed.
    const legacy = await legacyAdmit(row.id, at, { enqueuedWhileUnswitched: false });
    expect(legacy, JSON.stringify(legacy)).toMatchObject({ runId: expect.any(String) });

    // A later tick in the same minute still leaves it alone.
    expect(await processFlowScheduleTick(plus(s.switchAt, 1_000))).toMatchObject({ fired: 0 });
    expect(await flowRunsOf(s.flowId)).toEqual([]);
    expect(await legacyRunsOf(row.id)).toHaveLength(1);
    expect(await claimsOf(row.id)).toMatchObject([{ engine: 'legacy', occurrenceKey: occurrenceKey.schedule(at) }]);
  });

  /** Arms a revert of `s` right before the second child run of the next fan-out. */
  function revertBeforeSecondChild(s: Awaited<ReturnType<typeof switched>>, then?: () => void) {
    beforeChild.calls = 0;
    beforeChild.atCall = 2;
    beforeChild.fn = async () => {
      const r = await s.asOwner(() => revertConversion(s.auth(), s.conversionId));
      if (!r.ok) throw new Error(`revertConversion refused: ${JSON.stringify(r)}`);
      then?.();
    };
  }
  function disarm() {
    beforeChild.fn = null;
    beforeChild.atCall = 0;
    failOrg.id = null;
  }

  runDb('a revert committed between the parent claim and the last child: every org still runs once, legacy does not, the next occurrence is legacy\'s', async () => {
    const t = await tenant();
    const row = await job(t, { orgId: null, partnerId: t.partnerId, conditions: [], createdBy: null });
    const s = await switched(t, row);
    const at = nextHour(s.switchAt);
    const key = occurrenceKey.schedule(at);

    revertBeforeSecondChild(s);
    let tick;
    try {
      tick = await processFlowScheduleTick(plus(at, 10_000));
    } finally {
      disarm();
    }
    const ledger = (await system(() => db.select().from(flowAutomationConversions).where(eq(flowAutomationConversions.id, s.conversionId))))[0]!;
    expect(ledger.state).toBe('reverted');
    expect(tick.fired).toBe(2);
    const runs = await flowRunsOf(s.flowId);
    expect(runs.map((r) => r.orgId).sort()).toEqual([t.orgId, t.siblingId].sort());
    expect(runs.every((r) => r.dedupeKey === key)).toBe(true);
    expect(await claimsOf(row.id)).toMatchObject([{ engine: 'flow', occurrenceKey: key, flowRunId: null, legacyRunId: null }]);
    expect(await cursorOf(s.flowId)).toBe(key.slice('schedule:'.length));

    // Nothing more for that occurrence on either engine.
    expect(await processFlowScheduleTick(plus(at, 70_000))).toMatchObject({ fired: 0 });
    expect(await flowRunsOf(s.flowId)).toHaveLength(2);
    expect(await legacyAdmit(row.id, at, { enqueuedWhileUnswitched: false })).toMatchObject({ skipped: 'occurrence_claimed' });
    expect(await legacyRunsOf(row.id)).toEqual([]);

    // The next occurrence: the reverted flow attempts nothing, legacy runs and claims it.
    const next = plus(at, HOUR_MS);
    expect(await processFlowScheduleTick(plus(next, 10_000))).toMatchObject({ fired: 0 });
    expect(await flowRunsOf(s.flowId)).toHaveLength(2);
    expect(await legacyAdmit(row.id, next, { enqueuedWhileUnswitched: false })).toMatchObject({ runId: expect.any(String) });
    expect((await claimsOf(row.id)).map((c) => [c.engine, c.occurrenceKey]).sort()).toEqual([
      ['flow', key], ['legacy', occurrenceKey.schedule(next)],
    ]);
  });

  runDb('a reverted flow finishes, on a later tick, the org a revert-time failure left behind', async () => {
    const t = await tenant();
    const row = await job(t, { orgId: null, partnerId: t.partnerId, conditions: [], createdBy: null });
    const s = await switched(t, row);
    const at = nextHour(s.switchAt);
    const key = occurrenceKey.schedule(at);

    revertBeforeSecondChild(s, () => { failOrg.id = beforeChild.orgId; });
    let missed: string | null;
    try {
      await processFlowScheduleTick(plus(at, 10_000));
    } finally {
      missed = failOrg.id;
      disarm();
    }
    expect(missed).not.toBeNull();
    expect(await flowRunsOf(s.flowId)).toHaveLength(1);
    expect(await cursorOf(s.flowId)).not.toBe(key.slice('schedule:'.length));

    // The generation is reverted now; the tick still completes what it admitted, and claims nothing new.
    const retry = await processFlowScheduleTick(plus(at, 70_000));
    expect(retry.fired).toBe(1);
    const runs = await flowRunsOf(s.flowId);
    expect(runs.map((r) => r.orgId).sort()).toEqual([t.orgId, t.siblingId].sort());
    expect(runs.every((r) => r.dedupeKey === key)).toBe(true);
    expect(await claimsOf(row.id)).toHaveLength(1);
    expect(await cursorOf(s.flowId)).toBe(key.slice('schedule:'.length));
    expect(await legacyAdmit(row.id, at, { enqueuedWhileUnswitched: false })).toMatchObject({ skipped: 'occurrence_claimed' });
  });

  runDb('a reverted flow attempts nothing', async () => {
    const t = await tenant();
    const row = await job(t, { orgId: null, partnerId: t.partnerId, conditions: [], createdBy: null });
    const s = await switched(t, row);
    const r = await s.asOwner(() => revertConversion(s.auth(), s.conversionId));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const before = await cursorOf(s.flowId);
    // The flow stays enabled (Decision 7) and is still a schedule flow the tick reads.
    expect((await system(() => db.select().from(flows).where(and(eq(flows.id, s.flowId), eq(flows.status, 'enabled'))))))
      .toHaveLength(1);

    const at = nextHour(s.switchAt);
    expect(await processFlowScheduleTick(plus(at, 10_000))).toMatchObject({ fired: 0 });
    expect(await flowRunsOf(s.flowId)).toEqual([]);
    expect(await claimsOf(row.id)).toEqual([]);
    expect(await cursorOf(s.flowId)).toBe(before);

    // Legacy owns the occurrence again.
    expect(await legacyAdmit(row.id, at, { enqueuedWhileUnswitched: false })).toMatchObject({ runId: expect.any(String) });
    expect(await claimsOf(row.id)).toMatchObject([{ engine: 'legacy', occurrenceKey: occurrenceKey.schedule(at) }]);
  });
});
