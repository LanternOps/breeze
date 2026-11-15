import type { M365SyncDomain } from '@breeze/shared/m365';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { captureEntraDirectoryRun } from '../portalDirectory/entraCapture';
import { reconcileDeviceLinks } from './links';
import { recordM365SyncLinkAmbiguous } from './metrics';
import { upsertPostureRollup } from './rollup';
import type { DomainPersistResult, M365SyncOutcome, PersistContext } from './types';

/** UTC calendar day of the run — the key of `m365_posture_rollups`. */
function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Called by run.ts once per domain immediately AFTER its completion
 * transaction has COMMITTED, with no DB context held. That ordering is what
 * lets the rollup read this run's own `last_counts` from a durable row, and it
 * is why each step opens its OWN short system context (a cross-org worker
 * write; every statement inside is keyed on the org explicitly).
 *
 * Independent transactions on purpose:
 *  1. For a persisted `intune_devices` run, `reconcileDeviceLinks` (spec §5.6).
 *  2. Always, `upsertPostureRollup` (spec §5.9) — every outcome can change
 *     freshness, including a `needs_consent` one.
 *  3. For a `users` run, LAST, the portal directory capture (W8 D4).
 * A link failure must not cost the rollup, and neither may cost the capture,
 * so every step still runs and the earlier error is re-thrown afterwards. run.ts logs and swallows any throw from
 * here: a committed run with a stale rollup is repaired by the next run of any
 * domain in the org, whereas a run that un-completed because a rollup query was
 * slow would never make progress at all.
 */
export async function afterDomainPersisted(
  ctx: PersistContext & {
    domain: M365SyncDomain;
    outcome: M365SyncOutcome;
    persisted: DomainPersistResult;
  },
): Promise<void> {
  let linkError: unknown = null;
  if (ctx.domain === 'intune_devices' && (ctx.outcome === 'success' || ctx.outcome === 'partial')) {
    try {
      const links = await runOutsideDbContext(() => withSystemDbAccessContext(
        () => reconcileDeviceLinks(ctx.orgId),
        'm365SyncDeviceLinks',
      ));
      // One numeric argument: m365_sync_link_ambiguous_total carries no orgId
      // label, by contract (cardinality).
      if (links.ambiguous > 0) recordM365SyncLinkAmbiguous(links.ambiguous);
    } catch (error) {
      linkError = error;
    }
  }

  let rollupError: unknown = null;
  try {
    await runOutsideDbContext(() => withSystemDbAccessContext(
      () => upsertPostureRollup(ctx.orgId, ctx.tenantId, utcDate(ctx.now)),
      'm365SyncPostureRollup',
    ));
  } catch (error) {
    rollupError = error;
  }

  // 3. LAST, for every terminal `users` run: the portal directory capture
  //    (W8 D4). It runs under this run's generation fence — the only moment
  //    m365_users is exactly one snapshot — and after the rollup, so a slow
  //    capture (bounded by its 5 s lock timeout) can never cost the rollup.
  //    It never throws by contract; the catch keeps that true here too.
  if (ctx.domain === 'users') {
    try {
      await captureEntraDirectoryRun({
        orgId: ctx.orgId,
        tenantId: ctx.tenantId,
        connectionId: ctx.connectionId,
        generation: ctx.generation,
        now: ctx.now,
        persisted: ctx.persisted,
      });
    } catch (error) {
      console.error('[m365-sync] portal directory capture threw', {
        orgId: ctx.orgId,
        generation: ctx.generation,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  if (rollupError !== null) {
    // Both failed: surface both, or the link failure (often the more
    // actionable one) would vanish behind the rollup's.
    if (linkError !== null) {
      throw new AggregateError([linkError, rollupError], 'link reconciliation and posture rollup both failed');
    }
    throw rollupError;
  }

  if (linkError !== null) throw linkError;
}
