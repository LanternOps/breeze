/**
 * Functional cross-tenant RLS + constraint forge tests for the AI Operator
 * task object graph added in wave E2 (#6167): `ai_operator_task_targets`,
 * `ai_operator_task_target_accounts`, `ai_operator_task_steps`,
 * `ai_operator_task_events`.
 *
 * SECURITY-CRITICAL. `rls-coverage.integration.test.ts` only proves the
 * policies EXIST in pg_catalog for these four (Shape 1, direct NOT NULL
 * org_id, `breeze_has_org_access(org_id)`); it does NOT prove a real
 * cross-tenant write is rejected at runtime, nor that the composite FKs, the
 * CHECK constraints, and the append-only trigger on
 * `ai_operator_task_events` actually hold. This file is the behavioral
 * guard: it runs code-under-test as the unprivileged `breeze_app` role
 * (rolbypassrls=false) so RLS is actually enforced, mirroring
 * `quoteOrdersRls.integration.test.ts` and `m365TenantSyncRls.integration.test.ts`.
 *
 * Fixture topology (seeded fresh per test under system scope, which bypasses
 * RLS so the seed can write partner/org/site/agent/device rows):
 *   partnerA -> orgA (site + agent + device)   — the caller's tenant
 *   partnerB -> orgB (site + agent + device)   — the foreign tenant
 *   an m365_connections row + a contacts row seeded under orgB, used by the
 *   FK-mismatch cases (account naming a foreign connection, contact target
 *   naming a foreign contact).
 *
 * Runs under vitest.integration.config.ts. Fresh fixture per test — no
 * module-level caching, because setup.ts's beforeEach TRUNCATEs
 * partners/organizations CASCADE.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  aiAgents,
  aiOperatorTasks,
  aiOperatorTaskTargets,
  aiOperatorTaskTargetAccounts,
  aiOperatorTaskSteps,
  aiOperatorTaskEvents,
  contacts,
  devices,
  m365Connections,
} from '../../db/schema';
import { appendTaskEvent } from '../../services/aiOperator/eventService';
import { admitServiceRecoveryTask } from '../../services/aiOperator/taskService';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const credentialVersion = '0123456789abcdef0123456789abcdef';

interface TenantFixture {
  partnerId: string;
  orgId: string;
  siteId: string;
  agentId: string;
  deviceId: string;
  ctx: DbAccessContext;
}

interface Fixture {
  a: TenantFixture;
  b: TenantFixture;
  /** m365 connection + contact seeded under orgB, for the FK-mismatch cases. */
  orgBM365ConnectionId: string;
  orgBContactId: string;
}

async function insertAgent(orgId: string, createdBy: string): Promise<string> {
  const [agent] = await withSystemDbAccessContext(() =>
    db.insert(aiAgents).values({
      orgId, partnerId: null, kind: 'triage', name: 'Operator', enabled: true, createdBy,
    }).returning(),
  );
  return agent!.id;
}

async function insertDevice(orgId: string, siteId: string): Promise<string> {
  // Admin connection, matching the aiOperatorAdmission / m365TenantSync fixture
  // pattern: seeding a device is not the thing under test.
  const adminDb = getTestDb() as unknown as typeof db;
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb.insert(devices).values({
    orgId,
    siteId,
    agentId: `task-graph-rls-agent-${unique}`,
    hostname: `task-graph-rls-host-${unique}`,
    osType: 'windows',
    osVersion: '10',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning();
  return (device as { id: string }).id;
}

async function seedTenant(): Promise<TenantFixture> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  const agentId = await insertAgent(org.id, user.id);
  const deviceId = await insertDevice(org.id, site!.id);
  const ctx: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [partner.id],
    userId: null,
  };
  return { partnerId: partner.id, orgId: org.id, siteId: site!.id, agentId, deviceId, ctx };
}

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const a = await seedTenant();
    const b = await seedTenant();

    const [m365Conn] = await db.insert(m365Connections).values({
      orgId: b.orgId,
      userId: null,
      tenantId: randomUUID(),
      consentAttemptId: randomUUID(),
      clientId: randomUUID(),
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: `akv://vault.example/m365-customer-graph-read-${randomUUID()}/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 3,
      status: 'active',
    }).returning({ id: m365Connections.id });

    const [contact] = await db.insert(contacts).values({
      orgId: b.orgId,
      name: 'Foreign Contact',
    }).returning({ id: contacts.id });

    return {
      a,
      b,
      orgBM365ConnectionId: m365Conn!.id,
      orgBContactId: contact!.id,
    };
  });
}

/** Seeds a bare ai_operator_tasks row directly (system scope), with no
 *  target/step/event side-effects — used where a test needs a real task to
 *  hang children off without admission's own auto-created rows in the way. */
async function seedBareTask(t: TenantFixture, overrides: Record<string, unknown> = {}) {
  const [row] = await withSystemDbAccessContext(() =>
    db.insert(aiOperatorTasks).values({
      orgId: t.orgId,
      agentId: t.agentId,
      agentKind: 'triage',
      agentName: 'Operator',
      workflowKey: 'service_recovery',
      workflowVersion: 1,
      originKind: 'manual' as const,
      objective: 'Restart the print spooler',
      deviceId: t.deviceId,
      state: 'running',
      revision: 1,
      leaseEpoch: 0,
      deadlineAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    }).returning({ id: aiOperatorTasks.id }),
  );
  return row!.id as string;
}

async function seedTarget(t: TenantFixture, taskId: string, overrides: Record<string, unknown> = {}) {
  const [row] = await withSystemDbAccessContext(() =>
    db.insert(aiOperatorTaskTargets).values({
      orgId: t.orgId,
      taskId,
      targetKind: 'device',
      deviceId: t.deviceId,
      targetLabel: 'seeded-target',
      targetOrdinal: 0,
      ...overrides,
    }).returning({ id: aiOperatorTaskTargets.id }),
  );
  return row!.id as string;
}

async function enableOperatorFlags() {
  process.env.AI_OPERATOR_TASKS_ENABLED = 'true';
  process.env.AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED = 'true';
}

async function admitOrgTask(t: TenantFixture) {
  const result = await admitServiceRecoveryTask({
    orgId: t.orgId,
    agentId: t.agentId,
    objective: 'Restart the print spooler',
    originKind: 'manual',
    requesterUserId: null,
    recipeInput: { deviceId: t.deviceId, serviceName: 'spooler', triggeringAlertId: randomUUID() },
  });
  if (!result.ok) throw new Error(`admission failed: ${result.refusal} — ${result.detail}`);
  return result.taskId;
}

describe('AI Operator task graph RLS + constraint forge (breeze_app)', () => {
  beforeEach(() => {
    enableOperatorFlags();
  });

  afterEach(() => {
    delete process.env.AI_OPERATOR_TASKS_ENABLED;
    delete process.env.AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED;
  });

  // (0) Non-vacuity guard: the pool that code-under-test runs on inside
  // withDbAccessContext must be the unprivileged breeze_app role with
  // rolbypassrls=false. If this were ever a BYPASSRLS connection, every forge
  // assertion below would pass even with broken policies.
  runDb('code-under-test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const fx = await seedFixture();
    const rows = await withDbAccessContext(fx.a.ctx, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls
                     FROM pg_roles WHERE rolname = current_user`)
    );
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  // (1) ai_operator_task_targets: cross-tenant INSERT denied (42501).
  runDb('blocks a forged cross-tenant ai_operator_task_targets INSERT for another org (42501)', async () => {
    const fx = await seedFixture();
    const orgBTaskId = await seedBareTask(fx.b);

    await expect(
      withDbAccessContext(fx.a.ctx, () =>
        db.insert(aiOperatorTaskTargets).values({
          orgId: fx.b.orgId, // foreign org — RLS WITH CHECK must reject
          taskId: orgBTaskId, // real orgB task (FK-valid)
          targetKind: 'device',
          deviceId: fx.b.deviceId,
          targetLabel: 'forged-target',
          targetOrdinal: 0,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (2) ai_operator_task_target_accounts: cross-tenant INSERT denied (42501).
  runDb('blocks a forged cross-tenant ai_operator_task_target_accounts INSERT for another org (42501)', async () => {
    const fx = await seedFixture();
    const orgBTaskId = await seedBareTask(fx.b);
    const orgBTargetId = await seedTarget(fx.b, orgBTaskId);

    await expect(
      withDbAccessContext(fx.a.ctx, () =>
        db.insert(aiOperatorTaskTargetAccounts).values({
          orgId: fx.b.orgId, // foreign org — RLS WITH CHECK must reject
          taskId: orgBTaskId,
          targetId: orgBTargetId,
          provider: 'm365',
          m365ConnectionId: fx.orgBM365ConnectionId,
          externalId: 'forged-external-id',
          principalLabel: 'forged@example.com',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (3) ai_operator_task_steps: cross-tenant INSERT denied (42501).
  runDb('blocks a forged cross-tenant ai_operator_task_steps INSERT for another org (42501)', async () => {
    const fx = await seedFixture();
    const orgBTaskId = await seedBareTask(fx.b);

    await expect(
      withDbAccessContext(fx.a.ctx, () =>
        db.insert(aiOperatorTaskSteps).values({
          orgId: fx.b.orgId, // foreign org — RLS WITH CHECK must reject
          taskId: orgBTaskId,
          stepKey: 'investigate',
          stepKind: 'reason',
          attemptOrdinal: 0,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (4) ai_operator_task_events: cross-tenant INSERT denied (42501).
  runDb('blocks a forged cross-tenant ai_operator_task_events INSERT for another org (42501)', async () => {
    const fx = await seedFixture();
    const orgBTaskId = await seedBareTask(fx.b);

    await expect(
      withDbAccessContext(fx.a.ctx, () =>
        db.insert(aiOperatorTaskEvents).values({
          orgId: fx.b.orgId, // foreign org — RLS WITH CHECK must reject
          taskId: orgBTaskId,
          transitionSeq: 1,
          eventType: 'task_admitted',
          actorKind: 'system',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  // (5) Cross-tenant SELECT hidden for each of the 4 tables (silent zero-row
  // read, not an error), with a system-scope probe first confirming the row
  // exists, and a positive control proving an org-scoped context that DOES
  // own the tenant sees it.
  runDb('hides another org ai_operator_task_targets/accounts/steps/events from SELECT (system probe confirms existence)', async () => {
    const fx = await seedFixture();
    const orgBTaskId = await seedBareTask(fx.b);
    const orgBTargetId = await seedTarget(fx.b, orgBTaskId);
    const [orgBAccount] = await withSystemDbAccessContext(() =>
      db.insert(aiOperatorTaskTargetAccounts).values({
        orgId: fx.b.orgId,
        taskId: orgBTaskId,
        targetId: orgBTargetId,
        provider: 'm365',
        m365ConnectionId: fx.orgBM365ConnectionId,
        externalId: 'real-external-id',
        principalLabel: 'real@example.com',
      }).returning({ id: aiOperatorTaskTargetAccounts.id }),
    );
    const [orgBStep] = await withSystemDbAccessContext(() =>
      db.insert(aiOperatorTaskSteps).values({
        orgId: fx.b.orgId,
        taskId: orgBTaskId,
        stepKey: 'investigate',
        stepKind: 'reason',
        targetId: orgBTargetId,
        attemptOrdinal: 0,
      }).returning({ id: aiOperatorTaskSteps.id }),
    );
    const orgBEventSeq = await withSystemDbAccessContext(() =>
      appendTaskEvent(db, {
        orgId: fx.b.orgId,
        taskId: orgBTaskId,
        eventType: 'task_admitted',
        actor: { kind: 'system' },
      }),
    );
    expect(orgBEventSeq).not.toBeNull();

    const orgBCtx: DbAccessContext = fx.b.ctx;

    // targets
    const existsUnderSystem = await withSystemDbAccessContext(() =>
      db.select({ id: aiOperatorTaskTargets.id }).from(aiOperatorTaskTargets)
        .where(eq(aiOperatorTaskTargets.id, orgBTargetId)));
    expect(existsUnderSystem).toHaveLength(1);
    const targetVisibleToA = await withDbAccessContext(fx.a.ctx, () =>
      db.select({ id: aiOperatorTaskTargets.id }).from(aiOperatorTaskTargets)
        .where(eq(aiOperatorTaskTargets.id, orgBTargetId)));
    expect(targetVisibleToA).toHaveLength(0);
    const targetVisibleToB = await withDbAccessContext(orgBCtx, () =>
      db.select({ id: aiOperatorTaskTargets.id }).from(aiOperatorTaskTargets)
        .where(eq(aiOperatorTaskTargets.id, orgBTargetId)));
    expect(targetVisibleToB).toHaveLength(1);

    // target_accounts
    const accountVisibleToA = await withDbAccessContext(fx.a.ctx, () =>
      db.select({ id: aiOperatorTaskTargetAccounts.id }).from(aiOperatorTaskTargetAccounts)
        .where(eq(aiOperatorTaskTargetAccounts.id, orgBAccount!.id)));
    expect(accountVisibleToA).toHaveLength(0);
    const accountVisibleToB = await withDbAccessContext(orgBCtx, () =>
      db.select({ id: aiOperatorTaskTargetAccounts.id }).from(aiOperatorTaskTargetAccounts)
        .where(eq(aiOperatorTaskTargetAccounts.id, orgBAccount!.id)));
    expect(accountVisibleToB).toHaveLength(1);

    // steps
    const stepVisibleToA = await withDbAccessContext(fx.a.ctx, () =>
      db.select({ id: aiOperatorTaskSteps.id }).from(aiOperatorTaskSteps)
        .where(eq(aiOperatorTaskSteps.id, orgBStep!.id)));
    expect(stepVisibleToA).toHaveLength(0);
    const stepVisibleToB = await withDbAccessContext(orgBCtx, () =>
      db.select({ id: aiOperatorTaskSteps.id }).from(aiOperatorTaskSteps)
        .where(eq(aiOperatorTaskSteps.id, orgBStep!.id)));
    expect(stepVisibleToB).toHaveLength(1);

    // events
    const eventVisibleToA = await withDbAccessContext(fx.a.ctx, () =>
      db.select({ id: aiOperatorTaskEvents.id }).from(aiOperatorTaskEvents)
        .where(and(eq(aiOperatorTaskEvents.taskId, orgBTaskId), eq(aiOperatorTaskEvents.transitionSeq, orgBEventSeq!))));
    expect(eventVisibleToA).toHaveLength(0);
    const eventVisibleToB = await withDbAccessContext(orgBCtx, () =>
      db.select({ id: aiOperatorTaskEvents.id }).from(aiOperatorTaskEvents)
        .where(and(eq(aiOperatorTaskEvents.taskId, orgBTaskId), eq(aiOperatorTaskEvents.transitionSeq, orgBEventSeq!))));
    expect(eventVisibleToB).toHaveLength(1);
  });

  // (6) Same-org step naming a target belonging to a DIFFERENT task -> 23503
  // (violates ai_operator_task_steps_target_fk, the 3-column tuple FK).
  runDb('same-org step naming a target of a different task -> 23503', async () => {
    const fx = await seedFixture();
    const task1Id = await seedBareTask(fx.a);
    const task2Id = await seedBareTask(fx.a);
    const target1Id = await seedTarget(fx.a, task1Id);

    await expect(
      withDbAccessContext(fx.a.ctx, () =>
        db.insert(aiOperatorTaskSteps).values({
          orgId: fx.a.orgId,
          taskId: task2Id,
          targetId: target1Id, // belongs to task1, not task2
          stepKey: 'investigate',
          stepKind: 'reason',
          attemptOrdinal: 0,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  // (7) Account naming an m365_connections row belonging to a DIFFERENT org
  // -> 23503 (composite (m365_connection_id, org_id) FK can't resolve). The
  // insert itself is same-org (orgId=orgA) so RLS passes; only the FK fails.
  runDb('account naming an m365_connections row from a different org -> 23503', async () => {
    const fx = await seedFixture();
    const taskId = await seedBareTask(fx.a);
    const targetId = await seedTarget(fx.a, taskId);

    await expect(
      withDbAccessContext(fx.a.ctx, () =>
        db.insert(aiOperatorTaskTargetAccounts).values({
          orgId: fx.a.orgId, // same-org insert, RLS passes
          taskId,
          targetId,
          provider: 'm365',
          m365ConnectionId: fx.orgBM365ConnectionId, // orgB's connection
          externalId: 'mismatched-external-id',
          principalLabel: 'mismatched@example.com',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  // (8) Contact target naming a contact in a different org -> 23503
  // (composite (contact_id, org_id) -> contacts(id, org_id) FK).
  runDb('contact target naming a contact from a different org -> 23503', async () => {
    const fx = await seedFixture();
    const taskId = await seedBareTask(fx.a);

    await expect(
      withDbAccessContext(fx.a.ctx, () =>
        db.insert(aiOperatorTaskTargets).values({
          orgId: fx.a.orgId, // same-org insert, RLS passes
          taskId,
          targetKind: 'contact',
          contactId: fx.orgBContactId, // orgB's contact
          targetLabel: 'mismatched-contact-target',
          targetOrdinal: 0,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  // (9) target_kind 'contact' but only device_id set -> 23514 (violates
  // ai_operator_task_targets_kind_pointer_chk).
  runDb("target_kind 'contact' with only device_id set -> 23514 CHECK violation", async () => {
    const fx = await seedFixture();
    const taskId = await seedBareTask(fx.a);

    await expect(
      withDbAccessContext(fx.a.ctx, () =>
        db.insert(aiOperatorTaskTargets).values({
          orgId: fx.a.orgId,
          taskId,
          targetKind: 'contact',
          deviceId: fx.a.deviceId, // wrong pointer for the declared kind
          targetLabel: 'wrong-pointer-target',
          targetOrdinal: 0,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  // (10) Events append-only: UPDATE and DELETE are both rejected, either by
  // the REVOKE (42501) or the immutability trigger (55000) — whichever
  // surfaces first is correct per the migration header.
  runDb('ai_operator_task_events rejects UPDATE and DELETE as breeze_app (55000 or 42501)', async () => {
    const fx = await seedFixture();
    const taskId = await seedBareTask(fx.a);
    const seq = await withSystemDbAccessContext(() =>
      appendTaskEvent(db, {
        orgId: fx.a.orgId,
        taskId,
        eventType: 'task_admitted',
        actor: { kind: 'system' },
      }),
    );
    expect(seq).not.toBeNull();
    const [eventRow] = await withSystemDbAccessContext(() =>
      db.select({ id: aiOperatorTaskEvents.id }).from(aiOperatorTaskEvents)
        .where(and(eq(aiOperatorTaskEvents.taskId, taskId), eq(aiOperatorTaskEvents.transitionSeq, seq!))));
    const eventId = eventRow!.id;

    try {
      await withDbAccessContext(fx.a.ctx, () =>
        db.update(aiOperatorTaskEvents).set({ detail: 'tampered' })
          .where(eq(aiOperatorTaskEvents.id, eventId))
      );
      expect.unreachable('UPDATE on an append-only event row must be rejected');
    } catch (error) {
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      expect(['55000', '42501']).toContain(code);
    }

    try {
      await withDbAccessContext(fx.a.ctx, () =>
        db.delete(aiOperatorTaskEvents).where(eq(aiOperatorTaskEvents.id, eventId))
      );
      expect.unreachable('DELETE on an append-only event row must be rejected');
    } catch (error) {
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      expect(['55000', '42501']).toContain(code);
    }
  });

  // (11) 20 concurrent appendTaskEvent calls for ONE task, each in its OWN
  // withSystemDbAccessContext (20 separate transactions racing on the same
  // task row lock). The allocator serializes on the row lock, so the
  // returned transition_seq values must be exactly [1..20] with no gaps, no
  // duplicates, no null/rejection.
  runDb('20 concurrent appendTaskEvent calls for one task allocate transition_seq 1..20 with no gaps or duplicates', async () => {
    const fx = await seedFixture();
    const taskId = await seedBareTask(fx.a, { eventSeq: 0 });

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        withSystemDbAccessContext(() =>
          appendTaskEvent(db, {
            orgId: fx.a.orgId,
            taskId,
            eventType: 'step_opened',
            actor: { kind: 'coordinator' },
          })
        )
      )
    );

    expect(results.every((seq) => seq !== null)).toBe(true);
    const seqs = (results as number[]).slice().sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  // (12) admitServiceRecoveryTask side-effects: exactly one target, one step,
  // one event, and the task's own event_seq column equals 1.
  runDb('admitServiceRecoveryTask writes exactly one target, one step, one task_admitted event', async () => {
    const fx = await seedFixture();
    const taskId = await admitOrgTask(fx.a);

    const targets = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskTargets).where(eq(aiOperatorTaskTargets.taskId, taskId)));
    expect(targets).toHaveLength(1);
    expect(targets[0]!.targetOrdinal).toBe(0);
    expect(targets[0]!.targetKind).toBe('device');
    expect(targets[0]!.deviceId).toBe(fx.a.deviceId);
    expect(targets[0]!.state).toBe('active');

    const steps = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskSteps).where(eq(aiOperatorTaskSteps.taskId, taskId)));
    expect(steps).toHaveLength(1);
    expect(steps[0]!.stepKey).toBe('investigate');
    expect(steps[0]!.stepKind).toBe('reason');
    expect(steps[0]!.attemptOrdinal).toBe(0);

    const events = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskEvents).where(eq(aiOperatorTaskEvents.taskId, taskId)));
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('task_admitted');
    expect(events[0]!.transitionSeq).toBe(1);

    const [task] = await withSystemDbAccessContext(() =>
      db.select({ eventSeq: aiOperatorTasks.eventSeq }).from(aiOperatorTasks).where(eq(aiOperatorTasks.id, taskId)));
    expect(task!.eventSeq).toBe(1);
  });
});
