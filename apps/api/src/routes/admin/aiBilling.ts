/**
 * Platform-admin operator surface for platform AI credit debits (#7717).
 *
 *   GET  /api/v1/admin/ai-billing/failed-debits            terminally failed debits, every source
 *   POST /api/v1/admin/ai-billing/failed-debits/redrive    re-send ONE now (MFA)
 *   POST /api/v1/admin/ai-billing/failed-debits/requeue    bulk re-queue for the sweep (MFA, reason)
 *   GET  /api/v1/admin/ai-billing/dead-settlements         dead pending settlements
 *   POST /api/v1/admin/ai-billing/dead-settlements/:id/replay   replay one (MFA)
 *
 * Every re-drive re-sends the debit's ORIGINAL idempotency key and amount
 * (services/aiCreditDebits.ts): the billing service dedupes on the key, so
 * re-driving a debit that did land is a replay, never a second charge. The
 * typical use is a billing-service key rotation: every debit in that window
 * fails `auth` (401/403) and is terminal; after the key is fixed, one bulk
 * re-queue filtered to `failureClass=auth` and the rotation window recovers
 * them all within one sweep interval.
 *
 * Cross-tenant by nature (billing is ours, not a tenant's), so platform-admin
 * only via the gate in ./index.ts, plus MFA on every mutating verb.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import { listDeadPendingSettlements } from '../../services/aiBudgetReservations';
import {
  CREDIT_DEBIT_FAILURE_CLASSES,
  CREDIT_DEBIT_SOURCES,
  BillingServiceNotConfiguredError,
  MAX_FAILED_CREDIT_DEBIT_PAGE,
  listFailedPlatformCreditDebits,
  redriveFailedCreditDebit,
  replayDeadPendingSettlement,
  requeueFailedCreditDebits,
  type FailedCreditDebitFilter,
} from '../../services/aiCreditDebits';
import { createAuditLogAsync } from '../../services/auditService';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';

export const aiBillingAdminRoutes = new Hono();

// Re-driving needs a billing service to send to; without one, clearing a
// failure stamp would just hide the row. 409, nothing changed.
aiBillingAdminRoutes.onError((err, c) => {
  if (err instanceof BillingServiceNotConfiguredError) return c.json({ error: err.message }, 409);
  throw err;
});

const SUCCESSFUL_DEBIT_OUTCOMES = new Set(['debited', 'not_configured']);

const isoDate = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const limit = z.coerce.number().int().min(1).max(MAX_FAILED_CREDIT_DEBIT_PAGE);

const filterFields = {
  orgId: z.string().uuid().optional(),
  failureClass: z.enum(CREDIT_DEBIT_FAILURE_CLASSES).optional(),
  failedAfter: isoDate.optional(),
  failedBefore: isoDate.optional(),
};

const listQuerySchema = z.strictObject({ ...filterFields, limit: limit.optional() });
const requeueSchema = z.strictObject({
  ...filterFields,
  limit,
  reason: z.string().trim().min(3).max(500),
});
const redriveSchema = z.strictObject({
  source: z.enum(CREDIT_DEBIT_SOURCES),
  id: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});
const deadListSchema = z.strictObject({ limit: limit.optional() });
const reservationParamSchema = z.object({ reservationId: z.string().uuid() });
const replaySchema = z.strictObject({ reason: z.string().trim().max(500).optional() });

/** Drop absent keys so the service sees exactly the filters the operator set. */
function definedFilter<T extends FailedCreditDebitFilter>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function audit(c: Context, entry: {
  action: string; resourceId?: string; details: Record<string, unknown>; result?: 'success' | 'failure';
}): void {
  const auth = c.get('auth');
  // Non-throwing (retry-queued): once a re-drive went out, the response must
  // report what billing said, not a 500 from the audit write.
  void createAuditLogAsync({
    orgId: null,
    actorType: 'user',
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: entry.action,
    resourceType: 'ai_credit_debit',
    resourceId: entry.resourceId,
    details: entry.details,
    ipAddress: getTrustedClientIpOrUndefined(c),
    userAgent: c.req.header('user-agent'),
    result: entry.result ?? 'success',
  });
}

aiBillingAdminRoutes.get('/failed-debits', zValidator('query', listQuerySchema), async (c) => {
  const data = await listFailedPlatformCreditDebits(definedFilter(c.req.valid('query')));
  return c.json({ data });
});

aiBillingAdminRoutes.post('/failed-debits/redrive', requireMfa(), zValidator('json', redriveSchema), async (c) => {
  const { source, id, reason } = c.req.valid('json');
  const result = await redriveFailedCreditDebit({ source, id });
  if (result.kind === 'not_found') {
    return c.json({ error: 'No failed, undebited credit debit with that source and id' }, 404);
  }
  audit(c, {
    action: 'ai_billing.credit_debit_redriven',
    resourceId: id,
    details: { source, outcome: result.outcome, ...(reason ? { reason } : {}) },
    result: SUCCESSFUL_DEBIT_OUTCOMES.has(result.outcome) ? 'success' : 'failure',
  });
  return c.json({ data: { outcome: result.outcome } });
});

aiBillingAdminRoutes.post('/failed-debits/requeue', requireMfa(), zValidator('json', requeueSchema), async (c) => {
  const { reason, ...filter } = c.req.valid('json');
  const requeued = await requeueFailedCreditDebits(definedFilter(filter));
  audit(c, {
    action: 'ai_billing.credit_debits_requeued',
    details: {
      ...definedFilter(filter),
      failedAfter: filter.failedAfter?.toISOString(),
      failedBefore: filter.failedBefore?.toISOString(),
      count: requeued.length,
      reason,
    },
  });
  return c.json({ data: { requeued, count: requeued.length } });
});

aiBillingAdminRoutes.get('/dead-settlements', zValidator('query', deadListSchema), async (c) => {
  const data = await listDeadPendingSettlements(c.req.valid('query').limit ?? 100);
  return c.json({ data });
});

aiBillingAdminRoutes.post(
  '/dead-settlements/:reservationId/replay',
  requireMfa(),
  zValidator('param', reservationParamSchema),
  zValidator('json', replaySchema),
  async (c) => {
    const { reservationId } = c.req.valid('param');
    const { reason } = c.req.valid('json');
    const result = await replayDeadPendingSettlement(reservationId);
    switch (result.kind) {
      case 'not_found':
        return c.json({ error: 'No dead pending settlement with that reservation id' }, 404);
      case 'superseded':
        // Replaying would bill this turn's usage a second time: a later turn of
        // the same session was priced against a baseline that never saw it.
        return c.json({
          error: 'A later turn of the same session already billed this usage; replaying would double-bill it. Reconcile by hand.',
        }, 409);
      case 'failed':
        audit(c, {
          action: 'ai_billing.dead_settlement_replayed', resourceId: reservationId,
          details: { error: result.error, ...(reason ? { reason } : {}) }, result: 'failure',
        });
        return c.json({ error: 'Replay failed; the settlement is pending again and the sweep keeps retrying it', detail: result.error }, 502);
      case 'replayed':
        audit(c, {
          action: 'ai_billing.dead_settlement_replayed', resourceId: reservationId,
          details: { settlement: result.settlement, debit: result.debit, ...(reason ? { reason } : {}) },
          // The spend is recorded either way; the audit says whether billing took it.
          result: result.debit === null || SUCCESSFUL_DEBIT_OUTCOMES.has(result.debit) ? 'success' : 'failure',
        });
        return c.json({ data: result });
    }
  },
);
