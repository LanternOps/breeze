import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
const h = vi.hoisted(() => ({ get: vi.fn(), preview: vi.fn(), submit: vi.fn(), reconcile: vi.fn(), material: vi.fn(), audit: vi.fn() }));
vi.mock('../db', () => ({ db: {}, runOutsideDbContext: (f: any) => f(), withDbAccessContext: (_c: any, f: any) => f() }));
vi.mock('./pax8OrderService', async original => ({ ...await original<typeof import('./pax8OrderService')>(), getOrderWithLines: h.get }));
vi.mock('./pax8OrderSubmit', () => ({ preflightOrder: vi.fn(), submitOrder: h.submit, reconcileOrder: h.reconcile }));
vi.mock('./pax8OrderPreview', () => ({ previewPax8Order: h.preview }));
vi.mock('./actionIntents/pax8OrderDigest', () => ({ pax8OrderDigestMaterial: h.material, hashPax8OrderMaterial: (value: unknown) => value === null ? null : (value as any).digest }));
vi.mock('./aiToolsSoftwareShared', async original => ({ ...await original<typeof import('./aiToolsSoftwareShared')>(), auditToolWrite: h.audit }));
import { registerPax8OrderTools } from './aiToolsPax8Orders';
import { pax8ToolSchemas } from './aiToolSchemasPax8';
import { AGENT_HUMAN_ONLY_ACTIONS } from './aiToolExposure';
import { buildApprovalDescription, checkGuardrails } from './aiGuardrails';
import { isMfaGatedToolAction } from './aiToolMfaGate';
import { Pax8OrderError } from './pax8OrderService';
const ID = '00000000-0000-4000-8000-000000000001', ORG = '00000000-0000-4000-8000-000000000002', PARTNER = '00000000-0000-4000-8000-000000000003';
const digest = 'a'.repeat(64);
const company = { pax8CompanyId: 'fixture-company', name: 'Fixture Company' };
const line = { lineId: ID, action: 'new_subscription', pax8ProductId: 'fixture-product', productName: 'Fixture Product', quantity: '5', fromQuantity: null, unitCost: '8.25', currency: 'USD', billingTerm: 'Monthly', commitmentTerm: 'Annual', cancellationFeeApplied: true };
const args = () => ({ action: 'submit', orderId: ID, previewDigest: digest, expectedCompany: company, expectedLines: [{ ...line }] });
const auth = (over = {}) => ({ scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'all', user: { id: ID }, principal: { kind: 'user_session' }, accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG, orgCondition: () => undefined, token: { mfa: true }, ...over }) as unknown as AuthContext;
const tools = new Map<string, AiTool>(); registerPax8OrderTools(tools);
const run = async (input: Record<string, unknown> = args(), a = auth()) => JSON.parse(await tools.get('manage_pax8_orders')!.handler(input, a));
let preview: any;
beforeEach(() => {
  vi.clearAllMocks();
  preview = { order: { id: ID, orgId: ORG, source: 'quote', status: 'draft' }, company, lines: [{ ...line }], previewDigest: digest, blocked: [], totalsComplete: true };
  h.get.mockResolvedValue({ order: { id: ID, orgId: ORG, status: 'draft' }, lines: [{ id: ID }] });
  h.preview.mockImplementation(async () => preview);
  h.material.mockResolvedValue({ digest });
  h.submit.mockImplementation(async input => { await input.verifyClaim({ order: { id: ID, orgId: ORG }, lines: [{ id: ID }] }, {}); return { orderId: ID, status: 'completed', lines: [{ lineId: ID, submitState: 'succeeded', error: null }] }; });
  h.reconcile.mockResolvedValue({ resolved: 1, stillUnknown: 0 });
});
describe('W15 PR B Pax8 order submit', () => {
  it('appends exactly submit and reconcile to the action schema', () => expect(pax8ToolSchemas.manage_pax8_orders.shape.action.options).toEqual(['list','get','create_draft','add_line','update_line','remove_line','preview','preflight','submit','reconcile']));
  it('submit is four-eyes and agent-human-only; reconcile is supervised and MFA-gated', () => {
    expect(checkGuardrails('manage_pax8_orders', { action: 'submit' })).toMatchObject({ tier: 3, approvalScope: 'four_eyes' });
    expect(AGENT_HUMAN_ONLY_ACTIONS.has('manage_pax8_orders:submit')).toBe(true);
    expect(checkGuardrails('manage_pax8_orders', { action: 'reconcile' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    expect(isMfaGatedToolAction('manage_pax8_orders', 'submit')).toBe(true);
    expect(isMfaGatedToolAction('manage_pax8_orders', 'reconcile')).toBe(true);
  });
  it('verifies inside the claim before any isMock/write, without a pre-claim preflight', async () => {
    expect((await run()).status).toBe('completed');
    expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: ID, onPreflightFailure: 'reopen', verifyClaim: expect.any(Function) }));
    expect(h.material).toHaveBeenCalledWith({}, ID);
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'pax8.order.submit' }));
  });
  it.each(['unitCost', 'currency'])('PRICE_CHANGED on %s refuses before claim or writes', async field => {
    preview.lines[0][field] = 'changed';
    expect((await run()).code).toBe('PRICE_CHANGED'); expect(h.submit).not.toHaveBeenCalled();
  });
  it.each(['commitmentTerm', 'cancellationFeeApplied'])('COMMITMENT_CHANGED on %s refuses before claim or writes', async field => {
    preview.lines[0][field] = field === 'cancellationFeeApplied' ? false : 'Monthly';
    expect((await run()).code).toBe('COMMITMENT_CHANGED'); expect(h.submit).not.toHaveBeenCalled();
  });
  it.each(['change_quantity', 'cancel'])('%s checks freshly fetched commitment assertions too', async action => {
    const input = args(); input.expectedLines[0]!.action = action; preview.lines[0].action = action;
    preview.lines[0].commitmentTerm = 'Monthly';
    expect((await run(input)).code).toBe('COMMITMENT_CHANGED'); expect(h.submit).not.toHaveBeenCalled();
  });
  it.each([
    ['cancel', '0', '5', 'allowForEarlyCancellation'],
    ['change_quantity', '8', '5', 'allowForQuantityIncrease'],
    ['change_quantity', '2', '5', 'allowForQuantityDecrease'],
  ])('refuses newly forbidden %s even when its term and fee are unchanged', async (action, quantity, fromQuantity, flag) => {
    const input = args(); Object.assign(input.expectedLines[0]!, { action, quantity, fromQuantity });
    Object.assign(preview.lines[0], { action, quantity, fromQuantity, [flag]: false });
    expect((await run(input)).code).toBe('COMMITMENT_CHANGED'); expect(h.submit).not.toHaveBeenCalled();
  });
  it.each(['quantity','productName','pax8ProductId','billingTerm','fromQuantity'])('PREVIEW_MISMATCH for a wrong asserted %s', async field => {
    const input = args(); (input.expectedLines[0] as any)[field] = field === 'billingTerm' ? 'Annual' : 'wrong';
    expect((await run(input)).code).toBe('PREVIEW_MISMATCH'); expect(h.submit).not.toHaveBeenCalled();
  });
  it('refuses mismatched company, changed digest and changed locked material', async () => {
    expect((await run({ ...args(), expectedCompany: { ...company, name: 'Wrong' } })).code).toBe('PREVIEW_MISMATCH');
    preview.previewDigest = 'b'.repeat(64); expect((await run()).code).toBe('PREVIEW_MISMATCH');
    preview.previewDigest = digest; h.material.mockResolvedValue({ digest: 'c'.repeat(64) });
    expect((await run()).code).toBe('PREVIEW_MISMATCH');
  });
  it.each(['COST_UNKNOWN','COMMITMENT_AMBIGUOUS','TOO_MANY_LINES','NOT_PENDING','COMPANY_UNRESOLVED'])('%s refuses without submit', async code => {
    preview.blocked = [{ code }]; expect((await run()).code).toBe(code); expect(h.submit).not.toHaveBeenCalled();
  });
  it('refuses more than 20 lines before vendor preview', async () => {
    h.get.mockResolvedValue({ order: { id: ID, orgId: ORG }, lines: Array(21).fill({ id: ID }) });
    expect((await run()).code).toBe('TOO_MANY_LINES'); expect(h.preview).not.toHaveBeenCalled(); expect(h.submit).not.toHaveBeenCalled();
  });
  it('PREFLIGHT_FAILED reports the reopened order, never claims a terminal failure', async () => {
    h.submit.mockResolvedValue({ orderId: ID, status: 'draft', lines: [{ lineId: ID, submitState: 'pending', error: null }], refusalCode: 'PREFLIGHT_FAILED', error: 'bad provisioning' });
    const out = await run(); expect(out.code).toBe('PREFLIGHT_FAILED'); expect(out.result.status).toBe('draft');
  });
  it('clips all nested vendor errors to 2 KB on an unsent refusal', async () => {
    h.submit.mockResolvedValue({ orderId: ID, status: 'draft', lines: [{ lineId: ID, submitState: 'pending', error: '界'.repeat(4000) }], refusalCode: 'PREFLIGHT_FAILED', error: '界'.repeat(4000) });
    const out = await run();
    expect(out.code).toBe('PREFLIGHT_FAILED');
    for (const error of [out.error, out.result.error, out.result.lines[0].error]) expect(Buffer.byteLength(error)).toBeLessThanOrEqual(2048);
  });
  it('a re-delivered release loses the claim and is never re-sent', async () => {
    h.submit.mockRejectedValue(new Pax8OrderError('Another submit won the order claim; reconcile it.', 409));
    expect((await run()).code).toBe('CONFLICT'); expect(h.submit).toHaveBeenCalledTimes(1);
  });
  it('names ambiguous writes with a reconcile hint', async () => {
    h.submit.mockResolvedValue({ orderId: ID, status: 'partially_failed', lines: [{ lineId: ID, submitState: 'needs_reconcile', error: 'timeout' }] });
    expect((await run()).nextStep).toContain('reconcile');
  });
  it.each(['submit','reconcile'])('%s repeats MFA, site, device and org gates before services', async action => {
    for (const [over, code] of [[{ token: {} },'MFA_REQUIRED'],[{ allowedSiteIds: [ID] },'ACCESS_DENIED'],[{ allowedDeviceIds: [ID] },'ACCESS_DENIED']] as const) expect((await run({ ...args(), action }, auth(over))).code).toBe(code);
    h.get.mockResolvedValue({ order: { id: ID, orgId: ID }, lines: [] }); expect((await run({ ...args(), action })).code).toBe('FORBIDDEN');
    expect(h.submit).not.toHaveBeenCalled(); expect(h.reconcile).not.toHaveBeenCalled(); expect(h.preview).not.toHaveBeenCalled();
  });
  it('site-ceilinged preview cannot read whole-contract billing evidence', async () => {
    expect((await run({ action: 'preview', orderId: ID }, auth({ allowedSiteIds: [ID] }))).code).toBe('ACCESS_DENIED');
    expect(h.preview).not.toHaveBeenCalled();
  });
  it('refuses agent submit even when directly invoked', async () => {
    expect((await run(args(), auth({ principal: { kind: 'ai_agent' } }))).code).toBe('AGENT_HUMAN_ONLY'); expect(h.submit).not.toHaveBeenCalled();
  });
  it('reconcile calls the existing service and audits the read-backed billing result', async () => {
    expect(await run({ action: 'reconcile', orderId: ID })).toEqual({ resolved: 1, stillUnknown: 0 });
    expect(h.reconcile).toHaveBeenCalledWith({ partnerId: PARTNER, orderId: ID });
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'pax8.order.reconcile' }));
  });
  it('the approval card says estimated and identifies every CANCEL as terminal with its term', () => {
    const copy = buildApprovalDescription('manage_pax8_orders', 'submit', { ...args(), expectedLines: [{ ...line, action: 'cancel' }, { ...line, lineId: ORG, productName: 'Second Product', action: 'cancel', commitmentTerm: 'Monthly' }] });
    expect(copy).toContain('estimated'); expect(copy).toContain('Fixture Company'); expect(copy).toContain('Annual'); expect(copy).toContain('Monthly'); expect(copy.match(/terminal/gi)).toHaveLength(2);
  });
});
