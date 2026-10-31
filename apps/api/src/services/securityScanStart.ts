/**
 * Start a scan on ONE device now (#6263 W05-11): the "Scan now" of
 * POST /security/scan/:deviceId, shared with the AI `security_scan scan`
 * action.
 *
 * #10057 gap 2: a Scan now no longer dispatches a command directly, which let
 * it bypass the org / partner / device concurrency caps (and overlap a scan
 * already running on the device). It writes a `queued` row and enqueues the
 * same locked claim every other origin uses (jobs/securityScanClaim.ts). The
 * row carries what the direct dispatch used to hold in memory:
 *   - `paths` (custom scans);
 *   - `ai_origin`, re-checked against the remote-tools policy at dispatch;
 *   - `caller_mfa_satisfied`: the scan runs under the CALLER's authority, so
 *     the policy's auto-quarantine applies only with a satisfied MFA session
 *     (otherwise detect-only, recorded `manual_no_mfa`);
 *   - `queue_expires_at`: a throttled Scan now waits for a slot at most this
 *     long (SECURITY_SCAN_MANUAL_QUEUE_TTL_MINUTES, 24 h), then expires.
 * The policy settings and YARA rule sets are resolved at the claim, so a scan
 * that waited runs with the policy as it is when it starts.
 *
 * The row commits in its own DB context (`withAuthDbAccessContext`) BEFORE the
 * claim job is enqueued: a job that ran first would not see the row. If the
 * enqueue fails, the sweep pump re-admits queued Scan now rows each tick
 * (jobs/securityScanSweepPump.ts), so the scan is delayed, not lost.
 *
 * A device with a Scan now still waiting for dispatch refuses a second one
 * (409 with the waiting scan's id) rather than stacking duplicates.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { AiOriginRef } from '@breeze/shared';
import { db } from '../db';
import { deviceCommands, devices, securityScans } from '../db/schema';
import { withAuthDbAccessContext, type AuthContext } from '../middleware/auth';
import { checkAiRemoteToolsPolicy } from './aiRemoteToolsPolicy';
import { cancelDeviceCommands } from './commandCancelPropagation';
import { CommandTypes } from './commandQueue';
import { canAccessSite, getUserPermissions } from './permissions';
import { manualScanQueueTtlMinutes } from './securityScanSweepConfig';
import { captureException } from './sentry';

export type DeviceScanType = 'quick' | 'full' | 'custom';

export type StartedDeviceScan = {
  id: string;
  deviceId: string;
  deviceName: string;
  orgId: string;
  scanType: DeviceScanType;
  status: 'queued';
  startedAt: string;
  queueExpiresAt: string;
};

export type StartDeviceScanResult =
  | { ok: true; scan: StartedDeviceScan }
  | { ok: false; status: 403 | 404; error: string }
  | { ok: false; status: 409; error: string; scanId: string };

export async function startDeviceScan(
  auth: AuthContext,
  input: {
    deviceId: string;
    scanType: DeviceScanType;
    paths?: string[];
    /** `hasSatisfiedMfa(auth)` as the caller computes it. */
    mfaSatisfied: boolean;
    aiOrigin?: AiOriginRef;
  },
): Promise<StartDeviceScanResult> {
  const outcome = await withAuthDbAccessContext(auth, () => createQueuedScan(auth, input));
  if (!outcome.ok) return outcome;

  // Committed. Enqueue the claim; a failure here only costs latency.
  try {
    // Dynamic: the queue module pulls the claim and the agent socket graph,
    // which the HTTP route modules importing this service must not load.
    const { enqueueSecurityScan } = await import('../jobs/securityScanJobs');
    await enqueueSecurityScan(outcome.scan.id);
  } catch (error) {
    console.warn('[securityScanStart] claim enqueue failed; the sweep pump re-admits the queued scan', {
      scanId: outcome.scan.id,
      error: error instanceof Error ? error.message : String(error),
    });
    captureException(error instanceof Error ? error : new Error(String(error)));
  }
  return outcome;
}

async function createQueuedScan(
  auth: AuthContext,
  input: Parameters<typeof startDeviceScan>[1],
): Promise<StartDeviceScanResult> {
  const orgCondition = auth.orgCondition(devices.orgId);
  const conditions = [eq(devices.id, input.deviceId)];
  if (orgCondition) conditions.push(orgCondition);

  const [device] = await db
    .select({ id: devices.id, hostname: devices.hostname, orgId: devices.orgId, siteId: devices.siteId })
    .from(devices)
    .where(and(...conditions))
    .limit(1);
  if (!device) return { ok: false, status: 404, error: 'Device not found' };

  // Site-scope gate: a caller restricted via `allowedSiteIds` must not touch a
  // device in a site it cannot access. RLS does not defend the site axis.
  const userPerms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined,
  });
  if (userPerms?.allowedSiteIds) {
    if (typeof device.siteId !== 'string' || !canAccessSite(userPerms, device.siteId)) {
      return { ok: false, status: 403, error: 'Access to this site denied' };
    }
  }

  if (input.aiOrigin) {
    const decision = await checkAiRemoteToolsPolicy(device.id, CommandTypes.SECURITY_SCAN);
    if (!decision.allowed) return { ok: false, status: 403, error: decision.error };
  }

  // One undispatched Scan now per device: a second click (or an AI retry) would
  // only wait behind the first for the same device slot.
  const [waiting] = await db
    .select({ id: securityScans.id })
    .from(securityScans)
    .where(
      and(
        eq(securityScans.deviceId, device.id),
        eq(securityScans.status, 'queued'),
        isNull(securityScans.sweepId),
        isNull(securityScans.commandId),
        isNotNull(securityScans.callerMfaSatisfied),
      ),
    )
    .limit(1);
  if (waiting) return { ok: false, status: 409, error: 'A scan is already queued for this device', scanId: waiting.id };

  const scanId = randomUUID();
  const startedAt = new Date();
  const queueExpiresAt = new Date(startedAt.getTime() + manualScanQueueTtlMinutes() * 60_000);
  await db.insert(securityScans).values({
    id: scanId,
    deviceId: device.id,
    orgId: device.orgId,
    scanType: input.scanType,
    status: 'queued',
    startedAt,
    initiatedBy: auth.user.id,
    paths: input.scanType === 'custom' && input.paths && input.paths.length > 0 ? input.paths : null,
    aiOrigin: input.aiOrigin ?? null,
    callerMfaSatisfied: input.mfaSatisfied,
    queueExpiresAt,
    commandId: null,
  });

  return {
    ok: true,
    scan: {
      id: scanId,
      deviceId: device.id,
      deviceName: device.hostname,
      orgId: device.orgId,
      scanType: input.scanType,
      status: 'queued',
      startedAt: startedAt.toISOString(),
      queueExpiresAt: queueExpiresAt.toISOString(),
    },
  };
}

export type CancelDeviceScanResult =
  | { ok: true; scan: { id: string; status: 'cancelled' }; orgId: string }
  | { ok: false; status: 403 | 404; error: string }
  | { ok: false; status: 409; code: 'SWEEP_SCAN' | 'SCAN_RUNNING' | 'SCAN_FINISHED'; error: string };

/**
 * Cancel one scheduled or manual scan (#10057 gap 2), in its own caller-scoped
 * transaction:
 *   1. still waiting for a slot (`queued`, no command): CAS it to `cancelled`.
 *      The claim takes the row FOR UPDATE, so this either wins (the claim then
 *      sees a non-queued row and skips) or waits for the claim and matches
 *      nothing;
 *   2. dispatched but not delivered (command `pending`): cancel the command
 *      through `cancelDeviceCommands`, whose security_scan hook flips the row;
 *   3. otherwise the agent has it (409 SCAN_RUNNING: the agent has no scan
 *      cancel; its deadline bounds it) or it has finished (409 SCAN_FINISHED).
 * Sweep scans are cancelled through their sweep.
 */
export async function cancelDeviceScan(auth: AuthContext, scanId: string): Promise<CancelDeviceScanResult> {
  return withAuthDbAccessContext(auth, async (): Promise<CancelDeviceScanResult> => {
    const orgCondition = auth.orgCondition(securityScans.orgId);
    const [scan] = await db
      .select({
        id: securityScans.id,
        orgId: securityScans.orgId,
        deviceId: securityScans.deviceId,
        siteId: devices.siteId,
        sweepId: securityScans.sweepId,
      })
      .from(securityScans)
      .innerJoin(devices, eq(devices.id, securityScans.deviceId))
      .where(orgCondition ? and(eq(securityScans.id, scanId), orgCondition) : eq(securityScans.id, scanId))
      .limit(1);
    if (!scan) return { ok: false, status: 404, error: 'Scan not found' };

    const userPerms = await getUserPermissions(auth.user.id, {
      partnerId: auth.partnerId || undefined,
      orgId: auth.orgId || undefined,
    });
    if (userPerms?.allowedSiteIds) {
      if (typeof scan.siteId !== 'string' || !canAccessSite(userPerms, scan.siteId)) {
        return { ok: false, status: 403, error: 'Access to this site denied' };
      }
    }
    if (scan.sweepId) {
      return { ok: false, status: 409, code: 'SWEEP_SCAN', error: 'This scan belongs to a sweep; cancel the sweep instead' };
    }

    const cancelled = { ok: true as const, scan: { id: scan.id, status: 'cancelled' as const }, orgId: scan.orgId };
    const flipped = await db
      .update(securityScans)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(and(eq(securityScans.id, scan.id), eq(securityScans.status, 'queued'), isNull(securityScans.commandId)))
      .returning({ id: securityScans.id });
    if (flipped.length === 1) return cancelled;

    // A fresh statement sees what a concurrent claim committed.
    const [current] = await db
      .select({ status: securityScans.status, commandId: securityScans.commandId })
      .from(securityScans)
      .where(eq(securityScans.id, scan.id))
      .limit(1);
    if (!current || !['queued', 'running'].includes(current.status)) {
      return { ok: false, status: 409, code: 'SCAN_FINISHED', error: 'The scan has already finished' };
    }
    if (current.commandId) {
      const commands = await cancelDeviceCommands({
        result: { status: 'cancelled', reason: 'user_cancelled', cancelledBy: auth.user.id },
        where: and(
          eq(deviceCommands.id, current.commandId),
          eq(deviceCommands.deviceId, scan.deviceId),
          inArray(deviceCommands.status, ['pending']),
        )!,
      });
      if (commands.length > 0) return cancelled;
    }
    return {
      ok: false,
      status: 409,
      code: 'SCAN_RUNNING',
      error: 'The scan is already running on the device and cannot be cancelled',
    };
  });
}
