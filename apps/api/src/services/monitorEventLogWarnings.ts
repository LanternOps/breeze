import {
  isKindShapedRecoveryCondition,
  monitorEventLogCollectionWarnings,
  monitorKindSchema,
  recoveryConditionProblem,
} from '@breeze/shared';
import { hasDbAccessContext, withDbTransaction } from '../db';
import { loadPolicyApplicationProviders } from './eventLogPolicyProviders';
import { captureException } from './sentry';

/**
 * A stored recovery condition saved before validation existed (#10935) can't be
 * evaluated, so the monitor's alerts never auto-resolve. It compiles as stored to
 * keep the monitor editable, which makes this the only place an API caller hears
 * about it.
 */
function unusableRecoveryWarnings(kind: unknown, value: unknown): string[] {
  const parsedKind = monitorKindSchema.safeParse(kind);
  if (!parsedKind.success || !recoveryConditionProblem(parsedKind.data, value, { allowLegacy: true })) return [];
  return ["Recovery condition: this value can't be evaluated, so this monitor's alerts won't auto-resolve. Replace it or set it to null."];
}

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
  kind: unknown; condition: unknown; autoResolveConditions?: unknown; orgId: string | null; partnerId: string | null;
}): Promise<string[]> {
  const children = row.condition && typeof row.condition === 'object'
    ? (row.condition as { children?: unknown }).children : undefined;
  const hasEventLog = row.kind === 'event_log' || (row.kind === 'composite' && Array.isArray(children) &&
    children.some(child => child?.kind === 'event_log'));
  const unusable = unusableRecoveryWarnings(row.kind, row.autoResolveConditions);
  if (!hasEventLog) return unusable;
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
  const warnings = [...monitorEventLogCollectionWarnings(row.kind, row.condition, providers), ...unusable];
  // An uncollected recovery event is worse than an uncollected trigger: the alert
  // opens on its trigger and then never clears. A raw blob isn't this shape; skip it.
  if (row.kind === 'event_log' && isKindShapedRecoveryCondition('event_log', row.autoResolveConditions)) {
    const recovery = monitorEventLogCollectionWarnings(row.kind, row.autoResolveConditions, providers);
    warnings.push(...recovery.map((warning) => `Recovery condition: ${warning}`));
  }
  return warnings;
}
