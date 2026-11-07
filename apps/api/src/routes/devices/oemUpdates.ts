import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  OEM_CATEGORIES,
  OEM_LANES,
  OEM_UPDATE_MIN_AGENT_VERSION,
  type OemCategory,
  type OemLane,
} from '@breeze/shared';
import { db } from '../../db';
import { deviceHardware, deviceOemUpdateStatus, devices, organizations, partners, sites } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import {
  authMiddleware,
  requireInteractiveSession,
  requireMfa,
  requirePermission,
  requireScope,
  withAuthDbAccessContext,
  type AuthContext,
} from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { deliveryTtlMs } from '../../services/commandOfflinePolicy';
import { resolveApplicability } from '../../services/oemUpdates/applicability';
import {
  assertOemRunAllowedForActor,
  dispatchOemUpdateRun,
  type OemDispatchRefusal,
} from '../../services/oemUpdates/dispatch';
import { deriveOemDisplayState } from '../../services/oemUpdates/displayState';
import { oemUpdatesEnabled } from '../../services/oemUpdates/flags';
import { effectiveTimezoneFrom } from '../../services/oemUpdates/candidates';
import { listOemRuns } from '../../services/oemUpdates/history';
import { oemPolicySide } from '../../services/oemUpdates/policySide';
import { resolveOemUpdatesLinkForDevice } from '../../services/oemUpdates/resolver';
import { isCategoryOpen, SHIPPED_OEM_LANES, type GateState } from '../../services/oemUpdates/toolManifest';
import { trustDenyBody } from '../../services/partnerTrust';
import { TrustDeniedError } from '../../services/partnerTrust.commands';
import { PERMISSIONS, type UserPermissions } from '../../services/permissions';
import { isUnassignedPoolOrgType } from '../../services/unassignedPool/orgType';
import { deviceCommandsInCurrentOrg } from './commandOrgScope';
import {
  canAccessDeviceSite,
  getDeviceWithOrgAndSiteCheck,
  getDeviceWithOrgCheck,
  SITE_ACCESS_DENIED,
} from './helpers';

export const oemUpdatesRoutes = new Hono();

oemUpdatesRoutes.use('*', authMiddleware);

const runSchema = z.object({ reboot: z.enum(['when_finished', 'leave_to_me']) }).strict();

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  offset: z.coerce.number().int().min(0).default(0),
});

const REFUSAL_MESSAGES: Record<OemDispatchRefusal, string> = {
  flag_off: 'Vendor updates are not turned on for this organization.',
  lane_closed: "Vendor updates are not available yet for this device's manufacturer.",
  kill_switch: "Vendor updates are paused for this device's manufacturer.",
  agent_too_old: `This device's agent is too old for vendor updates. Update the agent to ${OEM_UPDATE_MIN_AGENT_VERSION} or later.`,
  not_applicable: 'Vendor updates do not apply to this device.',
  not_supported: "The vendor's tool does not support this model.",
  ephemeral: 'Vendor updates do not run on Quick Support devices.',
  parked: 'Assign this device to an organization before running vendor updates.',
  offline: 'The device is not online. Vendor updates only start on a device that is online now.',
  run_in_flight: 'A vendor update run is already in progress on this device.',
  no_open_categories: 'None of the update types available for this device can run with this reboot choice.',
  device_not_found: 'Device not found',
  decommissioned: 'Cannot send commands to a decommissioned device',
  trust_denied: "This partner's trust status does not allow running commands on devices.",
  cancelled_at_claim: 'The run was cancelled before it reached the device.',
};

function refusalStatus(refusal: OemDispatchRefusal): 403 | 404 | 409 {
  if (refusal === 'device_not_found') return 404;
  if (refusal === 'trust_denied') return 403;
  return 409;
}

/**
 * POST /devices/:id/oem-updates/run — "Run vendor updates" (#11065, spec 4.8).
 *
 * Runs the device maker's own update tool, which can flash a BIOS and restart the
 * machine, so it stays a human action: an interactive session (API keys, MCP
 * grants and AI agents refused), devices:execute and satisfied MFA. No AI tool
 * reaches it (Decision 9). There is no default for the reboot: the tech chooses,
 * and "leave reboot to me" drops bios and firmware, which need a reboot Breeze
 * controls. The reboot itself is queued when the run reports it needs one
 * (services/oemUpdates/results.ts).
 *
 * Registered in selfManagedDbContextRoutes.ts. The seam commits on its own
 * connection and then pushes to the socket, so a request transaction held here
 * would wait on a second pooled connection with the first one pinned (#1105).
 */
oemUpdatesRoutes.post(
  '/:id/oem-updates/run',
  requireScope('organization', 'partner', 'system'),
  requireInteractiveSession(),
  requirePermission(PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action),
  requireMfa(),
  zValidator('json', runSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { reboot } = c.req.valid('json');

    const device = await withAuthDbAccessContext(auth, () => getDeviceWithOrgCheck(c.req.param('id')!, auth));
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    // From here on, the device's canonical id, never the raw path segment.
    const deviceId = device.id;
    if (!canAccessDeviceSite(device, c.get('permissions') as UserPermissions | undefined)) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }

    try {
      await assertOemRunAllowedForActor(deviceId, auth.user.id);
    } catch (error) {
      if (!(error instanceof TrustDeniedError)) throw error;
      return c.json(trustDenyBody({
        allow: false,
        code: error.code,
        capability: 'device_execute',
        reason: error.reason,
      }, false), 403);
    }

    const outcome = await dispatchOemUpdateRun({
      deviceId,
      expectedOrgId: device.orgId,
      trigger: 'on_demand',
      // Everything: the seam narrows to the gates open at send time, so a gate
      // read here could only ever go stale.
      requestedCategories: [...OEM_CATEGORIES],
      blockedUpdateIds: [],
      rebootControlled: reboot === 'when_finished',
      notAfter: new Date(Date.now() + deliveryTtlMs('live_only')),
      occurrenceKey: null,
      actorUserId: auth.user.id,
    });

    if (!outcome.ok) {
      writeRouteAudit(c, {
        orgId: device.orgId,
        action: 'device.oem_updates.run',
        resourceType: 'device',
        resourceId: deviceId,
        resourceName: device.hostname,
        result: 'denied',
        details: { refusal: outcome.refusal, reboot },
      });
      return c.json({
        error: REFUSAL_MESSAGES[outcome.refusal],
        code: outcome.refusal,
        ...(outcome.refusal === 'agent_too_old' ? { minAgentVersion: OEM_UPDATE_MIN_AGENT_VERSION } : {}),
      }, refusalStatus(outcome.refusal));
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: 'device.oem_updates.run',
      resourceType: 'device',
      resourceId: deviceId,
      resourceName: device.hostname,
      details: {
        commandId: outcome.commandId,
        reboot,
        categories: outcome.categories,
        skippedCategories: outcome.skippedCategories,
      },
    });

    return c.json({
      commandId: outcome.commandId,
      categories: outcome.categories,
      skippedCategories: outcome.skippedCategories,
    }, 202);
  },
);

const NO_GATES: Record<OemCategory, GateState> = Object.freeze({
  bios: 'closed',
  firmware: 'closed',
  driver: 'closed',
  application: 'closed',
});

/**
 * What the console may offer: the lane this device would run, or null when a run
 * could not reach it whatever the gates say. Null hides the action, so with the
 * flag off the feature shows nowhere. The seam stays the real check.
 */
async function offeredLane(device: {
  orgId: string;
  id: string;
  status: string;
  osType: string;
  isVirtual: boolean;
  isEphemeral: boolean;
  deviceRole: string;
}): Promise<OemLane | null> {
  if (device.isEphemeral || device.status === 'decommissioned') return null;

  const [org] = await db
    .select({ partnerId: organizations.partnerId, type: organizations.type })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);
  if (!org || isUnassignedPoolOrgType(org.type) || !oemUpdatesEnabled(org.partnerId)) return null;

  const [hardware] = await db
    .select({ manufacturer: deviceHardware.manufacturer, model: deviceHardware.model })
    .from(deviceHardware)
    .where(eq(deviceHardware.deviceId, device.id))
    .limit(1);

  const applicability = resolveApplicability({
    osType: device.osType,
    isVirtual: device.isVirtual,
    deviceRole: device.deviceRole,
    manufacturer: hardware?.manufacturer ?? null,
    model: hardware?.model ?? null,
    enabledLanes: OEM_LANES,
    shippedLanes: SHIPPED_OEM_LANES,
  });
  return applicability.state === 'applicable' ? applicability.lane : null;
}

/**
 * What the device's policy says, for the display state: whether a schedule manages
 * this lane, and where that schedule is. No lane (the flag off, a parked device) means
 * nothing is scheduled, so there is no policy to read. Run Now does not read this:
 * it works with or without a policy, and whether a policy's blocked IDs bind it is
 * still open (its `blockedUpdateIds: []` above).
 *
 * The zone is read on the request's own connection, with the scheduler's rule
 * (`effectiveTimezoneFrom`). An org-scoped caller cannot see the partner row, so a
 * zone set only on the partner falls through to UTC here: a display edge of at most a
 * few hours around a window, accepted so a page load never takes a second pooled
 * connection for the partner read.
 */
async function policySide(device: { id: string; enrolledAt: Date | null }, lane: OemLane | null, now: Date) {
  const deviceId = device.id;
  const unmanaged = { linkEnabled: false, occurrence: null };
  if (!lane) return unmanaged;
  const link = await resolveOemUpdatesLinkForDevice(deviceId);
  if (!link?.settings.enabled || !link.settings.vendors[lane]?.enabled) return unmanaged;
  const [zone] = await db
    .select({
      siteTimezone: sites.timezone,
      orgSettings: organizations.settings,
      partnerTimezone: partners.timezone,
      partnerSettings: partners.settings,
    })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(partners, eq(partners.id, organizations.partnerId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .where(eq(devices.id, deviceId))
    .limit(1);
  const timezone = effectiveTimezoneFrom(zone ?? { siteTimezone: null, orgSettings: null, partnerTimezone: null, partnerSettings: null });
  return oemPolicySide({ deviceId, lane, link, timezone, now, enrolledAt: device.enrolledAt });
}

/** GET /devices/:id/oem-updates/status — the device section and whether to offer the action. */
oemUpdatesRoutes.get(
  '/:id/oem-updates/status',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const device = await getDeviceWithOrgAndSiteCheck(c, c.req.param('id')!, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const [row] = await db
      .select({
        lane: deviceOemUpdateStatus.lane,
        applicability: deviceOemUpdateStatus.applicability,
        toolVersion: deviceOemUpdateStatus.toolVersion,
        lastOutcome: deviceOemUpdateStatus.lastOutcome,
        lastErrorCode: deviceOemUpdateStatus.lastErrorCode,
        lastAttemptAt: deviceOemUpdateStatus.lastAttemptAt,
        lastSuccessAt: deviceOemUpdateStatus.lastSuccessAt,
        installedCount: deviceOemUpdateStatus.installedCount,
        failedCount: deviceOemUpdateStatus.failedCount,
        rebootRequired: deviceOemUpdateStatus.rebootRequired,
        rebootPendingSince: deviceOemUpdateStatus.rebootPendingSince,
        occurrenceKey: deviceOemUpdateStatus.occurrenceKey,
        attempts: deviceOemUpdateStatus.attempts,
        biosVersionBefore: deviceOemUpdateStatus.biosVersionBefore,
        biosVersionAfter: deviceOemUpdateStatus.biosVersionAfter,
        bitlockerAfter: deviceOemUpdateStatus.bitlockerAfter,
        verifiedAt: deviceOemUpdateStatus.verifiedAt,
      })
      .from(deviceOemUpdateStatus)
      .where(eq(deviceOemUpdateStatus.deviceId, device.id))
      .limit(1);

    const lane = await offeredLane(device);
    const gates = lane
      ? Object.fromEntries(OEM_CATEGORIES.map((category): [OemCategory, GateState] => [
          category,
          isCategoryOpen(lane, category, { deviceId: device.id }) ? 'open' : 'closed',
        ])) as Record<OemCategory, GateState>
      : NO_GATES;

    const now = new Date();
    const displayState = deriveOemDisplayState({
      status: row ?? null,
      ...(await policySide(device, lane, now)),
      now,
    });

    // The occurrence key and the attempt count only feed the state above.
    const { occurrenceKey: _occurrenceKey, attempts: _attempts, ...status } = row ?? { occurrenceKey: null, attempts: 0 };
    return c.json({ displayState, lane, status: row ? status : null, gates });
  },
);

/** GET /devices/:id/oem-updates/history — runs from this org's time with the device. */
oemUpdatesRoutes.get(
  '/:id/oem-updates/history',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', historyQuerySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { limit, offset } = c.req.valid('query');
    const device = await getDeviceWithOrgAndSiteCheck(c, c.req.param('id')!, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }
    const scope = await deviceCommandsInCurrentOrg(device);
    return c.json(await listOemRuns({ deviceId: device.id, scope, limit, offset }));
  },
);
