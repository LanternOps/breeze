import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  m365CaPolicies, m365Connections, m365IntuneDevices, m365LicenseSkus, m365SyncState, m365Users,
} from '../../db/schema';
import {
  connectionExecutionSnapshot, type M365ConnectionExecutionSnapshot,
} from '../m365ControlPlane/readActionService';
import type { M365SyncDomain } from '@breeze/shared/m365';
import type { M365SyncJobData } from './types';

/** The entity table each domain's `(graph_id, core_hash, is_stale)` set lives in. */
const DOMAIN_ENTITY_TABLE = {
  users: m365Users,
  intune_devices: m365IntuneDevices,
  ca_policies: m365CaPolicies,
  skus: m365LicenseSkus,
} as const satisfies Partial<Record<M365SyncDomain, unknown>>;

export type FenceReason =
  | 'state_missing' | 'generation_mismatch' | 'connection_not_executable'
  | 'connection_changed' | 'tenant_changed' | 'consent_changed';

export interface SyncRunContext {
  snapshot: M365ConnectionExecutionSnapshot;
  state: {
    intervalSeconds: number;
    continuation: string | null;
    lastCompleteSnapshotAt: Date | null;
    /**
     * NULL means this domain has never completed for this org. Phase B turns
     * that into `backfill: true` for `secure_score` (spec §5.5). Selecting it
     * here rather than re-reading in Phase B keeps the whole decision inside
     * the one short transaction that already holds the row.
     */
    lastSuccessAt: Date | null;
  };
  existing: Map<string, { coreHash: string; isStale: boolean }>;
}

interface StateAndConnection {
  runGeneration: number;
  intervalSeconds: number;
  continuation: string | null;
  lastCompleteSnapshotAt: Date | null;
  lastSuccessAt: Date | null;
  connectionId: string;
  id: string;
  orgId: string | null;
  tenantId: string | null;
  consentGeneration: number;
  status: string;
  permissionManifestVersion: number;
  vaultRef: string | null;
  credentialVersion: string | null;
}

/**
 * The four fencing conditions of spec §5.3, evaluated identically in Phase A and
 * Phase C. Extracted so the two can never disagree — a Phase C that checked one
 * fewer condition than Phase A would be a silent hole exactly in the window the
 * fence exists for.
 */
function fenceReason(row: StateAndConnection | undefined, data: M365SyncJobData): FenceReason | null {
  if (!row) return 'state_missing';
  if (Number(row.runGeneration) !== data.generation) return 'generation_mismatch';
  if (row.connectionId !== data.connectionId || row.id !== data.connectionId) return 'connection_changed';
  if (!connectionExecutionSnapshot(row as never)) return 'connection_not_executable';
  if (row.tenantId !== data.tenantId) return 'tenant_changed';
  if (Number(row.consentGeneration) !== data.consentGeneration) return 'consent_changed';
  return null;
}

function selectStateAndConnection(data: M365SyncJobData, forUpdate: boolean) {
  const query = db.select({
    runGeneration: m365SyncState.runGeneration,
    intervalSeconds: m365SyncState.intervalSeconds,
    continuation: m365SyncState.continuation,
    lastCompleteSnapshotAt: m365SyncState.lastCompleteSnapshotAt,
    lastSuccessAt: m365SyncState.lastSuccessAt,
    connectionId: m365SyncState.connectionId,
    id: m365Connections.id,
    orgId: m365Connections.orgId,
    tenantId: m365Connections.tenantId,
    consentGeneration: m365Connections.consentGeneration,
    status: m365Connections.status,
    permissionManifestVersion: m365Connections.permissionManifestVersion,
    vaultRef: m365Connections.vaultRef,
    credentialVersion: m365Connections.credentialVersion,
  })
    .from(m365SyncState)
    .innerJoin(m365Connections, and(
      eq(m365Connections.id, m365SyncState.connectionId),
      eq(m365Connections.orgId, m365SyncState.orgId),
    ))
    .where(and(
      eq(m365SyncState.orgId, data.orgId),
      eq(m365SyncState.domain, data.domain),
    ))
    .limit(1);
  return forUpdate ? query.for('update') : query;
}

/**
 * PHASE A (spec §5.3): one short system transaction that loads the connection
 * snapshot, the state row, and — only if the run is going ahead — the org's
 * existing `(graph_id, core_hash, is_stale)` set. It COMMITS before the fetch:
 * holding this open across a 110 s Graph call would pin a pooled connection
 * idle-in-transaction, which is the #1105 failure this whole three-phase shape
 * exists to avoid.
 */
export async function loadSyncRunContext(
  data: M365SyncJobData,
): Promise<SyncRunContext | { fenced: FenceReason }> {
  return withSystemDbAccessContext(async () => {
    const rows = await selectStateAndConnection(data, false);
    const row = rows[0] as StateAndConnection | undefined;

    const fenced = fenceReason(row, data);
    if (fenced) return { fenced };

    const snapshot = connectionExecutionSnapshot(row as never);
    if (!snapshot) return { fenced: 'connection_not_executable' as const };

    const table = DOMAIN_ENTITY_TABLE[data.domain as keyof typeof DOMAIN_ENTITY_TABLE];
    const existing = new Map<string, { coreHash: string; isStale: boolean }>();
    if (table) {
      const entityRows = await db.select({
        graphId: (table as { graphId: never }).graphId,
        coreHash: (table as { coreHash: never }).coreHash,
        isStale: (table as { isStale: never }).isStale,
      }).from(table as never).where(eq((table as { orgId: never }).orgId, data.orgId as never));
      for (const entity of entityRows as Array<{ graphId: string; coreHash: string | null; isStale: boolean }>) {
        existing.set(entity.graphId, { coreHash: entity.coreHash ?? '', isStale: Boolean(entity.isStale) });
      }
    }

    return {
      snapshot,
      state: {
        intervalSeconds: Number(row!.intervalSeconds),
        continuation: row!.continuation,
        lastCompleteSnapshotAt: row!.lastCompleteSnapshotAt,
        lastSuccessAt: row!.lastSuccessAt,
      },
      existing,
    };
  }, 'm365SyncPhaseA');
}

/**
 * PHASE C fence (spec §5.3): re-read state + connection `FOR UPDATE` and apply
 * the SAME conditions. This is what catches a disconnect, a rebind, or a
 * re-claim that happened while we were in Graph. Returns the reason, or null to
 * proceed.
 */
export async function assertStillFenced(data: M365SyncJobData): Promise<FenceReason | null> {
  return withSystemDbAccessContext(async () => {
    const rows = await selectStateAndConnection(data, true);
    return fenceReason(rows[0] as StateAndConnection | undefined, data);
  }, 'm365SyncPhaseCFence');
}

/**
 * Clear the lease WITHOUT advancing next_sync_at, so a no-op leaves the row due
 * and the next tick reclaims it with a fresh generation. Guarded on the
 * generation so a late job cannot release a lease a newer claim now holds.
 */
export async function releaseLease(data: M365SyncJobData): Promise<void> {
  await withSystemDbAccessContext(async () => {
    await db.update(m365SyncState)
      .set({ leaseUntil: null, updatedAt: new Date() })
      .where(and(
        eq(m365SyncState.orgId, data.orgId),
        eq(m365SyncState.domain, data.domain),
        eq(m365SyncState.runGeneration, data.generation),
      ));
  }, 'm365SyncReleaseLease');
}

export { DOMAIN_ENTITY_TABLE, sql };
