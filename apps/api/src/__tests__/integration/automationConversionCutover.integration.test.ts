/**
 * Tool Catalog W06 (#5221) Task B7 — the cutover, end to end, on REAL Postgres
 * (as `breeze_app`, FORCE RLS) and REAL Redis, through the real services:
 * createConversion → switchConversion (→ revertConversion), the legacy event
 * fan-out (`handleAutomationEvent`) and admission (`processTriggerEvent`,
 * `processTriggerSchedule`), the legacy webhook route, the flow event
 * subscriber (`handleFlowEventTrigger` → `createFlowRun`), the flow schedule
 * tick, the flow runner, the approval route and the release worker.
 *
 * The Review Focus scenario ("a switch during an event burst") is the first
 * case: 300 events whose instants span −120 s … +120 s around a real switch's
 * `switch_at`, delivered shuffled and concurrently to BOTH engines, one
 * publisher 20 s behind, 30 redeliveries after the switch and 5 events with a
 * future `occurredAt`. Every event is admitted exactly once, by one engine, and
 * the claims are exactly the admissions.
 *
 * Time is compressed: an event's instant is its metadata (what both engines
 * compare to `switch_at`), and its DELIVERY phase (before or after the switch
 * commits) is where the test hands it to the engines. Residual (b) of Decision
 * 6 (a pre-commit future-`occurredAt` event delivered to the flow before the
 * commit and to legacy only after it) is excluded by construction: the future
 * events published before the switch reach legacy before the commit.
 *
 * Mocked: the BullMQ producers (adds are recorded and the trigger-event jobs
 * are driven directly), the automation.started publish and the flow-run slice
 * enqueue. The device is an offline device with no agent (dispatch queues).
 * All tenants are synthetic.
 */
import './setup';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { Job } from 'bullmq';
import { occurrenceKey, type ConversionSwitchRequest } from '@breeze/shared';

const { queueAdds } = vi.hoisted(() => ({
  queueAdds: [] as Array<{ name: string; data: Record<string, unknown>; taken: boolean }>,
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    getJob = async () => undefined;
    add = async (name: string, data: Record<string, unknown>, opts?: { jobId?: string }) => {
      queueAdds.push({ name, data, taken: false });
      return { id: opts?.jobId ?? randomUUID() };
    };
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

import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  actionIntents,
  approvalRequests,
  automationOccurrenceClaims,
  automationRuns,
  automations,
  flowAutomationConversions,
  flowRuns,
  flowRunSteps,
} from '../../db/schema';
import { __testOnly as automationWorker, handleAutomationEvent, shouldTriggerScheduleAutomation } from '../../jobs/automationWorker';
import { processFlowRunJob } from '../../jobs/flowRunner';
import { processFlowScheduleTick } from '../../jobs/flowScheduleTick';
import { releaseApprovedIntent } from '../../jobs/intentReleaseWorker';
import type { FlowRunJobData } from '../../jobs/queueSchemas';
import { approvalRoutes } from '../../routes/approvals';
import { automationWebhookRoutes } from '../../routes/automations';
import { formatScheduleTriggerKey } from '../../services/automationRuntime';
import type { BreezeEvent } from '../../services/eventBus';
import { automationSourceDigest } from '../../services/flows/conversion/convertAutomation';
import { revertConversion } from '../../services/flows/conversion/revert';
import { createConversion } from '../../services/flows/conversion/service';
import { switchConversion } from '../../services/flows/conversion/switch';
import { handleFlowEventTrigger } from '../../services/flows/eventTrigger';
import { createAccessToken } from '../../services/jwt';
import { encryptSecret } from '../../services/secretCrypto';
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

// An event Job converts only where the flow event subscriber is durable (W05).
const ENV_KEYS = ['FLOWS_ENABLED', 'EVENT_DISPATCH_MODE', 'EVENT_DISPATCH_QUEUE_SUBSCRIBERS'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.FLOWS_ENABLED = 'true';
  process.env.EVENT_DISPATCH_MODE = 'enforce';
  process.env.EVENT_DISPATCH_QUEUE_SUBSCRIBERS = 'flow-event-trigger';
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
beforeEach(() => {
  queueAdds.length = 0;
});

const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

const PERMS = [
  { resource: 'automations', action: 'read' },
  { resource: 'automations', action: 'write' },
  { resource: 'scripts', action: 'read' },
  { resource: 'scripts', action: 'write' },
  { resource: 'scripts', action: 'execute' },
  { resource: 'devices', action: 'read' },
  { resource: 'approvals', action: 'decide' },
];

async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const sibling = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const orgRole = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
  await grantRolePermissions(orgRole.id, PERMS);
  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(partnerRole.id, PERMS);

  const sw = await createUser({ partnerId: partner.id, orgId: org.id, email: `co-sw-${randomUUID()}@cutover.test` });
  await assignUserToOrganization(sw.id, org.id, orgRole.id);
  const psw = await createUser({ partnerId: partner.id, email: `co-psw-${randomUUID()}@cutover.test` });
  await assignUserToPartner(psw.id, partner.id, partnerRole.id, 'all');
  const device = await createDevice({ orgId: org.id, siteId: site!.id });
  const switcher = { id: sw.id, email: sw.email };
  const partnerSwitcher = { id: psw.id, email: psw.email };

  return {
    partnerId: partner.id,
    orgId: org.id,
    siblingId: sibling.id,
    orgRoleId: orgRole.id,
    deviceId: device.id,
    switcher,
    orgAuth: () => interactiveOrgAuth(org.id, partner.id, switcher, orgRole.id),
    partnerAuth: () => interactivePartnerAuth(partner.id, [org.id, sibling.id], partnerSwitcher, 'all', partnerRole.id),
    asOrg: <T>(fn: () => Promise<T>) => withDbAccessContext(orgContext(org.id, partner.id, switcher.id), fn),
    asPartner: <T>(fn: () => Promise<T>) => withDbAccessContext(partnerContext(partner.id, [org.id, sibling.id], partnerSwitcher.id), fn),
  };
}
type Tenant = Awaited<ReturnType<typeof tenant>>;

const EVENT_TYPE = 'alert.triggered';

async function job(t: Tenant, values: Partial<typeof automations.$inferInsert>) {
  const [row] = await system(() => db.insert(automations).values({
    orgId: t.orgId,
    name: `Cutover ${randomUUID().slice(0, 6)}`,
    trigger: { type: 'event', eventType: EVENT_TYPE },
    conditions: { type: 'devices', deviceIds: [t.deviceId] },
    actions: [{ type: 'execute_command', command: 'Write-Output cutover', shell: 'powershell', whenOffline: 'queue' }],
    onFailure: 'stop',
    ...values,
  } as typeof automations.$inferInsert).returning());
  return row!;
}
type AutomationRow = Awaited<ReturnType<typeof job>>;

// Every script Job's shadow diverges under the switch defaults (would_park), so the switch acknowledges it.
const SWITCH: ConversionSwitchRequest = {
  expectedFlowVersion: 1, preApprovals: [], acceptScopeWidening: false, acceptDelegatorLifecycle: true, acknowledgeDivergence: true,
};

interface Converted {
  conversionId: string;
  flowId: string;
  auth: () => ReturnType<Tenant['orgAuth']>;
  asOwner: <T>(fn: () => Promise<T>) => Promise<T>;
  doSwitch: () => Promise<Date>;
  doRevert: () => Promise<void>;
}

/** A shadow conversion through the real createConversion, aged past the gate; switch and revert are the real services. */
async function converted(t: Tenant, row: AutomationRow): Promise<Converted> {
  const asOwner = <T>(fn: () => Promise<T>) => (row.orgId ? t.asOrg(fn) : t.asPartner(fn));
  const auth = () => (row.orgId ? t.orgAuth() : t.partnerAuth());
  const created = await asOwner(() => createConversion(auth(), row.id, { expectedSourceDigest: automationSourceDigest(row) }));
  if (!created.ok) throw new Error(`createConversion refused: ${JSON.stringify(created)}`);
  const conversionId = created.conversion.id;
  await system(() => db.update(flowAutomationConversions).set({
    shadowRuns: 5, shadowDivergences: 0, shadowStartedAt: new Date(Date.now() - 8 * 86_400_000),
  }).where(eq(flowAutomationConversions.id, conversionId)));
  return {
    conversionId,
    flowId: created.conversion.flowId,
    auth,
    asOwner,
    doSwitch: async () => {
      const r = await asOwner(() => switchConversion(auth(), conversionId, SWITCH));
      if (!r.ok) throw new Error(`switchConversion refused: ${JSON.stringify(r)}`);
      const [ledger] = await system(() => db.select().from(flowAutomationConversions).where(eq(flowAutomationConversions.id, conversionId)));
      return ledger!.switchAt!;
    },
    doRevert: async () => {
      const r = await asOwner(() => revertConversion(auth(), conversionId));
      if (!r.ok) throw new Error(`revertConversion refused: ${JSON.stringify(r)}`);
    },
  };
}

const claimsOf = (automationId: string) =>
  system(() => db.select().from(automationOccurrenceClaims).where(eq(automationOccurrenceClaims.automationId, automationId)));
const legacyRunsOf = (automationId: string) =>
  system(() => db.select().from(automationRuns).where(eq(automationRuns.automationId, automationId)));
const flowRunsOf = (flowId: string) => system(() => db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId)));
const runRow = (id: string) => system(async () => (await db.select().from(flowRuns).where(eq(flowRuns.id, id)))[0]!);

// ── events ──────────────────────────────────────────────────────────────────

function breezeEvent(orgId: string, id: string, at: Date, payload: Record<string, unknown> = { severity: 'high' }): BreezeEvent {
  return {
    id, type: EVENT_TYPE, orgId, source: 'cutover-it', priority: 'normal', payload,
    metadata: { timestamp: at.toISOString() },
  } as unknown as BreezeEvent;
}

/** The legacy engine as it runs: the fan-out enqueues, then the worker admits each job it enqueued. */
async function legacyDeliver(event: BreezeEvent): Promise<void> {
  await handleAutomationEvent(event);
  const jobs = queueAdds.filter((a) => !a.taken && a.name === 'trigger-event' && a.data.eventId === event.id);
  for (const j of jobs) j.taken = true;
  for (const j of jobs) {
    await automationWorker.processTriggerEvent(j.data as unknown as Parameters<typeof automationWorker.processTriggerEvent>[0]);
  }
}

/** One delivery of one event to BOTH engines, concurrently, in a random order. */
function deliverBoth(event: BreezeEvent, rnd: () => number): Promise<unknown> {
  const engines = [() => legacyDeliver(event), () => handleFlowEventTrigger(event)];
  if (rnd() < 0.5) engines.reverse();
  return Promise.all(engines.map((e) => e()));
}

async function inChunks<T>(items: T[], size: number, fn: (x: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}

/** Deterministic PRNG (mulberry32) so a failing shuffle can be replayed from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], rnd: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Who admitted each event: one row per event id across both engines' run tables, plus the claims. */
async function admissionsByEvent(automationId: string, flowId: string) {
  const legacy = (await legacyRunsOf(automationId)).filter((r) => r.occurrenceKey?.startsWith('event:'));
  const flow = (await flowRunsOf(flowId)).filter((r) => r.dedupeKey.startsWith('event:'));
  const byEvent = new Map<string, Array<{ engine: 'legacy' | 'flow'; runId: string }>>();
  const add = (key: string, v: { engine: 'legacy' | 'flow'; runId: string }) => byEvent.set(key, [...(byEvent.get(key) ?? []), v]);
  for (const r of legacy) add(r.occurrenceKey!.slice('event:'.length), { engine: 'legacy', runId: r.id });
  for (const r of flow) add(r.dedupeKey.slice('event:'.length), { engine: 'flow', runId: r.id });
  return { byEvent, legacy: legacy.length, flow: flow.length };
}

describe('the cutover, end to end (real Postgres + Redis, #5221 B7)', () => {
  runDb('three hundred events across the switch produce three hundred admissions', async () => {
    const seed = Number(process.env.CUTOVER_SEED ?? 5221);
    const rnd = prng(seed);
    const t = await tenant();
    const row = await job(t, {});
    const c = await converted(t, row);

    // 295 regular events with publish offsets evenly spread over −120 s … +120 s
    // around switch_at, every sixth from a publisher whose clock is 20 s behind,
    // plus 5 events whose publisher stamped an occurredAt 10+ minutes ahead.
    const LEAD = 60_000; // SWITCH_LEAD_MS: the switch commits 60 s before switch_at.
    const SKEW = 20_000;
    interface Planned { id: string; offset: number; skewed: boolean; future: boolean; at?: Date }
    const regular: Planned[] = Array.from({ length: 295 }, (_, i) => ({
      id: randomUUID(), offset: -120_000 + Math.round((240_000 * i) / 294), skewed: i % 6 === 0, future: false,
    }));
    const future: Planned[] = Array.from({ length: 5 }, (_, i) => ({ id: randomUUID(), offset: 600_000 + i * 60_000, skewed: false, future: true }));
    const preCommit = regular.filter((e) => e.offset < -LEAD); // published before the switch commits
    const postCommit = regular.filter((e) => e.offset >= -LEAD);
    const futureEarly = future.slice(0, 3); // published before the commit
    const futureLate = future.slice(3); // published after it

    // Phase A — before the switch. switch_at is not known yet: instants are
    // taken relative to the switch about to happen (now + LEAD), so they all
    // fall before the real switch_at (asserted below).
    const predictedSwitchAt = Date.now() + LEAD;
    for (const e of [...preCommit, ...futureEarly]) e.at = new Date(predictedSwitchAt + e.offset - (e.skewed ? SKEW : 0));
    const phaseA = shuffle(preCommit, rnd);
    const racingSwitch = phaseA.slice(-15); // delivered while the switch transaction runs
    const beforeSwitch = shuffle([...phaseA.slice(0, -15), ...futureEarly], rnd);
    await inChunks(beforeSwitch, 10, (e) => deliverBoth(breezeEvent(t.orgId, e.id, e.at!), rnd));
    const [switchAt] = await Promise.all([
      c.doSwitch(),
      ...racingSwitch.map((e) => deliverBoth(breezeEvent(t.orgId, e.id, e.at!), rnd)),
    ]);
    const S = switchAt.getTime();
    for (const e of preCommit) expect(e.at!.getTime()).toBeLessThan(S);
    for (const e of futureEarly) expect(e.at!.getTime()).toBeGreaterThanOrEqual(S);

    // Phase B — after the commit: the rest of the burst, the late future events
    // and 30 redeliveries, each placed after its own first delivery.
    for (const e of [...postCommit, ...futureLate]) e.at = new Date(S + e.offset - (e.skewed ? SKEW : 0));
    const all = [...regular, ...future];
    const sequence: Planned[] = shuffle([...postCommit, ...futureLate], rnd);
    const redelivered = shuffle(all, rnd).slice(0, 30);
    for (const r of redelivered) {
      const first = sequence.indexOf(r);
      const pos = first + 1 + Math.floor(rnd() * (sequence.length - first));
      sequence.splice(pos, 0, r);
    }
    expect(sequence).toHaveLength(postCommit.length + futureLate.length + 30);
    await inChunks(sequence, 12, (e) => deliverBoth(breezeEvent(t.orgId, e.id, e.at!), rnd));

    // Exactly 300 admissions, each by exactly one engine.
    const { byEvent, legacy, flow } = await admissionsByEvent(row.id, c.flowId);
    const missing = all.filter((e) => !byEvent.has(e.id)).map((e) => ({ id: e.id, offset: e.offset, skewed: e.skewed, future: e.future }));
    const doubled = [...byEvent].filter(([, v]) => v.length !== 1);
    expect({ seed, missing, doubled }).toEqual({ seed, missing: [], doubled: [] });
    expect(byEvent.size).toBe(300);
    expect(legacy + flow).toBe(300);

    // Claims = admissions: one claim per event, naming the run of the engine that admitted it.
    const claims = await claimsOf(row.id);
    expect(claims).toHaveLength(300);
    for (const claim of claims) {
      const [admitted] = byEvent.get(claim.occurrenceKey.slice('event:'.length)) ?? [];
      expect(admitted, claim.occurrenceKey).toBeDefined();
      expect(claim.engine).toBe(admitted!.engine);
      expect(admitted!.engine === 'legacy' ? claim.legacyRunId : claim.flowRunId).toBe(admitted!.runId);
      expect(claim.conversionId).toBe(c.conversionId);
    }

    // Who won is what Decision 6 says it is where only one engine attempts.
    const engineOf = (e: Planned) => byEvent.get(e.id)![0]!.engine;
    for (const e of phaseA.slice(0, -15)) expect(engineOf(e), `pre-commit ${e.offset}`).toBe('legacy');
    for (const e of futureEarly) expect(engineOf(e)).toBe('legacy');
    for (const e of [...postCommit, ...futureLate].filter((x) => x.at!.getTime() >= S)) expect(engineOf(e), `post-switch_at ${e.offset}`).toBe('flow');
    // The 20 s publisher straddles switch_at: some of its post-switch_at events carry pre-switch_at instants.
    expect(postCommit.some((e) => e.skewed && e.offset >= 0 && e.at!.getTime() < S)).toBe(true);
  }, 180_000);

  runDb('a revert hands later events back once', async () => {
    const rnd = prng(17);
    const t = await tenant();
    const row = await job(t, {});
    const c = await converted(t, row);
    const S = (await c.doSwitch()).getTime();

    const before = Array.from({ length: 10 }, (_, i) => ({ id: randomUUID(), at: new Date(S + 1_000 + i * 1_000) }));
    await inChunks(before, 5, (e) => deliverBoth(breezeEvent(t.orgId, e.id, e.at), rnd));
    expect((await admissionsByEvent(row.id, c.flowId)).flow).toBe(10);

    await c.doRevert();

    // Later events (instants after switch_at, delivered after the revert) go to legacy, once each;
    // redeliveries of what the flow already admitted are duplicates on both sides.
    const after = Array.from({ length: 10 }, (_, i) => ({ id: randomUUID(), at: new Date(S + 60_000 + i * 1_000) }));
    const deliveries = shuffle([...after, ...after.slice(0, 4), ...before], rnd);
    await inChunks(deliveries, 6, (e) => deliverBoth(breezeEvent(t.orgId, e.id, e.at), rnd));

    const { byEvent, legacy, flow } = await admissionsByEvent(row.id, c.flowId);
    expect({ legacy, flow }).toEqual({ legacy: 10, flow: 10 });
    for (const e of before) expect(byEvent.get(e.id)).toEqual([{ engine: 'flow', runId: expect.any(String) }]);
    for (const e of after) expect(byEvent.get(e.id)).toEqual([{ engine: 'legacy', runId: expect.any(String) }]);
    expect(await claimsOf(row.id)).toHaveLength(20);
  }, 60_000);

  runDb('a parked flow run released after the revert executes', async () => {
    const rnd = prng(7);
    const t = await tenant();
    const row = await job(t, {});
    const c = await converted(t, row);
    const S = (await c.doSwitch()).getTime();

    // An event after switch_at about the device: the flow admits it, and its run parks on the
    // generated-script step (no pre-approval was ticked at the switch).
    const eventId = randomUUID();
    const onDevice = { severity: 'high', deviceId: t.deviceId };
    await deliverBoth(breezeEvent(t.orgId, eventId, new Date(S + 5_000), onDevice), rnd);
    const [run] = await flowRunsOf(c.flowId);
    expect(run).toMatchObject({ dedupeKey: `event:${eventId}`, triggerKind: 'event' });
    await slice(run!.id);
    const parked = await runRow(run!.id);
    expect(parked, JSON.stringify({ error: parked.error, code: parked.errorCode })).toMatchObject({ status: 'awaiting_approval' });
    const step = (await system(() => db.select().from(flowRunSteps).where(eq(flowRunSteps.runId, run!.id))))
      .find((s) => s.status === 'awaiting_approval')!;
    const intentId = step.actionIntentId!;

    await c.doRevert();
    // Admission is closed (the same event again, and a new one, go to legacy), execution is not.
    await deliverBoth(breezeEvent(t.orgId, eventId, new Date(S + 5_000), onDevice), rnd);
    expect((await admissionsByEvent(row.id, c.flowId))).toMatchObject({ legacy: 0, flow: 1 });

    const [approval] = await system(() => db.select({ id: approvalRequests.id }).from(approvalRequests)
      .where(and(eq(approvalRequests.intentId, intentId), eq(approvalRequests.userId, t.switcher.id))));
    expect(approval).toBeDefined();
    const decided = await approveViaRoute(t, approval!.id);
    expect(decided.status, await decided.clone().text()).toBe(200);
    await releaseApprovedIntent(intentId);
    const [released] = await system(() => db.select().from(actionIntents).where(eq(actionIntents.id, intentId)));
    expect(released!.status, JSON.stringify({ errorCode: released!.errorCode, result: released!.result })).toBe('completed');
    await slice(run!.id);
    const done = await runRow(run!.id);
    expect(done, JSON.stringify({ error: done.error, code: done.errorCode })).toMatchObject({ status: 'completed', errorCode: null });
  }, 60_000);

  runDb('a schedule across a switch, a revert and a DST fall-back fires each occurrence once, twice in the repeated hour', async () => {
    const t = await tenant();
    // 01:30 New York: on 2026-11-01 that wall time happens twice (EDT 05:30Z, then EST 06:30Z).
    const trigger = { type: 'schedule' as const, cronExpression: '30 1 * * *', timezone: 'America/New_York' };
    const row = await job(t, { trigger });
    const c = await converted(t, row);
    const S = (await c.doSwitch()).getTime();
    const legacyAdmit = (slot: Date, enqueuedWhileUnswitched: boolean) => automationWorker.processTriggerSchedule({
      type: 'trigger-schedule', automationId: row.id, slotKey: formatScheduleTriggerKey(slot),
      scanAt: new Date(slot.getTime() + 4_000).toISOString(), enqueuedWhileUnswitched,
    });

    // Before switch_at: today's occurrence is legacy's; the tick leaves it alone.
    const earlier = new Date('2026-10-27T05:30:00Z');
    expect(earlier.getTime()).toBeLessThan(S);
    expect(await processFlowScheduleTick(new Date(earlier.getTime() + 10_000))).toMatchObject({ fired: 0 });
    expect(await legacyAdmit(earlier, false)).toMatchObject({ runId: expect.any(String) });

    // The fall-back day: legacy's own matcher fires twice in the repeated hour …
    const scan = Array.from({ length: 240 }, (_, m) => new Date(Date.UTC(2026, 10, 1, 4, m)))
      .filter((at) => shouldTriggerScheduleAutomation(trigger, at)).map((at) => at.toISOString());
    expect(scan).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
    // … and so does the converted flow (UTC occurrence keys); legacy attempts neither.
    for (const iso of scan) {
      const at = new Date(iso);
      expect(at.getTime()).toBeGreaterThan(S);
      expect(await processFlowScheduleTick(new Date(at.getTime() + 10_000)), iso).toMatchObject({ fired: 1 });
      expect(await processFlowScheduleTick(new Date(at.getTime() + 40_000)), iso).toMatchObject({ fired: 0 });
      expect(await legacyAdmit(at, false)).toEqual({ skipped: 'occurrence_not_preferred' });
      // A stray scan job enqueued before the switch loses to the flow's claim.
      expect(await legacyAdmit(at, true)).toMatchObject({ skipped: 'occurrence_claimed' });
    }

    await c.doRevert();
    // After the revert the next occurrence is legacy's again; the flow attempts nothing.
    const next = new Date('2026-11-02T06:30:00Z');
    expect(shouldTriggerScheduleAutomation(trigger, next)).toBe(true);
    expect(await processFlowScheduleTick(new Date(next.getTime() + 10_000))).toMatchObject({ fired: 0 });
    expect(await legacyAdmit(next, false)).toMatchObject({ runId: expect.any(String) });

    // Each occurrence once, by one engine.
    const claims = (await claimsOf(row.id)).map((x) => [x.occurrenceKey, x.engine]).sort();
    expect(claims).toEqual([
      [occurrenceKey.schedule(earlier), 'legacy'],
      [occurrenceKey.schedule(new Date(scan[0]!)), 'flow'],
      [occurrenceKey.schedule(new Date(scan[1]!)), 'flow'],
      [occurrenceKey.schedule(next), 'legacy'],
    ].sort());
    expect((await legacyRunsOf(row.id)).map((r) => r.occurrenceKey).sort()).toEqual([
      `schedule:${formatScheduleTriggerKey(earlier)}`, `schedule:${formatScheduleTriggerKey(next)}`,
    ].sort());
    expect((await flowRunsOf(c.flowId)).map((r) => r.dedupeKey).sort()).toEqual(scan.map((iso) => occurrenceKey.schedule(new Date(iso))).sort());
  }, 60_000);

  runDb('a partner-wide schedule fans out once per org per occurrence across the switch, and a racing stray legacy job never doubles it', async () => {
    const t = await tenant();
    const HOUR = 3_600_000;
    const row = await job(t, {
      orgId: null, partnerId: t.partnerId, conditions: [], createdBy: null,
      trigger: { type: 'schedule', cronExpression: '0 * * * *', timezone: 'UTC' },
    });
    const c = await converted(t, row);
    const S = (await c.doSwitch()).getTime();
    const legacyAdmit = (slot: Date, enqueuedWhileUnswitched: boolean) => automationWorker.processTriggerSchedule({
      type: 'trigger-schedule', automationId: row.id, slotKey: formatScheduleTriggerKey(slot),
      scanAt: new Date(slot.getTime() + 4_000).toISOString(), enqueuedWhileUnswitched,
    });

    // The current hour is before switch_at: one legacy run (spanning the orgs), no flow run.
    const before = new Date(Math.floor(Date.now() / HOUR) * HOUR);
    expect(before.getTime()).toBeLessThan(S);
    expect(await processFlowScheduleTick(new Date(before.getTime() + 10_000))).toMatchObject({ fired: 0 });
    expect(await legacyAdmit(before, false)).toMatchObject({ runId: expect.any(String) });

    // The next two hours are after it: the tick and a stray pre-switch scan job race for each.
    const winners: string[] = [];
    for (const h of [1, 2]) {
      const at = new Date(before.getTime() + h * HOUR);
      const [tick, legacy] = await Promise.all([processFlowScheduleTick(new Date(at.getTime() + 10_000)), legacyAdmit(at, true)]);
      const flowWon = tick.fired > 0;
      winners.push(flowWon ? 'flow' : 'legacy');
      if (flowWon) {
        expect(tick.fired).toBe(2);
        expect(legacy).toMatchObject({ skipped: 'occurrence_claimed' });
      } else {
        expect(legacy).toMatchObject({ runId: expect.any(String) });
      }
      // A retried tick and a fresh scan job add nothing.
      expect(await processFlowScheduleTick(new Date(at.getTime() + 70_000))).toMatchObject({ fired: 0 });
      expect(await legacyAdmit(at, false)).toMatchObject({ skipped: expect.stringMatching(/^occurrence_(claimed|not_preferred)$/) });
    }

    const claims = await claimsOf(row.id);
    expect(claims).toHaveLength(3);
    expect(claims.every((x) => x.orgId === null && x.partnerId === t.partnerId)).toBe(true);
    const flowRuns = await flowRunsOf(c.flowId);
    const legacyRuns = await legacyRunsOf(row.id);
    // Per occurrence: legacy → 1 run; flow → one child per org under ONE parent claim.
    const flowWins = winners.filter((w) => w === 'flow').length;
    expect(legacyRuns).toHaveLength(1 + (2 - flowWins));
    expect(flowRuns).toHaveLength(2 * flowWins);
    for (const key of new Set(flowRuns.map((r) => r.dedupeKey))) {
      expect(flowRuns.filter((r) => r.dedupeKey === key).map((r) => r.orgId).sort()).toEqual([t.orgId, t.siblingId].sort());
      expect(claims.filter((x) => x.occurrenceKey === key)).toMatchObject([{ engine: 'flow', flowRunId: null }]);
    }
  }, 60_000);

  runDb('webhook retries across the switch: with a delivery id they are duplicates; without one, a re-signed retry is residual (a)', async () => {
    const t = await tenant();
    const secret = `legacy-${randomUUID()}`;
    const row = await job(t, { trigger: { type: 'webhook', secret: encryptSecret(secret) } as unknown as AutomationRow['trigger'] });
    const c = await converted(t, row);
    const post = (r: { body: string; headers: Record<string, string> }) =>
      new Hono().route('/api/v1/automations/webhooks', automationWebhookRoutes)
        .request(`/api/v1/automations/webhooks/${row.id}`, { method: 'POST', headers: r.headers, body: r.body });
    const signed = (body: string, extra: Record<string, string> = {}, ts = Math.floor(Date.now() / 1000)) => ({
      body,
      headers: {
        'content-type': 'application/json', 'x-breeze-timestamp': String(ts),
        'x-breeze-signature': `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`, ...extra,
      },
    });

    // Accepted by legacy before the switch: one with a delivery id, one without.
    const withId = `evt_${randomUUID()}`;
    const a = signed(JSON.stringify({ n: 'with-id' }), { 'x-breeze-event-id': withId });
    const b = signed(JSON.stringify({ n: 'no-id' }));
    expect((await post(a)).status).toBe(202);
    expect((await post(b)).status).toBe(202);
    const legacyBefore = await legacyRunsOf(row.id);
    expect(legacyBefore).toHaveLength(2);

    await c.doSwitch();

    const later = Math.floor(Date.now() / 1000) + 1;
    // Re-signed retry, same delivery id → the webhook:dlv alias collides: duplicate.
    const aRetry = await post(signed(JSON.stringify({ n: 'with-id' }), { 'x-breeze-event-id': withId }, later));
    expect(aRetry.status).toBe(200);
    expect(await aRetry.json()).toMatchObject({ status: 'duplicate' });
    // Identical signed redelivery without an id → the webhook:sig alias collides: duplicate.
    const bSame = await post(b);
    expect(bSame.status).toBe(200);
    expect(await bSame.json()).toMatchObject({ status: 'duplicate' });
    // Re-signed retry without an id → a new signature, nothing to collide with: the flow admits
    // it again. Residual (a) of Decision 6, stated in the PR (legacy has the same exposure today).
    const bResigned = await post(signed(JSON.stringify({ n: 'no-id' }), {}, later));
    expect(bResigned.status).toBe(202);
    // A delivery first sent after the switch, and its re-signed retry with the same id: one flow run.
    const fresh = `evt_${randomUUID()}`;
    expect((await post(signed(JSON.stringify({ n: 'fresh' }), { 'x-breeze-event-id': fresh }))).status).toBe(202);
    const freshRetry = await post(signed(JSON.stringify({ n: 'fresh' }), { 'x-breeze-event-id': fresh }, later + 1));
    expect(freshRetry.status).toBe(200);
    expect(await freshRetry.json()).toMatchObject({ status: 'duplicate' });

    // Admissions: legacy 2 (before the switch), flow 2 (b's re-signed retry, the fresh delivery).
    expect(await legacyRunsOf(row.id)).toHaveLength(2);
    const flowRuns = await flowRunsOf(c.flowId);
    expect(flowRuns).toHaveLength(2);
    const claims = await claimsOf(row.id);
    expect(claims.filter((x) => x.engine === 'legacy')).toHaveLength(3); // a: sig + dlv; b: sig
    expect(claims.filter((x) => x.engine === 'flow')).toHaveLength(3); // b re-signed: sig; fresh: sig + dlv
    expect(claims.map((x) => x.occurrenceKey)).toEqual(expect.arrayContaining([`webhook:dlv:${withId}`, `webhook:dlv:${fresh}`]));
  }, 60_000);
});

function slice(runId: string): Promise<void> {
  return processFlowRunJob({ id: `it-${randomUUID()}`, name: 'flow-run-slice', data: { runId } } as unknown as Job<FlowRunJobData>);
}

async function approveViaRoute(t: Tenant, approvalId: string): Promise<Response> {
  const token = await createAccessToken({
    sub: t.switcher.id, email: t.switcher.email, roleId: t.orgRoleId, orgId: t.orgId, partnerId: t.partnerId,
    scope: 'organization', mfa: false, aep: 1, mep: 1, sid: randomUUID(),
  });
  const app = new Hono();
  app.route('/approvals', approvalRoutes);
  return app.request(`/approvals/${approvalId}/approve`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}
