import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { sites, organizations } from '../../db/schema';
import {
  authMiddleware,
  requireInteractiveSession,
  requireMfa,
  requirePermission,
  requireScope,
} from '../../middleware/auth';
import { moveOrgResourceDigest, validateStepUpGrant, type StepUpGrantBinding } from '../../services/mfaStepUpGrant';
import { getUserEpochs } from '../../services/authEpochs';
import { ENABLE_2FA } from '../auth/schemas';
import { hasPermission, PERMISSIONS } from '../../services/permissions';
import {
  getDeviceWithOrgAndSiteCheck,
  SITE_ACCESS_DENIED,
  projectPublicDevice,
} from './helpers';
import { moveOrgSchema } from './schemas';
import { writeRouteAudit } from '../../services/auditEvents';
import { disconnectAgent } from '../agentWs';
import { captureException } from '../../services/sentry';
import {
  TicketMoveCurrencyBlockedError,
  type MoveCurrencyGuardDetails,
} from '../../services/ticketMoveCurrencyGuard';
import { TicketMoveHourBlockError } from '../../services/ticketMoveHourBlockGuard';
import { schedulePeripheralPolicyDevice } from '../../jobs/peripheralJobs';
import { expireDiagnosticApprovalsForMovedDevice } from '../../services/diagnosticAccess/deviceMove';
import { PamDeviceMoveBlockedError } from '../../services/pamDeviceMoveGuard';
import { pgErrorNode } from '../../utils/pgErrors';
import { checkPoolMembershipTransition } from '../../services/unassignedPool/orgType';
import { TicketServiceError } from '../../services/ticketService';
import {
  DevicePoolMembershipRefusedError,
  moveDeviceOrgInTransaction,
  MoveOrgStepUpConsumedError,
  OrgVanishedDuringMoveError,
  type AlertChildOrgRewriteCounts,
  type MoveDeviceOrgResult,
} from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';

const STEP_UP_REQUIRED_BODY = { error: 'Step-up required', code: 'STEP_UP_REQUIRED' } as const;

export const moveOrgRoutes = new Hono();

moveOrgRoutes.use('*', authMiddleware);

/**
 * POST /devices/:id/move-org
 *
 * Move a device between organizations (and into a site within the target org)
 * without uninstalling/reinstalling the agent. The agent re-resolves its
 * `org_id` from `devices.org_id` on every heartbeat / WS handshake, so the
 * column flip is sufficient to relocate the agent at runtime.
 *
 * The route is gated on:
 *   - scope ∈ {partner, system} — cross-org capability requires at minimum
 *     partner reach. Single-org callers can't see two orgs at once and
 *     therefore can't legitimately move between them.
 *   - devices:write AND organizations:write — relocating a device is both
 *     a device mutation and an org-membership mutation.
 *   - an interactive user session — API keys, MCP-OAuth grants and AI agents
 *     are denied unconditionally (requireInteractiveSession, spec 2026-09-18 D1)
 *   - an MFA-assured session (requireMfa) AND, while ENABLE_2FA is on, a fresh
 *     single-use step-up grant for operation 'device_move_org' bound to this
 *     exact { deviceId, orgId, siteId, acceptCurrencyMismatch } (D2/D3). The
 *     grant is validated before the transaction and consumed inside it, after
 *     a FOR SHARE lock on the actor row and BEFORE the organisation locks.
 *
 * Cross-partner moves are rejected even for partner-scoped callers; only
 * system scope can move a device across partner boundaries.
 *
 * RLS hazard: 64 device-scoped tables denormalize `org_id` for RLS perf
 * (see getDeviceOrgDenormalizedTables()). All of them MUST be rewritten in
 * the same transaction or pre-existing rows for this device will be
 * visible only to the OLD org and invisible to the NEW one. Tables that
 * denormalize org_id but have no device_id column (CUSTOM_ORG_REWRITE_TABLES)
 * get dedicated rewrites in the same
 * transaction.
 *
 * Audit: writes ONE audit row per org (source + target) so the move shows
 * up in both audit feeds.
 */
moveOrgRoutes.post(
  '/:id/move-org',
  requireScope('partner', 'system'),
  requireInteractiveSession(),
  requirePermission(PERMISSIONS.DEVICES_WRITE.resource, PERMISSIONS.DEVICES_WRITE.action),
  requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action),
  requireMfa(),
  zValidator('json', moveOrgSchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id')!;
    const { orgId: targetOrgId, siteId: targetSiteId, acceptCurrencyMismatch, stepUpGrant } = c.req.valid('json');

    // Multi-currency (#3776): tickets bound to this device move with it, and
    // accepting that their unbilled monetary rows stay in the OLD currency is a
    // billing decision — invoices:write on top of the move's own gates.
    // `permissions` is populated by the requirePermission middleware above.
    if (
      acceptCurrencyMismatch === true &&
      !hasPermission(c.get('permissions'), PERMISSIONS.INVOICES_WRITE.resource, PERMISSIONS.INVOICES_WRITE.action)
    ) {
      return c.json({ error: 'Accepting a currency mismatch requires invoices:write' }, 403);
    }

    // Source-side access check via the standard chokepoint.
    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const sourceOrgId = device.orgId;

    if (targetOrgId === sourceOrgId) {
      return c.json(
        { error: 'Target organization is the same as the source. Use PATCH /devices/:id to change site.' },
        400,
      );
    }

    // Target-side access check.
    if (!auth.canAccessOrg(targetOrgId)) {
      return c.json({ error: 'Access to target organization denied' }, 403);
    }

    // Look up both orgs to enforce cross-partner policy.
    const orgRows = await db
      .select({
        id: organizations.id,
        partnerId: organizations.partnerId,
        name: organizations.name,
        type: organizations.type,
        // NOTE (#3778): currency is NOT read here any more — the guard uses the
        // values read under the in-transaction org SHARE lock below, so a
        // concurrent changeOrgCurrency cannot slip between this check and the move.
      })
      .from(organizations)
      .where(sql`${organizations.id} IN (${sourceOrgId}::uuid, ${targetOrgId}::uuid)`);

    const sourceOrg = orgRows.find((r) => r.id === sourceOrgId);
    const targetOrg = orgRows.find((r) => r.id === targetOrgId);

    if (!targetOrg) {
      return c.json({ error: 'Target organization not found' }, 404);
    }
    if (!sourceOrg) {
      // Defensive — device.orgId failed FK invariants. Treat as 500-class.
      return c.json({ error: 'Source organization not found' }, 500);
    }
    if (sourceOrg.partnerId !== targetOrg.partnerId && auth.scope !== 'system') {
      return c.json(
        { error: 'Cross-partner moves require system scope' },
        403,
      );
    }

    // Holding-area membership is one-way: nothing moves
    // a device INTO a holding org, and a parked device leaves only through the
    // dedicated assignment operation — never through this route. The
    // devices_unassigned_pool_move_guard trigger enforces the entry half in
    // the database as well.
    const poolRefusal = checkPoolMembershipTransition({
      sourceOrgType: sourceOrg.type,
      targetOrgType: targetOrg.type,
      via: 'generic_move',
    });
    if (poolRefusal) {
      return c.json({ error: poolRefusal.message, code: poolRefusal.code }, 409);
    }

    // Target site must belong to the target org.
    const [targetSite] = await db
      .select({ id: sites.id })
      .from(sites)
      .where(and(eq(sites.id, targetSiteId), eq(sites.orgId, targetOrgId)))
      .limit(1);

    if (!targetSite) {
      return c.json(
        { error: 'Target site not found or does not belong to the target organization' },
        400,
      );
    }

    // Device move-org step-up (spec 2026-09-18 D3). Every preflight above is
    // read-only, so a denial here costs no write and no lock. Missing, stale
    // and mismatched grants are ONE response on purpose: telling a caller which
    // of the three it hit is a probing oracle for the binding.
    let grantBinding: StepUpGrantBinding | null = null;
    if (ENABLE_2FA) {
      const epochs = await getUserEpochs(auth.user.id);
      const sid = auth.token?.sid;
      if (!epochs || !sid) {
        return c.json({ error: 'Service temporarily unavailable' }, 503);
      }
      grantBinding = {
        userId: auth.user.id,
        operation: 'device_move_org',
        authEpoch: epochs.authEpoch,
        mfaEpoch: epochs.mfaEpoch,
        sid,
        resourceDigest: moveOrgResourceDigest({
          deviceId,
          targetOrgId,
          targetSiteId,
          acceptCurrencyMismatch,
        }),
      };
      if (!stepUpGrant || !(await validateStepUpGrant(stepUpGrant, grantBinding))) {
        return c.json(STEP_UP_REQUIRED_BODY, 403);
      }
    }

    // ----------- the actual move -----------
    // The transaction body is the shared engine (services/deviceOrgMove); this
    // route keeps its pre-checks, the step-up validation above, HTTP mapping,
    // post-commit side effects and audit.
    let moved: MoveDeviceOrgResult | undefined;
    try {
      await db.transaction(async (tx) => {
        moved = await moveDeviceOrgInTransaction(tx, {
          deviceId,
          sourceOrgId,
          targetOrgId,
          targetSiteId,
          targetOrgName: targetOrg.name,
          deviceLinkGroupId: device.linkGroupId ?? null,
          acceptCurrencyMismatch,
          actor: { userId: auth.user.id, allowedSiteIds: auth.allowedSiteIds },
          stepUp: grantBinding ? { grantId: stepUpGrant!, binding: grantBinding, auth } : null,
          via: 'generic_move',
        });
      });
    } catch (err) {
      const pgNode = pgErrorNode(err);
      if (
        err instanceof PamDeviceMoveBlockedError
        || (
          // eslint-disable-next-line breeze/no-direct-sqlstate -- Driver node already unwrapped by the existing cause-chain mapper.
          pgNode?.code === '23514'
          && pgNode.constraint_name === 'devices_pam_history_move_guard'
        )
      ) {
        writeRouteAudit(c, {
          orgId: sourceOrgId,
          action: 'device.move_org.failed',
          resourceType: 'device',
          resourceId: deviceId,
          resourceName: device.hostname,
          details: { code: 'PAM_DEVICE_MOVE_BLOCKED' },
        });
        return c.json({
          error: 'Device organization move is blocked because durable PAM lifecycle evidence exists',
          code: 'PAM_DEVICE_MOVE_BLOCKED',
        }, 409);
      }
      // A consumed/invalidated grant is a refusal, not a failure: the
      // transaction rolled back untouched, so answer as the pre-transaction
      // validation would have — no Sentry, no failed-move audit.
      if (err instanceof MoveOrgStepUpConsumedError) {
        return c.json(STEP_UP_REQUIRED_BODY, 403);
      }
      // A currency-policy block is not a failure: the transaction rolled back
      // (device + tickets untouched), so report it and skip Sentry / the
      // failed-move audit.
      if (err instanceof TicketMoveCurrencyBlockedError) {
        return c.json({ error: err.message, code: err.code, details: err.details }, 409);
      }
      // #8181: block-drawn time cannot change org — same rolled-back refusal.
      if (err instanceof TicketMoveHourBlockError) {
        return c.json({ error: err.message, code: err.code, details: err.details }, 409);
      }
      // #5573 W02 — same shape: the transaction rolled back untouched, so this
      // is an explainable refusal, not a failure worth Sentry.
      if (err instanceof TicketServiceError && err.code === 'DELIVERABLE_TICKET_PINNED') {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      // A row deleted under us is a lost race, not an exception: the
      // transaction rolled back, so answer exactly as the pre-transaction
      // existence checks would have — no Sentry, no failed-move audit.
      // The one-way holding-area rule, re-checked under lock by the engine:
      // same answer as the pre-transaction check above, rolled back untouched.
      if (err instanceof DevicePoolMembershipRefusedError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      if (err instanceof OrgVanishedDuringMoveError) {
        return err.which === 'target'
          ? c.json({ error: 'Target organization not found' }, 404)
          : c.json({ error: 'Source organization not found' }, 500);
      }
      console.error(`[devices.moveOrg] failed for ${deviceId}:`, err);
      captureException(err, c);
      // Best-effort audit on the failed cross-tenant move — a rolled-back
      // attempt is security-relevant. Source-org row only since target
      // never committed.
      writeRouteAudit(c, {
        orgId: sourceOrgId,
        action: 'device.move_org.failed',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname,
        details: { sourceOrgId, targetOrgId, sourceSiteId: device.siteId, targetSiteId, error: String(err) },
      });
      return c.json({ error: 'Failed to move device between organizations' }, 500);
    }

    const { updated, linkGroupDissolved, currencyGuard, alertChildRewrite, customFieldRehome } = moved!;

    await expireDiagnosticApprovalsForMovedDevice(deviceId).catch((error) => {
      console.error(`[devices.moveOrg] failed to expire diagnostic access approvals for ${deviceId}:`, error);
    });

    await schedulePeripheralPolicyDevice(deviceId, 'device_org_changed').catch((error) => {
      console.error(`[devices.moveOrg] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
    });

    // Force-close any active WS so the agent reconnects with a fresh
    // handshake on the new org_id. Without this, createAgentWsHandlers
    // (agentWs.ts:1411) closes over the SOURCE-org preValidatedAgent for
    // the lifetime of the connection — every subsequent runWithAgentDbAccess
    // (status, IP history, event publish, command result) writes telemetry
    // under the OLD org's RLS context until the agent eventually reconnects.
    if (updated?.agentId) {
      disconnectAgent(updated.agentId, 4040, 'device moved to a different organization, reconnecting');
    }

    // Audit on BOTH orgs so the move shows up in source and target feeds.
    // (Cast: TS narrows the closure-assigned `let` to its initial null.)
    const acceptedGuard = currencyGuard as MoveCurrencyGuardDetails | null;
    const alertChildCounts = alertChildRewrite as AlertChildOrgRewriteCounts | null;
    const auditDetails = {
      deviceId,
      sourceOrgId,
      targetOrgId,
      sourceSiteId: device.siteId,
      targetSiteId,
      // Device move-org step-up: how admission was proved. 'grant' = a fresh
      // single-use step-up grant was consumed inside the transaction;
      // 'disabled_2fa' = ENABLE_2FA is off on this deployment.
      stepUp: grantBinding ? 'grant' : 'disabled_2fa',
      // #2138/#2308 — a move can dissolve the device's old link group and
      // unlink every remaining member (all guests, when a vm_host group's
      // host moves). Without this the audit trail shows only "device moved"
      // while sibling devices silently lost their grouping.
      ...(device.linkGroupId
        ? { linkGroupId: device.linkGroupId, linkGroupDissolved }
        : {}),
      // #3776 — the caller knowingly left unbilled ticket money in the source
      // currency; record the counts so the stranded snapshots are traceable.
      ...(acceptedGuard?.accepted ? { currencyMismatchAccepted: acceptedGuard } : {}),
      // #4867 — how much alert-axis derived state travelled with the device,
      // and how many correlation groups were held back on purpose. Omitted
      // entirely for a device with no alerts, so a quiet move adds no noise.
      ...(alertChildCounts ? { alertChildRewrite: alertChildCounts } : {}),
      // #3257 W05 — custom-field values re-pointed onto the target org's
      // identically-keyed definitions, and values DROPPED because the target org
      // defines no such key. A dropped value is unrecoverable, so the count is
      // on the record even though the operator was not prompted. Omitted for a
      // device with no values, so a quiet move adds no noise.
      ...(customFieldRehome.rehomed > 0 || customFieldRehome.dropped > 0
        ? { customFieldValues: customFieldRehome }
        : {}),
    } as const;

    writeRouteAudit(c, {
      orgId: sourceOrgId,
      action: 'device.move_org.source',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: updated?.hostname ?? device.hostname,
      details: auditDetails,
    });
    writeRouteAudit(c, {
      orgId: targetOrgId,
      action: 'device.move_org.target',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: updated?.hostname ?? device.hostname,
      details: auditDetails,
    });

    return c.json({
      success: true,
      device: updated ? projectPublicDevice(updated) : null,
    });
  },
);
