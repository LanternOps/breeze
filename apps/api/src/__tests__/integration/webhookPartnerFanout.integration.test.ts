import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext as system } from '../../db';
import { organizations, organizationExternalLinks, partners, webhooks, webhookDeliveries } from '../../db/schema';
import { buildWebhookFanoutDeps } from '../../services/webhookFanoutDeps';
import { configureWebhookDeliveryExecution, configureWebhookFanout, handleWebhookFanoutEvent, processWebhookAttemptJob } from '../../workers/webhookDelivery';
import { claimDeliveryForExecution, recordDeliveryOutcome, releaseDeliveryClaim } from '../../services/webhookDeliveryRecord';
import { closeWebhookDeliveryQueue, getWebhookDeliveryQueue, webhookAttemptJobId } from '../../jobs/webhookDeliveryQueue';
import { closeRedis } from '../../services/redis';
import type { BreezeEvent } from '../../services/eventBus';
import * as urlSafety from '../../services/urlSafety';

const jobs: string[] = [];
afterAll(async () => {
  const queue = getWebhookDeliveryQueue();
  for (const id of jobs) await (await queue.getJob(id))?.remove();
  await closeWebhookDeliveryQueue();
  await closeRedis();
});

async function seed() {
  return system(async () => {
    const suffix = randomUUID();
    const ps = await db.insert(partners).values([1, 2].map(i => ({ name: `Fanout ${i}`, slug: `fanout-${i}-${suffix}` }))).returning();
    const p = ps[0]!.id, other = ps[1]!.id;
    const orgs = await db.insert(organizations).values([
      { name: 'First', slug: `first-${suffix}`, partnerId: p },
      { name: 'Second', slug: `second-${suffix}`, partnerId: p },
      { name: 'Other', slug: `other-${suffix}`, partnerId: other },
      { name: 'Holding', slug: `holding-${suffix}`, partnerId: p, type: 'unassigned_pool' as const },
      { name: 'Support', slug: `support-${suffix}`, partnerId: p, type: 'quick_support' as const },
      { name: 'Deleted', slug: `deleted-${suffix}`, partnerId: p, deletedAt: new Date() },
      { name: 'Suspended', slug: `suspended-${suffix}`, partnerId: p, status: 'suspended' as const },
    ].map(o => ({ ...o, currencyCode: 'USD' }))).returning();
    const hooks = await db.insert(webhooks).values([
      { orgId: null, partnerId: p, name: 'Partner', url: 'https://example.test/hook', events: ['*'] },
      { orgId: orgs[0]!.id, name: 'Org', url: 'https://example.test/hook', events: ['*'] },
    ]).returning();
    return { p, other, orgs, partnerHook: hooks[0]!, orgHook: hooks[1]! };
  });
}
function event(orgId: string): BreezeEvent {
  return { id: randomUUID(), orgId, type: 'alert.triggered', source: 'test', priority: 'normal', payload: { alertId: randomUUID(), title: 'Offline' }, metadata: { timestamp: new Date().toISOString() } };
}
async function fanout(e: BreezeEvent) {
  await handleWebhookFanoutEvent(e);
  const deliveries = await system(() => db.select().from(webhookDeliveries).where(eq(webhookDeliveries.eventId, e.id)));
  jobs.push(...deliveries.map(row => webhookAttemptJobId(row.id, 0)));
  return deliveries;
}

describe('partner webhook fan-out against real Postgres', () => {
  beforeEach(() => {
    configureWebhookFanout(buildWebhookFanoutDeps());
    configureWebhookDeliveryExecution({ claim: claimDeliveryForExecution, recordOutcome: recordDeliveryOutcome, releaseClaim: releaseDeliveryClaim });
  });

  it('routes two live orgs to their partner, isolates other partners, and stores each event org', async () => {
    const { p, orgs, partnerHook, orgHook } = await seed();
    const externalId = `company-${randomUUID()}`;
    await system(() => db.insert(organizationExternalLinks).values({
      orgId: orgs[0]!.id, partnerId: p, system: 'connectwise', externalId,
    }));
    const first = await fanout(event(orgs[0]!.id));
    expect(first.map(d => d.webhookId).sort()).toEqual([partnerHook.id, orgHook.id].sort());
    expect(first.every(d => d.orgId === orgs[0]!.id)).toBe(true);
    const second = await fanout(event(orgs[1]!.id));
    expect(second.map(d => d.webhookId)).toEqual([partnerHook.id]);
    expect(second[0]!.orgId).toBe(orgs[1]!.id);
    expect(await fanout(event(orgs[2]!.id))).toEqual([]);
    expect(first.find(d => d.webhookId === partnerHook.id)!.payload).toHaveProperty('orgExternalIds', [{ system: 'connectwise', externalId }]);
    expect(first.find(d => d.webhookId === orgHook.id)!.payload).not.toHaveProperty('orgExternalIds');
  });

  it('includes trial org events in partner-wide fan-out', async () => {
    const { orgs, partnerHook } = await seed();
    await system(() => db.update(organizations).set({ status: 'trial' }).where(eq(organizations.id, orgs[1]!.id)));
    const deliveries = await fanout(event(orgs[1]!.id));
    expect(deliveries).toMatchObject([{ webhookId: partnerHook.id, orgId: orgs[1]!.id }]);
  });

  it('excludes holding, quick-support, deleted and suspended orgs', async () => {
    const { orgs } = await seed();
    for (const org of orgs.slice(3)) expect(await fanout(event(org.id))).toEqual([]);
  });

  it('POSTs a live partner event with its delivery org, and a partner test with NULL org', async () => {
    const { orgs, partnerHook } = await seed();
    const [delivery] = await fanout(event(orgs[1]!.id));
    const [test] = await system(() => db.insert(webhookDeliveries).values({
      webhookId: partnerHook.id, orgId: null, eventType: 'test', eventId: `test-${randomUUID()}`,
      payload: {}, payloadVersion: 2, webhookGeneration: partnerHook.approvalGeneration,
    }).returning());
    const post = vi.spyOn(urlSafety, 'safeFetch').mockResolvedValue(new Response('ok'));
    try {
      for (const row of [delivery!, test!]) {
        await processWebhookAttemptJob({ data: { deliveryId: row.id, webhookId: partnerHook.id, generation: partnerHook.approvalGeneration, attemptsMade: 0 } } as never);
      }
      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls.map(([, options]) => JSON.parse(String(options?.body)).orgId)).toEqual([orgs[1]!.id, null]);
    } finally { post.mockRestore(); }
  });

  it.each(['moved', 'suspended', 'deleted'] as const)('resolves a queued delivery without POST or retry after its org is %s', async change => {
    const { orgs, partnerHook, other } = await seed();
    const [delivery] = await fanout(event(orgs[1]!.id));
    await system(() => db.update(organizations).set(change === 'moved' ? { partnerId: other } : change === 'suspended' ? { status: 'suspended' } : { deletedAt: new Date() }).where(eq(organizations.id, orgs[1]!.id)));
    const post = vi.spyOn(urlSafety, 'safeFetch').mockResolvedValue(new Response('ok'));
    try {
      await processWebhookAttemptJob({ data: { deliveryId: delivery!.id, webhookId: partnerHook.id, generation: partnerHook.approvalGeneration, attemptsMade: 0 } } as never);
      expect(post).not.toHaveBeenCalled();
      const [row] = await system(() => db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, delivery!.id)));
      // "deleted" above is a soft delete: the org still has its partner but
      // is inactive. A physically missing org is covered by the worker unit test.
      expect(row).toMatchObject({ status: 'failed', nextRetryAt: null, errorMessage: change === 'moved'
        ? "superseded_by_edit: organization no longer belongs to this webhook's partner"
        : 'superseded_by_edit: organization is not active for partner-wide delivery' });
    } finally { post.mockRestore(); }
  });
});
