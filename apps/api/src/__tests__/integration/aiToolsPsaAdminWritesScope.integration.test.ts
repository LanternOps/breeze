/**
 * Integration test — the W02 (#6756, Task 15c) admin/PSA write tools keep
 * their scope guards against real Postgres as the unprivileged `breeze_app`
 * role:
 *
 *   manage_tags:add               out-of-site device -> denied, tags unchanged
 *   manage_saved_filters:delete   cross-org          -> not found, row survives
 *   manage_notification_channels  update/delete/test cross-org -> not found;
 *                                 partner-wide channel without
 *                                 canManagePartnerWidePolicies -> refused;
 *                                 site-restricted caller -> site-ceiling refusal;
 *                                 create with an inaccessible orgId -> refused
 *   test_webhook                  cross-org -> not found; site-restricted -> refused
 *   manage_billing_catalog        org-scope caller -> refused; partner A cannot
 *                                 touch partner B's item
 *
 * Every family also has an in-scope positive so the denials are not vacuous.
 */
import './setup';
import { getTestDb } from './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import {
  catalogItems,
  devices,
  notificationChannels,
  savedFilters,
  webhookDeliveries,
  webhooks,
} from '../../db/schema';
import { createCatalogItemWithPrice, createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { registerDeviceTools } from '../../services/aiToolsDevice';
import { registerUITools } from '../../services/aiToolsUI';
import { registerAlertTools } from '../../services/aiToolsAlerts';
import { registerIntegrationTools } from '../../services/aiToolsIntegrations';
import { registerCatalogTools } from '../../services/aiToolsCatalog';
import { SITE_CEILING_WRITE_DENIED_MESSAGE } from '../../services/siteCeilingAccess';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';

// Group re-evaluation and webhook delivery go through BullMQ; neither is under
// test here, and stubbing them lets us assert they were / were not reached.
const { reevaluateMock, queueDeliveryMock } = vi.hoisted(() => ({
  reevaluateMock: vi.fn(),
  queueDeliveryMock: vi.fn(async () => undefined),
}));
vi.mock('../../jobs/deviceGroupJobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../jobs/deviceGroupJobs')>();
  return { ...actual, requestDeviceGroupReevaluationAfterCommit: reevaluateMock };
});
vi.mock('../../jobs/webhookDeliveryQueue', () => ({ enqueueWebhookAttempt: queueDeliveryMock }));

const registry = new Map<string, AiTool>();
registerDeviceTools(registry);
registerUITools(registry);
registerAlertTools(registry);
registerIntegrationTools(registry);
registerCatalogTools(registry);

async function run(tool: string, ctx: DbAccessContext, auth: AuthContext, input: Record<string, unknown>) {
  const handler = registry.get(tool)?.handler;
  if (!handler) throw new Error(`tool not registered: ${tool}`);
  return JSON.parse(await withDbAccessContext(ctx, async () => handler(input, auth)));
}

function orgAuth(opts: { userId: string; partnerId: string; orgId: string; allowedSiteIds?: string[] }): AuthContext {
  const { allowedSiteIds } = opts;
  return {
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as any,
    partnerId: opts.partnerId,
    orgId: opts.orgId,
    scope: 'organization',
    accessibleOrgIds: [opts.orgId],
    orgCondition: (col: any) => eq(col, opts.orgId),
    canAccessOrg: (id: string) => id === opts.orgId,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) =>
      !allowedSiteIds ? true : !!s && allowedSiteIds.includes(s),
  } as unknown as AuthContext;
}

function partnerAuth(opts: { userId: string; partnerId: string; accessibleOrgIds: string[]; partnerOrgAccess: 'all' | 'selected' }): AuthContext {
  return {
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as any,
    partnerId: opts.partnerId,
    orgId: null,
    scope: 'partner',
    partnerOrgAccess: opts.partnerOrgAccess,
    accessibleOrgIds: opts.accessibleOrgIds,
    orgCondition: (col: any) => {
      // Mirrors middleware/auth.ts: an IN over the accessible orgs.
      const ids = opts.accessibleOrgIds;
      return ids.length === 1 ? eq(col, ids[0]!) : undefined;
    },
    canAccessOrg: (id: string) => opts.accessibleOrgIds.includes(id),
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

interface Fixture {
  partnerA: string;
  partnerB: string;
  orgA: string;
  orgB: string;
  userId: string;
  siteA: string;
  siteB: string;
  devIn: string;
  devOut: string;
  orgCtxA: DbAccessContext;
  partnerCtxA: DbAccessContext;
  orgUnrestricted: AuthContext;
  orgRestricted: AuthContext;
  partnerAll: AuthContext;
  partnerSelected: AuthContext;
}

async function seedFixture(): Promise<Fixture> {
  const pA = await createPartner();
  const pB = await createPartner();
  const orgA = await createOrganization({ partnerId: pA.id });
  const orgB = await createOrganization({ partnerId: pB.id });
  const user = await createUser({ partnerId: pA.id, orgId: orgA.id, email: `psa-${randomUUID()}@psa-scope.test` });
  const siteA = await createSite({ orgId: orgA.id });
  const siteB = await createSite({ orgId: orgA.id });
  const devIn = await createDevice({ orgId: orgA.id, siteId: siteA.id });
  const devOut = await createDevice({ orgId: orgA.id, siteId: siteB.id });

  const base = { userId: user.id, partnerId: pA.id };
  return {
    partnerA: pA.id,
    partnerB: pB.id,
    orgA: orgA.id,
    orgB: orgB.id,
    userId: user.id,
    siteA: siteA.id,
    siteB: siteB.id,
    devIn: devIn.id,
    devOut: devOut.id,
    orgCtxA: { scope: 'organization', orgId: orgA.id, accessibleOrgIds: [orgA.id], accessiblePartnerIds: [], userId: user.id, currentPartnerId: pA.id },
    partnerCtxA: { scope: 'partner', orgId: null, accessibleOrgIds: [orgA.id], accessiblePartnerIds: [pA.id], userId: user.id, currentPartnerId: pA.id },
    orgUnrestricted: orgAuth({ ...base, orgId: orgA.id }),
    orgRestricted: orgAuth({ ...base, orgId: orgA.id, allowedSiteIds: [siteA.id] }),
    partnerAll: partnerAuth({ ...base, accessibleOrgIds: [orgA.id], partnerOrgAccess: 'all' }),
    partnerSelected: partnerAuth({ ...base, accessibleOrgIds: [orgA.id], partnerOrgAccess: 'selected' }),
  };
}

const adminDb = () => getTestDb() as any;

async function deviceTags(id: string): Promise<string[]> {
  const [row] = await adminDb().select({ tags: devices.tags }).from(devices).where(eq(devices.id, id));
  return (row?.tags ?? []) as string[];
}

describe('manage_tags — site axis', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await seedFixture();
    reevaluateMock.mockClear();
  });

  it('add: out-of-site device is denied with tags unchanged and no group re-evaluation; in-site succeeds; unrestricted reaches both', async () => {
    const before = await deviceTags(f.devOut);
    const denied = await run('manage_tags', f.orgCtxA, f.orgRestricted, { action: 'add', deviceId: f.devOut, tags: ['pwned'] });
    expect(denied).toEqual({ error: 'Device not found or access denied' });
    expect(await deviceTags(f.devOut)).toEqual(before);
    expect(reevaluateMock).not.toHaveBeenCalled();

    const ok = await run('manage_tags', f.orgCtxA, f.orgRestricted, { action: 'add', deviceId: f.devIn, tags: ['ok-tag'] });
    expect(ok.success).toBe(true);
    expect(await deviceTags(f.devIn)).toContain('ok-tag');
    expect(reevaluateMock).toHaveBeenCalledTimes(1);

    const wide = await run('manage_tags', f.orgCtxA, f.orgUnrestricted, { action: 'add', deviceId: f.devOut, tags: ['wide-tag'] });
    expect(wide.success).toBe(true);
    expect(await deviceTags(f.devOut)).toContain('wide-tag');
  });

  // remove widens an agent's self-scope like add does (QV2: a negative-rule
  // dynamic group can admit a device when a tag goes away), so pin it too.
  it('remove: out-of-site device is denied with tags unchanged; in-site succeeds', async () => {
    await run('manage_tags', f.orgCtxA, f.orgUnrestricted, { action: 'add', deviceId: f.devOut, tags: ['keep-out'] });
    await run('manage_tags', f.orgCtxA, f.orgUnrestricted, { action: 'add', deviceId: f.devIn, tags: ['drop-in'] });
    reevaluateMock.mockClear();
    const denied = await run('manage_tags', f.orgCtxA, f.orgRestricted, { action: 'remove', deviceId: f.devOut, tags: ['keep-out'] });
    expect(denied).toEqual({ error: 'Device not found or access denied' });
    expect(await deviceTags(f.devOut)).toContain('keep-out');
    expect(reevaluateMock).not.toHaveBeenCalled();

    const ok = await run('manage_tags', f.orgCtxA, f.orgRestricted, { action: 'remove', deviceId: f.devIn, tags: ['drop-in'] });
    expect(ok.success).toBe(true);
    expect(await deviceTags(f.devIn)).not.toContain('drop-in');
  });

  it('add: a device in another org is not found and untouched', async () => {
    const orgC = await createOrganization({ partnerId: f.partnerA });
    const siteC = await createSite({ orgId: orgC.id });
    const devC = await createDevice({ orgId: orgC.id, siteId: siteC.id });
    const denied = await run('manage_tags', f.orgCtxA, f.orgUnrestricted, { action: 'add', deviceId: devC.id, tags: ['x'] });
    expect(denied).toEqual({ error: 'Device not found or access denied' });
    expect(await deviceTags(devC.id)).toEqual([]);
  });
});

describe('manage_saved_filters — org axis', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await seedFixture();
  });

  it('delete: another org\'s filter is not found and survives; own filter is deleted', async () => {
    const [foreign] = await adminDb().insert(savedFilters).values({ orgId: f.orgB, name: 'foreign', conditions: { all: [] } }).returning();
    const [own] = await adminDb().insert(savedFilters).values({ orgId: f.orgA, name: 'own', conditions: { all: [] } }).returning();

    const denied = await run('manage_saved_filters', f.orgCtxA, f.orgUnrestricted, { action: 'delete', filterId: foreign.id });
    expect(denied).toEqual({ error: 'Saved filter not found or access denied' });
    expect(await adminDb().select().from(savedFilters).where(eq(savedFilters.id, foreign.id))).toHaveLength(1);

    const ok = await run('manage_saved_filters', f.orgCtxA, f.orgUnrestricted, { action: 'delete', filterId: own.id });
    expect(ok.success).toBe(true);
    expect(await adminDb().select().from(savedFilters).where(eq(savedFilters.id, own.id))).toHaveLength(0);
  });
});

describe('manage_notification_channels — org / partner-wide / site ceiling', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await seedFixture();
  });

  async function seedChannel(opts: { orgId: string | null; partnerId?: string | null; name: string }) {
    const [row] = await adminDb().insert(notificationChannels).values({
      orgId: opts.orgId,
      partnerId: opts.partnerId ?? null,
      name: opts.name,
      type: 'email',
    }).returning();
    return row as typeof notificationChannels.$inferSelect;
  }
  const nameOf = async (id: string) => {
    const [row] = await adminDb().select({ name: notificationChannels.name }).from(notificationChannels).where(eq(notificationChannels.id, id));
    return row?.name as string | undefined;
  };

  it('update / delete / test on another org\'s channel are not found and change nothing; own-org update succeeds', async () => {
    const foreign = await seedChannel({ orgId: f.orgB, name: 'foreign-channel' });
    const own = await seedChannel({ orgId: f.orgA, name: 'own-channel' });
    const NOT_FOUND = { error: 'Notification channel not found or access denied' };

    expect(await run('manage_notification_channels', f.orgCtxA, f.orgUnrestricted, { action: 'update', channelId: foreign.id, name: 'hijacked' })).toEqual(NOT_FOUND);
    expect(await run('manage_notification_channels', f.orgCtxA, f.orgUnrestricted, { action: 'delete', channelId: foreign.id })).toEqual(NOT_FOUND);
    expect(await run('manage_notification_channels', f.orgCtxA, f.orgUnrestricted, { action: 'test', channelId: foreign.id })).toEqual(NOT_FOUND);
    expect(await nameOf(foreign.id)).toBe('foreign-channel');

    const ok = await run('manage_notification_channels', f.orgCtxA, f.orgUnrestricted, { action: 'update', channelId: own.id, name: 'renamed-own' });
    expect(ok.success).toBe(true);
    expect(await nameOf(own.id)).toBe('renamed-own');
    const tested = await run('manage_notification_channels', f.orgCtxA, f.orgUnrestricted, { action: 'test', channelId: own.id });
    expect(tested.success).toBe(true);
  });

  it('partner-wide channel: update/delete are refused without canManagePartnerWidePolicies and the row is intact; allowed with orgAccess all', async () => {
    const wide = await seedChannel({ orgId: null, partnerId: f.partnerA, name: 'partner-wide' });
    const REFUSED = {
      error: 'Modifying a partner-wide notification channel requires full partner org access (orgAccess must be "all")',
    };

    expect(await run('manage_notification_channels', f.partnerCtxA, f.partnerSelected, { action: 'update', channelId: wide.id, name: 'hijacked' })).toEqual(REFUSED);
    expect(await run('manage_notification_channels', f.partnerCtxA, f.partnerSelected, { action: 'delete', channelId: wide.id })).toEqual(REFUSED);
    expect(await nameOf(wide.id)).toBe('partner-wide');

    const ok = await run('manage_notification_channels', f.partnerCtxA, f.partnerAll, { action: 'update', channelId: wide.id, name: 'partner-wide-renamed' });
    expect(ok.success).toBe(true);
    expect(await nameOf(wide.id)).toBe('partner-wide-renamed');
  });

  it('site-restricted caller: every write is refused with the site-ceiling message and nothing changes; list still works; unrestricted caller can write', async () => {
    const own = await seedChannel({ orgId: f.orgA, name: 'ceiling-channel' });
    const DENIED = { error: SITE_CEILING_WRITE_DENIED_MESSAGE };
    const ctx = f.orgCtxA;
    const r = f.orgRestricted;

    expect(await run('manage_notification_channels', ctx, r, { action: 'update', channelId: own.id, name: 'hijacked' })).toEqual(DENIED);
    expect(await run('manage_notification_channels', ctx, r, { action: 'delete', channelId: own.id })).toEqual(DENIED);
    expect(await run('manage_notification_channels', ctx, r, { action: 'test', channelId: own.id })).toEqual(DENIED);
    expect(await run('manage_notification_channels', ctx, r, {
      action: 'create', name: 'ceiling-created', type: 'email', config: { recipients: ['a@example.com'] },
    })).toEqual(DENIED);
    expect(await nameOf(own.id)).toBe('ceiling-channel');
    expect(await adminDb().select().from(notificationChannels).where(eq(notificationChannels.name, 'ceiling-created'))).toHaveLength(0);

    const listed = await run('manage_notification_channels', ctx, r, { action: 'list' });
    expect(listed.channels.map((c: { id: string }) => c.id)).toContain(own.id);

    const ok = await run('manage_notification_channels', ctx, f.orgUnrestricted, { action: 'update', channelId: own.id, name: 'renamed-by-unrestricted' });
    expect(ok.success).toBe(true);
    expect(await nameOf(own.id)).toBe('renamed-by-unrestricted');
  });

  it('create: an inaccessible orgId is refused and writes nothing; an accessible orgId succeeds', async () => {
    const config = { recipients: ['ops@example.com'] };
    const denied = await run('manage_notification_channels', f.partnerCtxA, f.partnerAll, {
      action: 'create', orgId: f.orgB, name: 'cross-org-create', type: 'email', config,
    });
    expect(denied).toEqual({ error: 'Access denied to this organization' });
    expect(await adminDb().select().from(notificationChannels).where(eq(notificationChannels.name, 'cross-org-create'))).toHaveLength(0);

    // An org-scope caller cannot redirect the write to another org either.
    const orgDenied = await run('manage_notification_channels', f.orgCtxA, f.orgUnrestricted, {
      action: 'create', orgId: f.orgB, name: 'cross-org-create-2', type: 'email', config,
    });
    expect(orgDenied).toEqual({ error: 'Cannot access another organization' });
    expect(await adminDb().select().from(notificationChannels).where(eq(notificationChannels.name, 'cross-org-create-2'))).toHaveLength(0);

    const ok = await run('manage_notification_channels', f.partnerCtxA, f.partnerAll, {
      action: 'create', orgId: f.orgA, name: 'in-scope-create', type: 'email', config,
    });
    expect(ok.success).toBe(true);
    const [row] = await adminDb().select().from(notificationChannels).where(eq(notificationChannels.id, ok.channelId));
    expect(row.orgId).toBe(f.orgA);
  });
});

describe('test_webhook — org axis + site ceiling', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await seedFixture();
    queueDeliveryMock.mockClear();
  });

  async function seedWebhook(orgId: string) {
    const [row] = await adminDb().insert(webhooks).values({
      orgId, name: `hook-${randomUUID().slice(0, 6)}`, url: 'https://hooks.example.com/in', events: ['device.online'],
    }).returning();
    return row as typeof webhooks.$inferSelect;
  }
  const deliveriesFor = (webhookId: string) =>
    adminDb().select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, webhookId)) as Promise<unknown[]>;

  it('cross-org webhook is not found: no delivery row, nothing queued; own webhook queues exactly one delivery', async () => {
    const foreign = await seedWebhook(f.orgB);
    const own = await seedWebhook(f.orgA);

    const denied = await run('test_webhook', f.orgCtxA, f.orgUnrestricted, { webhookId: foreign.id });
    expect(denied).toEqual({ error: 'Webhook not found or access denied' });
    expect(await deliveriesFor(foreign.id)).toHaveLength(0);
    expect(queueDeliveryMock).not.toHaveBeenCalled();

    const ok = await run('test_webhook', f.orgCtxA, f.orgUnrestricted, { webhookId: own.id });
    expect(ok.success).toBe(true);
    expect(await deliveriesFor(own.id)).toHaveLength(1);
    expect(queueDeliveryMock).toHaveBeenCalledTimes(1);
  });

  it('site-restricted caller is refused with the site-ceiling message before any lookup, delivery row or queue call', async () => {
    const own = await seedWebhook(f.orgA);
    const denied = await run('test_webhook', f.orgCtxA, f.orgRestricted, { webhookId: own.id });
    expect(denied).toEqual({ error: SITE_CEILING_WRITE_DENIED_MESSAGE });
    expect(await deliveriesFor(own.id)).toHaveLength(0);
    expect(queueDeliveryMock).not.toHaveBeenCalled();
  });
});

describe('manage_billing_catalog — partner scope + partner isolation', () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await seedFixture();
  });

  const catalogName = async (id: string) => {
    const [row] = await adminDb().select({ name: catalogItems.name, isActive: catalogItems.isActive }).from(catalogItems).where(eq(catalogItems.id, id));
    return row as { name: string; isActive: boolean };
  };

  it('an organization-scope caller is refused PARTNER_SCOPE_REQUIRED and nothing changes', async () => {
    const item = await createCatalogItemWithPrice({ partnerId: f.partnerA, name: 'org-scope-target', currencyCode: 'USD', unitPrice: '10.00' });
    const refused = await run('manage_billing_catalog', f.orgCtxA, f.orgUnrestricted, { action: 'archive_item', catalogId: item.id });
    expect(refused.code).toBe('PARTNER_SCOPE_REQUIRED');
    expect(await catalogName(item.id)).toMatchObject({ name: 'org-scope-target', isActive: true });
  });

  it('partner A cannot update or archive partner B\'s item; its own item updates', async () => {
    const foreign = await createCatalogItemWithPrice({ partnerId: f.partnerB, name: 'partner-b-item', currencyCode: 'USD', unitPrice: '10.00' });
    const own = await createCatalogItemWithPrice({ partnerId: f.partnerA, name: 'partner-a-item', currencyCode: 'USD', unitPrice: '10.00' });

    const upd = await run('manage_billing_catalog', f.partnerCtxA, f.partnerAll, { action: 'update_item', catalogId: foreign.id, item: { name: 'hijacked' } });
    expect(upd.code).toBe('ITEM_NOT_FOUND');
    const arch = await run('manage_billing_catalog', f.partnerCtxA, f.partnerAll, { action: 'archive_item', catalogId: foreign.id });
    expect(arch.code).toBe('ITEM_NOT_FOUND');
    expect(await catalogName(foreign.id)).toMatchObject({ name: 'partner-b-item', isActive: true });

    const ok = await run('manage_billing_catalog', f.partnerCtxA, f.partnerAll, { action: 'update_item', catalogId: own.id, item: { name: 'partner-a-renamed' } });
    expect(ok.error).toBeUndefined();
    expect(ok.previous).toBeDefined();
    expect((await catalogName(own.id)).name).toBe('partner-a-renamed');
  });
});
