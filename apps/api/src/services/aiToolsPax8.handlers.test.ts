import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
const h = vi.hoisted(() => ({ rows: [] as unknown[][], sync: vi.fn(), link: vi.fn(), unlink: vi.fn(), products: vi.fn(), pricing: vi.fn(), client: vi.fn(), drift: vi.fn() }));
vi.mock('../db', () => ({ db: { select: () => { const q: any = new Proxy({}, { get: (_t, k) => k === 'then' ? (resolve: any) => resolve(h.rows.shift() ?? []) : () => q }); return q; } }, runOutsideDbContext: (f: any) => f(), withDbAccessContext: (_c: any, f: any) => f(), withSystemDbAccessContext: (f: any) => f() }));
vi.mock('./auditService', () => ({ createAuditLogAsync: vi.fn() }));
vi.mock('../jobs/pax8SyncWorker', () => ({ enqueuePax8Sync: h.sync }));
vi.mock('./pax8SyncService', () => ({ createPax8ClientForIntegration: h.client, linkPax8SubscriptionToContractLine: h.link, unlinkPax8Subscription: h.unlink }));
vi.mock('./pax8CatalogService', async original => ({ ...await original<typeof import('./pax8CatalogService')>(), getPax8ProductPricing: h.pricing }));
vi.mock('./pax8Drift', () => ({ detectPax8Drift: h.drift }));
vi.mock('./pax8OrderService', async (original) => ({ ...await original<typeof import('./pax8OrderService')>(), listPax8Products: h.products }));
import { pax8Clip, registerPax8Tools } from './aiToolsPax8';
import { pax8ToolSchemas } from './aiToolSchemasPax8';
import { Pax8ApiError } from './pax8Client';
import { Pax8CatalogError } from './pax8CatalogService';
import { CatalogServiceError } from './catalogService';
import { createAuditLogAsync } from './auditService';
const PARTNER = '00000000-0000-4000-8000-000000000001';
const ORG = '00000000-0000-4000-8000-000000000002';
const ID = '00000000-0000-4000-8000-000000000003';
const auth = (over = {}) => ({ scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'all', user: { id: ID }, principal: { kind: 'user_session' }, accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG, orgCondition: () => undefined, token: { mfa: true }, ...over }) as unknown as AuthContext;
const tools = new Map<string, AiTool>(); registerPax8Tools(tools);
const run = async (name: string, input: Record<string, unknown> = {}, a = auth()) => JSON.parse(await tools.get(name)!.handler(input, a));
beforeEach(() => { vi.clearAllMocks(); h.rows = []; h.products.mockResolvedValue([]); h.drift.mockResolvedValue([]); });
describe('W15 Pax8 tools', () => {
  it('clips a multibyte error to at most 2048 UTF-8 bytes without replacement characters', () => {
    const clipped = pax8Clip('x'.repeat(2047) + '😀');
    expect(Buffer.byteLength(clipped!, 'utf8')).toBeLessThanOrEqual(2048);
    expect(clipped).not.toContain('�');
  });
  it.each(['get_pax8_status', 'search_pax8_products', 'manage_pax8_subscriptions'])('%s refuses org scope and device-bound sessions', async name => {
    expect((await run(name, { action: 'list' }, auth({ scope: 'organization' }))).code).toBe('PARTNER_SCOPE_REQUIRED');
    expect((await run(name, { action: 'list' }, auth({ allowedDeviceIds: [ID] }))).code).toBe('ACCESS_DENIED');
  });
  it('status and every subscription action require full partner org access', async () => {
    const selected = auth({ partnerOrgAccess: 'selected' });
    expect((await run('get_pax8_status', {}, selected)).code).toBe('ACCESS_DENIED');
    for (const action of ['list','drift','sync','link','unlink']) expect((await run('manage_pax8_subscriptions', { action }, selected)).code).toBe('ACCESS_DENIED');
    expect(h.sync).not.toHaveBeenCalled(); expect(h.link).not.toHaveBeenCalled();
  });
  it('resolves partner scope exactly like REST', async () => {
    expect((await run('get_pax8_status', { partnerId: ORG })).code).toBe('FORBIDDEN');
    expect((await run('get_pax8_status', {}, auth({ scope: 'system' }))).code).toBe('VALIDATION_ERROR');
  });
  it('status never returns credentials or tokens and clips errors', async () => {
    h.rows.push([{ id: ID, name: 'Test integration', clientIdEncrypted: 'secret', accessToken: 'secret', accessTokenEncrypted: 'secret', lastSyncError: 'x'.repeat(3000), hasClientId: true }]);
    const out = await run('get_pax8_status'); expect(JSON.stringify(out)).not.toContain('secret'); expect(out.data.lastSyncError.length).toBeLessThanOrEqual(2048);
  });
  it('companies expose readiness without metadata', async () => {
    h.rows.push([{ id: ID }], [{ pax8CompanyId: 'company-example', pax8CompanyName: 'Example', status: 'Active', metadata: { private: 'hidden' } }]);
    const out = await run('get_pax8_status', { view: 'companies' }); expect(out.data[0].metadata).toBeUndefined(); expect(out.data[0].orderReady).toBe(false);
  });
  it('subscriptions expose active commitment evidence without raw', async () => {
    h.rows.push([{ id: ID }], [{ id: ID, raw: { private: 'hidden' }, productName: 'Example' }]);
    const out = await run('manage_pax8_subscriptions', { action: 'list' }); expect(out.data[0].raw).toBeUndefined(); expect(JSON.stringify(out)).not.toContain('hidden');
  });
  it.each(['sync','link','unlink'])('%s requires MFA before services', async action => {
    expect((await run('manage_pax8_subscriptions', { action }, auth({ token: {} }))).code).toBe('MFA_REQUIRED');
    for (const service of [h.sync, h.link, h.unlink, h.products, h.pricing, h.client, h.drift]) expect(service).not.toHaveBeenCalled();
    expect(h.rows).toEqual([]);
  });
  it('refuses device-bound sync before enqueueing or reading the integration', async () => {
    h.rows.push([{ id: ID }]);
    expect((await run('manage_pax8_subscriptions', { action: 'sync' }, auth({ allowedDeviceIds: [ID] }))).code).toBe('ACCESS_DENIED');
    expect(h.sync).not.toHaveBeenCalled(); expect(h.rows).toHaveLength(1);
  });
  it('companies reports a missing or inactive integration', async () => {
    expect((await run('get_pax8_status', { view: 'companies' })).code).toBe('NOT_FOUND');
  });
  it.each([
    [new Pax8CatalogError('Pax8 is not connected', 400, 'PAX8_NOT_CONFIGURED'), 'PAX8_NOT_CONFIGURED'],
    [new Pax8CatalogError('Missing catalog product', 404), 'NOT_FOUND'],
    [new Pax8CatalogError('Partner denied', 403), 'FORBIDDEN'],
    [new CatalogServiceError('No catalog price', 400, 'NO_PRICE_FOR_CURRENCY'), 'NO_PRICE_FOR_CURRENCY'],
    [new CatalogServiceError('Catalog missing', 404), 'NOT_FOUND'],
  ])('preserves expected catalog errors: %s', async (error, code) => {
    h.pricing.mockRejectedValueOnce(error);
    const out = await run('search_pax8_products', { action: 'pricing', productId: 'example-product' });
    expect(out).toMatchObject({ error: error.message, code });
  });
  it.each(['Pax8 integration not found', 'Pax8 integration is inactive', 'Pax8 integration credentials could not be decrypted', 'Malformed encrypted secret'])('reports client configuration failures: %s', async message => {
    h.rows.push([{ id: ID }]); h.client.mockRejectedValueOnce(new Error(message));
    const out = await run('search_pax8_products', { action: 'dependencies', productId: 'example-product' });
    expect(out.code).toBe('PAX8_NOT_CONFIGURED'); expect(out.error).toContain('not configured');
  });
  it('reports a credential decryption failure in the pricing path as not configured', async () => {
    h.pricing.mockRejectedValueOnce(new Error('Malformed encrypted secret'));
    expect((await run('search_pax8_products', { action: 'pricing', productId: 'example-product' })).code).toBe('PAX8_NOT_CONFIGURED');
  });
  it.each(['Map the Pax8 company to a Breeze organization before linking billing lines.', 'This contract line is already linked to another Pax8 subscription.', 'x'.repeat(3000)])('returns link validation messages clipped to 2 KiB', async message => {
    h.rows.push([{ id: ID }], [{ orgId: ORG, integrationId: ID }], [{ orgId: ORG }]); h.link.mockRejectedValueOnce(new Error(message));
    const out = await run('manage_pax8_subscriptions', { action: 'link', subscriptionSnapshotId: ID, contractLineId: ID });
    expect(out).toMatchObject({ error: pax8Clip(message), code: 'VALIDATION_ERROR' });
    expect(createAuditLogAsync).not.toHaveBeenCalled();
  });
  it('clips Pax8 API errors to 2 KiB', async () => {
    h.products.mockRejectedValue(new Pax8ApiError('Pax8 failed', 502, 'x'.repeat(4000)));
    const out = await run('search_pax8_products', { action: 'search' }); expect(out.error.length).toBeLessThanOrEqual(2048);
  });
  it('search is local, filters mapped products and supports a cursor', async () => {
    h.products.mockResolvedValue([{ catalogName: 'Example suite', pax8ProductId: 'product-a' }, { catalogName: 'Example suite two', pax8ProductId: 'product-b' }, { catalogName: 'Other', pax8ProductId: 'product-c' }]);
    const first = await run('search_pax8_products', { action: 'search', q: 'suite', limit: 1 });
    expect(first.data[0].pax8ProductId).toBe('product-a'); expect(first.hasMore).toBe(true);
    const second = await run('search_pax8_products', { action: 'search', q: 'suite', limit: 1, cursor: first.nextCursor });
    expect(second.data[0].pax8ProductId).toBe('product-b'); expect(second.hasMore).toBe(false);
    expect(h.client).not.toHaveBeenCalled();
  });
  it.each(['provision_details', 'dependencies'])('%s passes only a product identifier to Pax8', async action => {
    const read = vi.fn(async () => []);
    h.rows.push([{ id: ID }]); h.client.mockResolvedValue({ integration: { partnerId: PARTNER }, client: { getProvisionDetails: read, getProductDependencies: read } });
    await run('search_pax8_products', { action, productId: 'example-product' });
    expect(read).toHaveBeenCalledExactlyOnceWith('example-product');
  });
  it('pricing strips raw vendor bodies', async () => {
    h.pricing.mockResolvedValue([{ partnerBuyRate: '12.00', currencyCode: 'USD', raw: { private: 'hidden' } }]);
    const out = await run('search_pax8_products', { action: 'pricing', productId: 'example-product' });
    expect(out.data).toEqual([{ partnerBuyRate: '12.00', currencyCode: 'USD' }]);
    expect(h.pricing).toHaveBeenCalledWith('example-product', expect.objectContaining({ partnerId: PARTNER }), expect.objectContaining({ accessiblePartnerIds: [PARTNER] }));
  });
  it('link verifies both local targets and defaults syncEnabled to false', async () => {
    h.rows.push([{ id: ID }], [{ orgId: ORG, integrationId: ID }], [{ orgId: ORG }]); h.link.mockResolvedValue({ id: ID });
    expect((await run('manage_pax8_subscriptions', { action: 'link', integrationId: ID, subscriptionSnapshotId: ID, contractLineId: ID })).data.id).toBe(ID);
    expect(h.link).toHaveBeenCalledWith({ integrationId: ID, partnerId: PARTNER, subscriptionSnapshotId: ID, contractLineId: ID, syncEnabled: false });
    expect(createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      action: 'pax8.subscription.link_contract_line',
      details: expect.objectContaining({ contractLineId: ID, syncEnabled: false }),
    }));
  });
  it('unlink refuses a foreign snapshot org before mutation', async () => {
    h.rows.push([{ id: ID }], [{ orgId: ID, integrationId: ID }]);
    expect((await run('manage_pax8_subscriptions', { action: 'unlink', integrationId: ID, subscriptionSnapshotId: ID })).code).toBe('FORBIDDEN');
    expect(h.unlink).not.toHaveBeenCalled();
  });
  it('foreign integration never invokes drift or sync', async () => {
    for (const action of ['drift','sync']) expect((await run('manage_pax8_subscriptions', { action, integrationId: ID })).code).toBe('NOT_FOUND');
    expect(h.drift).not.toHaveBeenCalled(); expect(h.sync).not.toHaveBeenCalled();
  });
  it('action enums exclude human-only surfaces', () => {
    expect(pax8ToolSchemas.search_pax8_products.shape.action.options).toEqual(['search','provision_details','dependencies','pricing']);
    expect(pax8ToolSchemas.manage_pax8_subscriptions.shape.action.options).toEqual(['list','drift','sync','link','unlink']);
  });
});
