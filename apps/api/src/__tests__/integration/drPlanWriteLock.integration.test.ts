// A DR execution runs the plan definition captured when it was created. Plan
// writers and execution creation serialise on the plan row (`FOR UPDATE`):
// a writer refuses once an execution is pending or running, and an execution
// start that waited on a writer reads the writer's committed definition. Only
// real PostgreSQL can show that one transaction actually waits for the other.
import './setup';

import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { drExecutions, drPlanGroups, drPlans } from '../../db/schema';
import { readDrPlanDefinition } from '../../services/drPlanDefinition';
import { reconcileDrExecution } from '../../services/drExecutionService';
import { addDrPlanGroup, deleteDrPlanGroup, updateDrPlanGroup } from '../../services/drPlanWrites';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const STILL_WAITING = Symbol('still waiting');
const WAIT_MS = 400;

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
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

describe('DR plan writes and execution start serialise on the plan row', () => {
  async function seedPlan() {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [plan] = await testDb.insert(drPlans).values({
      orgId: org.id,
      name: `DR plan write lock ${crypto.randomUUID()}`,
      status: 'active',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    }).returning({ id: drPlans.id });
    if (!plan) throw new Error('DR plan fixture insert failed');
    const [group] = await testDb.insert(drPlanGroups).values({
      planId: plan.id,
      orgId: org.id,
      name: 'Tier 1',
      sequence: 1,
      devices: ['approved-device'],
      restoreConfig: { commandType: 'vm_restore_from_backup', payload: { vmName: 'approved' } },
    }).returning({ id: drPlanGroups.id });
    if (!group) throw new Error('DR group fixture insert failed');
    return { orgId: org.id, planId: plan.id, groupId: group.id };
  }

  async function storedGroup(groupId: string) {
    const [row] = await getTestDb().select().from(drPlanGroups).where(eq(drPlanGroups.id, groupId));
    return row;
  }

  runDb('a group write waits for an execution start that holds the plan, then refuses', async () => {
    const { orgId, planId, groupId } = await seedPlan();
    const release = gate();
    const locked = gate();

    // An execution start: lock the plan, capture the definition, insert the
    // pending execution, and hold the transaction open until released.
    const start = withSystemDbAccessContext(async () => {
      const definition = await readDrPlanDefinition(planId, db, { orgId, lock: true });
      locked.open();
      await release.opened;
      await db.insert(drExecutions).values({
        planId,
        orgId,
        executionType: 'failover',
        status: 'pending',
        authorizationPrincipalKind: 'api_key',
        authorizationPrincipalId: crypto.randomUUID(),
        authorizationGrantRevision: 'grant',
        authorizationState: 'authorized',
        authorizationCheckedAt: new Date(),
      });
      return definition;
    });
    await locked.opened;

    const write = withSystemDbAccessContext(() => updateDrPlanGroup({
      planId, orgId, groupId, changes: { devices: ['later-device'] },
    }));
    expect(await settlesWithin(write, WAIT_MS)).toBe(STILL_WAITING);

    release.open();
    const captured = await start;
    expect(captured?.groups[0]?.devices).toEqual(['approved-device']);
    expect(await write).toEqual({ status: 'execution_in_progress' });
    expect((await storedGroup(groupId))?.devices).toEqual(['approved-device']);
  });

  runDb('an execution start waits for a group write in progress and reads its committed result', async () => {
    const { orgId, planId, groupId } = await seedPlan();
    const before = await withSystemDbAccessContext(() => readDrPlanDefinition(planId, db, { orgId }));
    const release = gate();
    const written = gate();

    const write = withSystemDbAccessContext(async () => {
      const result = await updateDrPlanGroup({ planId, orgId, groupId, changes: { devices: ['edited-device'] } });
      written.open();
      await release.opened;
      return result;
    });
    await written.opened;

    const start = withSystemDbAccessContext(() => readDrPlanDefinition(planId, db, { orgId, lock: true }));
    expect(await settlesWithin(start, WAIT_MS)).toBe(STILL_WAITING);

    release.open();
    expect((await write).status).toBe('written');
    const captured = await start;
    expect(captured?.groups[0]?.devices).toEqual(['edited-device']);
    // The write moved the plan revision, so an approval pinned before it no longer matches.
    expect(captured?.updatedAt).not.toBe(before?.updatedAt);
  });

  runDb('writes are accepted again once the execution is no longer pending or running', async () => {
    const { orgId, planId, groupId } = await seedPlan();
    const [execution] = await getTestDb().insert(drExecutions).values({
      planId,
      orgId,
      executionType: 'rehearsal',
      status: 'running',
      authorizationPrincipalKind: 'api_key',
      authorizationPrincipalId: crypto.randomUUID(),
      authorizationGrantRevision: 'grant',
      authorizationState: 'authorized',
      authorizationCheckedAt: new Date(),
    }).returning({ id: drExecutions.id });
    if (!execution) throw new Error('DR execution fixture insert failed');

    const refused = await withSystemDbAccessContext(() => updateDrPlanGroup({
      planId, orgId, groupId, changes: { name: 'Renamed' },
    }));
    expect(refused).toEqual({ status: 'execution_in_progress' });

    await getTestDb().update(drExecutions).set({ status: 'aborted' }).where(eq(drExecutions.id, execution.id));
    const accepted = await withSystemDbAccessContext(() => updateDrPlanGroup({
      planId, orgId, groupId, changes: { name: 'Renamed' },
    }));
    expect(accepted.status).toBe('written');
    expect((await storedGroup(groupId))?.name).toBe('Renamed');
  });

  runDb('an execution saved without its definition stops instead of running the live plan', async () => {
    const { orgId, planId } = await seedPlan();
    const [execution] = await getTestDb().insert(drExecutions).values({
      planId,
      orgId,
      executionType: 'failover',
      status: 'pending',
      results: { plannedGroups: [{ id: 'g', deviceCount: 1 }] },
      authorizationPrincipalKind: 'api_key',
      authorizationPrincipalId: crypto.randomUUID(),
      authorizationGrantRevision: 'grant',
      authorizationState: 'authorized',
      authorizationCheckedAt: new Date(),
    }).returning({ id: drExecutions.id });
    if (!execution) throw new Error('DR execution fixture insert failed');

    const outcome = await withSystemDbAccessContext(() => reconcileDrExecution(execution.id));

    expect(outcome.pending).toEqual([]);
    expect(outcome.nextDelayMs).toBeNull();
    expect(outcome.execution).toMatchObject({
      status: 'failed',
      authorizationState: 'denied',
      authorizationDenialCode: 'execution_definition_unavailable',
    });
    const commands = await getTestDb().execute(sql`
      select id from device_commands where payload ->> 'drExecutionId' = ${execution.id}
    `);
    expect(commands).toHaveLength(0);
  });
});

// dr_plan_groups.depends_on_group_id is a plain foreign key: it is not limited
// to the plan or org, and foreign-key checks ignore row-level security. The
// write path therefore checks the predecessor itself, under the plan lock.
describe('recovery group dependencies stay inside their plan', () => {
  async function seedOrgPlan(orgId?: string) {
    const testDb = getTestDb();
    const resolvedOrgId = orgId ?? (await createOrganization({ partnerId: (await createPartner()).id })).id;
    const [plan] = await testDb.insert(drPlans).values({
      orgId: resolvedOrgId, name: `DR dependency ${crypto.randomUUID()}`, status: 'active',
    }).returning({ id: drPlans.id });
    const [group] = await testDb.insert(drPlanGroups).values({
      planId: plan!.id, orgId: resolvedOrgId, name: 'Tier 1', sequence: 1, devices: [],
    }).returning({ id: drPlanGroups.id });
    return { orgId: resolvedOrgId, planId: plan!.id, groupId: group!.id };
  }

  function orgContext(orgId: string): DbAccessContext {
    return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [] };
  }

  runDb('refuses a predecessor from another plan or another org, and accepts one from the same plan', async () => {
    const home = await seedOrgPlan();
    const sibling = await seedOrgPlan(home.orgId);
    const foreign = await seedOrgPlan();

    for (const predecessor of [sibling.groupId, foreign.groupId]) {
      const added = await withSystemDbAccessContext(() => addDrPlanGroup({
        planId: home.planId, orgId: home.orgId, values: { name: 'Tier 2', dependsOnGroupId: predecessor },
      }));
      expect(added).toEqual({ status: 'invalid_dependency' });
      const updated = await withSystemDbAccessContext(() => updateDrPlanGroup({
        planId: home.planId, orgId: home.orgId, groupId: home.groupId, changes: { dependsOnGroupId: predecessor },
      }));
      expect(updated).toEqual({ status: 'invalid_dependency' });
    }
    const groups = await getTestDb().select().from(drPlanGroups).where(eq(drPlanGroups.planId, home.planId));
    expect(groups.map((group) => group.dependsOnGroupId)).toEqual([null]);

    const added = await withSystemDbAccessContext(() => addDrPlanGroup({
      planId: home.planId, orgId: home.orgId, values: { name: 'Tier 2', dependsOnGroupId: home.groupId },
    }));
    expect(added.status).toBe('written');
  });

  runDb('refuses to delete a group that another group depends on, including one this scope cannot see', async () => {
    const home = await seedOrgPlan();
    const [dependent] = await getTestDb().insert(drPlanGroups).values({
      planId: home.planId, orgId: home.orgId, name: 'Tier 2', sequence: 2, devices: [], dependsOnGroupId: home.groupId,
    }).returning({ id: drPlanGroups.id });
    expect(await withDbAccessContext(orgContext(home.orgId), () => deleteDrPlanGroup({
      planId: home.planId, orgId: home.orgId, groupId: home.groupId,
    }))).toEqual({ status: 'group_has_dependents' });

    // A pointer stored before this check existed, from a group of another org:
    // invisible to this org's scope, still enforced by the foreign key.
    const foreign = await seedOrgPlan();
    await getTestDb().update(drPlanGroups).set({ dependsOnGroupId: null }).where(eq(drPlanGroups.id, dependent!.id));
    await getTestDb().update(drPlanGroups).set({ dependsOnGroupId: home.groupId }).where(eq(drPlanGroups.id, foreign.groupId));
    expect(await withDbAccessContext(orgContext(home.orgId), () => deleteDrPlanGroup({
      planId: home.planId, orgId: home.orgId, groupId: home.groupId,
    }))).toEqual({ status: 'group_has_dependents' });

    const [stillThere] = await getTestDb().select({ id: drPlanGroups.id }).from(drPlanGroups).where(eq(drPlanGroups.id, home.groupId));
    expect(stillThere).toBeDefined();
  });
});
