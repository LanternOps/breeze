import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
const h = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), draft: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn(), preflight: vi.fn(), preview: vi.fn(), audit: vi.fn() }));
vi.mock('../db', () => ({ db: {}, runOutsideDbContext: (f: any) => f(), withDbAccessContext: (_c: any, f: any) => f() }));
vi.mock('./aiToolsSoftwareShared', async original => ({ ...await original<typeof import('./aiToolsSoftwareShared')>(), verifiedUserIdOrNull: vi.fn(async () => null), auditToolWrite: h.audit }));
vi.mock('./pax8OrderService', async original => ({ ...await original<typeof import('./pax8OrderService')>(), getOrderWithLines: h.get, listPax8Orders: h.list, getOrCreateDraftOrder: h.draft, addOrderLine: h.add, updateOrderLine: h.update, removeOrderLine: h.remove }));
vi.mock('./pax8OrderSubmit', () => ({ preflightOrder: h.preflight }));
vi.mock('./pax8OrderPreview', () => ({ previewPax8Order: h.preview }));
import { registerPax8OrderTools } from './aiToolsPax8Orders';
import { pax8ToolSchemas } from './aiToolSchemasPax8';
const PARTNER = '00000000-0000-4000-8000-000000000001', ORG = '00000000-0000-4000-8000-000000000002', ID = '00000000-0000-4000-8000-000000000003';
const auth = (over = {}) => ({ scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'all', user: { id: ID }, principal: { kind: 'user_session' }, accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG, orgCondition: () => undefined, token: { mfa: true }, ...over }) as unknown as AuthContext;
const tools = new Map<string, AiTool>(); registerPax8OrderTools(tools);
const run = async (input: Record<string, unknown>, a = auth()) => JSON.parse(await tools.get('manage_pax8_orders')!.handler(input, a));
const writes = ['create_draft','add_line','update_line','remove_line','preflight'];
beforeEach(() => { vi.clearAllMocks(); h.get.mockResolvedValue({ order: { id: ID, orgId: ORG }, lines: [] }); h.draft.mockResolvedValue({ id: ID, orgId: ORG }); h.list.mockResolvedValue([]); });
describe('Pax8 orders', () => {
  it('action enum is exactly PR A', () => expect(pax8ToolSchemas.manage_pax8_orders.shape.action.options).toEqual(['list','get','create_draft','add_line','update_line','remove_line','preview','preflight']));
  it('refuses organization scope and device-bound sessions', async () => {
    expect((await run({ action: 'list' }, auth({ scope: 'organization' }))).code).toBe('PARTNER_SCOPE_REQUIRED');
    expect((await run({ action: 'get', orderId: ID }, auth({ allowedDeviceIds: [ID] }))).code).toBe('ACCESS_DENIED');
  });
  it.each(writes)('%s requires MFA', async action => { expect((await run({ action, orgId: ORG, orderId: ID }, auth({ token: {} }))).code).toBe('MFA_REQUIRED'); });
  it.each(writes)('%s refuses site-ceiling writes', async action => { expect((await run({ action, orgId: ORG, orderId: ID }, auth({ allowedSiteIds: [ID] }))).code).toBe('ACCESS_DENIED'); });
  it.each(['get','preview','add_line','update_line','remove_line','preflight'])('%s gates the order org before services', async action => {
    h.get.mockResolvedValue({ order: { id: ID, orgId: ID }, lines: [] });
    expect((await run({ action, orderId: ID })).code).toBe('FORBIDDEN');
    for (const f of [h.add,h.update,h.remove,h.preflight,h.preview]) expect(f).not.toHaveBeenCalled();
  });
  it('create_draft passes a verified users FK (null for synthetic principal)', async () => { await run({ action: 'create_draft', orgId: ORG }); expect(h.draft).toHaveBeenCalledWith({ partnerId: PARTNER, orgId: ORG, actorUserId: null }); });
  it('validates strict add/update inputs and calls only matching service', async () => {
    expect((await run({ action: 'add_line', orderId: ID, line: { action: 'new', invented: true } })).code).toBe('VALIDATION_ERROR');
    expect((await run({ action: 'update_line', orderId: ID, lineId: ID, patch: {} })).code).toBe('VALIDATION_ERROR');
    expect(h.add).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  });
  it('list preserves the org allowlist and filters service results defensively', async () => {
    h.list.mockResolvedValue([{ id: ID, orgId: ORG }, { id: ORG, orgId: ID }]);
    const out = await run({ action: 'list' }); expect(out.data).toHaveLength(1);
    expect(h.list).toHaveBeenCalledWith({ partnerId: PARTNER, accessibleOrgIds: [ORG] });
  });
  it('get explicitly projects orders and lines and clips vendor errors', async () => {
    h.get.mockResolvedValue({ order: { id: ID, orgId: ORG, error: 'x'.repeat(3000), metadata: 'hidden' }, lines: [{ id: ID, error: 'x'.repeat(3000), raw: 'hidden' }] });
    const out = await run({ action: 'get', orderId: ID });
    expect(JSON.stringify(out)).not.toContain('hidden'); expect(out.data.order.error.length).toBe(2048); expect(out.data.lines[0].error.length).toBe(2048);
  });
  it('preview calls the read-only service after authorization', async () => {
    h.preview.mockResolvedValue({ order: { id: ID }, lines: [], blocked: [] });
    const out = await run({ action: 'preview', orderId: ID }); expect(out.order.id).toBe(ID);
    expect(h.preview).toHaveBeenCalledWith({ partnerId: PARTNER, orderId: ID });
  });
  it('line writes mirror strict route bodies and audit route action names', async () => {
    const line = { action: 'new_subscription', pax8ProductId: 'example-product', quantity: '5' };
    h.add.mockResolvedValue({ id: ID, ...line });
    await run({ action: 'add_line', orderId: ID, line });
    expect(h.add).toHaveBeenCalledWith({ partnerId: PARTNER, orderId: ID, ...line });
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'pax8.order.line.create' }));
    h.update.mockResolvedValue({ id: ID, commitmentTermId: null });
    await run({ action: 'update_line', orderId: ID, lineId: ID, patch: { commitmentTermId: null } });
    expect(h.update).toHaveBeenCalledWith({ partnerId: PARTNER, orderId: ID, lineId: ID, commitmentTermId: null });
    h.remove.mockResolvedValue({ removed: true });
    expect((await run({ action: 'remove_line', orderId: ID, lineId: ID })).removed).toBe(true);
  });
  it('preflight failure returns a clipped error and audits', async () => {
    h.preflight.mockResolvedValue({ ok: false, errorBody: 'x'.repeat(4000) }); const out = await run({ action: 'preflight', orderId: ID }); expect(out.error.length).toBeLessThanOrEqual(2048); expect(h.audit).toHaveBeenCalled();
  });
});
