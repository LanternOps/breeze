import { sql } from 'drizzle-orm';
import type { WakeStatusSnapshot } from '@breeze/shared';
import { db } from '../db';
import { deviceWakeStatus } from '../db/schema/deviceWake';

export interface IngestWakeStatusArgs {
  deviceId: string;
  orgId: string;
  agentVersion: string | null;
  snapshot: WakeStatusSnapshot;
  receivedAt: Date;
}

/**
 * Stores the agent's read-only Wake-on-LAN readiness snapshot (#10838).
 *
 * One upsert on `device_wake_status` (PK device_id). `received_at` is server
 * time; `collected_at` is stored as the agent sent it and never used for
 * ordering. A fingerprint change means the hardware or configuration moved, so
 * the consecutive-timeout counter restarts. `proof_fingerprint` and
 * `last_came_online_at` belong to the wake-attempt sweep and are never touched.
 */
export async function ingestWakeStatusSnapshot(args: IngestWakeStatusArgs): Promise<{ accepted: boolean }> {
  const { snapshot: s, receivedAt } = args;
  const row = {
    deviceId: args.deviceId,
    orgId: args.orgId,
    readinessState: s.readinessState,
    reasonCodes: s.reasonCodes,
    vendor: s.vendor,
    fingerprint: s.fingerprint,
    agentVersion: args.agentVersion,
    collectedAt: new Date(s.collectedAt),
    receivedAt,
    lastApplyAt: s.lastApplyAt ? new Date(s.lastApplyAt) : null,
    lastApplyResult: s.lastApplyResult,
    lastWiredAdapterSeenAt: s.lastWiredAdapterSeenAt ? new Date(s.lastWiredAdapterSeenAt) : null,
    details: s.details,
    updatedAt: receivedAt,
  };
  const { deviceId: _deviceId, orgId: _orgId, ...update } = row;
  await db.insert(deviceWakeStatus).values(row).onConflictDoUpdate({
    target: deviceWakeStatus.deviceId,
    set: {
      ...update,
      consecutiveTimeouts: sql`CASE WHEN ${deviceWakeStatus.fingerprint} IS DISTINCT FROM excluded.fingerprint THEN 0 ELSE ${deviceWakeStatus.consecutiveTimeouts} END`,
    },
  });
  return { accepted: true };
}
