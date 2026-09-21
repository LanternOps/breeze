/**
 * Recipe Library spec §6.1 / wave E1: a task frozen against a recipe this
 * build does not ship must HAND OFF, not throw and not spin.
 *
 * Against real Postgres because the property being proved is about a committed
 * row and a committed terminal transition: `advanceTask` takes a lease, writes
 * under the lease CAS, and the test reads the row back. A mocked db would
 * prove only that a branch was taken.
 *
 * Why this matters more than it looks: the wake path (`handleTaskWake`) turns
 * a throw into a retried BullMQ job. A task whose recipe vanished — a rolled
 * back deploy, a recipe renamed between releases, a version retired — would
 * then be re-attempted forever, holding a coordinator tick each time, with
 * nothing in its own outcome telling a technician why it never finished.
 *
 * Fixtures reused verbatim from `aiOperatorCoordinator.integration.test.ts`
 * (seedTenant / createTask / readTask), changing only the workflowKey/
 * workflowVersion written and the assertions.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { aiAgents, aiOperatorTasks, devices } from '../../db/schema';
import {
  advanceTask,
  claimTaskLease,
} from '../../services/aiOperator/taskCoordinator';
import {
  buildServiceRecoveryCriterion,
  parseServiceRecoveryInput,
} from '../../services/aiOperator/recipes/serviceRecovery';
import { taskCheckpointSchema, TASK_CHECKPOINT_VERSION, type TaskCheckpoint } from '@breeze/shared';
import {
  createOrganization,
  createPartner,
  createSite,
  createUser,
} from './db-utils';

const TOOL_NAME = 'manage_services';

interface Tenant {
  partnerId: string;
  orgId: string;
  siteId: string;
  requesterId: string;
  agentId: string;
  deviceId: string;
}

async function seedTenant(): Promise<Tenant> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });

  const requester = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `requester-${randomUUID()}@recipereg.test`,
  });

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

  const unique = randomUUID().slice(0, 8);
  const [device] = await withSystemDbAccessContext(() =>
    db
      .insert(devices)
      .values({
        orgId: org.id,
        siteId: site.id,
        agentId: `recipereg-agent-${unique}`,
        hostname: `recipereg-host-${unique}`,
        osType: 'linux',
        osVersion: '22.04',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning(),
  );

  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    requesterId: requester.id,
    agentId: agent!.id,
    deviceId: (device as { id: string }).id,
  };
}

async function seedTask(
  t: Tenant,
  overrides: Partial<typeof aiOperatorTasks.$inferInsert> = {},
): Promise<string> {
  const recipeInput = parseServiceRecoveryInput({
    deviceId: t.deviceId, serviceName: 'spooler', triggeringAlertId: null,
  });
  const checkpoint: TaskCheckpoint = taskCheckpointSchema.parse({
    version: TASK_CHECKPOINT_VERSION,
    recipeInput,
    criterion: buildServiceRecoveryCriterion(recipeInput),
    findings: [],
    satisfiedCriteria: [],
    unsatisfiedCriteria: ['service_running'],
    mutationAttempts: 0,
    lastVerification: null,
    lastOperationKey: null,
    fixWatchId: null,
  });

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
        objective: 'Restart the print spooler',
        deviceId: t.deviceId,
        state: 'queued',
        phase: 'investigate',
        currentStepKey: 'investigate',
        revision: 1,
        leaseEpoch: 0,
        attemptOrdinal: 0,
        checkpoint: checkpoint as unknown as Record<string, unknown>,
        deadlineAt: new Date(Date.now() + 3_600_000),
        nextWakeAt: new Date(),
        ...overrides,
      })
      .returning({ id: aiOperatorTasks.id }),
  );
  return row!.id;
}

async function readTaskRow(id: string) {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.id, id)).limit(1);
    return row ?? null;
  });
}

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_TASKS_ENABLED', 'true');
  vi.stubEnv('AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('coordinator: unresolvable recipe (E1)', () => {
  runDb('hands off a task whose workflow key this build does not ship', async () => {
    const t = await seedTenant();
    const taskId = await seedTask(t, { workflowKey: 'identity_offboarding', workflowVersion: 1 });

    const claim = await claimTaskLease({ orgId: t.orgId, taskId, requireWakeDue: false });
    expect(claim.won).toBe(true);
    if (!claim.won) return;

    const outcome = await advanceTask(claim.task, claim.leaseEpoch);
    expect(outcome).toContain('handed off');

    const row = await readTaskRow(taskId);
    expect(row?.state).toBe('handed_off');
    expect(row?.outcome).toBe('unresolved');
    expect(row?.outcomeDetail).toContain('identity_offboarding');
    expect(row?.handoffSummary).toContain('Nothing was changed');
    // Released, not held: a task that can never advance must not pin a lease.
    expect(row?.leaseOwner).toBeNull();
    expect(row?.nextWakeAt).toBeNull();
  });

  runDb('hands off a task frozen at a workflow VERSION this build does not ship', async () => {
    const t = await seedTenant();
    const taskId = await seedTask(t, { workflowKey: 'service_recovery', workflowVersion: 99 });

    const claim = await claimTaskLease({ orgId: t.orgId, taskId, requireWakeDue: false });
    expect(claim.won).toBe(true);
    if (!claim.won) return;

    const outcome = await advanceTask(claim.task, claim.leaseEpoch);
    expect(outcome).toContain('handed off');

    const row = await readTaskRow(taskId);
    expect(row?.state).toBe('handed_off');
    expect(row?.outcomeDetail).toContain('version 99');
  });

  runDb('a released service_recovery task still advances normally — the registry did not break dispatch', async () => {
    const t = await seedTenant();
    const taskId = await seedTask(t, { workflowKey: 'service_recovery', workflowVersion: 1 });

    const claim = await claimTaskLease({ orgId: t.orgId, taskId, requireWakeDue: false });
    expect(claim.won).toBe(true);
    if (!claim.won) return;

    const outcome = await advanceTask(claim.task, claim.leaseEpoch);
    // The investigate step admits a reasoning run or hands off because one
    // could not be admitted — either way it is NOT the unresolvable-recipe
    // branch, which is the discriminator this case exists for.
    expect(outcome).not.toContain('does not ship');
  });
});
