/**
 * AI Operator manual delegation — the requester's live access must be
 * re-checked before the coordinator lets a task proceed toward its next
 * effect (spec `docs/superpowers/specs/ai-mcp/2026-09-07-ai-operator-completion-design.md`
 * §5.1: "Manual delegation captures the requester's authorized org/site/
 * target ceiling and rechecks current access before each new effect. Loss of
 * that access pauses delegated execution.").
 *
 * `advanceExecute` is the chokepoint every `execute`-step tick passes
 * through before anything dispatches, so it is where the recheck is wired.
 * Both cases below reach the SAME "no operation reserved" fallback that
 * `advanceExecute` already had — the only observable difference the recheck
 * introduces is which detail explains the hand-off, proving the check runs
 * (and runs FIRST) without needing to build a full reserved-operation
 * fixture.
 */
import './setup';
import { getTestDb } from './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { aiAgents, aiOperatorTasks, devices, organizationUsers } from '../../db/schema';
import { advanceTask } from '../../services/aiOperator/taskCoordinator';
import { taskCheckpointSchema } from '@breeze/shared';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
} from './db-utils';

const SERVICE_NAME = 'spooler';
const TOOL_NAME = 'manage_services';

interface Tenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  requesterId: string;
  agentId: string;
  deviceId: string;
  orgUserRowId: string;
}

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const role = await createRole({ scope: 'organization', orgId: org.id });
  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@opaccess.test`,
  });
  const orgUserRow = await assignUserToOrganization(requester.id, org.id, role.id);

  const [agent] = await withSystemDbAccessContext(() =>
    db
      .insert(aiAgents)
      .values({
        partnerId: partner.id,
        orgId: null,
        kind: 'triage',
        name: 'Operator',
        enabled: true,
        mode: 'shadow',
        toolAllowlist: [TOOL_NAME],
        protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
        limits: { maxConcurrentRuns: 5, maxRunsPerHour: 50, maxBudgetCentsPerDay: 1000 },
        triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: false },
        recipients: { userIds: [], roleIds: [] },
        cooldownSeconds: 0,
        createdBy: requester.id,
      })
      .returning(),
  );

  const adminDb = getTestDb() as unknown as typeof db;
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `opaccess-agent-${unique}`,
      hostname: `opaccess-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
    })
    .returning();

  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    requesterId: requester.id,
    agentId: agent!.id,
    deviceId: (device as { id: string }).id,
    orgUserRowId: (orgUserRow as { id: string }).id,
  };
}

function checkpointFor(t: Tenant) {
  return taskCheckpointSchema.parse({
    version: 1,
    recipeInput: {
      deviceId: t.deviceId, serviceName: SERVICE_NAME,
      triggeringAlertId: null, maxRestartAttempts: 1,
    },
    criterion: {
      adapter: 'service_running', adapterVersion: 1,
      deviceId: t.deviceId, serviceName: SERVICE_NAME,
      freshnessSeconds: 120, alertId: null, resolvableWithoutAlert: false,
    },
    findings: [], satisfiedCriteria: [], unsatisfiedCriteria: ['service_running'],
    mutationAttempts: 0, lastVerification: null, lastOperationKey: null, fixWatchId: null,
  });
}

async function createExecuteTask(t: Tenant) {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .insert(aiOperatorTasks)
      .values({
        orgId: t.orgId,
        agentId: t.agentId,
        agentKind: 'triage',
        agentName: 'Operator',
        workflowKey: 'service_recovery',
        workflowVersion: 1,
        originKind: 'manual' as const,
        requesterUserId: t.requesterId,
        objective: `Restart ${SERVICE_NAME}`,
        deviceId: t.deviceId,
        state: 'running',
        phase: 'execute',
        currentStepKey: 'execute',
        checkpoint: checkpointFor(t) as unknown as Record<string, unknown>,
        revision: 1,
        leaseEpoch: 0,
        attemptOrdinal: 0,
        deadlineAt: new Date(Date.now() + 3_600_000),
      })
      .returning(),
  );
  return row!;
}

async function readOutcome(taskId: string, orgId: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db
      .select({ outcomeDetail: aiOperatorTasks.outcomeDetail, state: aiOperatorTasks.state })
      .from(aiOperatorTasks)
      .where(eq(aiOperatorTasks.id, taskId))
      .limit(1),
  );
  void orgId;
  return row;
}

describe('AI Operator — requester live-access recheck at the execute boundary', () => {
  it('a requester who still has live org+site access reaches the ordinary "no operation reserved" hand-off', async () => {
    const t = await seedTenant();
    const task = await createExecuteTask(t);

    await advanceTask(task, task.leaseEpoch);

    const after = await readOutcome(task.id, t.orgId);
    expect(after?.outcomeDetail).toMatch(/no operation is reserved/);
  });

  it('a requester whose org membership was revoked mid-task pauses the task instead of proceeding toward the next effect', async () => {
    const t = await seedTenant();
    const task = await createExecuteTask(t);

    // Revoke the requester's org membership — a membership/role change
    // applied while the task is still non-terminal.
    await withSystemDbAccessContext(() =>
      db.delete(organizationUsers).where(eq(organizationUsers.id, t.orgUserRowId)),
    );

    await advanceTask(task, task.leaseEpoch);

    const after = await readOutcome(task.id, t.orgId);
    expect(after?.outcomeDetail).toMatch(/requester/i);
    expect(after?.outcomeDetail).not.toMatch(/no operation is reserved/);
  });
});
