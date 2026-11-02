import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
const h = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), draft: vi.fn(), add: vi.fn(), update: vi.fn(), remove: vi.fn(), preflight: vi.fn(), preview: vi.fn(), audit: vi.fn(), auditLog: vi.fn() }));
vi.mock('../db', () => ({ db: {}, runOutsideDbContext: (f: any) => f(), withDbAccessContext: (_c: any, f: any) => f() }));
vi.mock('./aiToolsSoftwareShared', async original => ({ ...await original<typeof import('./aiToolsSoftwareShared')>(), verifiedUserIdOrNull: vi.fn(async () => null), auditToolWrite: h.audit }));
vi.mock('./pax8OrderService', async original => ({ ...await original<typeof import('./pax8OrderService')>(), getOrderWithLines: h.get, listPax8Orders: h.list, getOrCreateDraftOrder: h.draft, addOrderLine: h.add, updateOrderLine: h.update, removeOrderLine: h.remove }));
vi.mock('./auditService', () => ({ createAuditLogAsync: h.auditLog }));
vi.mock('./pax8OrderSubmit', () => ({ preflightOrder: h.preflight }));
vi.mock('./pax8OrderPreview', () => ({ previewPax8Order: h.preview }));
import { registerPax8OrderTools } from './aiToolsPax8Orders';
import { pax8ToolSchemas } from './aiToolSchemasPax8';
import { Pax8ApiError } from './pax8Client';
import { Pax8OrderError } from './pax8OrderService';
import { auditToolWrite } from './aiToolsSecurityPolicyShared';
const PARTNER = '00000000-0000-4000-8000-000000000001', ORG = '00000000-0000-4000-8000-000000000002', ID = '00000000-0000-4000-8000-000000000003';
const auth = (over = {}) => ({ scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'all', user: { id: ID }, principal: { kind: 'user_session' }, accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG, orgCondition: () => undefined, token: { mfa: true }, ...over }) as unknown as AuthContext;
const tools = new Map<string, AiTool>(); registerPax8OrderTools(tools);
const run = async (input: Record<string, unknown>, a = auth()) => JSON.parse(await tools.get('manage_pax8_orders')!.handler(input, a));
const writes = ['create_draft','add_line','update_line','remove_line','preflight'];
beforeEach(() => { vi.clearAllMocks(); h.get.mockResolvedValue({ order: { id: ID, orgId: ORG }, lines: [] }); h.draft.mockResolvedValue({ id: ID, orgId: ORG }); h.list.mockResolvedValue([]); });
describe('Pax8 orders', () => {
  it.each(['success', 'failure'] as const)('persists the selected audit result %s', result => {
    auditToolWrite(auth(), { orgId: ORG, action: 'pax8.order.preflight', resourceType: 'pax8_order', result });
    expect(h.auditLog).toHaveBeenCalledWith(expect.objectContaining({ result }));
  });
  it('action enum is exactly PR B', () => expect(pax8ToolSchemas.manage_pax8_orders.shape.action.options).toEqual(['list','get','create_draft','add_line','update_line','remove_line','preview','preflight','submit','reconcile']));
  it('refuses organization scope and device-bound sessions', async () => {
    expect((await run({ action: 'list' }, auth({ scope: 'organization' }))).code).toBe('PARTNER_SCOPE_REQUIRED');
    expect((await run({ action: 'get', orderId: ID }, auth({ allowedDeviceIds: [ID] }))).code).toBe('ACCESS_DENIED');
  });
  it.each(writes)('%s requires MFA before calling any service', async action => {
    expect((await run({ action, orgId: ORG, orderId: ID }, auth({ token: {} }))).code).toBe('MFA_REQUIRED');
    for (const f of [h.get,h.list,h.draft,h.add,h.update,h.remove,h.preflight,h.preview]) expect(f).not.toHaveBeenCalled();
  });
  it('refuses device-bound add_line before calling any service', async () => {
    expect((await run({ action: 'add_line', orderId: ID, line: { action: 'new_subscription', pax8ProductId: 'product', quantity: '1' } }, auth({ allowedDeviceIds: [ID] }))).code).toBe('ACCESS_DENIED');
    expect(h.get).not.toHaveBeenCalled(); expect(h.add).not.toHaveBeenCalled();
  });
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
  it('preview propagates a clipped vendor failure through pax8Error', async () => {
    h.preview.mockRejectedValue(new Pax8ApiError('vendor rejected', 503, 'x'.repeat(4000)));
    const out = await run({ action: 'preview', orderId: ID });
    expect(out.code).toBe('PAX8_API_ERROR'); expect(out.error).toHaveLength(2048);
  });
  it('preflight failure returns a clipped error and audits failure', async () => {
    h.preflight.mockResolvedValue({ ok: false, errorBody: 'x'.repeat(4000), cause: new Pax8ApiError('rejected', 422, 'x'.repeat(4000)) });
    const out = await run({ action: 'preflight', orderId: ID });
    expect(out.code).toBe('PREFLIGHT_FAILED'); expect(out.error).toHaveLength(2048);
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ result: 'failure', details: expect.objectContaining({ ok: false }) }));
  });
  it.each([
    [new Pax8ApiError('unavailable', 503, 'vendor outage'), 'PAX8_API_ERROR'],
    [new Pax8ApiError('transport'), 'PAX8_API_ERROR'],
    [new Pax8OrderError('bad order', 422), 'VALIDATION_ERROR'],
  ])('audits thrown preflight %s and uses the normal error mapping', async (error, code) => {
    h.preflight.mockRejectedValue(error);
    expect((await run({ action: 'preflight', orderId: ID })).code).toBe(code);
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ result: 'failure', details: expect.objectContaining({ ok: false, error: error.constructor.name }) }));
  });
  it('maps only thrown Pax8 4xx to PREFLIGHT_FAILED', async () => {
    h.preflight.mockRejectedValue(new Pax8ApiError('invalid', 422, 'x'.repeat(4000)));
    const out = await run({ action: 'preflight', orderId: ID });
    expect(out.code).toBe('PREFLIGHT_FAILED'); expect(out.error).toHaveLength(2048);
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ result: 'failure' }));
  });
  it('routes returned non-4xx failures through pax8Error', async () => {
    h.preflight.mockResolvedValue({ ok: false, errorBody: 'outage', cause: new Pax8ApiError('unavailable', 503, 'outage') });
    expect((await run({ action: 'preflight', orderId: ID })).code).toBe('PAX8_API_ERROR');
    expect(h.audit).toHaveBeenCalledTimes(1);
  });
  it('reports and audits a preflight that sent nothing to Pax8', async () => {
    h.preflight.mockResolvedValue({ ok: true, sentToPax8: false, reason: 'NO_NEW_SUBSCRIPTIONS' });
    expect(await run({ action: 'preflight', orderId: ID })).toEqual({ ok: true, sentToPax8: false, reason: 'NO_NEW_SUBSCRIPTIONS' });
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ result: 'success', details: expect.objectContaining({ ok: true, sentToPax8: false, reason: 'NO_NEW_SUBSCRIPTIONS' }) }));
  });
  it('reports and audits a completed vendor dry run', async () => {
    h.preflight.mockResolvedValue({ ok: true, sentToPax8: true });
    expect(await run({ action: 'preflight', orderId: ID })).toEqual({ ok: true, sentToPax8: true });
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ result: 'success', details: expect.objectContaining({ ok: true, sentToPax8: true }) }));
  });
});
