import { monitorEventLogCollectionWarnings } from '@breeze/shared';
import { hasDbAccessContext, withDbTransaction } from '../db';
import { loadPolicyApplicationProviders } from './eventLogPolicyProviders';
import { captureException } from './sentry';

/**
 * A monitor has no single device: this advisory uses what policies in its
 * ownership scope can collect. The monitor row is already saved when this
 * runs, so a failed policy lookup must never fail the request: it falls back
 * to the built-in provider check and reports the error. The lookup runs in its
 * own savepoint: a failed statement in the request transaction itself would
 * abort it, and the commit would then roll back the monitor that was saved.
 * Outside a DB access context there is no RLS scope to read under, so only the
 * built-in check runs.
 */
export async function policyAwareMonitorEventLogWarnings(row: {
  kind: unknown; condition: unknown; orgId: string | null; partnerId: string | null;
}): Promise<string[]> {
  const children = row.condition && typeof row.condition === 'object'
    ? (row.condition as { children?: unknown }).children : undefined;
  const hasEventLog = row.kind === 'event_log' || (row.kind === 'composite' && Array.isArray(children) &&
    children.some(child => child?.kind === 'event_log'));
  if (!hasEventLog) return [];
  let providers: string[] = [];
  if (hasDbAccessContext()) {
    try {
      providers = await withDbTransaction(() =>
        loadPolicyApplicationProviders({ orgId: row.orgId ?? null, partnerId: row.partnerId ?? null }));
    } catch (err) {
      console.warn('[monitorEventLogWarnings] policy provider lookup failed; using built-in providers only', err);
      captureException(err, undefined, { component: 'monitorEventLogWarnings' });
    }
  }
  return monitorEventLogCollectionWarnings(row.kind, row.condition, providers);
}
