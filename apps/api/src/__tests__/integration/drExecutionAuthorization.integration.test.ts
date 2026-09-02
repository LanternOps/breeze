import './setup';

import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import { drExecutions, drPlans } from '../../db/schema';
import { reconcileDrExecution } from '../../services/drExecutionService';
import { handleDrCommandResult } from '../../routes/backup/drResultHandler';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('DR reconciliation authorization against real PostgreSQL', () => {
  runDb('serializes the execution row and quarantines legacy authority with zero commands', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [plan] = await testDb.insert(drPlans).values({
      orgId: org.id,
      name: `DR authorization integration ${crypto.randomUUID()}`,
    }).returning({ id: drPlans.id });
    if (!plan) throw new Error('DR plan fixture insert failed');

    const [execution] = await testDb.insert(drExecutions).values({
      planId: plan.id,
      orgId: org.id,
      executionType: 'rehearsal',
      status: 'pending',
      authorizationPrincipalKind: 'unknown',
      authorizationState: 'quarantined_authorization_unknown',
      authorizationDenialCode: 'authorization_subject_unknown',
    }).returning({ id: drExecutions.id });
    if (!execution) throw new Error('DR execution fixture insert failed');

    const reconcile = () => withSystemDbAccessContext(() => reconcileDrExecution(execution.id));
    const outcomes = await Promise.all([reconcile(), reconcile()]);

    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.nextDelayMs).toBeNull();
      expect(outcome.execution).toMatchObject({
        id: execution.id,
        status: 'pending',
        authorizationState: 'quarantined_authorization_unknown',
        authorizationDenialCode: 'authorization_subject_unknown',
      });
    }

    const commands = await testDb.execute(sql`
      select id
      from device_commands
      where payload ->> 'drExecutionId' = ${execution.id}
    `);
    expect(commands).toHaveLength(0);
  });

  runDb('preserves the durable subject when an agent result wakes reconciliation', async () => {
    const testDb = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [plan] = await testDb.insert(drPlans).values({
      orgId: org.id,
      name: `DR result subject integration ${crypto.randomUUID()}`,
    }).returning({ id: drPlans.id });
    if (!plan) throw new Error('DR plan fixture insert failed');

    const principalId = crypto.randomUUID();
    const [execution] = await testDb.insert(drExecutions).values({
      planId: plan.id,
      orgId: org.id,
      executionType: 'rehearsal',
      status: 'pending',
      authorizationPrincipalKind: 'api_key',
      authorizationPrincipalId: principalId,
      authorizationGrantRevision: 'durable-grant-revision',
      authorizationState: 'authorized',
      authorizationCheckedAt: new Date('2026-08-24T12:00:00.000Z'),
      results: {
        plannedGroups: [{ groupId: 'group-1', deviceCount: 1 }],
        groupResults: [],
      },
    }).returning({ id: drExecutions.id });
    if (!execution) throw new Error('DR execution fixture insert failed');

    await withSystemDbAccessContext(() => handleDrCommandResult({
      commandId: crypto.randomUUID(),
      commandType: 'vm_restore_from_backup',
      deviceId: crypto.randomUUID(),
      status: 'completed',
      result: { ok: true },
      payload: { drExecutionId: execution.id, drGroupId: 'group-1' },
    }));

    const [after] = await testDb.select().from(drExecutions).where(eq(drExecutions.id, execution.id));
    expect(after).toMatchObject({
      authorizationPrincipalKind: 'api_key',
      authorizationPrincipalId: principalId,
      authorizationGrantRevision: 'durable-grant-revision',
      authorizationState: 'authorized',
    });
  });
});
