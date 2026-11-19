/**
 * #12084 review item 5: the PAM stale-request expirer closes a helper
 * execution row that no approval-wait close-out managed to close. Split from
 * `aiApprovalCloseOutClicks.integration.test.ts` so the PAM sources it
 * imports stay with the suite that owns them.
 */
import './setup';

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import { aiSessions, aiToolExecutions, elevationRequests } from '../../db/schema';
import { decideHelperToolAction } from '../../services/pamToolActionGovernance';
import { expireStaleRequests } from '../../jobs/pamJobs';
import { tenant, toolAuth, type Tenant } from './caughtQueryFixtures';
import { getTestDb } from './setup';

let t: Tenant;
let sessionId: string;

beforeEach(async () => {
  t = await tenant();
  const auth = await toolAuth(t);
  const [s] = await getTestDb()
    .insert(aiSessions)
    .values({ orgId: t.orgId, userId: auth.user.id, type: 'general', model: 'close-out-model' })
    .returning({ id: aiSessions.id });
  sessionId = s!.id;
});

async function seedExecution(): Promise<string> {
  const [row] = await getTestDb()
    .insert(aiToolExecutions)
    .values({ sessionId, toolName: 'execute_command', toolInput: { deviceId: 'd' }, status: 'pending' })
    .returning({ id: aiToolExecutions.id });
  return row!.id;
}

async function readExecution(executionId: string) {
  const [row] = await getTestDb()
    .select({ status: aiToolExecutions.status, errorMessage: aiToolExecutions.errorMessage })
    .from(aiToolExecutions)
    .where(eq(aiToolExecutions.id, executionId));
  return row;
}

describe('a helper/PAM execution no close-out closed (#12084 review item 5)', () => {
  it('the PAM stale-request expirer closes the linked execution row as expired', async () => {
    const executionId = await seedExecution();
    // No PAM rule matches: the elevation request is created pending.
    const decision = await decideHelperToolAction({
      orgId: t.orgId, deviceId: t.deviceId, executionId, toolName: 'execute_command', toolInput: {},
      riskTier: 2, subjectUsername: 'helper-host',
    });
    expect(decision).toBe('pending');
    // Every close-out failed, so the row is still pending; the request is past its TTL.
    await getTestDb()
      .update(elevationRequests)
      .set({ requestedAt: new Date(Date.now() - 24 * 60 * 60_000) })
      .where(eq(elevationRequests.executionId, executionId));

    // As the BullMQ worker runs it: in system scope.
    expect(await withSystemDbAccessContext(() => expireStaleRequests())).toBeGreaterThanOrEqual(1);

    expect(await readExecution(executionId)).toEqual({ status: 'rejected', errorMessage: 'Approval request expired' });
    const [elevation] = await getTestDb()
      .select({ status: elevationRequests.status })
      .from(elevationRequests)
      .where(eq(elevationRequests.executionId, executionId));
    expect(elevation!.status).toBe('expired');
  });

  it('leaves an execution that is no longer pending as it is', async () => {
    const executionId = await seedExecution();
    expect(await decideHelperToolAction({
      orgId: t.orgId, deviceId: t.deviceId, executionId, toolName: 'execute_command', toolInput: {},
      riskTier: 2, subjectUsername: 'helper-host',
    })).toBe('pending');
    // Already closed by its wait (say, as timed out) before the request went stale.
    await getTestDb()
      .update(aiToolExecutions)
      .set({ status: 'rejected', errorMessage: 'Approval timed out' })
      .where(eq(aiToolExecutions.id, executionId));
    await getTestDb()
      .update(elevationRequests)
      .set({ requestedAt: new Date(Date.now() - 24 * 60 * 60_000) })
      .where(eq(elevationRequests.executionId, executionId));

    expect(await withSystemDbAccessContext(() => expireStaleRequests())).toBeGreaterThanOrEqual(1);

    expect(await readExecution(executionId)).toEqual({ status: 'rejected', errorMessage: 'Approval timed out' });
  });
});
