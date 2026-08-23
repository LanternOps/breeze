import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { requireScope, requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { contractCurrencyMismatchQuerySchema } from '@breeze/shared';
import { listContractCurrencyMismatches } from '../../services/contractCurrencyReportService';
import { contractActorFrom, handleContractError } from './contracts';

/**
 * Read-only contract reports (multi-currency wave 6, #3778, Task 15).
 *
 * MOUNT ORDER IS LOAD-BEARING: this router owns the LITERAL path
 * `/currency-mismatches`, which `contractCrudRoutes`' `GET /:id` would swallow
 * (answering 400 "invalid uuid") if it were registered first. index.ts mounts
 * it before every param-matching router; reports.test.ts pins that.
 *
 * Read permission only, and no mutating verb exists here — the owner-fixed
 * decisions forbid bulk restamping history, so this router must never grow one.
 */
export const contractReportRoutes = new Hono();
const scopes = requireScope('partner', 'system');
const readPerm = requirePermission(PERMISSIONS.CONTRACTS_READ.resource, PERMISSIONS.CONTRACTS_READ.action);

contractReportRoutes.get(
  '/currency-mismatches', scopes, readPerm,
  zValidator('query', contractCurrencyMismatchQuerySchema),
  async (c) => {
    try {
      return c.json({
        data: await listContractCurrencyMismatches(c.req.valid('query'), contractActorFrom(c)),
      });
    } catch (err) { return handleContractError(c, err); }
  }
);
