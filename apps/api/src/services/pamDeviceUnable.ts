/**
 * #9517: the agent reports an elevation request it cannot act on.
 *
 * The agent creates a uac_intercept request first and only then looks for a
 * SYSTEM helper in the requester's Windows session to run the PAM flow. When
 * none can be found or started (#8996: an RD Session Host whose helper
 * lifecycle is on-demand, a disconnected session, a helper in crash cooldown),
 * the device will never show the dialog or act on a remote approval. Before
 * this report existed the request stayed 'pending' and a technician could
 * approve something nothing would ever carry out.
 *
 * Recording the report:
 *   - stamps device_unable_at / _reason / _detail on the request, first report
 *     wins (a retried or duplicate report changes nothing);
 *   - closes a still-pending request as 'expired', so neither the web console
 *     (respond CAS on status='pending') nor a phone (decideApprovalRequest's
 *     elevation lock sees it no longer pending) can approve it;
 *   - writes a 'device_unable' audit row, plus an 'expired' row when it closed
 *     the request, matching the stale-request expirer's shape.
 * A request in any other status keeps its status: an auto-approved or denied
 * request was never waiting on a technician, and an approved/actuating one is
 * already in the actuation lifecycle, which reports its own outcome.
 *
 * The caller runs this inside the agent's org-scoped DB context. The request
 * must be a uac_intercept request belonging to the reporting device; any other
 * request (another device's, another org's under RLS, or a tech_jit_admin /
 * ai_tool_action request on this device) is reported as not found.
 */
import { and, eq, isNull } from 'drizzle-orm';

import { db } from '../db';
import { elevationAudit, elevationRequests } from '../db/schema';

/**
 * Categories the agent reports. The column accepts any code matching
 * ^[a-z][a-z_]{0,63}$ so a newer agent does not need a migration, but the
 * route only accepts these, which the web console knows how to label.
 */
export const PAM_DEVICE_UNABLE_REASONS = [
  // The SYSTEM helper that started for the session does not hold the PAM
  // scope, so it cannot run the elevation flow.
  'helper_unavailable',
  // The requester's Windows session cannot host a helper: unresolved, found
  // but not active or connected, or ended while waiting for the helper.
  'session_unavailable',
  // A helper was requested but did not start: crash cooldown, retries
  // exhausted, spawning unavailable on the host, or not ready in time.
  'helper_start_failed',
] as const;

export type PamDeviceUnableReason = (typeof PAM_DEVICE_UNABLE_REASONS)[number];

/** Same bound as elevation_requests_device_unable_chk. */
export const PAM_DEVICE_UNABLE_DETAIL_MAX = 1000;

export type RecordDeviceUnableResult =
  | { kind: 'not_found' }
  | { kind: 'already_reported'; id: string; orgId: string; flowType: string; status: string }
  | {
      kind: 'recorded';
      id: string;
      orgId: string;
      deviceId: string;
      flowType: string;
      priorStatus: string;
      status: string;
      closed: boolean;
    };

/**
 * Collapse control characters (newlines, tabs, NUL, ...) to spaces, trim, and
 * cap the agent's diagnostic text. It is shown in the console as a tooltip and
 * is never interpreted, but it is untrusted device input.
 */
export function sanitizeDeviceUnableDetail(detail: string | undefined | null): string | null {
  if (detail == null) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = detail.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, PAM_DEVICE_UNABLE_DETAIL_MAX);
}

export async function recordElevationDeviceUnable(args: {
  deviceId: string;
  elevationRequestId: string;
  reason: PamDeviceUnableReason;
  detail?: string | null;
}): Promise<RecordDeviceUnableResult> {
  const detail = sanitizeDeviceUnableDetail(args.detail);

  return db.transaction(async (tx) => {
    // Lock the elevation first: every path that touches both an elevation and
    // its mobile approval rows takes the elevation first (#7526). The sibling
    // approval rows are expired by the caller after this commits.
    const [row] = await tx
      .select({
        id: elevationRequests.id,
        orgId: elevationRequests.orgId,
        deviceId: elevationRequests.deviceId,
        flowType: elevationRequests.flowType,
        status: elevationRequests.status,
        deviceUnableAt: elevationRequests.deviceUnableAt,
      })
      .from(elevationRequests)
      .where(and(
        eq(elevationRequests.id, args.elevationRequestId),
        eq(elevationRequests.deviceId, args.deviceId),
        // Only the flow the agent itself creates (POST elevation-requests).
        // A technician's JIT grant or a governed AI tool action on the same
        // device is not the agent's to close.
        eq(elevationRequests.flowType, 'uac_intercept'),
      ))
      .limit(1)
      .for('no key update');

    if (!row) return { kind: 'not_found' as const };
    if (row.deviceUnableAt) {
      return { kind: 'already_reported' as const, id: row.id, orgId: row.orgId, flowType: row.flowType, status: row.status };
    }

    const now = new Date();
    const close = row.status === 'pending';
    const updated = await tx
      .update(elevationRequests)
      .set({
        deviceUnableAt: now,
        deviceUnableReason: args.reason,
        deviceUnableDetail: detail,
        updatedAt: now,
        ...(close ? { status: 'expired' as const, expiredAt: now } : {}),
      })
      .where(and(
        eq(elevationRequests.id, row.id),
        isNull(elevationRequests.deviceUnableAt),
        // Re-check the status this decision was based on, so a request
        // decided between the read and here (impossible under the lock, but
        // cheap) is never closed over a technician's decision.
        eq(elevationRequests.status, row.status),
      ))
      .returning({ id: elevationRequests.id, status: elevationRequests.status });

    if (updated.length === 0) {
      // Unreachable under the row lock above; report what is there rather
      // than claiming a write that did not happen.
      return { kind: 'already_reported' as const, id: row.id, orgId: row.orgId, flowType: row.flowType, status: row.status };
    }

    const auditRows: (typeof elevationAudit.$inferInsert)[] = [
      {
        orgId: row.orgId,
        elevationRequestId: row.id,
        eventType: 'device_unable',
        actor: 'system',
        details: { reason: args.reason, prior_status: row.status, closed: close },
        occurredAt: now,
      },
    ];
    if (close) {
      auditRows.push({
        orgId: row.orgId,
        elevationRequestId: row.id,
        eventType: 'expired',
        actor: 'system',
        details: { cause: 'device_unable', prior_status: row.status },
        occurredAt: now,
      });
    }
    await tx.insert(elevationAudit).values(auditRows);

    return {
      kind: 'recorded' as const,
      id: row.id,
      orgId: row.orgId,
      deviceId: row.deviceId,
      flowType: row.flowType,
      priorStatus: row.status,
      status: updated[0]!.status,
      closed: close,
    };
  });
}
