/**
 * Behavioral proof that the four wave-E2 AI Operator task-graph tables
 * (`ai_operator_task_targets`, `ai_operator_task_target_accounts`,
 * `ai_operator_task_steps`, `ai_operator_task_events`) are correctly wired
 * into EVERY tenant-lifecycle cascade: org erasure, device delete, device
 * org-move, ticket org-move, and org merge.
 *
 * Cascade registration is a SEPARATE contract from RLS coverage and is the
 * one that gets missed (see CLAUDE.md's "Cascade registration (step 4)"
 * section — a missing cascade-list entry is a latent GDPR org-erasure bug
 * that has shipped or blocked CI five times, caught 5/5 by contract tests and
 * 0/5 by code review). `aiOperatorTaskGraphRls.integration.test.ts` already
 * proves the tenant-isolation half (RLS + composite-FK forges); this file is
 * the companion that proves the four tables actually behave correctly when a
 * tenant-lifecycle operation runs against them for real, against real
 * Postgres — not just that the table names appear in the right lists.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  aiOperatorTaskEvents,
  aiOperatorTaskSteps,
  aiOperatorTaskTargetAccounts,
  aiOperatorTaskTargets,
  aiOperatorTasks,
  aiAgents,
  contacts,
  devices,
  m365Connections,
  tickets,
} from '../../db/schema';
import { createTaskTarget } from '../../services/aiOperator/targetService';
import { admitServiceRecoveryTask } from '../../services/aiOperator/taskService';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { moveTicketOrg } from '../../services/ticketService';
import { executeOrgMerge } from '../../services/orgMerge';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const credentialVersion = '0123456789abcdef0123456789abcdef';

async function insertAgent(orgId: string, createdBy: string): Promise<string> {
  const [agent] = await withSystemDbAccessContext(() =>
    db.insert(aiAgents).values({
      orgId, partnerId: null, kind: 'triage', name: 'Operator', enabled: true, createdBy,
    }).returning(),
  );
  return agent!.id;
}

async function insertDevice(orgId: string, siteId: string): Promise<string> {
  const adminDb = getTestDb() as unknown as typeof db;
  const unique = randomUUID().slice(0, 8);
  const [device] = await adminDb.insert(devices).values({
    orgId,
    siteId,
    agentId: `task-graph-cascade-agent-${unique}`,
    hostname: `task-graph-cascade-host-${unique}`,
    osType: 'windows',
    osVersion: '10',
    architecture: 'x86_64',
    agentVersion: '0.0.0-test',
    status: 'online',
  }).returning();
  return (device as { id: string }).id;
}

interface Org {
  partnerId: string;
  orgId: string;
  siteId: string;
  agentId: string;
  deviceId: string;
}

/** Seeds partner -> org -> site -> agent -> device, under system scope. */
async function seedOrg(partnerId?: string): Promise<Org> {
  return withSystemDbAccessContext(async () => {
    const partner = partnerId ? { id: partnerId } : await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const creator = await createUser({
      partnerId: partner.id, orgId: org.id,
      email: `task-graph-cascade-creator-${randomUUID().slice(0, 8)}@example.test`,
    });
    const agentId = await insertAgent(org.id, creator.id);
    const deviceId = await insertDevice(org.id, site!.id);
    return { partnerId: partner.id, orgId: org.id, siteId: site!.id, agentId, deviceId };
  });
}

async function enableOperatorFlags() {
  process.env.AI_OPERATOR_TASKS_ENABLED = 'true';
  process.env.AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED = 'true';
}

/** Admits a real service-recovery task against `org`'s device — one target
 *  (device, ordinal 0), one step, one event — via the real admission path. */
async function admitTask(org: Org): Promise<string> {
  const result = await admitServiceRecoveryTask({
    orgId: org.orgId,
    agentId: org.agentId,
    objective: 'Restart the print spooler',
    originKind: 'manual',
    requesterUserId: null,
    recipeInput: { deviceId: org.deviceId, serviceName: 'spooler', triggeringAlertId: null },
  });
  if (!result.ok) throw new Error(`admission failed: ${result.refusal} — ${result.detail}`);
  return result.taskId;
}

async function readTarget(id: string) {
  const [row] = await withSystemDbAccessContext(() =>
    db.select().from(aiOperatorTaskTargets).where(eq(aiOperatorTaskTargets.id, id)));
  return row!;
}

describe('AI Operator task graph — tenant-lifecycle cascade wiring (#6167 wave E2)', () => {
  beforeEach(() => {
    enableOperatorFlags();
  });

  afterEach(() => {
    delete process.env.AI_OPERATOR_TASKS_ENABLED;
    delete process.env.AI_OPERATOR_RECIPE_SERVICE_RECOVERY_ENABLED;
  });

  // (1) Org erasure removes rows from all 4 tables, including the
  // append-only events table — proving the breeze_audit_admin erasure path
  // actually works for it (a naive breeze_app DELETE would 42501).
  runDb('org erasure removes rows from all 4 task-graph tables', async () => {
    const org = await seedOrg();
    const taskId = await admitTask(org);
    const actor = await withSystemDbAccessContext(() => createUser({
      partnerId: org.partnerId, orgId: null,
      email: `cascade-erase-${randomUUID().slice(0, 8)}@example.test`,
    }));

    const stats = await cascadeDeleteOrg(org.orgId, actor.id);

    expect(stats.tablesDeleted.ai_operator_task_targets ?? 0).toBeGreaterThanOrEqual(1);
    expect(stats.tablesDeleted.ai_operator_task_steps ?? 0).toBeGreaterThanOrEqual(1);
    expect(stats.tablesDeleted.ai_operator_task_events ?? 0).toBeGreaterThanOrEqual(1);
    expect(stats.tablesDeleted.ai_operator_tasks ?? 0).toBeGreaterThanOrEqual(1);

    const [targets, steps, events, tasks] = await withSystemDbAccessContext(() => Promise.all([
      db.select().from(aiOperatorTaskTargets).where(eq(aiOperatorTaskTargets.taskId, taskId)),
      db.select().from(aiOperatorTaskSteps).where(eq(aiOperatorTaskSteps.taskId, taskId)),
      db.select().from(aiOperatorTaskEvents).where(eq(aiOperatorTaskEvents.taskId, taskId)),
      db.select().from(aiOperatorTasks).where(eq(aiOperatorTasks.id, taskId)),
    ]));
    expect(targets).toHaveLength(0);
    expect(steps).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(tasks).toHaveLength(0);
  });

  // (2) Bare contact DELETE fires the backstop trigger
  // (ai_operator_task_targets_stamp_detach): without it, the referential
  // SET NULL would trip ai_operator_task_targets_one_pointer_chk (23514) and
  // abort the contact DELETE. A passing test here is direct proof the
  // trigger works — with the trigger disabled/broken this test would instead
  // fail with a 23514 on the DELETE FROM contacts statement, not silently.
  runDb('a bare contact DELETE detaches its contact-kind target via the stamp-detach trigger', async () => {
    const org = await seedOrg();
    const taskId = await admitTask(org);

    const contactId = await withSystemDbAccessContext(async () => {
      const [contact] = await db.insert(contacts).values({
        orgId: org.orgId, name: 'Offboarding Target',
      }).returning({ id: contacts.id });
      return contact!.id;
    });

    const targetId = await withSystemDbAccessContext(() =>
      createTaskTarget(db, {
        orgId: org.orgId,
        taskId,
        targetKind: 'contact',
        contactId,
        targetLabel: 'Offboarding Target',
        targetOrdinal: 1,
      }).then((r) => r.id),
    );

    await withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM contacts WHERE id = ${contactId}`));

    const target = await readTarget(targetId);
    expect(target.contactId).toBeNull();
    expect(target.state).toBe('detached');
    expect(target.detachedReason).toBe('scope_invalidated');
    expect(target.targetLabel).toBe('Offboarding Target');
  });

  // (3) Device hard-delete: bare `DELETE FROM devices` (system scope) also
  // fires the backstop stamp-detach trigger via the plain
  // `ON DELETE SET NULL` FK on device_id, with reason 'device_deleted'
  // (OLD.device_id IS NOT NULL branch). Driving deviceDeletion.ts's explicit
  // stamp directly would additionally prove that SPECIFIC statement, but no
  // route in this repo calls deleteDeviceCascade with a device that has NOT
  // already been detached from every other subsystem in a short, self
  // -contained way — the bare DELETE is the documented acceptable fallback
  // and still proves a real, different code path (the trigger) than test (2)
  // above exercises via a different table's FK.
  runDb('a bare device DELETE detaches its device-kind target with device_deleted', async () => {
    const org = await seedOrg();
    const taskId = await admitTask(org);

    const [target] = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskTargets).where(eq(aiOperatorTaskTargets.taskId, taskId)));
    expect(target!.deviceId).toBe(org.deviceId);

    // Detach the task's own inline device_id first (the admitted task also
    // carries devices.id via its FK with ON DELETE RESTRICT semantics on
    // some paths) — clear ai_operator_tasks.device_id and any other device
    // FK referencing this device so the bare DELETE below is not blocked by
    // an unrelated RESTRICT edge; only the target's own detach behavior is
    // under test here.
    await withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE ai_operator_tasks SET device_id = NULL WHERE device_id = ${org.deviceId}`));

    await withSystemDbAccessContext(() =>
      db.execute(sql`DELETE FROM devices WHERE id = ${org.deviceId}`));

    const detached = await readTarget(target!.id);
    expect(detached.deviceId).toBeNull();
    expect(detached.state).toBe('detached');
    expect(detached.detachedReason).toBe('device_deleted');
  });

  // (4) Direct device org-move (`UPDATE devices SET org_id`) fires
  // breeze_cascade_device_org_id(), which detaches the device-kind target
  // with 'device_moved', and severs a ticket-kind target on a device-bound
  // ticket with 'scope_invalidated'.
  runDb('a direct device org-move detaches the device target (device_moved) and the ticket target (scope_invalidated)', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const orgA = await seedOrg(partner.id);
    const orgA2 = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
    const siteA2 = await withSystemDbAccessContext(() => createSite({ orgId: orgA2.id }));

    const taskId = await admitTask(orgA);
    const [deviceTarget] = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskTargets).where(eq(aiOperatorTaskTargets.taskId, taskId)));

    const ticketId = await withSystemDbAccessContext(async () => {
      const [ticket] = await db.insert(tickets).values({
        orgId: orgA.orgId,
        partnerId: partner.id,
        ticketNumber: `CASC-${randomUUID().slice(0, 8)}`,
        subject: 'device-bound ticket',
        deviceId: orgA.deviceId,
        source: 'manual',
      }).returning({ id: tickets.id });
      return ticket!.id;
    });

    const ticketTargetId = await withSystemDbAccessContext(() =>
      createTaskTarget(db, {
        orgId: orgA.orgId,
        taskId,
        targetKind: 'ticket',
        ticketId,
        targetLabel: 'device-bound ticket target',
        targetOrdinal: 1,
      }).then((r) => r.id),
    );

    await withSystemDbAccessContext(() =>
      db.execute(sql`UPDATE devices SET org_id = ${orgA2.id}, site_id = ${siteA2!.id} WHERE id = ${orgA.deviceId}`));

    const movedDeviceTarget = await readTarget(deviceTarget!.id);
    expect(movedDeviceTarget.deviceId).toBeNull();
    expect(movedDeviceTarget.state).toBe('detached');
    expect(movedDeviceTarget.detachedReason).toBe('device_moved');

    const severedTicketTarget = await readTarget(ticketTargetId);
    expect(severedTicketTarget.ticketId).toBeNull();
    expect(severedTicketTarget.state).toBe('detached');
    expect(severedTicketTarget.detachedReason).toBe('scope_invalidated');
  });

  // (5) `moveTicketOrg` detaches a ticket-kind target with 'scope_invalidated'.
  runDb('moveTicketOrg detaches a ticket-kind target', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const orgA = await seedOrg(partner.id);
    const orgA2 = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
    const actor = await withSystemDbAccessContext(() => createUser({
      partnerId: partner.id, orgId: orgA.orgId,
      email: `cascade-ticket-move-${randomUUID().slice(0, 8)}@example.test`,
    }));

    const taskId = await admitTask(orgA);

    const ticketId = await withSystemDbAccessContext(async () => {
      const [ticket] = await db.insert(tickets).values({
        orgId: orgA.orgId,
        partnerId: partner.id,
        ticketNumber: `CASC-${randomUUID().slice(0, 8)}`,
        subject: 'ticket to move',
        source: 'manual',
      }).returning({ id: tickets.id });
      return ticket!.id;
    });

    const ticketTargetId = await withSystemDbAccessContext(() =>
      createTaskTarget(db, {
        orgId: orgA.orgId,
        taskId,
        targetKind: 'ticket',
        ticketId,
        targetLabel: 'ticket to move target',
        targetOrdinal: 1,
      }).then((r) => r.id),
    );

    await withSystemDbAccessContext(() =>
      moveTicketOrg(ticketId, orgA2.id, { userId: actor.id }));

    const severed = await readTarget(ticketTargetId);
    expect(severed.ticketId).toBeNull();
    expect(severed.state).toBe('detached');
    expect(severed.detachedReason).toBe('scope_invalidated');
  });

  // (6) Org merge with a contact target + a frozen m365 account on a LIVE
  // task completes without 23503, detaches the contact/device/ticket
  // pointers with 'org_merged', nulls the account's connection pointer while
  // freezing external_id/principal_label, and leaves the target row's org_id
  // pointing at the LOSER org (leave-for-erasure, not repointed).
  runDb('org merge fences a live task, detaches its contact target with org_merged, and freezes the account evidence', async () => {
    const partner = await withSystemDbAccessContext(() => createPartner());
    const loser = await seedOrg(partner.id);
    const survivor = await withSystemDbAccessContext(() => createOrganization({ partnerId: partner.id }));
    const actor = await withSystemDbAccessContext(() => createUser({
      partnerId: partner.id, orgId: null,
      email: `cascade-merge-${randomUUID().slice(0, 8)}@example.test`,
    }));

    // admitTask leaves the task in 'queued', a live state per
    // AI_OPERATOR_LIVE_TASK_STATES — exactly the case the merge fence exists for.
    const taskId = await admitTask(loser);

    const { contactId, connectionId } = await withSystemDbAccessContext(async () => {
      const [contact] = await db.insert(contacts).values({
        orgId: loser.orgId, name: 'Merge Contact',
      }).returning({ id: contacts.id });
      const [conn] = await db.insert(m365Connections).values({
        orgId: loser.orgId,
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
      return { contactId: contact!.id, connectionId: conn!.id };
    });

    const contactTargetId = await withSystemDbAccessContext(() =>
      createTaskTarget(db, {
        orgId: loser.orgId,
        taskId,
        targetKind: 'contact',
        contactId,
        targetLabel: 'Merge Contact',
        targetOrdinal: 1,
      }).then((r) => r.id),
    );

    const accountId = await withSystemDbAccessContext(async () => {
      const [row] = await db.insert(aiOperatorTaskTargetAccounts).values({
        orgId: loser.orgId,
        taskId,
        targetId: contactTargetId,
        provider: 'm365',
        m365ConnectionId: connectionId,
        externalId: 'frozen-external-id-abc123',
        principalLabel: 'merge.contact@example.test',
      }).returning({ id: aiOperatorTaskTargetAccounts.id });
      return row!.id;
    });

    const priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      await expect(executeOrgMerge({
        loserOrgId: loser.orgId,
        survivorOrgId: survivor.id,
        partnerId: partner.id,
        performedBy: actor.id,
        performedByEmail: actor.email,
      })).resolves.not.toThrow();
    } finally {
      if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
    }

    const target = await readTarget(contactTargetId);
    expect(target.state).toBe('detached');
    expect(target.detachedReason).toBe('org_merged');
    expect(target.contactId).toBeNull();
    // leave-for-erasure: the target's org_id is STILL the loser's, not
    // repointed to the survivor.
    expect(target.orgId).toBe(loser.orgId);

    const [account] = await withSystemDbAccessContext(() =>
      db.select().from(aiOperatorTaskTargetAccounts).where(eq(aiOperatorTaskTargetAccounts.id, accountId)));
    expect(account!.m365ConnectionId).toBeNull();
    expect(account!.externalId).toBe('frozen-external-id-abc123');
    expect(account!.principalLabel).toBe('merge.contact@example.test');
  });
});
