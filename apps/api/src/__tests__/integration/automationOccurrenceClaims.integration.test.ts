/**
 * Tool Catalog W06 (#5221) Task B2 — the cross-engine exactly-once contract on
 * REAL Postgres. Both engines run their real admission code:
 *
 *  - legacy: `automationWorker`'s trigger-event / trigger-schedule admission
 *    (`createAutomationRunRecord` + the claim in its transaction);
 *  - flow: `createFlowRun` (+ the claim after its insert and charge), and the
 *    durable event subscriber `handleFlowEventTrigger`.
 *
 * What only a database can show: the claim commits or rolls back WITH the run
 * (a forced failure on either side of it leaves neither), the unique index
 * decides a real race between the two engines (exactly one run, the loser is
 * told who won), pre-claim legacy history (automation_runs, with legacy's
 * compact slot spelling) is a claim, and the widened legacy reads load a
 * switched row but never a row disabled any other way.
 *
 * Boundaries mocked: BullMQ (the queue records adds), the event bus publish
 * (automation.started), the flow slice enqueue. All tenants are synthetic.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { occurrenceKey } from '@breeze/shared';

const { queueAdds } = vi.hoisted(() => ({
  queueAdds: [] as Array<{ name: string; data: Record<string, unknown> }>,
}));
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: class {
    getJob = async () => undefined;
    add = async (name: string, data: Record<string, unknown>, opts?: { jobId?: string }) => {
      queueAdds.push({ name, data });
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
vi.mock('../../jobs/flowRunQueue', () => ({ enqueueFlowRunSlice: vi.fn(async () => 'job') }));

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { automationOccurrenceClaims, automationRuns, automations, flowRuns } from '../../db/schema';
import { __testOnly } from '../../jobs/automationWorker';
import { createAutomationRunRecord, formatScheduleTriggerKey } from '../../services/automationRuntime';
import type { BreezeEvent } from '../../services/eventBus';
import { claimOccurrence } from '../../services/flows/conversion/claims';
import { handleFlowEventTrigger } from '../../services/flows/eventTrigger';
import { createFlowRun } from '../../services/flows/runService';
import { createOrganization, createPartner, createUser } from './db-utils';
import { seedEnabledFlow } from './helpers/flowSeed';
import { pgMessage } from './helpers/flowRls';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const EVENT_TYPE = 'device.offline';
const PIN = { stepId: 'look', tool: 'list_devices', source: 'core', tier: 1, approvalScope: null } as const;
const STEP = { id: 'look', tool: 'list_devices', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300 };
const DOC = { version: 1, name: 'Converted job', trigger: { type: 'event', event: EVENT_TYPE, filter: {} }, inputs: [], steps: [STEP] };

const system = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

type State = 'none' | 'shadow' | 'switched' | 'reverted';

interface Fixture {
  partnerId: string;
  orgId: string;
  automationId: string;
  flowId: string;
  conversionId: string | null;
}

/**
 * One standalone automation and, unless `none`, its converted flow (enabled)
 * and a conversion generation in `state`. A switched row is retired the way
 * the switch leaves it (enabled = false, converted_to_flow); a reverted one is
 * re-enabled the way revert leaves it.
 */
async function fixture(state: State, opts: { trigger?: Record<string, unknown>; switchAt?: Date; enabled?: boolean } = {}): Promise<Fixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const delegator = await createUser({ partnerId: partner.id, orgId: org.id, email: `claims-${randomUUID()}@claims.test` });
  const [automation] = await getTestDb().insert(automations).values({
    orgId: org.id,
    partnerId: null,
    name: `Claims ${randomUUID()}`,
    enabled: opts.enabled ?? true,
    trigger: opts.trigger ?? { type: 'event', eventType: EVENT_TYPE },
    conditions: {},
    actions: [{ type: 'execute_command', command: 'synthetic-claims' }],
    onFailure: 'stop',
  }).returning({ id: automations.id });
  const automationId = automation!.id;
  if (state === 'none') return { partnerId: partner.id, orgId: org.id, automationId, flowId: '', conversionId: null };

  const { flowId } = await seedEnabledFlow({ orgId: org.id, partnerId: partner.id, delegatorUserId: delegator.id, definition: DOC, pins: [PIN] });
  const conversionId = await system(async () => {
    const [row] = (await db.execute(sql`
      INSERT INTO flow_automation_conversions (org_id, automation_id, flow_id, fidelity, source_digest, source_snapshot, document_digest)
      VALUES (${org.id}, ${automationId}, ${flowId}, 'exact', ${'a'.repeat(64)}, '{}', ${'b'.repeat(64)})
      RETURNING id`)) as unknown as Array<{ id: string }>;
    const id = row!.id;
    if (state === 'switched' || state === 'reverted') {
      const switchAt = opts.switchAt ?? new Date(Date.now() + 60_000);
      await db.execute(sql`UPDATE flow_automation_conversions
        SET state = 'switched', switch_at = ${switchAt.toISOString()}::timestamptz, switched_at = now() WHERE id = ${id}`);
      await db.execute(sql`UPDATE automations SET enabled = false, retired_at = now(), retired_reason = 'converted_to_flow',
        converted_to_flow_id = ${flowId} WHERE id = ${automationId}`);
    }
    if (state === 'reverted') {
      await db.execute(sql`UPDATE flow_automation_conversions SET state = 'reverted', revert_at = now() WHERE id = ${id}`);
      await db.execute(sql`UPDATE automations SET enabled = true, retired_at = NULL, retired_reason = NULL,
        converted_to_flow_id = NULL WHERE id = ${automationId}`);
    }
    return id;
  });
  return { partnerId: partner.id, orgId: org.id, automationId, flowId, conversionId };
}

function eventJob(f: Fixture, eventId: string, over: Record<string, unknown> = {}) {
  return {
    type: 'trigger-event' as const, automationId: f.automationId, eventType: EVENT_TYPE, eventId,
    eventTimestamp: new Date().toISOString(), eventPayload: {}, ...over,
  };
}

function flowEvent(f: Fixture, eventId: string, at: Date | null = new Date()) {
  return createFlowRun({
    triggerKind: 'event', flowId: f.flowId, orgId: f.orgId, scope: { firedAt: new Date().toISOString() }, inputs: {},
    dedupeKey: `event:${eventId}`, chainDepth: 0, causedByRunId: null,
    occurrence: { keys: [occurrenceKey.event(eventId)], at },
  });
}

async function claimsOf(automationId: string) {
  return getTestDb().select().from(automationOccurrenceClaims).where(eq(automationOccurrenceClaims.automationId, automationId));
}
async function legacyRunsOf(automationId: string, key?: string) {
  return getTestDb().select().from(automationRuns).where(and(
    eq(automationRuns.automationId, automationId),
    ...(key ? [eq(automationRuns.occurrenceKey, key)] : []),
  ));
}
async function flowRunsOf(flowId: string) {
  return getTestDb().select().from(flowRuns).where(eq(flowRuns.flowId, flowId));
}

let prevFlag: string | undefined;
beforeAll(() => {
  prevFlag = process.env.FLOWS_ENABLED;
  process.env.FLOWS_ENABLED = 'true';
});
afterAll(() => {
  if (prevFlag === undefined) delete process.env.FLOWS_ENABLED;
  else process.env.FLOWS_ENABLED = prevFlag;
});
beforeEach(() => {
  queueAdds.length = 0;
});

describe('automation occurrence claims — real PostgreSQL (#5221 B2)', () => {
  runDb('claim and run commit together (a forced failure after the claim leaves no claim)', async () => {
    const f = await fixture('shadow');
    const key = occurrenceKey.event(randomUUID());

    // A bare claim in a transaction that then fails.
    await expect(system(async () => {
      const r = await claimOccurrence(db, {
        automationId: f.automationId, owner: { orgId: f.orgId, partnerId: null }, keys: [key], engine: 'flow',
        conversionId: f.conversionId, occurrenceAt: new Date(),
      });
      expect(r).toEqual({ ok: true });
      throw new Error('forced after the claim');
    })).rejects.toThrow('forced after the claim');
    expect(await claimsOf(f.automationId)).toHaveLength(0);

    // The legacy admission shape: run insert, then the claim in its onCreated, then a failure.
    const [automation] = await getTestDb().select().from(automations).where(eq(automations.id, f.automationId));
    await expect(system(() => createAutomationRunRecord({
      automation: automation!, triggeredBy: `event:${EVENT_TYPE}`, occurrenceKey: key,
      onCreated: async (tx, run) => {
        const r = await claimOccurrence(tx, {
          automationId: f.automationId, owner: { orgId: f.orgId, partnerId: null }, keys: [key], engine: 'legacy',
          conversionId: f.conversionId, legacyRunId: run.id, occurrenceAt: new Date(),
        });
        expect(r).toEqual({ ok: true });
        throw new Error('forced after the legacy claim');
      },
    }))).rejects.toThrow('forced after the legacy claim');
    expect(await claimsOf(f.automationId)).toHaveLength(0);
    expect(await legacyRunsOf(f.automationId)).toHaveLength(0);
  });

  runDb('a forced failure of the run insert leaves no claim', async () => {
    const f = await fixture('shadow');
    const fn = `claims_fail_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const admin = getTestDb();
    await admin.execute(sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'forced run insert failure'; END $$`));
    await admin.execute(sql.raw(`CREATE TRIGGER ${fn}_trg BEFORE INSERT ON automation_runs FOR EACH ROW
      WHEN (NEW.automation_id = '${f.automationId}') EXECUTE FUNCTION ${fn}()`));
    try {
      let err: unknown = null;
      try { await __testOnly.processTriggerEvent(eventJob(f, randomUUID())); } catch (e) { err = e; }
      expect(pgMessage(err)).toMatch(/forced run insert failure/);
    } finally {
      await admin.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn}_trg ON automation_runs`));
      await admin.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
    }
    expect(await claimsOf(f.automationId)).toHaveLength(0);
    expect(await legacyRunsOf(f.automationId)).toHaveLength(0);
    expect(queueAdds.filter((a) => a.name === 'execute-run')).toHaveLength(0);
  });

  runDb('second engine gets the existing linkage', async () => {
    const f = await fixture('switched');
    const eventId = randomUUID();
    // Legacy first: an instant before switch_at, enqueued after the switch.
    const legacy = await __testOnly.processTriggerEvent(eventJob(f, eventId, { enqueuedWhileUnswitched: false }));
    expect(legacy).toMatchObject({ runId: expect.any(String) });
    const [run] = await legacyRunsOf(f.automationId, `event:${eventId}`);
    expect(run!.id).toBe((legacy as { runId: string }).runId);
    const claims = await claimsOf(f.automationId);
    expect(claims).toMatchObject([{ occurrenceKey: `event:${eventId}`, engine: 'legacy', legacyRunId: run!.id, conversionId: f.conversionId }]);

    // Then the switched flow sees the same event: a duplicate that names the legacy run.
    expect(await flowEvent(f, eventId)).toEqual({
      created: false, reason: 'occurrence_claimed', claimedBy: { engine: 'legacy', legacyRunId: run!.id, flowRunId: null },
    });
    expect(await flowRunsOf(f.flowId)).toHaveLength(0);
  });

  runDb('legacy skips an occurrence the flow claimed', async () => {
    const f = await fixture('switched');
    const eventId = randomUUID();
    const flow = await flowEvent(f, eventId);
    expect(flow).toMatchObject({ created: true });
    const flowRunId = (flow as { runId: string }).runId;
    expect(await claimsOf(f.automationId)).toMatchObject([{ engine: 'flow', flowRunId, legacyRunId: null }]);

    const [before] = await getTestDb().select({ runCount: automations.runCount }).from(automations).where(eq(automations.id, f.automationId));
    // Enqueued while unswitched: legacy attempts it, and the claim turns it away.
    expect(await __testOnly.processTriggerEvent(eventJob(f, eventId))).toEqual({
      skipped: 'occurrence_claimed', claimedBy: { engine: 'flow', legacyRunId: null, flowRunId },
    });
    expect(await legacyRunsOf(f.automationId)).toHaveLength(0);
    const [after] = await getTestDb().select({ runCount: automations.runCount }).from(automations).where(eq(automations.id, f.automationId));
    expect(after!.runCount).toBe(before!.runCount);
    expect(queueAdds.filter((a) => a.name === 'execute-run')).toHaveLength(0);
  });

  runDb('pre-claim automation_runs history counts as a claim', async () => {
    const f = await fixture('switched');
    const slot = new Date('2027-01-09T03:00:00Z');
    // Admitted by legacy before the conversion existed: a run, no claim, legacy's compact slot.
    const [run] = await getTestDb().insert(automationRuns).values({
      automationId: f.automationId, triggeredBy: `schedule:${formatScheduleTriggerKey(slot)}`, status: 'completed',
      occurrenceKey: `schedule:${formatScheduleTriggerKey(slot)}`,
    }).returning({ id: automationRuns.id });
    const r = await system(() => claimOccurrence(db, {
      automationId: f.automationId, owner: { orgId: f.orgId, partnerId: null }, keys: [occurrenceKey.schedule(slot)],
      engine: 'flow', conversionId: f.conversionId, occurrenceAt: slot,
    }));
    expect(r).toEqual({ ok: false, existing: { engine: 'legacy', legacyRunId: run!.id, flowRunId: null } });
    expect(await claimsOf(f.automationId)).toHaveLength(0);
  });

  runDb('pre-claim legacy run history is honoured', async () => {
    const f = await fixture('switched');
    const eventId = randomUUID();
    const [run] = await getTestDb().insert(automationRuns).values({
      automationId: f.automationId, triggeredBy: `event:${EVENT_TYPE}`, status: 'completed', occurrenceKey: `event:${eventId}`,
    }).returning({ id: automationRuns.id });
    expect(await flowEvent(f, eventId)).toEqual({
      created: false, reason: 'occurrence_claimed', claimedBy: { engine: 'legacy', legacyRunId: run!.id, flowRunId: null },
    });
    expect(await flowRunsOf(f.flowId)).toHaveLength(0);
  });

  runDb('redelivery of a legacy-admitted event is a flow duplicate', async () => {
    const f = await fixture('switched');
    const eventId = randomUUID();
    const occurredAt = new Date();
    await __testOnly.processTriggerEvent(eventJob(f, eventId, { eventTimestamp: occurredAt.toISOString() }));
    expect(await legacyRunsOf(f.automationId, `event:${eventId}`)).toHaveLength(1);

    // The durable flow subscriber receives the same event (first delivery to it, or a redelivery).
    const event = {
      id: eventId, type: EVENT_TYPE, orgId: f.orgId, source: 'test', priority: 'normal', payload: {},
      metadata: { timestamp: occurredAt.toISOString() },
    } as unknown as BreezeEvent;
    await handleFlowEventTrigger(event);
    await handleFlowEventTrigger(event);
    expect(await flowRunsOf(f.flowId)).toHaveLength(0);
    expect(await claimsOf(f.automationId)).toHaveLength(1);
  });

  runDb('webhook aliases conflict on either key', async () => {
    const f = await fixture('shadow');
    const owner = { orgId: f.orgId, partnerId: null };
    const sig = occurrenceKey.webhookSig('c'.repeat(64));
    const dlv = occurrenceKey.webhookDelivery(`dlv-${randomUUID()}`);
    const legacyRun = await system(async () => {
      const [automation] = await db.select().from(automations).where(eq(automations.id, f.automationId));
      const { run } = await createAutomationRunRecord({ automation: automation!, triggeredBy: 'webhook' });
      return run.id;
    });
    await expect(system(() => claimOccurrence(db, {
      automationId: f.automationId, owner, keys: [sig, dlv], engine: 'legacy', conversionId: f.conversionId, legacyRunId: legacyRun, occurrenceAt: new Date(),
    }))).resolves.toEqual({ ok: true });

    const winner = { engine: 'legacy', legacyRunId: legacyRun, flowRunId: null };
    // A re-signed retry (new signature) with the same delivery id …
    const resigned = occurrenceKey.webhookSig('d'.repeat(64));
    await expect(system(() => claimOccurrence(db, {
      automationId: f.automationId, owner, keys: [resigned, dlv], engine: 'flow', conversionId: f.conversionId, occurrenceAt: new Date(),
    }))).resolves.toEqual({ ok: false, existing: winner });
    // … and an identical signed redelivery without a delivery id: both duplicates.
    await expect(system(() => claimOccurrence(db, {
      automationId: f.automationId, owner, keys: [sig], engine: 'flow', conversionId: f.conversionId, occurrenceAt: new Date(),
    }))).resolves.toEqual({ ok: false, existing: winner });
    // The losing alias left nothing behind.
    const keys = (await claimsOf(f.automationId)).map((c) => c.occurrenceKey).sort();
    expect(keys).toEqual([sig, dlv].sort());
  });

  runDb('two engines admitting one occurrence concurrently produce exactly one run; the loser gets the linkage', async () => {
    const f = await fixture('switched');
    for (let i = 0; i < 8; i += 1) {
      const eventId = randomUUID();
      const [legacy, flow] = await Promise.all([
        __testOnly.processTriggerEvent(eventJob(f, eventId)),
        flowEvent(f, eventId),
      ]);
      const legacyRuns = await legacyRunsOf(f.automationId, `event:${eventId}`);
      const flowRunRows = (await flowRunsOf(f.flowId)).filter((r) => r.dedupeKey === `event:${eventId}`);
      expect(legacyRuns.length + flowRunRows.length).toBe(1);
      const claims = (await claimsOf(f.automationId)).filter((c) => c.occurrenceKey === `event:${eventId}`);
      expect(claims).toHaveLength(1);
      if (legacyRuns.length === 1) {
        expect(legacy).toEqual({ runId: legacyRuns[0]!.id });
        expect(flow).toEqual({ created: false, reason: 'occurrence_claimed', claimedBy: { engine: 'legacy', legacyRunId: legacyRuns[0]!.id, flowRunId: null } });
        expect(claims[0]).toMatchObject({ engine: 'legacy', legacyRunId: legacyRuns[0]!.id });
      } else {
        expect(flow).toMatchObject({ created: true, runId: flowRunRows[0]!.id });
        expect(legacy).toEqual({ skipped: 'occurrence_claimed', claimedBy: { engine: 'flow', legacyRunId: null, flowRunId: flowRunRows[0]!.id } });
        expect(claims[0]).toMatchObject({ engine: 'flow', flowRunId: flowRunRows[0]!.id });
      }
    }
  });

  runDb('a legacy admission for a row with no conversion writes no claim', async () => {
    const f = await fixture('none');
    const eventId = randomUUID();
    expect(await __testOnly.processTriggerEvent(eventJob(f, eventId))).toMatchObject({ runId: expect.any(String) });
    expect(await legacyRunsOf(f.automationId, `event:${eventId}`)).toHaveLength(1);
    expect(await claimsOf(f.automationId)).toHaveLength(0);
  });

  runDb('a schedule admission claims the ISO minute while automation_runs keeps the compact slot', async () => {
    const f = await fixture('shadow', { trigger: { type: 'schedule', cronExpression: '0 3 * * *', timezone: 'UTC' } });
    const slot = new Date('2027-01-09T03:00:00Z');
    const result = await __testOnly.processTriggerSchedule({
      type: 'trigger-schedule', automationId: f.automationId, slotKey: formatScheduleTriggerKey(slot), scanAt: '2027-01-09T03:00:02.000Z',
    });
    expect(result).toMatchObject({ runId: expect.any(String) });
    expect(await legacyRunsOf(f.automationId, `schedule:${formatScheduleTriggerKey(slot)}`)).toHaveLength(1);
    expect(await claimsOf(f.automationId)).toMatchObject([{ occurrenceKey: occurrenceKey.schedule(slot), engine: 'legacy' }]);
  });

  runDb('the widened reads load a switched row, a reverted row loads as before, and a row disabled any other way never loads', async () => {
    const everyMinute = { type: 'schedule', cronExpression: '* * * * *', timezone: 'UTC' };
    const switchedRow = await fixture('switched', { trigger: everyMinute, switchAt: new Date(Date.now() + 120_000) });
    const revertedRow = await fixture('reverted', { trigger: everyMinute });
    const disabledRow = await fixture('none', { trigger: everyMinute, enabled: false });

    await system(() => __testOnly.processScanSchedules(new Date().toISOString()));
    const scheduled = (id: string) => queueAdds.filter((a) => a.name === 'trigger-schedule' && a.data.automationId === id);
    expect(scheduled(switchedRow.automationId)).toHaveLength(1);
    expect(scheduled(switchedRow.automationId)[0]!.data).toMatchObject({ enqueuedWhileUnswitched: false });
    expect(scheduled(revertedRow.automationId)).toHaveLength(1);
    expect(scheduled(revertedRow.automationId)[0]!.data).not.toHaveProperty('enqueuedWhileUnswitched');
    expect(scheduled(disabledRow.automationId)).toHaveLength(0);

    // Admission by id: the same three rows.
    const job = scheduled(switchedRow.automationId)[0]!.data as { slotKey: string; scanAt: string };
    const admit = (id: string, over: Record<string, unknown> = {}) => __testOnly.processTriggerSchedule({
      type: 'trigger-schedule', automationId: id, slotKey: job.slotKey, scanAt: job.scanAt, ...over,
    });
    expect(await admit(switchedRow.automationId, { enqueuedWhileUnswitched: false })).toMatchObject({ runId: expect.any(String) });
    expect(await admit(revertedRow.automationId)).toMatchObject({ runId: expect.any(String) });
    expect(await admit(disabledRow.automationId)).toEqual({ skipped: 'automation_not_found_or_disabled' });
    expect(await claimsOf(disabledRow.automationId)).toHaveLength(0);
    expect(await claimsOf(revertedRow.automationId)).toHaveLength(1);

    // Events: a row disabled for any other reason is not admitted either.
    expect(await __testOnly.processTriggerEvent(eventJob(disabledRow, randomUUID()))).toEqual({ skipped: 'automation_not_found_or_disabled' });
  });
});
