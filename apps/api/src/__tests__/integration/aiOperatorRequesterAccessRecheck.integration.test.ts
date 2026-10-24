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

// ---------------------------------------------------------------------------
// R1a-0 Task 1f — the target-aware gate against real Postgres. Appended; the
// two device-path cases above are unchanged.
//
// Only the service-recovery checkpoint arm exists in R1a-0 (R1a adds the
// identity arm), so a contact-targeted task cannot yet be ADVANCED: these
// cases call `requesterAccessLostForTargets` directly on a real task with real
// target rows, real membership and real `organization_users.site_ids`. The
// coordinator's arm-based selection of this gate is unit-tested in
// taskCoordinatorPlanApproval.test.ts; R1a's identity E2E drives it end to end.
// ---------------------------------------------------------------------------
import { aiOperatorTaskTargets as aiOperatorTaskTargetsR1a0, contacts, organizationUsers as orgUsersTable } from '../../db/schema';
import { requesterAccessLostForTargets } from '../../services/aiOperator/requesterAccessGate';
import { createTaskTarget, detachTargets } from '../../services/aiOperator/targetService';

async function createContactTask(t: Tenant) {
  const [contact] = await withSystemDbAccessContext(() =>
    db.insert(contacts).values({ orgId: t.orgId, name: 'Dana Departing', email: `dana-${randomUUID()}@customer.test` }).returning(),
  );
  const [task] = await withSystemDbAccessContext(() =>
    db
      .insert(aiOperatorTasks)
      .values({
        orgId: t.orgId,
        agentId: t.agentId,
        agentKind: 'triage',
        agentName: 'Operator',
        workflowKey: 'fixture_contact_recipe',
        workflowVersion: 1,
        originKind: 'manual' as const,
        requesterUserId: t.requesterId,
        objective: 'Offboard a person',
        deviceId: null,
        state: 'running',
        phase: 'execute',
        currentStepKey: 'effects',
        checkpoint: checkpointFor(t) as unknown as Record<string, unknown>,
        revision: 1,
        leaseEpoch: 0,
        attemptOrdinal: 0,
        deadlineAt: new Date(Date.now() + 3_600_000),
      })
      .returning(),
  );
  const target = await withSystemDbAccessContext(() => createTaskTarget(db, {
    orgId: t.orgId, taskId: task!.id, targetKind: 'contact', contactId: contact!.id,
    targetLabel: 'Dana Departing', targetOrdinal: 0,
  }));
  return { task: task!, contactId: contact!.id, targetId: target.id };
}

describe('AI Operator — target-aware requester recheck (R1a-0, contact target)', () => {
  it('an unrestricted org requester on a live, in-org contact target keeps access', async () => {
    const t = await seedTenant();
    const { task } = await createContactTask(t);
    await expect(requesterAccessLostForTargets(task)).resolves.toEqual({ lost: false, detail: null });
  });

  it('a requester narrowed to a site loses access on a contact target', async () => {
    const t = await seedTenant();
    const { task } = await createContactTask(t);
    await withSystemDbAccessContext(() =>
      db.update(orgUsersTable).set({ siteIds: [t.siteId] }).where(eq(orgUsersTable.id, t.orgUserRowId)),
    );
    const check = await requesterAccessLostForTargets(task);
    expect(check.lost).toBe(true);
    expect(check.detail).toMatch(/site-restricted/);
  });

  it('a task whose only contact target was detached loses access', async () => {
    const t = await seedTenant();
    const { task } = await createContactTask(t);
    await withSystemDbAccessContext(() => detachTargets(db, { orgId: t.orgId, taskId: task.id, reason: 'org_merged' }));
    const check = await requesterAccessLostForTargets(task);
    expect(check.lost).toBe(true);
    expect(check.detail).toMatch(/detached/);
  });

  it("a revoked org membership loses access before any target is read", async () => {
    const t = await seedTenant();
    const { task } = await createContactTask(t);
    await withSystemDbAccessContext(() =>
      db.delete(orgUsersTable).where(eq(orgUsersTable.id, t.orgUserRowId)),
    );
    const check = await requesterAccessLostForTargets(task);
    expect(check.lost).toBe(true);
    expect(check.detail).toMatch(/organization/);
  });

  it("another org's task id never resolves this org's targets (the org_id predicate is the isolation)", async () => {
    const t = await seedTenant();
    const other = await seedTenant();
    const { task } = await createContactTask(t);
    // Same task id, the OTHER tenant's org and requester: the target rows are
    // keyed to t.orgId, so the gate must find no live target for other.orgId.
    const check = await requesterAccessLostForTargets({ id: task.id, orgId: other.orgId, requesterUserId: other.requesterId });
    expect(check.lost).toBe(true);
    expect(check.detail).toMatch(/no live target/);
  });
});

// ---- R1a-0 review round (Opus): appended ----
import { createSite as createSiteR1a0 } from './db-utils';

describe('AI Operator — target-aware requester recheck: review-round cases (R1a-0)', () => {
  it('one detached contact target alongside a live one loses access (the sealed plan may still act on it)', async () => {
    const t = await seedTenant();
    const { task } = await createContactTask(t);
    const [second] = await withSystemDbAccessContext(() =>
      db.insert(contacts).values({ orgId: t.orgId, name: 'Second Person', email: `second-${randomUUID()}@customer.test` }).returning(),
    );
    const extra = await withSystemDbAccessContext(() => createTaskTarget(db, {
      orgId: t.orgId, taskId: task.id, targetKind: 'contact', contactId: second!.id, targetLabel: 'Second Person', targetOrdinal: 1,
    }));
    await expect(requesterAccessLostForTargets(task)).resolves.toEqual({ lost: false, detail: null });
    await withSystemDbAccessContext(() => detachTargets(db, { orgId: t.orgId, targetId: extra.id, reason: 'scope_invalidated' }));
    const check = await requesterAccessLostForTargets(task);
    expect(check.lost).toBe(true);
    expect(check.detail).toMatch(/detached/);
  });

  it("a device target on a site outside the requester's sites loses access; on their site it keeps it", async () => {
    const t = await seedTenant();
    const { task } = await createContactTask(t);
    // Replace the contact target with a device target on the tenant's site.
    await withSystemDbAccessContext(() =>
      db.delete(aiOperatorTaskTargetsR1a0).where(eq(aiOperatorTaskTargetsR1a0.taskId, task.id)),
    );
    await withSystemDbAccessContext(() => createTaskTarget(db, {
      orgId: t.orgId, taskId: task.id, targetKind: 'device', deviceId: t.deviceId, targetLabel: 'host', targetOrdinal: 0,
    }));
    await withSystemDbAccessContext(() =>
      db.update(orgUsersTable).set({ siteIds: [t.siteId] }).where(eq(orgUsersTable.id, t.orgUserRowId)),
    );
    await expect(requesterAccessLostForTargets(task)).resolves.toEqual({ lost: false, detail: null });

    const otherSite = await createSiteR1a0({ orgId: t.orgId });
    await withSystemDbAccessContext(() =>
      db.update(orgUsersTable).set({ siteIds: [otherSite.id] }).where(eq(orgUsersTable.id, t.orgUserRowId)),
    );
    const check = await requesterAccessLostForTargets(task);
    expect(check.lost).toBe(true);
    expect(check.detail).toMatch(/site/);
  });
});
