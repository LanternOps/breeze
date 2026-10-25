/**
 * Tool catalog W04 (#5219), plan Task A9 — run creation and the two
 * background triggers against REAL Postgres: the `flow_runs_dedupe_uq`
 * conflict target, the explicit owner predicates (an event or a schedule of
 * one partner never reaches another partner's org) and the partner-wide
 * fan-out over live orgs. The branch logic is unit-tested
 * (runService.test.ts, eventTrigger.test.ts, flowScheduleTick.test.ts).
 */
import './setup';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';

vi.mock('../../jobs/flowRunQueue', () => ({ enqueueFlowRunSlice: vi.fn(async () => 'job') }));

import { db, withSystemDbAccessContext } from '../../db';
import { flowRuns, flows } from '../../db/schema';
import type { BreezeEvent } from '../../services/eventBus';
import { createFlowRun } from '../../services/flows/runService';
import { handleFlowEventTrigger } from '../../services/flows/eventTrigger';
import { processFlowScheduleTick } from '../../jobs/flowScheduleTick';
import { createOrganization, createPartner, createUser } from './db-utils';
import { seedEnabledFlow } from './helpers/flowSeed';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const PIN = { stepId: 'look', tool: 'list_devices', source: 'core', tier: 1, approvalScope: null } as const;
const STEP = { id: 'look', tool: 'list_devices', input: {}, approval: 'default', onFailure: 'stop', timeoutSec: 300 };

function eventDoc(event: string, filter: Record<string, unknown> = {}) {
  return { version: 1, name: 'On event', trigger: { type: 'event', event, filter }, inputs: [], steps: [STEP] };
}
function scheduleDoc(cron = '0 * * * *', timezone = 'UTC') {
  return { version: 1, name: 'Hourly', trigger: { type: 'schedule', cron, timezone }, inputs: [], steps: [STEP] };
}

function runsOf(flowId: string) {
  return withSystemDbAccessContext(() => db.select().from(flowRuns).where(eq(flowRuns.flowId, flowId)));
}

async function tenant() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const delegator = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `delegator-${randomUUID()}@flowtriggers.test` });
  return { partnerId: partner.id, orgA: orgA.id, delegatorId: delegator.id };
}

function event(orgId: string, over: Partial<BreezeEvent> = {}): BreezeEvent {
  return {
    id: randomUUID(), type: 'alert.triggered', orgId, source: 'test', priority: 'normal',
    payload: { severity: 'critical' }, metadata: { timestamp: new Date().toISOString() },
    ...over,
  } as BreezeEvent;
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

describe('flow triggers (real Postgres)', () => {
  runDb('createFlowRun twice with one dedupe key ⇒ created, then duplicate naming the first run', async () => {
    const t = await tenant();
    const { flowId, publicationId } = await seedEnabledFlow({
      orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc('alert.triggered'), pins: [PIN],
    });
    const input = {
      triggerKind: 'event' as const, flowId, orgId: t.orgA, scope: { firedAt: new Date().toISOString() },
      inputs: {}, dedupeKey: 'event:x', chainDepth: 0, causedByRunId: null,
    };
    const first = await createFlowRun(input);
    expect(first).toMatchObject({ created: true, preApprovalsHonored: true });
    const second = await createFlowRun(input);
    expect(second).toEqual({ created: false, reason: 'duplicate', runId: (first as { runId: string }).runId, preApprovalsHonored: true });

    const rows = await runsOf(flowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: t.orgA, flowVersionId: publicationId, triggerKind: 'event', triggeredVia: 'event', status: 'queued',
      preApprovalsHonored: true, dedupeKey: 'event:x', chainDepth: 0,
    });
    expect(rows[0]!.triggerPayload).toMatchObject({ kind: 'event', orgId: t.orgA });
  });

  runDb('concurrent creations with one dedupe key race onto ON CONFLICT: one run, every caller names it', async () => {
    const t = await tenant();
    const { flowId } = await seedEnabledFlow({
      orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc('alert.triggered'), pins: [PIN],
    });
    const input = {
      triggerKind: 'event' as const, flowId, orgId: t.orgA, scope: { firedAt: new Date().toISOString() },
      inputs: {}, dedupeKey: `event:${randomUUID()}`, chainDepth: 0, causedByRunId: null,
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => createFlowRun(input)));
    const created = results.filter((r) => r.created);
    expect(created).toHaveLength(1);
    const winner = (created[0] as { runId: string }).runId;
    for (const r of results) expect((r as { runId: string }).runId).toBe(winner);
    expect(await runsOf(flowId)).toHaveLength(1);
  });

  runDb('a manual api run is stored with pre-approvals not honoured; the CHECK holds the line', async () => {
    const t = await tenant();
    const { flowId } = await seedEnabledFlow({
      orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId,
      definition: { ...eventDoc('alert.triggered'), trigger: { type: 'manual' } }, pins: [PIN],
    });
    const r = await createFlowRun({
      triggerKind: 'manual', triggeredVia: 'api', triggeredByUserId: t.delegatorId, aiSessionId: null, triggererCleared: true,
      flowId, orgId: t.orgA, scope: { firedAt: new Date().toISOString() }, inputs: {}, dedupeKey: `manual:${randomUUID()}`,
    });
    expect(r).toMatchObject({ created: true, preApprovalsHonored: false });
    const [row] = await runsOf(flowId);
    expect(row).toMatchObject({ triggeredVia: 'api', preApprovalsHonored: false, triggeredByUserId: t.delegatorId });
  });

  runDb('a disabled flow or another partner\'s org is not_enabled (explicit owner predicates)', async () => {
    const t = await tenant();
    const other = await tenant();
    const { flowId } = await seedEnabledFlow({
      owner: 'partner', partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc('alert.triggered'), pins: [PIN],
    });
    const base = { triggerKind: 'schedule' as const, flowId, scope: { firedAt: new Date().toISOString() }, inputs: {}, dedupeKey: 'schedule:k' };
    await expect(createFlowRun({ ...base, orgId: other.orgA })).resolves.toEqual({ created: false, reason: 'not_enabled' });
    await withSystemDbAccessContext(() => db.update(flows).set({ status: 'disabled', enabledPublicationSeq: null }).where(eq(flows.id, flowId)));
    await expect(createFlowRun({ ...base, orgId: t.orgA })).resolves.toEqual({ created: false, reason: 'not_enabled' });
    expect(await runsOf(flowId)).toHaveLength(0);
  });

  runDb('a partner-wide event flow creates runs only in the event\'s org', async () => {
    const t = await tenant();
    const orgB = (await createOrganization({ partnerId: t.partnerId })).id;
    const other = await tenant();
    const { flowId } = await seedEnabledFlow({
      owner: 'partner', partnerId: t.partnerId, delegatorUserId: t.delegatorId,
      definition: eventDoc('alert.triggered', { severity: 'critical' }), pins: [PIN],
    });
    // An org flow of org B on the same event: an event in org A must not start it.
    const orgBFlow = await seedEnabledFlow({
      orgId: orgB, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc('alert.triggered'), pins: [PIN],
    });

    const inA = event(t.orgA);
    await handleFlowEventTrigger(inA);
    await handleFlowEventTrigger(inA); // redelivery
    await handleFlowEventTrigger(event(other.orgA)); // another partner's org
    await handleFlowEventTrigger(event(t.orgA, { payload: { severity: 'low' } })); // filter miss

    const rows = await runsOf(flowId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: t.orgA, dedupeKey: `event:${inA.id}`, triggerKind: 'event', chainDepth: 0 });
    expect(await runsOf(orgBFlow.flowId)).toHaveLength(0);

    // The org flow fires for its own org's event.
    await handleFlowEventTrigger(event(orgB));
    expect(await runsOf(orgBFlow.flowId)).toHaveLength(1);
    expect((await runsOf(flowId)).map((r) => r.orgId).sort()).toEqual([orgB, t.orgA].sort());
  });

  runDb('a partner-wide event flow ignores events from orgs the schedule fan-out skips (quick_support, holding, suspended)', async () => {
    const t = await tenant();
    const quickSupport = (await createOrganization({ partnerId: t.partnerId, type: 'quick_support' })).id;
    const holding = (await createOrganization({ partnerId: t.partnerId, type: 'unassigned_pool' })).id;
    const suspended = (await createOrganization({ partnerId: t.partnerId, status: 'suspended' })).id;
    const { flowId } = await seedEnabledFlow({
      owner: 'partner', partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc('alert.triggered'), pins: [PIN],
    });
    // An org flow owned by the quick_support org still fires for its own org.
    const qsOrgFlow = await seedEnabledFlow({
      orgId: quickSupport, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc('alert.triggered'), pins: [PIN],
    });

    for (const orgId of [quickSupport, holding, suspended]) await handleFlowEventTrigger(event(orgId));
    expect(await runsOf(flowId)).toHaveLength(0);
    expect((await runsOf(qsOrgFlow.flowId)).map((r) => r.orgId)).toEqual([quickSupport]);

    // Control: a live customer org of the same partner does start it.
    await handleFlowEventTrigger(event(t.orgA));
    expect((await runsOf(flowId)).map((r) => r.orgId)).toEqual([t.orgA]);
  });

  runDb('a chained event inherits depth + 1 and never re-triggers its own flow', async () => {
    const t = await tenant();
    const listener = await seedEnabledFlow({
      orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: eventDoc('alert.resolved'), pins: [PIN],
    });
    const created = await createFlowRun({
      triggerKind: 'schedule', flowId: listener.flowId, orgId: t.orgA, scope: { firedAt: new Date().toISOString() }, inputs: {}, dedupeKey: 'schedule:seed',
    });
    const causingRunId = (created as { runId: string }).runId;

    // The listener's own run resolved the alert: ignored.
    await handleFlowEventTrigger(event(t.orgA, {
      type: 'alert.resolved', metadata: { timestamp: new Date().toISOString(), flowRunId: causingRunId, flowChainDepth: 0 },
    }));
    expect(await runsOf(listener.flowId)).toHaveLength(1);

    // Another flow's run at depth 1 resolved it: depth 2, cause recorded.
    const other = await seedEnabledFlow({
      orgId: t.orgA, partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: scheduleDoc(), pins: [PIN],
    });
    const otherRun = await createFlowRun({
      triggerKind: 'event', flowId: other.flowId, orgId: t.orgA, scope: { firedAt: new Date().toISOString() }, inputs: {},
      dedupeKey: 'event:seed', chainDepth: 1, causedByRunId: causingRunId,
    });
    const otherRunId = (otherRun as { runId: string }).runId;
    await handleFlowEventTrigger(event(t.orgA, {
      type: 'alert.resolved', metadata: { timestamp: new Date().toISOString(), flowRunId: otherRunId, flowChainDepth: 1 },
    }));
    const chained = (await runsOf(listener.flowId)).find((r) => r.triggerKind === 'event');
    expect(chained).toMatchObject({ chainDepth: 2, causedByRunId: otherRunId });
  });

  runDb('a partner-wide schedule tick creates one run per live org of the partner and none for another partner', async () => {
    const t = await tenant();
    const orgB = (await createOrganization({ partnerId: t.partnerId })).id;
    const suspended = (await createOrganization({ partnerId: t.partnerId, status: 'suspended' })).id;
    const other = await tenant();
    const enabledAt = new Date('2026-10-25T08:30:00Z');
    const pw = await seedEnabledFlow({
      owner: 'partner', partnerId: t.partnerId, delegatorUserId: t.delegatorId, definition: scheduleDoc(), pins: [PIN], enabledAt,
    });
    const otherFlow = await seedEnabledFlow({
      orgId: other.orgA, partnerId: other.partnerId, delegatorUserId: other.delegatorId, definition: scheduleDoc(), pins: [PIN], enabledAt,
    });

    const now = new Date('2026-10-25T10:00:20Z');
    const tick = await processFlowScheduleTick(now);
    expect(tick.fired).toBe(3); // org A + org B of partner 1, org A of partner 2

    const rows = await runsOf(pw.flowId);
    expect(rows.map((r) => r.orgId).sort()).toEqual([t.orgA, orgB].sort());
    expect(rows.every((r) => r.dedupeKey === 'schedule:2026-10-25T10:00@UTC' && r.triggeredVia === 'scheduler' && r.preApprovalsHonored)).toBe(true);
    expect(rows.some((r) => r.orgId === suspended || r.orgId === other.orgA)).toBe(false);
    expect((await runsOf(otherFlow.flowId)).map((r) => r.orgId)).toEqual([other.orgA]);

    const [stamped] = await withSystemDbAccessContext(() => db.select().from(flows).where(eq(flows.id, pw.flowId)));
    expect(stamped!.scheduleLastOccurrenceKey).toBe('2026-10-25T10:00@UTC');

    // Same minute again: nothing new.
    expect(await processFlowScheduleTick(new Date('2026-10-25T10:00:50Z'))).toEqual({ fired: 0, skipped: 2 });
    expect(await runsOf(pw.flowId)).toHaveLength(2);
  });
});
