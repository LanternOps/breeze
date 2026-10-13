import { and, eq, gt, inArray, type SQL } from 'drizzle-orm';
import type { EdrIsolationState, EdrOsPlatform, EdrVendorKind } from '@breeze/shared';
import { db } from '../../db';
import { edrActions, edrDetections, edrEndpoints } from '../../db/schema';
import { EdrActionError } from './actionErrors';
import type { EdrActionTargetInput } from './actions';

/** A same-target, same-action success/submission this recent refuses a re-request (Open Decision 9). */
export const EDR_ACTION_COOLDOWN_MS = 60_000;

export interface ResolvedEdrActionTarget {
  orgId: string;
  partnerId: string;
  connectionId: string;
  /** Live tenant id; null only on a tombstoned detection (then `detached`). */
  tenantId: string;
  breezeDeviceId: string | null;
  endpoint: {
    id: string;
    vendorEndpointId: string;
    osPlatform: EdrOsPlatform;
    isolationState: EdrIsolationState;
    online: boolean | null;
  } | null;
  detection: { id: string; vendorDetectionId: string; vendorKind: EdrVendorKind } | null;
  detached: boolean;
  recentlyRequested: boolean;
}

const ENDPOINT_COLUMNS = {
  id: edrEndpoints.id,
  orgId: edrEndpoints.orgId,
  partnerId: edrEndpoints.partnerId,
  connectionId: edrEndpoints.connectionId,
  tenantId: edrEndpoints.tenantId,
  breezeDeviceId: edrEndpoints.breezeDeviceId,
  vendorEndpointId: edrEndpoints.vendorEndpointId,
  osPlatform: edrEndpoints.osPlatform,
  isolationState: edrEndpoints.isolationState,
  online: edrEndpoints.online,
} as const;

type EndpointRow = {
  id: string; orgId: string; partnerId: string; connectionId: string; tenantId: string;
  breezeDeviceId: string | null; vendorEndpointId: string; osPlatform: EdrOsPlatform;
  isolationState: EdrIsolationState; online: boolean | null;
};

async function recentlyRequested(where: SQL, action: string, now: Date): Promise<boolean> {
  const rows = await db
    .select({ id: edrActions.id })
    .from(edrActions)
    .where(and(
      where,
      eq(edrActions.action, action as typeof edrActions.$inferSelect.action),
      inArray(edrActions.status, ['succeeded', 'submitted']),
      gt(edrActions.requestedAt, new Date(now.getTime() - EDR_ACTION_COOLDOWN_MS)),
    ))
    .limit(1);
  return rows.length > 0;
}

function fromEndpoint(row: EndpointRow) {
  return {
    orgId: row.orgId,
    partnerId: row.partnerId,
    connectionId: row.connectionId,
    tenantId: row.tenantId,
    breezeDeviceId: row.breezeDeviceId,
    endpoint: {
      id: row.id,
      vendorEndpointId: row.vendorEndpointId,
      osPlatform: row.osPlatform,
      isolationState: row.isolationState,
      online: row.online,
    },
    detection: null,
    detached: false,
  };
}

/**
 * Step 2 of `dispatchEdrAction`: read the target under the CALLER's RLS
 * context — that read is the authorization. Must run inside the caller's
 * `withDbAccessContext`. Returns null when nothing is visible ("does not
 * exist" and "not yours" are indistinguishable).
 */
export async function resolveEdrActionTarget(
  input: EdrActionTargetInput,
  now: Date,
): Promise<ResolvedEdrActionTarget | null> {
  if (input.kind === 'endpoint' || input.kind === 'device') {
    const where = input.kind === 'endpoint'
      ? eq(edrEndpoints.id, input.endpointId)
      : and(
        eq(edrEndpoints.breezeDeviceId, input.deviceId),
        input.connectionId ? eq(edrEndpoints.connectionId, input.connectionId) : undefined,
      );
    const rows = await db.select(ENDPOINT_COLUMNS).from(edrEndpoints).where(where).limit(2) as EndpointRow[];
    if (rows.length === 0) return null;
    if (rows.length > 1) {
      throw new EdrActionError('target_not_found', 404,
        'Device is linked to more than one EDR connection; pass connectionId');
    }
    const row = rows[0]!;
    return {
      ...fromEndpoint(row),
      recentlyRequested: await recentlyRequested(eq(edrActions.endpointId, row.id), input.action, now),
    };
  }

  const [d] = await db
    .select({
      id: edrDetections.id,
      orgId: edrDetections.orgId,
      partnerId: edrDetections.partnerId,
      connectionId: edrDetections.connectionId,
      tenantId: edrDetections.tenantId,
      endpointId: edrDetections.endpointId,
      breezeDeviceId: edrDetections.breezeDeviceId,
      vendorDetectionId: edrDetections.vendorDetectionId,
      vendorKind: edrDetections.vendorKind,
      detachedAt: edrDetections.detachedAt,
    })
    .from(edrDetections)
    .where(eq(edrDetections.id, input.detectionId))
    .limit(1);
  if (!d) return null;
  const detached = d.detachedAt !== null || d.tenantId === null;
  let endpoint: ResolvedEdrActionTarget['endpoint'] = null;
  if (!detached && d.endpointId) {
    const [e] = await db.select(ENDPOINT_COLUMNS).from(edrEndpoints)
      .where(eq(edrEndpoints.id, d.endpointId)).limit(1) as EndpointRow[];
    if (e) endpoint = fromEndpoint(e).endpoint;
  }
  return {
    orgId: d.orgId,
    partnerId: d.partnerId,
    connectionId: d.connectionId,
    tenantId: d.tenantId ?? '',
    breezeDeviceId: d.breezeDeviceId,
    // The endpoint only informs the capability facts. Detection-action rows
    // never carry endpoint_id: the in-flight index is per (endpoint, action),
    // so two detections on one endpoint must not collide.
    endpoint,
    detection: { id: d.id, vendorDetectionId: d.vendorDetectionId, vendorKind: d.vendorKind },
    detached,
    recentlyRequested: detached
      ? false
      : await recentlyRequested(eq(edrActions.detectionId, d.id), input.action, now),
  };
}
