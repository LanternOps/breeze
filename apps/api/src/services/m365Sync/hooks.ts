import type { M365SyncDomain } from '@breeze/shared/m365';
import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
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
 * Two independent transactions on purpose:
 *  1. For a persisted `intune_devices` run, `reconcileDeviceLinks` (spec §5.6).
 *  2. Always, `upsertPostureRollup` (spec §5.9) — every outcome can change
 *     freshness, including a `needs_consent` one.
 * A link failure must not cost the rollup, so the rollup still runs and the
 * link error is re-thrown afterwards. run.ts logs and swallows any throw from
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

  try {
    await runOutsideDbContext(() => withSystemDbAccessContext(
      () => upsertPostureRollup(ctx.orgId, ctx.tenantId, utcDate(ctx.now)),
      'm365SyncPostureRollup',
    ));
  } catch (rollupError) {
    // Both failed: surface both, or the link failure (often the more
    // actionable one) would vanish behind the rollup's.
    if (linkError !== null) {
      throw new AggregateError([linkError, rollupError], 'link reconciliation and posture rollup both failed');
    }
    throw rollupError;
  }

  if (linkError !== null) throw linkError;
}
