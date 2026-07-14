import { PAX8_BILLING_TERMS, PAX8_ORDER_ACTIONS } from '@breeze/shared';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { db, runOutsideDbContext, withDbAccessContext, type DbAccessContext } from '../db';
import { pax8Integrations } from '../db/schema';
import { zValidator } from '../lib/validation';
import {
  authMiddleware,
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { Pax8ApiError, type Pax8Client } from '../services/pax8Client';
import {
  addOrderLine,
  getOrderWithLines,
  getOrCreateDraftOrder,
  listPax8Products,
  listPax8Orders,
  Pax8OrderError,
  removeOrderLine,
  updateOrderLine,
} from '../services/pax8OrderService';
import { preflightOrder, reconcileOrder, submitOrder } from '../services/pax8OrderSubmit';
import { createPax8ClientForIntegration } from '../services/pax8SyncService';
import { detectPax8Drift } from '../services/pax8Drift';
import { PERMISSIONS } from '../services/permissions';
import { captureException } from '../services/sentry';

export const pax8OrderRoutes = new Hono();

type RouteAuth = Pick<
  AuthContext,
  'scope' | 'partnerId' | 'orgId' | 'canAccessOrg' | 'accessibleOrgIds' | 'user'
>;

function resolvePartnerId(auth: RouteAuth, requested?: string): { partnerId: string } | { error: string; status: 400 | 403 } {
  if (auth.scope === 'partner') {
    if (!auth.partnerId) return { error: 'Partner context required', status: 403 };
    if (requested && requested !== auth.partnerId) return { error: 'Access to this partner denied', status: 403 };
    return { partnerId: auth.partnerId };
  }
  if (auth.scope === 'organization') {
    return { error: 'Pax8 ordering is managed at partner scope', status: 403 };
  }
  if (!requested) return { error: 'partnerId is required for system scope', status: 400 };
  return { partnerId: requested };
}

const billingManage = requirePermission(
  PERMISSIONS.BILLING_MANAGE.resource,
  PERMISSIONS.BILLING_MANAGE.action,
);
const partnerScopes = requireScope('partner', 'system');

const partnerQuerySchema = z.object({
  partnerId: z.string().guid().optional(),
});

const orderListQuerySchema = partnerQuerySchema.extend({
  orgId: z.string().guid().optional(),
});

const driftQuerySchema = partnerQuerySchema.extend({
  integrationId: z.string().guid(),
});

const orderIdSchema = z.object({ id: z.string().guid() });
const orderLineIdSchema = orderIdSchema.extend({ lineId: z.string().guid() });
const productIdSchema = z.object({ productId: z.string().trim().min(1).max(64) });

const createOrderSchema = z.object({
  orgId: z.string().guid(),
});

const provisioningDetailSchema = z.object({
  key: z.string().trim().min(1).max(200),
  values: z.array(z.string().max(5000)).max(100),
});

const addLineSchema = z.object({
  action: z.enum(PAX8_ORDER_ACTIONS),
  pax8ProductId: z.string().trim().min(1).max(64).optional(),
  catalogItemId: z.string().guid().optional(),
  billingTerm: z.enum(PAX8_BILLING_TERMS).optional(),
  commitmentTermId: z.string().trim().min(1).max(64).optional(),
  quantity: z.string().trim().min(1).max(40).optional(),
  provisioningDetails: z.array(provisioningDetailSchema).max(200).optional(),
  targetSubscriptionId: z.string().trim().min(1).max(64).optional(),
  cancelDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  contractLineId: z.string().guid().optional(),
}).strict();

const updateLineSchema = z.object({
  commitmentTermId: z.string().trim().min(1).max(64).nullable().optional(),
  provisioningDetails: z.array(provisioningDetailSchema).max(200).optional(),
}).strict().refine(
  (value) => value.commitmentTermId !== undefined || value.provisioningDetails !== undefined,
  { message: 'At least one editable line field is required.' },
);

function partnerDbContext(auth: RouteAuth, partnerId: string): DbAccessContext {
  const system = auth.scope === 'system';
  return {
    scope: system ? 'system' : 'partner',
    orgId: null,
    accessibleOrgIds: system ? null : auth.accessibleOrgIds,
    accessiblePartnerIds: system ? null : [partnerId],
    userId: auth.user.id,
    currentPartnerId: partnerId,
  };
}

async function loadAuthorizedOrder(auth: RouteAuth, partnerId: string, orderId: string) {
  const bundle = await withDbAccessContext(
    partnerDbContext(auth, partnerId),
    () => getOrderWithLines({ partnerId, orderId }),
  );
  if (!auth.canAccessOrg(bundle.order.orgId)) {
    throw new Pax8OrderError('Access to this organization denied.', 403);
  }
  return bundle;
}

async function resolveProductClient(auth: RouteAuth, partnerId: string): Promise<Pax8Client> {
  return runOutsideDbContext(() => withDbAccessContext(partnerDbContext(auth, partnerId), async () => {
    const [integration] = await db
      .select({ id: pax8Integrations.id, partnerId: pax8Integrations.partnerId })
      .from(pax8Integrations)
      .where(and(
        eq(pax8Integrations.partnerId, partnerId),
        eq(pax8Integrations.isActive, true),
      ))
      .limit(1);
    if (!integration) throw new Pax8OrderError('Pax8 integration not found.', 404);

    const created = await createPax8ClientForIntegration(integration.id);
    if (created.integration.partnerId !== partnerId) {
      throw new Pax8OrderError('The Pax8 integration belongs to a different partner.', 403);
    }
    return created.client;
  }));
}

function isJsonBody(body: string): boolean {
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function rawBody(c: Context, body: string, status: 422 | 502): Response {
  return c.body(body, status, {
    'content-type': isJsonBody(body) ? 'application/json' : 'text/plain; charset=UTF-8',
  });
}

function routeError(c: Context, error: unknown): Response {
  if (error instanceof Pax8OrderError) return c.json({ error: error.message }, error.status);
  if (error instanceof Pax8ApiError) return rawBody(c, error.body || error.message, 502);
  captureException(error instanceof Error ? error : new Error(String(error)));
  return c.json({ error: 'Internal server error' }, 500);
}

function auditOrderAction(
  c: Context,
  input: {
    action: string;
    partnerId: string;
    orgId: string;
    orderId?: string;
    result?: 'success' | 'failure';
    details?: Record<string, unknown>;
  },
): void {
  writeRouteAudit(c, {
    orgId: input.orgId,
    action: input.action,
    resourceType: 'pax8_order',
    resourceId: input.orderId,
    result: input.result,
    details: { partnerId: input.partnerId, ...input.details },
  });
}

type FailureClass =
  | 'Pax8OrderError'
  | 'Pax8ApiError'
  | 'UnexpectedError'
  | 'NotFound'
  | 'Pax8Validation'
  | 'OrderResultNotCompleted'
  | 'ReconciliationIncomplete';

function classifyFailure(error: unknown): { status: number; errorClass: FailureClass } {
  if (error instanceof Pax8OrderError) return { status: error.status, errorClass: 'Pax8OrderError' };
  if (error instanceof Pax8ApiError) return { status: 502, errorClass: 'Pax8ApiError' };
  return { status: 500, errorClass: 'UnexpectedError' };
}

function auditOrderFailure(
  c: Context,
  input: Omit<Parameters<typeof auditOrderAction>[1], 'result'>,
  failure: { status: number; errorClass: FailureClass },
): void {
  auditOrderAction(c, {
    ...input,
    result: 'failure',
    details: { ...input.details, ...failure },
  });
}

async function runAuditedMutation<T>(
  c: Context,
  audit: Omit<Parameters<typeof auditOrderAction>[1], 'result'>,
  operation: () => Promise<T>,
): Promise<{ value: T } | { response: Response }> {
  try {
    return { value: await operation() };
  } catch (error) {
    // The route audit is deliberately fire-and-forget, matching every existing
    // writeRouteAudit call. It receives only a bounded classification; response
    // mapping still receives the original error so raw Pax8 bodies reach the
    // caller but can never enter audit metadata.
    auditOrderFailure(c, audit, classifyFailure(error));
    return { response: routeError(c, error) };
  }
}

function submitAuditDetails(result: Awaited<ReturnType<typeof submitOrder>>) {
  let succeededCount = 0;
  let failedCount = 0;
  let needsReconcileCount = 0;
  for (const line of result.lines) {
    if (line.submitState === 'succeeded') succeededCount += 1;
    else if (line.submitState === 'failed') failedCount += 1;
    else if (line.submitState === 'needs_reconcile') needsReconcileCount += 1;
  }
  return {
    orderStatus: result.status,
    succeededCount,
    failedCount,
    needsReconcileCount,
  };
}

pax8OrderRoutes.use('*', authMiddleware);

// `requireScope()` intentionally follows this check. Its generic 403 would
// otherwise hide the ordering-specific refusal promised to org-scoped callers.
pax8OrderRoutes.use('*', async (c, next) => {
  const auth = c.get('auth');
  if (auth.scope === 'organization') {
    return c.json({ error: 'Pax8 ordering is managed at partner scope' }, 403);
  }
  await next();
});

pax8OrderRoutes.get(
  '/drift',
  partnerScopes,
  billingManage,
  zValidator('query', driftQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const partner = resolvePartnerId(auth, query.partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    try {
      const data = await withDbAccessContext(partnerDbContext(auth, partner.partnerId), async () => {
        const [integration] = await db
          .select({ id: pax8Integrations.id })
          .from(pax8Integrations)
          .where(and(
            eq(pax8Integrations.id, query.integrationId),
            eq(pax8Integrations.partnerId, partner.partnerId),
          ))
          .limit(1);
        if (!integration) throw new Pax8OrderError('Pax8 integration not found.', 404);
        return detectPax8Drift({
          partnerId: partner.partnerId,
          integrationId: integration.id,
        });
      });
      return c.json({ data });
    } catch (error) {
      return routeError(c, error);
    }
  },
);

pax8OrderRoutes.get(
  '/orders',
  partnerScopes,
  billingManage,
  zValidator('query', orderListQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const partner = resolvePartnerId(auth, query.partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    if (query.orgId && !auth.canAccessOrg(query.orgId)) {
      return c.json({ error: 'Access to this organization denied.' }, 403);
    }
    try {
      const data = await listPax8Orders({
        partnerId: partner.partnerId,
        ...(query.orgId ? { orgId: query.orgId } : {}),
        ...(!query.orgId && auth.scope === 'partner'
          ? { accessibleOrgIds: auth.accessibleOrgIds }
          : {}),
      });
      return c.json({ data });
    } catch (error) {
      return routeError(c, error);
    }
  },
);

pax8OrderRoutes.get(
  '/orders/:id',
  partnerScopes,
  billingManage,
  zValidator('query', partnerQuerySchema),
  zValidator('param', orderIdSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { id } = c.req.valid('param');
    const partner = resolvePartnerId(auth, query.partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    try {
      return c.json({ data: await loadAuthorizedOrder(auth, partner.partnerId, id) });
    } catch (error) {
      return routeError(c, error);
    }
  },
);

pax8OrderRoutes.post(
  '/orders',
  partnerScopes,
  billingManage,
  requireMfa(),
  zValidator('query', partnerQuerySchema),
  zValidator('json', createOrderSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const body = c.req.valid('json');
    const partner = resolvePartnerId(auth, query.partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    if (!auth.canAccessOrg(body.orgId)) return c.json({ error: 'Access to this organization denied.' }, 403);
    const mutation = await runAuditedMutation(c, {
      action: 'pax8.order.create', partnerId: partner.partnerId, orgId: body.orgId,
    }, () => getOrCreateDraftOrder({
        partnerId: partner.partnerId,
        orgId: body.orgId,
        actorUserId: auth.user.id,
      }));
    if ('response' in mutation) return mutation.response;
    const order = mutation.value;
    auditOrderAction(c, {
      action: 'pax8.order.create', partnerId: partner.partnerId,
      orgId: order.orgId, orderId: order.id,
    });
    return c.json({ data: order }, 201);
  },
);

pax8OrderRoutes.patch(
  '/orders/:id/lines/:lineId',
  partnerScopes,
  billingManage,
  requireMfa(),
  zValidator('query', partnerQuerySchema),
  zValidator('param', orderLineIdSchema),
  zValidator('json', updateLineSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { id, lineId } = c.req.valid('param');
    const body = c.req.valid('json');
    const partner = resolvePartnerId(auth, query.partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    let bundle: Awaited<ReturnType<typeof loadAuthorizedOrder>>;
    try {
      bundle = await loadAuthorizedOrder(auth, partner.partnerId, id);
    } catch (error) {
      return routeError(c, error);
    }
    const audit = {
      action: 'pax8.order.line.update', partnerId: partner.partnerId,
      orgId: bundle.order.orgId, orderId: id, details: { lineId },
    };
    const mutation = await runAuditedMutation(c, audit, () => updateOrderLine({
      partnerId: partner.partnerId,
      orderId: id,
      lineId,
      ...body,
    }));
    if ('response' in mutation) return mutation.response;
    auditOrderAction(c, { ...audit, result: 'success' });
    return c.json({ data: mutation.value });
  },
);

pax8OrderRoutes.post(
  '/orders/:id/lines',
  partnerScopes,
  billingManage,
  requireMfa(),
  zValidator('query', partnerQuerySchema),
  zValidator('param', orderIdSchema),
  zValidator('json', addLineSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const partner = resolvePartnerId(auth, query.partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    let bundle: Awaited<ReturnType<typeof loadAuthorizedOrder>>;
    try {
      bundle = await loadAuthorizedOrder(auth, partner.partnerId, id);
    } catch (error) {
      return routeError(c, error);
    }
    const mutation = await runAuditedMutation(c, {
      action: 'pax8.order.line.create', partnerId: partner.partnerId,
      orgId: bundle.order.orgId, orderId: id, details: { lineAction: body.action },
    }, () => addOrderLine({ partnerId: partner.partnerId, orderId: id, ...body }));
    if ('response' in mutation) return mutation.response;
    const line = mutation.value;
    auditOrderAction(c, {
      action: 'pax8.order.line.create', partnerId: partner.partnerId,
      orgId: bundle.order.orgId, orderId: id,
      details: { lineId: line.id, lineAction: line.action },
    });
    return c.json({ data: line }, 201);
  },
);

pax8OrderRoutes.delete(
  '/orders/:id/lines/:lineId',
  partnerScopes,
  billingManage,
  requireMfa(),
  zValidator('query', partnerQuerySchema),
  zValidator('param', orderLineIdSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { id, lineId } = c.req.valid('param');
    const partner = resolvePartnerId(auth, query.partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    let bundle: Awaited<ReturnType<typeof loadAuthorizedOrder>>;
    try {
      bundle = await loadAuthorizedOrder(auth, partner.partnerId, id);
    } catch (error) {
      return routeError(c, error);
    }
    const audit = {
      action: 'pax8.order.line.delete', partnerId: partner.partnerId,
      orgId: bundle.order.orgId, orderId: id, details: { lineId },
    };
    const mutation = await runAuditedMutation(c, audit, () =>
      removeOrderLine({ partnerId: partner.partnerId, orderId: id, lineId }));
    if ('response' in mutation) return mutation.response;
    if (!mutation.value.removed) {
      auditOrderFailure(c, audit, { status: 404, errorClass: 'NotFound' });
      return c.json({ error: 'Pax8 order line not found.' }, 404);
    }
    auditOrderAction(c, { ...audit, result: 'success' });
    return c.json({ removed: true });
  },
);

pax8OrderRoutes.post(
  '/orders/:id/preflight',
  partnerScopes,
  billingManage,
  requireMfa(),
  zValidator('query', partnerQuerySchema),
  zValidator('param', orderIdSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { id } = c.req.valid('param');
    const partner = resolvePartnerId(auth, query.partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    let bundle: Awaited<ReturnType<typeof loadAuthorizedOrder>>;
    try {
      bundle = await loadAuthorizedOrder(auth, partner.partnerId, id);
    } catch (error) {
      return routeError(c, error);
    }
    const audit = {
      action: 'pax8.order.preflight', partnerId: partner.partnerId,
      orgId: bundle.order.orgId, orderId: id,
    };
    const mutation = await runAuditedMutation(c, audit, () =>
      preflightOrder({ partnerId: partner.partnerId, orderId: id }));
    if ('response' in mutation) return mutation.response;
    const result = mutation.value;
    if (!result.ok) {
      auditOrderFailure(c, audit, { status: 422, errorClass: 'Pax8Validation' });
      return rawBody(c, result.errorBody, 422);
    }
    auditOrderAction(c, { ...audit, result: 'success' });
    return c.json(result);
  },
);

pax8OrderRoutes.post(
  '/orders/:id/submit',
  partnerScopes,
  billingManage,
  requireMfa(),
  zValidator('query', partnerQuerySchema),
  zValidator('param', orderIdSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { id } = c.req.valid('param');
    const partner = resolvePartnerId(auth, query.partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    let bundle: Awaited<ReturnType<typeof loadAuthorizedOrder>>;
    try {
      bundle = await loadAuthorizedOrder(auth, partner.partnerId, id);
    } catch (error) {
      return routeError(c, error);
    }
    const audit = {
      action: 'pax8.order.submit', partnerId: partner.partnerId,
      orgId: bundle.order.orgId, orderId: id,
    };
    const mutation = await runAuditedMutation(c, audit, () =>
      submitOrder({ partnerId: partner.partnerId, orderId: id, actorUserId: auth.user.id }));
    if ('response' in mutation) return mutation.response;
    const result = mutation.value;
    const details = submitAuditDetails(result);
    if (result.status === 'completed') {
      auditOrderAction(c, {
        ...audit,
        result: 'success',
        details,
      });
    } else {
      auditOrderFailure(c, { ...audit, details }, {
        status: 200, errorClass: 'OrderResultNotCompleted',
      });
    }
    return c.json(result);
  },
);

pax8OrderRoutes.post(
  '/orders/:id/reconcile',
  partnerScopes,
  billingManage,
  requireMfa(),
  zValidator('query', partnerQuerySchema),
  zValidator('param', orderIdSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { id } = c.req.valid('param');
    const partner = resolvePartnerId(auth, query.partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    let bundle: Awaited<ReturnType<typeof loadAuthorizedOrder>>;
    try {
      bundle = await loadAuthorizedOrder(auth, partner.partnerId, id);
    } catch (error) {
      return routeError(c, error);
    }
    const audit = {
      action: 'pax8.order.reconcile', partnerId: partner.partnerId,
      orgId: bundle.order.orgId, orderId: id,
    };
    const mutation = await runAuditedMutation(c, audit, () =>
      reconcileOrder({ partnerId: partner.partnerId, orderId: id }));
    if ('response' in mutation) return mutation.response;
    const result = mutation.value;
    if (result.stillUnknown === 0) {
      auditOrderAction(c, {
        ...audit, result: 'success',
        details: { resolved: result.resolved, stillUnknown: result.stillUnknown },
      });
    } else {
      auditOrderFailure(c, {
        ...audit, details: { resolved: result.resolved, stillUnknown: result.stillUnknown },
      }, { status: 200, errorClass: 'ReconciliationIncomplete' });
    }
    return c.json(result);
  },
);

pax8OrderRoutes.get(
  '/products',
  partnerScopes,
  billingManage,
  zValidator('query', partnerQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const partner = resolvePartnerId(auth, query.partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    try {
      return c.json({ data: await listPax8Products({ partnerId: partner.partnerId }) });
    } catch (error) {
      return routeError(c, error);
    }
  },
);

pax8OrderRoutes.get(
  '/products/:productId/provision-details',
  partnerScopes,
  billingManage,
  zValidator('query', partnerQuerySchema),
  zValidator('param', productIdSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { productId } = c.req.valid('param');
    const partner = resolvePartnerId(auth, query.partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    try {
      const client = await resolveProductClient(auth, partner.partnerId);
      const data = await runOutsideDbContext(() => client.getProvisionDetails(productId));
      return c.json({ data });
    } catch (error) {
      return routeError(c, error);
    }
  },
);

pax8OrderRoutes.get(
  '/products/:productId/dependencies',
  partnerScopes,
  billingManage,
  zValidator('query', partnerQuerySchema),
  zValidator('param', productIdSchema),
  async (c) => {
    const auth = c.get('auth');
    const query = c.req.valid('query');
    const { productId } = c.req.valid('param');
    const partner = resolvePartnerId(auth, query.partnerId);
    if ('error' in partner) return c.json({ error: partner.error }, partner.status);
    try {
      const client = await resolveProductClient(auth, partner.partnerId);
      const data = await runOutsideDbContext(() => client.getProductDependencies(productId));
      return c.json({ data });
    } catch (error) {
      return routeError(c, error);
    }
  },
);
