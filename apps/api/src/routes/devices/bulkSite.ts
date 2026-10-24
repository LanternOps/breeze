/**
 * POST /devices/bulk/site — move up to BULK_SITE_MOVE_CAP agent devices to one site in their own
 * org (#9796; spec §4.4 and Decision 5: one MFA-gated endpoint, not a client loop).
 *
 * Its own file, like bulkLifecycle.ts, for the same two reasons: the path starts with the static
 * segment `bulk`, so it is mounted ahead of core's `/:id` matcher (pinned by
 * bulkLifecycle.mountorder.test.ts), and it opts out of the ambient request transaction
 * (`middleware/selfManagedDbContextRoutes.ts`), which is easiest to reason about in isolation.
 *
 * Nothing here re-implements a move rule:
 *  - each device is authorized through the `getDeviceWithOrgAndSiteCheck` chokepoint — the
 *    same one PATCH /devices/:id uses — inside that device's own transaction;
 *  - the move itself is `moveDeviceToSite` (services/deviceSiteMove.ts), PATCH's extracted body:
 *    expectedSiteId guard, target-site org + allowlist, row lock, guarded UPDATE savepoint,
 *    denormalized rewrite, group re-evaluation, peripheral reconciliation, both audit rows.
 *
 * Gates match PATCH: organization/partner/system scope, `devices:write`, and `requireMfa()` (which
 * also refuses an ai_agent principal). MCP: `human_only_bulk_destructive` in services/mcpCoverage.ts.
 *
 * Response: 200 with one outcome per requested device, in request order, plus `{ moved, total }`.
 * A partial batch is still a 200 (Gate B item 7) — the web decides success / warning / error from
 * the outcomes. Whole-batch problems are 400s, all decided BEFORE any write:
 *   schema (empty, over cap, malformed) → duplicate_device_ids → site_not_found → mixed_org →
 *   site_org_mismatch.
 */
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { sites } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { runBulkIsolated } from '../../lib/bulkOps';
import {
  authMiddleware,
  requireScope,
  requirePermission,
  requireMfa,
  dbAccessContextFromAuth,
  type AuthContext,
} from '../../middleware/auth';
import { PERMISSIONS, canAccessSite, type UserPermissions } from '../../services/permissions';
import { writeRouteAudit } from '../../services/auditEvents';
import { moveDeviceToSite, type SiteMoveAuditEntry, type SiteMoveOutcome } from '../../services/deviceSiteMove';
import { schedulePeripheralPolicyDevice } from '../../jobs/peripheralJobs';
import { bulkSiteMoveSchema } from './schemas';
import {
  ensureOrgAccess,
  getDeviceWithOrgAndSiteCheck,
  getDevicesWithOrgAndSiteCheck,
  SITE_ACCESS_DENIED,
} from './helpers';

export const bulkSiteRoutes = new Hono();

bulkSiteRoutes.use('*', authMiddleware);

export type BulkSiteMoveResult = {
  id: string;
  outcome: SiteMoveOutcome;
  message?: string;
  /** Only on a `conflict`, and only when the caller may see that site (PATCH's 409 rule). */
  currentSiteId?: string;
};

export type BulkSiteMoveBatchErrorCode = 'duplicate_device_ids' | 'site_not_found' | 'mixed_org' | 'site_org_mismatch';

const batchError = (code: BulkSiteMoveBatchErrorCode, error: string, extra: Record<string, unknown> = {}) =>
  ({ error, code, ...extra });

bulkSiteRoutes.post(
  '/bulk/site',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requireMfa(),
  zValidator('json', bulkSiteMoveSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const permissions = c.get('permissions') as UserPermissions | undefined;
    const { siteId, devices: requested } = c.req.valid('json');
    const ids = requested.map((d) => d.id);

    // Gate B item 3: a duplicate rejects the whole batch. Deduplicating (bulk/restore's `new Set`)
    // would have to pick one of two possibly different expectedSiteIds and report one outcome for
    // two rows the client thinks are distinct.
    const seen = new Set<string>();
    const duplicateIds = [...new Set(ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
    if (duplicateIds.length > 0) {
      return c.json(batchError('duplicate_device_ids', 'Each device may appear only once per request', { duplicateIds }), 400);
    }

    const ctx = dbAccessContextFromAuth(auth);

    // One short read in its OWN caller-scoped transaction (the route is self-managed: there is no
    // ambient one, and a bare pool read is forbidden). It decides the whole-batch refusals; it is
    // NOT a lock — every device is re-authorized and re-checked inside its own transaction below.
    // Devices this read cannot see are not a batch error; they come back not_found / forbidden.
    const preRead = await withDbAccessContext(ctx, async () => {
      const [site] = await db.select({ id: sites.id, orgId: sites.orgId }).from(sites).where(eq(sites.id, siteId)).limit(1);
      // An invisible target — missing, another tenant's, or outside a site-scoped caller's
      // allowlist — is one answer, so the response cannot tell them apart.
      const siteVisible = !!site
        && (await ensureOrgAccess(site.orgId, auth))
        && (!permissions?.allowedSiteIds || canAccessSite(permissions, site.id));
      if (!siteVisible) return { error: 'site_not_found' as const };

      const lookups = await getDevicesWithOrgAndSiteCheck(c, ids, auth);
      const orgIds = new Set<string>();
      for (const found of lookups.values()) {
        if (found && found !== SITE_ACCESS_DENIED) orgIds.add(found.orgId);
      }
      if (orgIds.size > 1) return { error: 'mixed_org' as const };
      if (orgIds.size === 1 && !orgIds.has(site!.orgId)) return { error: 'site_org_mismatch' as const };
      return { error: null };
    });
    if (preRead.error === 'site_not_found') {
      return c.json(batchError('site_not_found', 'Target site not found'), 400);
    }
    if (preRead.error === 'mixed_org') {
      return c.json(batchError('mixed_org', 'Selected devices belong to more than one organization'), 400);
    }
    if (preRead.error === 'site_org_mismatch') {
      return c.json(batchError('site_org_mismatch', 'The target site belongs to a different organization than the devices'), 400);
    }

    const expectedById = new Map(requested.map((d) => [d.id, d.expectedSiteId]));
    // Filled ONLY from afterItemCommit, i.e. once the device's own transaction has committed. An
    // item whose transaction threw or failed to commit never lands here and is reported `error`,
    // so a `moved` in the response is always durable.
    const committed = new Map<string, BulkSiteMoveResult>();

    // What one device's transaction hands to its post-commit step. The move's two audit rows and its
    // peripheral reconciliation are held here rather than written in the transaction: writeRouteAudit
    // persists on its own connection immediately, so writing it in-transaction would leave a
    // `device.site_move` row for a device whose COMMIT then failed (reported `error`).
    type ItemValue = { id: string; result: BulkSiteMoveResult; audits: SiteMoveAuditEntry[] };

    await runBulkIsolated<ItemValue>(
      ctx,
      ids,
      async (deviceId): Promise<ItemValue> => {
        const audits: SiteMoveAuditEntry[] = [];
        const done = (result: BulkSiteMoveResult): ItemValue => ({ id: deviceId, result, audits });
        try {
          const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
          if (device === SITE_ACCESS_DENIED) return done({ id: deviceId, outcome: 'forbidden', message: 'Access to this site denied' });
          if (!device) return done({ id: deviceId, outcome: 'not_found' });

          const result = await moveDeviceToSite({
            device,
            permissions,
            toSiteId: siteId,
            expectedSiteId: expectedById.get(deviceId),
            trigger: 'manual',
            reevaluationReason: 'device_bulk_site_move',
            audit: (entry) => { audits.push({ ...entry, details: { ...entry.details, bulk: true } }); },
            peripheralReconciliation: 'caller',
          });
          switch (result.outcome) {
            case 'moved':
            case 'already_there':
              return done({ id: deviceId, outcome: result.outcome });
            case 'conflict':
              return done({
                id: deviceId, outcome: 'conflict', message: result.message,
                ...(result.currentSiteId ? { currentSiteId: result.currentSiteId } : {}),
              });
            case 'forbidden':
              return done({ id: deviceId, outcome: 'forbidden', message: result.message });
          }
        } catch (err) {
          // Rethrown so the device's transaction rolls back; logged here because this is the
          // only server-side record of which device failed and why (bulk/restore precedent).
          console.error(`[devices] bulk site move failed for ${deviceId}:`, err);
          throw err;
        }
      },
      async (deviceId, value) => {
        committed.set(deviceId, value.result);
        if (value.result.outcome !== 'moved') return;
        // Best-effort, like PATCH: neither may turn a committed move into a reported failure.
        try {
          for (const entry of value.audits) writeRouteAudit(c, entry);
        } catch (err) {
          console.error(`[devices] bulk site move audit failed for ${deviceId}:`, err);
        }
        await schedulePeripheralPolicyDevice(deviceId, 'device_site_changed').catch((error) => {
          console.error(`[devices] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
        });
      },
    );

    const results: BulkSiteMoveResult[] = ids.map(
      (id) => committed.get(id) ?? { id, outcome: 'error', message: 'Move failed' },
    );
    return c.json({
      results,
      summary: { moved: results.filter((r) => r.outcome === 'moved').length, total: results.length },
    });
  },
);
