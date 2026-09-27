/**
 * Which connection an accounting job runs against (Xero W01, spec "Jobs carry
 * connectionId"). ONE place for the drop rules both accounting workers share.
 *
 * A job's destination is NEVER reinterpreted: a job carrying a connectionId runs
 * against that row or not at all; a legacy job (enqueued before W01, no
 * connectionId) was QuickBooks work by construction and runs only against a
 * QuickBooks active connection. Payment jobs bind through their outbox mapping
 * row instead of a payload field (plan preamble item 4).
 */
import type { AccountingConnection, DbExecutor } from '../services/accounting/accountingConnectionService';
import {
  getConnectionById,
  getConnectionForMapping,
  resolveActiveConnection,
} from '../services/accounting/accountingConnectionService';
import { LEGACY_UNTARGETED_JOB_PROVIDER, providerSupports } from '../services/accounting/providerRegistry';
import type { ConnectionTarget } from '../services/accounting/accountingMappingService';
import type { AccountingCapability } from '../services/accounting/types';

export type JobDropReason = 'connection_gone' | 'legacy_non_quickbooks' | 'capability_unavailable';
export type JobConnectionResolution =
  | { kind: 'ok'; conn: AccountingConnection; target: ConnectionTarget }
  | { kind: 'absent'; conn: AccountingConnection | null }
  | { kind: 'drop'; reason: JobDropReason };

// Exclusive on purpose: a job resolves against EITHER its mapping row OR its
// connectionId OR neither (legacy, pre-W01) — never both. Admitting both at
// once let the function silently prefer mappingId, masking a caller bug.
export type JobConnectionRef =
  & { partnerId: string }
  & (
    | { mappingId: string; connectionId?: never }
    | { connectionId: string; mappingId?: never }
    | { connectionId?: undefined; mappingId?: undefined }
  );

export async function resolveJobConnection(
  job: JobConnectionRef,
  capability: AccountingCapability,
  dbc: DbExecutor,
): Promise<JobConnectionResolution> {
  if (job.mappingId !== undefined) {
    const conn = await getConnectionForMapping(dbc, job.mappingId, job.partnerId);
    if (!conn || conn.status !== 'connected') return { kind: 'absent', conn };
    if (!providerSupports(conn.provider, capability)) return { kind: 'drop', reason: 'capability_unavailable' };
    return { kind: 'ok', conn, target: { connectionId: conn.id } };
  }
  if (job.connectionId !== undefined) {
    const conn = await getConnectionById(dbc, job.connectionId, job.partnerId);
    if (!conn) return { kind: 'drop', reason: 'connection_gone' };
    if (!providerSupports(conn.provider, capability)) return { kind: 'drop', reason: 'capability_unavailable' };
    if (conn.status !== 'connected') return { kind: 'absent', conn };
    return { kind: 'ok', conn, target: { connectionId: conn.id } };
  }
  const active = await resolveActiveConnection(dbc, job.partnerId);
  if (!active) return { kind: 'absent', conn: null };
  if (active.provider !== LEGACY_UNTARGETED_JOB_PROVIDER) return { kind: 'drop', reason: 'legacy_non_quickbooks' };
  if (active.status !== 'connected') return { kind: 'absent', conn: active };
  return { kind: 'ok', conn: active, target: { connectionId: active.id } };
}

export function logJobDrop(
  queue: string,
  jobType: string,
  data: { partnerId: string; connectionId?: string },
  reason: JobDropReason,
): void {
  console.log(`[${queue}] job dropped`, `reason=${reason}`, `type=${jobType}`,
    `partnerId=${data.partnerId}`, `connectionId=${data.connectionId ?? 'legacy'}`);
}
