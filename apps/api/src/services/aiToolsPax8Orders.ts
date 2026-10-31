/** W15 PR A: editable drafts and read-only previews; preflight sends only isMock requests. */
import { runOutsideDbContext, withDbAccessContext } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import { PAX8_DRAFT_ACTIONS, pax8AddLineSchema, pax8UpdateLineSchema, pax8ToolSchemas } from './aiToolSchemasPax8';
import { pax8Clip, pax8DbContext, pax8Error, pax8InputSchema, pax8Page, pax8Partner } from './aiToolsPax8';
import { addOrderLine, getOrderWithLines, getOrCreateDraftOrder, listPax8Orders, removeOrderLine, updateOrderLine, type Pax8OrderLineRow, type Pax8OrderRow } from './pax8OrderService';
import { previewPax8Order } from './pax8OrderPreview';
import { preflightOrder } from './pax8OrderSubmit';
import { Pax8ApiError } from './pax8Client';
import { auditToolWrite, bounded, jsonError, orgWideWriteDenied, verifiedUserIdOrNull } from './aiToolsSoftwareShared';
const TOOL = 'manage_pax8_orders';
const WRITES: ReadonlySet<(typeof PAX8_DRAFT_ACTIONS)[number]> = new Set(
  PAX8_DRAFT_ACTIONS.filter(action => action !== 'list' && action !== 'get' && action !== 'preview'),
);
function presentOrder(order: Pax8OrderRow) {
  return { id: order.id, orgId: order.orgId, source: order.source, sourceQuoteId: order.sourceQuoteId, status: order.status,
    pax8CompanyId: order.pax8CompanyId, pax8OrderId: order.pax8OrderId, createdAt: order.createdAt, updatedAt: order.updatedAt,
    submittedAt: order.submittedAt, error: pax8Clip(order.error) };
}
function presentLine(line: Pax8OrderLineRow) {
  return { id: line.id, orderId: line.orderId, action: line.action, pax8ProductId: line.pax8ProductId,
    catalogItemId: line.catalogItemId, billingTerm: line.billingTerm, commitmentTermId: line.commitmentTermId,
    quantity: line.quantity, authorizedBaselineQuantity: line.authorizedBaselineQuantity, targetSubscriptionId: line.targetSubscriptionId,
    cancelDate: line.cancelDate, contractLineId: line.contractLineId, provisioningDetails: line.provisioningDetails,
    sortOrder: line.sortOrder, submitState: line.submitState, error: pax8Clip(line.error) };
}
function audit(auth: AuthContext, partnerId: string, orgId: string, action: string, orderId: string, details = {}, result: 'success' | 'failure' = 'success') {
  auditToolWrite(auth, { orgId, partnerId, action, resourceType: 'pax8_order', resourceId: orderId, result, details: { tool_name: TOOL, ...details } });
}
export function registerPax8OrderTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1, deviceArgs: [], domain: 'billing', searchHint: 'Pax8 order drafts, seat changes, staged cancellations, cost preview and mock preflight',
    selfManagedDbContext: ['add_line', 'preview', 'preflight'],
    definition: { name: TOOL, description: 'Pax8 orders: list, get, create_draft, add_line, update_line, remove_line, preview and preflight. Draft edits send no order; preflight is a supervised vendor dry run.', input_schema: pax8InputSchema(pax8ToolSchemas.manage_pax8_orders) },
    handler: async (input, auth) => {
      const partner = pax8Partner(auth, input.partnerId); if ('refusal' in partner) return partner.refusal;
      const partnerId = partner.partnerId, action = String(input.action);
      const write = WRITES.has(action as (typeof PAX8_DRAFT_ACTIONS)[number]);
      if (write) {
        const mfa = mfaGatedToolError(TOOL, action, auth); if (mfa) return mfa;
        const denied = orgWideWriteDenied(auth, 'Pax8 orders'); if (denied) return denied;
        if (auth.allowedSiteIds !== undefined) return jsonError('Pax8 orders affect the whole organization', 'ACCESS_DENIED');
      }
      const ctx = pax8DbContext(auth, partnerId);
      try {
        if (action === 'list') {
          if (typeof input.orgId === 'string' && !auth.canAccessOrg(input.orgId)) return jsonError('Access to organization denied', 'FORBIDDEN');
          const rows = await listPax8Orders({ partnerId, ...(input.orgId ? { orgId: input.orgId as string } : {}), ...(auth.scope === 'partner' ? { accessibleOrgIds: auth.accessibleOrgIds } : {}) });
          return pax8Page(TOOL, input, rows.filter(row => auth.canAccessOrg(row.orgId)).map(presentOrder), 100);
        }
        if (action === 'create_draft') {
          if (typeof input.orgId !== 'string') return jsonError('orgId is required', 'VALIDATION_ERROR');
          if (!auth.canAccessOrg(input.orgId)) return jsonError('Access to organization denied', 'FORBIDDEN');
          const order = await getOrCreateDraftOrder({ partnerId, orgId: input.orgId, actorUserId: await verifiedUserIdOrNull(auth) });
          audit(auth, partnerId, order.orgId, 'pax8.order.create', order.id);
          return bounded({ data: presentOrder(order) });
        }
        if (typeof input.orderId !== 'string') return jsonError('orderId is required', 'VALIDATION_ERROR');
        const orderId = input.orderId;
        const bundle = await withDbAccessContext(ctx, () => getOrderWithLines({ partnerId, orderId }));
        if (!auth.canAccessOrg(bundle.order.orgId)) return jsonError('Access to organization denied', 'FORBIDDEN');
        if (action === 'get') return bounded({ data: { order: presentOrder(bundle.order), lines: bundle.lines.map(presentLine) } });
        if (action === 'preview') return bounded(await runOutsideDbContext(() => previewPax8Order({ partnerId, orderId })));
        if (action === 'preflight') {
          try {
            const result = await runOutsideDbContext(() => preflightOrder({ partnerId, orderId }));
            if (!result.ok) throw result.cause ?? new Error(result.errorBody);
            const response = result.sentToPax8 === false
              ? { ok: true, sentToPax8: false, reason: result.reason }
              : { ok: true, sentToPax8: true };
            audit(auth, partnerId, bundle.order.orgId, 'pax8.order.preflight', orderId, response);
            return bounded(response);
          } catch (error) {
            audit(auth, partnerId, bundle.order.orgId, 'pax8.order.preflight', orderId,
              { ok: false, error: error instanceof Error ? error.constructor.name : typeof error }, 'failure');
            if (error instanceof Pax8ApiError && error.status !== undefined && error.status >= 400 && error.status < 500) {
              return jsonError(pax8Clip(error.body || error.message) ?? 'Pax8 preflight failed', 'PREFLIGHT_FAILED');
            }
            throw error;
          }
        }
        if (action === 'add_line') {
          const parsed = pax8AddLineSchema.safeParse(input.line);
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid line', 'VALIDATION_ERROR');
          const line = await runOutsideDbContext(() => addOrderLine({ partnerId, orderId, ...parsed.data }));
          audit(auth, partnerId, bundle.order.orgId, 'pax8.order.line.create', orderId, { lineId: line.id, lineAction: line.action });
          return bounded({ data: presentLine(line) });
        }
        if (typeof input.lineId !== 'string') return jsonError('lineId is required', 'VALIDATION_ERROR');
        const lineId = input.lineId;
        if (action === 'update_line') {
          const parsed = pax8UpdateLineSchema.safeParse(input.patch);
          if (!parsed.success) return jsonError(parsed.error.issues[0]?.message ?? 'Invalid patch', 'VALIDATION_ERROR');
          const line = await updateOrderLine({ partnerId, orderId, lineId, ...parsed.data });
          audit(auth, partnerId, bundle.order.orgId, 'pax8.order.line.update', orderId, { lineId });
          return bounded({ data: presentLine(line) });
        }
        if (action === 'remove_line') {
          const result = await removeOrderLine({ partnerId, orderId, lineId });
          if (!result.removed) return jsonError('Pax8 order line not found', 'NOT_FOUND');
          audit(auth, partnerId, bundle.order.orgId, 'pax8.order.line.delete', orderId, { lineId });
          return bounded(result);
        }
        return jsonError('Unknown Pax8 order action', 'VALIDATION_ERROR');
      } catch (error) { return pax8Error(TOOL, error); }
    },
  });
}
