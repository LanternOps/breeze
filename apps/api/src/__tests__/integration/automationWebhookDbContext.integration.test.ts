/**
 * #7363 — `POST /api/v1/automations/webhooks/:id` is mounted without
 * `authMiddleware`, so nothing opens a DB context for it. Code under test
 * connects as the unprivileged `breeze_app` role, where `automations` is
 * FORCE ROW LEVEL SECURITY and `breeze_current_scope()` defaults to 'none': a
 * contextless lookup sees zero rows and every correctly signed webhook
 * answered `404 Automation not found`.
 *
 * These drive the real router against real Postgres (as `breeze_app`) and real
 * Redis (replay nonces). Only the BullMQ enqueue is stubbed, and it asserts the
 * run row is already committed when it is called.
 */
import './setup';
import { createHmac, randomUUID } from 'crypto';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueAutomationRun = vi.hoisted(() => vi.fn());
vi.mock('../../jobs/automationWorker', async (orig) => ({
  ...(await orig<typeof import('../../jobs/automationWorker')>()),
  enqueueAutomationRun,
}));

import { automations, automationRuns, devices, organizations, partners } from '../../db/schema';
import { automationWebhookRoutes } from '../../routes/automations';
import { encryptSecret } from '../../services/secretCrypto';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';

const SECRET = 'webhook-secret-7363';

function app() {
  return new Hono().route('/api/v1/automations/webhooks', automationWebhookRoutes);
}

function signedPost(automationId: string, body: unknown, secret = SECRET) {
  const rawBody = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
  return app().request(`/api/v1/automations/webhooks/${automationId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-breeze-timestamp': timestamp,
      'x-breeze-signature': signature,
      'x-breeze-event-id': randomUUID(),
    },
    body: rawBody,
  });
}

async function seedWebhookAutomation(owner: { orgId: string } | { partnerId: string }) {
  const [row] = await getTestDb()
    .insert(automations)
    .values({
      ...owner,
      name: `webhook-7363-${randomUUID()}`,
      enabled: true,
      trigger: { type: 'webhook', secret: encryptSecret(SECRET) },
      actions: [{ type: 'execute_command', command: 'echo ok' }],
      runCount: 0,
    })
    .returning();
  if (!row) throw new Error('failed to seed automation');
  return row;
}

async function seedDevice(orgId: string) {
  const site = await createSite({ orgId });
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId: site!.id,
      agentId: `agent-${randomUUID()}`,
      hostname: `host-${randomUUID().slice(0, 8)}`,
      osType: 'linux',
      osVersion: '1.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning();
  if (!row) throw new Error('failed to seed device');
  return row;
}

async function runsFor(automationId: string) {
  return getTestDb().select().from(automationRuns).where(eq(automationRuns.automationId, automationId));
}

describe('automation webhook route under breeze_app (#7363)', () => {
  beforeEach(() => {
    enqueueAutomationRun.mockReset();
    enqueueAutomationRun.mockImplementation(async (runId: string) => {
      // Enqueue must follow the commit: the worker reads the run on another connection.
      const [committed] = await getTestDb().select().from(automationRuns).where(eq(automationRuns.id, runId));
      expect(committed?.status).toBe('running');
    });
  });

  it('accepts a signed webhook for an org-owned automation and records the run', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner!.id });
    const sibling = await createOrganization({ partnerId: partner!.id });
    const own = await seedDevice(org!.id);
    await seedDevice(sibling!.id);
    const automation = await seedWebhookAutomation({ orgId: org!.id });

    const res = await signedPost(automation.id, { ping: true });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    // Unbounded target = every device the owner can see: its own org only.
    expect(body.run.devicesTargeted).toBe(1);
    const runs = await runsFor(automation.id);
    expect(runs.map((r) => r.id)).toEqual([body.run.id]);
    expect(runs[0]?.triggeredBy).toBe('webhook');
    expect(enqueueAutomationRun).toHaveBeenCalledWith(body.run.id, [own.id]);
    const [after] = await getTestDb().select().from(automations).where(eq(automations.id, automation.id));
    expect(after?.runCount).toBe(1);
  });

  it('accepts a signed webhook for a partner-wide automation (org_id NULL)', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner!.id });
    const orgB = await createOrganization({ partnerId: partner!.id });
    const suspended = await createOrganization({ partnerId: partner!.id, status: 'suspended' });
    // Active status but soft-deleted: only the owner allowlist's deletedAt filter excludes it.
    const deleted = await createOrganization({ partnerId: partner!.id, status: 'active', deletedAt: new Date() });
    const foreignPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: foreignPartner!.id });
    const a = await seedDevice(orgA!.id);
    const b = await seedDevice(orgB!.id);
    await seedDevice(suspended!.id);
    await seedDevice(deleted!.id);
    await seedDevice(foreignOrg!.id);
    const automation = await seedWebhookAutomation({ partnerId: partner!.id });

    const res = await signedPost(automation.id, { ping: true });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect((await runsFor(automation.id)).map((r) => r.id)).toEqual([body.run.id]);
    // Fans out across the partner's active orgs; never suspended, deleted or another partner's.
    expect(enqueueAutomationRun).toHaveBeenCalledTimes(1);
    expect([...enqueueAutomationRun.mock.calls[0]![1]].sort()).toEqual([a.id, b.id].sort());
  });

  it('rejects a bad signature without creating a run', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner!.id });
    const automation = await seedWebhookAutomation({ orgId: org!.id });

    const res = await signedPost(automation.id, { ping: true }, 'wrong-secret');

    expect(res.status).toBe(401);
    expect(await runsFor(automation.id)).toEqual([]);
    expect(enqueueAutomationRun).not.toHaveBeenCalled();
  });

  it('404s an unknown or disabled automation', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner!.id });
    const disabled = await seedWebhookAutomation({ orgId: org!.id });
    await getTestDb().update(automations).set({ enabled: false }).where(eq(automations.id, disabled.id));

    expect((await signedPost(randomUUID(), {})).status).toBe(404);
    expect((await signedPost(disabled.id, {})).status).toBe(404);
    expect(enqueueAutomationRun).not.toHaveBeenCalled();
  });

  it('refuses a verified webhook whose owning org or partner is not active, without creating a run', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner!.id });
    const orgOwned = await seedWebhookAutomation({ orgId: org!.id });
    await getTestDb().update(organizations).set({ status: 'suspended' }).where(eq(organizations.id, org!.id));

    const inactivePartnerOrgOwner = await createPartner();
    const activeOrgOfInactivePartner = await createOrganization({ partnerId: inactivePartnerOrgOwner!.id });
    const orgOwnedInactivePartner = await seedWebhookAutomation({ orgId: activeOrgOfInactivePartner!.id });
    await getTestDb().update(partners).set({ status: 'suspended' }).where(eq(partners.id, inactivePartnerOrgOwner!.id));

    const suspendedPartner = await createPartner();
    const partnerWide = await seedWebhookAutomation({ partnerId: suspendedPartner!.id });
    await getTestDb().update(partners).set({ status: 'suspended' }).where(eq(partners.id, suspendedPartner!.id));

    expect((await signedPost(orgOwned.id, {})).status).toBe(403);
    expect((await signedPost(partnerWide.id, {})).status).toBe(403);
    expect((await signedPost(orgOwnedInactivePartner.id, {})).status).toBe(403);
    // An unverified caller learns nothing about the owner's status.
    expect((await signedPost(orgOwned.id, {}, 'wrong-secret')).status).toBe(401);
    expect(await runsFor(orgOwned.id)).toEqual([]);
    expect(await runsFor(partnerWide.id)).toEqual([]);
    expect(enqueueAutomationRun).not.toHaveBeenCalled();
  });

  it('marks the run failed under the owner context when the enqueue throws', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner!.id });
    const automation = await seedWebhookAutomation({ orgId: org!.id });
    enqueueAutomationRun.mockRejectedValueOnce(new Error('redis down'));

    const res = await signedPost(automation.id, { ping: true });

    expect(res.status).toBe(500);
    const body = await res.json();
    const [run] = await runsFor(automation.id);
    expect(run?.id).toBe(body.runId);
    expect(run?.status).toBe('failed');
    expect(run?.completedAt).not.toBeNull();
  });
});
