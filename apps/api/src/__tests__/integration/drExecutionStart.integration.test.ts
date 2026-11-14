// Starting a DR execution captures the plan definition and inserts the
// execution row in ONE transaction that holds the plan row lock throughout, so
// a plan writer and a second start of the same plan both see the new pending
// execution and refuse. This drives the real createDrExecutionAndEnqueue;
// only the principal capture/authorization and the queue are stubbed, and the
// authorization stub can hold the transaction open between capture and insert.
import './setup';

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

const authorizationGate = vi.hoisted(() => ({
  hold: null as null | { entered: () => void; release: Promise<void> },
}));

vi.mock('../../services/recoveryAuthorizationSubject', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/recoveryAuthorizationSubject')>();
  return {
    ...actual,
    captureRecoveryAuthorizationSubject: vi.fn(async () => ({
      authorizationPrincipalKind: 'api_key',
      authorizationPrincipalId: randomUUID(),
      authorizationGrantRevision: 'grant',
      authorizationState: 'authorized',
      authorizationDenialCode: null,
      authorizationCheckedAt: new Date(),
    })),
    authorizeQueuedRecoveryWork: vi.fn(async () => {
      const hold = authorizationGate.hold;
      if (hold) {
        authorizationGate.hold = null;
        hold.entered();
        await hold.release;
      }
      return { subject: {}, resources: { resources: [] } };
    }),
  };
});

vi.mock('../../jobs/drExecutionWorker', () => ({
  enqueueDrExecutionReconcile: vi.fn(async () => undefined),
}));

import { withSystemDbAccessContext } from '../../db';
import { drExecutions, drPlanGroups, drPlans } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { classifyDrExecutionAuthorizationError, createDrExecutionAndEnqueue } from '../../services/drExecutionService';
import { updateDrPlanGroup } from '../../services/drPlanWrites';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const STILL_WAITING = Symbol('still waiting');
const WAIT_MS = 400;
const AUTH = { principal: { kind: 'api_key' } } as unknown as AuthContext;

function holdAuthorization() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  authorizationGate.hold = { entered, release: new Promise<void>((resolve) => { release = resolve; }) };
  return { reached, release };
}

async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T | typeof STILL_WAITING> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<typeof STILL_WAITING>((resolve) => { timer = setTimeout(() => resolve(STILL_WAITING), ms); });
  try {
    return await Promise.race([promise, waited]);
  } finally {
    clearTimeout(timer);
  }
}

async function seedPlan() {
  const testDb = getTestDb();
  const org = await createOrganization({ partnerId: (await createPartner()).id });
  const [plan] = await testDb.insert(drPlans).values({
    orgId: org.id, name: `DR start ${randomUUID()}`, status: 'active',
  }).returning({ id: drPlans.id });
  const deviceId = randomUUID();
  const [group] = await testDb.insert(drPlanGroups).values({
    planId: plan!.id, orgId: org.id, name: 'Tier 1', sequence: 1, devices: [deviceId],
    restoreConfig: { commandType: 'vm_restore_from_backup', sourceSnapshotId: randomUUID() },
  }).returning({ id: drPlanGroups.id });
  return { orgId: org.id, planId: plan!.id, groupId: group!.id, deviceId };
}

const start = (planId: string, orgId: string) =>
  createDrExecutionAndEnqueue({ planId, orgId, executionType: 'failover', auth: AUTH });

async function executionsOf(planId: string) {
  return getTestDb().select().from(drExecutions).where(eq(drExecutions.planId, planId));
}

describe('starting a DR execution against real PostgreSQL', () => {
  runDb('holds the plan lock from capture through insert, so a group write waits and then refuses', async () => {
    const { orgId, planId, groupId, deviceId } = await seedPlan();
    const held = holdAuthorization();
    const starting = start(planId, orgId);
    await held.reached; // definition captured, execution row not yet inserted

    const write = withSystemDbAccessContext(() => updateDrPlanGroup({
      planId, orgId, groupId, changes: { devices: [randomUUID()] },
    }));
    expect(await settlesWithin(write, WAIT_MS)).toBe(STILL_WAITING);

    held.release();
    const execution = await starting;
    expect(await write).toEqual({ status: 'execution_in_progress' });

    const [stored] = await executionsOf(planId);
    expect(stored?.id).toBe(execution?.id);
    const definition = (stored!.results as { definition: { groups: Array<{ devices: string[] }> } }).definition;
    expect(definition.groups.map((group) => group.devices)).toEqual([[deviceId]]);
  });

  runDb('refuses a second start of a plan while its first execution is pending', async () => {
    const { orgId, planId } = await seedPlan();
    const held = holdAuthorization();
    const first = start(planId, orgId);
    await held.reached;

    const second = start(planId, orgId).then(() => null, (error: unknown) => error);
    expect(await settlesWithin(second, WAIT_MS)).toBe(STILL_WAITING);

    held.release();
    expect((await first)?.status).toBe('pending');
    expect(classifyDrExecutionAuthorizationError(await second)).toEqual({ status: 409, code: 'dr_plan_execution_in_progress' });
    expect(await executionsOf(planId)).toHaveLength(1);

    // Once the first is no longer pending or running, the plan can run again.
    await getTestDb().update(drExecutions).set({ status: 'aborted' }).where(eq(drExecutions.planId, planId));
    expect((await start(planId, orgId))?.status).toBe('pending');
    expect(await executionsOf(planId)).toHaveLength(2);
  });

  runDb('captures groups that share a sequence in group id order', async () => {
    const { orgId, planId, groupId } = await seedPlan();
    // Inserted second but with the lower id, so insertion order and id order differ.
    const lowerId = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
    const [sibling] = await getTestDb().insert(drPlanGroups).values({
      id: lowerId, planId, orgId, name: 'Tier 1b', sequence: 1, devices: [randomUUID()],
      restoreConfig: { commandType: 'vm_restore_from_backup', sourceSnapshotId: randomUUID() },
    }).returning({ id: drPlanGroups.id });

    await start(planId, orgId);
    const [stored] = await executionsOf(planId);
    const definition = (stored!.results as { definition: { groups: Array<{ id: string }> } }).definition;
    expect(definition.groups.map((group) => group.id)).toEqual([sibling!.id, groupId]);
  });
});
