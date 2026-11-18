/** W15 PR A: local reads, drafts and isMock preflight; credential/company mapping stays in the web app. */
import { PAX8_BILLING_TERMS, PAX8_ORDER_ACTIONS } from '@breeze/shared';
import { z } from 'zod';
import { pageZodShape } from './aiToolPagination';
export const PAX8_PRODUCT_ACTIONS = ['search', 'provision_details', 'dependencies', 'pricing'] as const;
export const PAX8_SUBSCRIPTION_ACTIONS = ['list', 'drift', 'sync', 'link', 'unlink'] as const;
export const PAX8_DRAFT_ACTIONS = ['list', 'get', 'create_draft', 'add_line', 'update_line', 'remove_line', 'preview', 'preflight', 'submit', 'reconcile'] as const;
const uuid = z.string().guid();
const productId = z.string().trim().min(1).max(64);
const provisioningDetailSchema = z.object({ key: z.string().trim().min(1).max(200), values: z.array(z.string().max(5000)).max(100) });
/** Exact body validation of routes/pax8Orders.ts, without importing a route. */
export const pax8AddLineSchema = z.object({
  action: z.enum(PAX8_ORDER_ACTIONS), pax8ProductId: productId.optional(), catalogItemId: uuid.optional(),
  billingTerm: z.enum(PAX8_BILLING_TERMS).optional(), commitmentTermId: productId.optional(),
  quantity: z.string().trim().min(1).max(40).optional(),
  provisioningDetails: z.array(provisioningDetailSchema).max(200).optional(), targetSubscriptionId: productId.optional(),
  cancelDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
const patchShape = {
  commitmentTermId: productId.nullable().optional(), provisioningDetails: z.array(provisioningDetailSchema).max(200).optional(),
};
export const pax8UpdateLineSchema = z.object(patchShape).strict().refine(
  value => value.commitmentTermId !== undefined || value.provisioningDetails !== undefined,
  { message: 'At least one editable line field is required.' },
);
/** Assertions copied verbatim from preview.submitWith; release re-checks every field. */
export const pax8ExpectedLineSchema = z.object({
  lineId: uuid, action: z.enum(PAX8_ORDER_ACTIONS), pax8ProductId: productId.nullable(),
  productName: z.string().max(255).nullable(), quantity: z.string().max(40).nullable(),
  fromQuantity: z.string().max(40).nullable(), unitCost: z.string().max(40).nullable(),
  currency: z.string().max(3).nullable(), billingTerm: z.enum(PAX8_BILLING_TERMS).nullable(),
  commitmentTerm: z.string().max(255).nullable(), cancellationFeeApplied: z.boolean().nullable(),
}).strict();
export const pax8SubmitAssertionsSchema = z.object({
  previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedCompany: z.object({ pax8CompanyId: productId, name: z.string().max(255) }).strict(),
  expectedLines: z.array(pax8ExpectedLineSchema).min(1).max(20),
}).strict();
const partner = { partnerId: uuid.optional() };
export const pax8ToolSchemas = {
  get_pax8_status: z.object({ ...partner, view: z.enum(['summary', 'companies']).optional(), integrationId: uuid.optional(), ...pageZodShape(50, 100) }).strict(),
  search_pax8_products: z.object({ ...partner, action: z.enum(PAX8_PRODUCT_ACTIONS), productId: productId.optional(), q: z.string().max(255).optional(), ...pageZodShape(50, 100) }).strict(),
  manage_pax8_subscriptions: z.object({ ...partner, action: z.enum(PAX8_SUBSCRIPTION_ACTIONS), integrationId: uuid.optional(), orgId: uuid.optional(), unmappedOnly: z.boolean().optional(), subscriptionSnapshotId: uuid.optional(), contractLineId: uuid.optional(), syncEnabled: z.boolean().optional(), ...pageZodShape(50, 100) }).strict(),
  manage_pax8_orders: z.object({ ...partner, action: z.enum(PAX8_DRAFT_ACTIONS), orgId: uuid.optional(), orderId: uuid.optional(), lineId: uuid.optional(), previewDigest: pax8SubmitAssertionsSchema.shape.previewDigest.optional(), expectedCompany: pax8SubmitAssertionsSchema.shape.expectedCompany.optional(), expectedLines: pax8SubmitAssertionsSchema.shape.expectedLines.optional(), line: pax8AddLineSchema.optional(), patch: z.object(patchShape).strict().optional(), ...pageZodShape(50, 100) }).strict(),
};
