import { sql } from 'drizzle-orm';
import type { TopologyScope } from '@breeze/shared';
import { topologyGloballyDisabled } from '../config/env';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { captureException } from '../services/sentry';
import { resolveTopologyFlags, withResolvedTopologyFlags, type TopologyFlags } from '../services/topology/flags';
import { importLegacyTopologySite } from '../services/topology/legacyImport';
import { LEGACY_IMPORT_BOOTSTRAP_KEY, TopologyCaptureIncompleteError } from '../services/topology/legacyImportState';
import { retryableTopologyTransaction, transientTopologyInfrastructureError } from '../services/topology/transactionRetry';

/**
 * Automatic first-snapshot bootstrap (#7557).
 *
 * Site readiness is the `legacyImport` checkpoint in
 * `topology_site_state.effective_settings`, which only `importLegacyTopologySite`
 * creates. The repair tick only drains sites that ALREADY have a checkpoint, so
 * without this pass a site whose org turned materialization on — or a site
 * created afterwards — would sit on "Building the topology map" forever.
 *
 * Each pass stages at most TOPOLOGY_BOOTSTRAP_SITE_BATCH sites; the import's own
 * first drain batch runs in the same transaction and the repair tick finishes
 * the rest. Concurrency:
 *  - Flags are resolved in the ONE set-based candidate query (partners/orgs
 *    joined in a system context) BEFORE any import transaction opens, and the
 *    import runs under `withResolvedTopologyFlags`, so nothing in it can take
 *    the partner-axis escape to a second pooled connection while holding the
 *    `topology_site_state` row lock (the 2026-09-22 US wedge shape).
 *  - Each site imports in its own `runOutsideDbContext(withSystemDbAccessContext)`
 *    transaction. The import locks exactly one `topology_site_state` row, so it
 *    trivially respects the ascending-site lock order (collectionAuthority.ts).
 *  - 40P01/40001/55P03 retry the WHOLE transaction; a site still contended
 *    after three attempts, or hit by a database/driver fault, is deferred (a
 *    short in-process back-off, rate-limited alert) — never marked failed.
 *  - A concurrent import of the same site (another replica, the operator
 *    script) serializes on the state row lock; the loser finds the checkpoint
 *    and only drains.
 * Fairness: a site-specific failure writes a durable back-off marker
 * (LEGACY_IMPORT_BOOTSTRAP_KEY) that the candidate query honours, and a
 * deferred site is excluded in-process for SOFT_BACKOFF_MS, so neither can
 * occupy the batch every pass; candidates otherwise rotate by
 * least-recently-touched state row. A pass stops starting imports after
 * PASS_BUDGET_MS so one large site cannot hold the shared tick for long. Capture being incomplete is deployment-wide
 * ("not yet eligible"), so it backs the whole pass off without marking sites.
 */
export const TOPOLOGY_BOOTSTRAP_INTERVAL_MS = 15_000;
export const TOPOLOGY_BOOTSTRAP_SITE_BATCH = 3;
const IMPORT_EVENT_BATCH = 200;
const CAPTURE_BACKOFF_MS = 5 * 60_000;
const CAPTURE_ALERT_INTERVAL_MS = 30 * 60_000;
const FAILURE_BACKOFF_BASE_SECONDS = 15 * 60;
const FAILURE_BACKOFF_MAX_SECONDS = 6 * 60 * 60;
const SOFT_BACKOFF_MS = 2 * 60_000;
const DEFERRED_ALERT_INTERVAL_MS = 15 * 60_000;
export const TOPOLOGY_BOOTSTRAP_PASS_BUDGET_MS = 10_000;

let captureBlockedUntil = 0;
let lastCaptureAlertAt = 0;
let lastDeferredAlertAt = 0;
/** siteId -> epoch ms before which this process will not select it again. */
const deferredUntil = new Map<string, number>();

export function resetTopologyBootstrapStateForTests(): void {
  captureBlockedUntil = 0;
  lastCaptureAlertAt = 0;
  lastDeferredAlertAt = 0;
  deferredUntil.clear();
}

function defer(siteId: string, error?: unknown): void {
  deferredUntil.set(siteId, Date.now() + SOFT_BACKOFF_MS);
  if (error === undefined || Date.now() - lastDeferredAlertAt < DEFERRED_ALERT_INTERVAL_MS) return;
  lastDeferredAlertAt = Date.now();
  captureException(error, undefined, { siteId, stage: 'topology_bootstrap_deferred' });
}

function deferredSiteIds(): string[] {
  const now = Date.now();
  for (const [siteId, until] of deferredUntil) if (until <= now) deferredUntil.delete(siteId);
  return [...deferredUntil.keys()];
}

type CandidateRow = { org_id: string; site_id: string; org_settings: unknown; partner_settings: unknown };
type SiteOutcome = { kind: 'imported' | 'failed' } | { kind: 'deferred'; error: unknown } | { kind: 'capture_incomplete'; missing: readonly string[] };

/** Mirrors `flagOverrides` in flags.ts for ONE flag: only a boolean inside an
 * object-valued `topologyFeatureFlags` counts. The TS resolver re-checks every
 * row, so drift here can only under-select, never import a disabled site. */
const materializationOverride = (settings: ReturnType<typeof sql.raw>) => sql`CASE
  WHEN jsonb_typeof(${settings}->'topologyFeatureFlags')='object'
   AND jsonb_typeof(${settings}->'topologyFeatureFlags'->'materialization')='boolean'
  THEN (${settings}->'topologyFeatureFlags'->>'materialization')::boolean END`;

function selectCandidates(excludedSiteIds: readonly string[]) {
  const bootstrap = sql`st.effective_settings->(${LEGACY_IMPORT_BOOTSTRAP_KEY}::text)`;
  return runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute<CandidateRow>(sql`
    SELECT si.org_id, si.id AS site_id, o.settings AS org_settings, p.settings AS partner_settings
    FROM sites si
    JOIN organizations o ON o.id = si.org_id
    JOIN partners p ON p.id = o.partner_id
    LEFT JOIN topology_site_state st ON st.org_id = si.org_id AND st.site_id = si.id
    WHERE o.deleted_at IS NULL
      AND o.status NOT IN ('offboarding', 'merging', 'archived', 'purging', 'churned')
      AND p.status NOT IN ('suspended', 'churned', 'offboarding')
      AND COALESCE(${materializationOverride(sql.raw('o.settings'))}, ${materializationOverride(sql.raw('p.settings'))}, false)
      AND (st.site_id IS NULL OR (
        st.effective_settings->'legacyImport' IS NULL
        -- COALESCE: with no marker every operand is NULL, and NOT NULL would
        -- silently drop exactly the sites this pass exists for.
        -- CASE (not AND) guarantees the cast only sees a number.
        AND NOT COALESCE(CASE WHEN jsonb_typeof(${bootstrap}->'retryAfter')='number'
          THEN (${bootstrap}->>'retryAfter')::double precision > extract(epoch FROM now()) END, false)))
      AND si.id NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(excludedSiteIds)}::jsonb)::uuid)
    ORDER BY st.updated_at ASC NULLS FIRST, si.id
    LIMIT ${TOPOLOGY_BOOTSTRAP_SITE_BATCH}
  `), 'topology bootstrap candidates'));
}

/** Durable, per-site exponential back-off (15 min doubling to 6 h). Its own
 * short transaction; it never touches a site that has since been staged. */
export function recordBootstrapFailure(scope: TopologyScope) {
  const previous = sql`topology_site_state.effective_settings->(${LEGACY_IMPORT_BOOTSTRAP_KEY}::text)`;
  const attempts = sql`(CASE WHEN jsonb_typeof(${previous}->'attempts')='number' THEN LEAST((${previous}->>'attempts')::numeric, 1000000)::int ELSE 0 END + 1)`;
  const marker = (n: ReturnType<typeof sql>) => sql`jsonb_build_object(${LEGACY_IMPORT_BOOTSTRAP_KEY}::text, jsonb_build_object(
    'status', 'failed', 'attempts', ${n}, 'failedAt', to_jsonb(now()),
    'retryAfter', extract(epoch FROM now()) + LEAST(${FAILURE_BACKOFF_BASE_SECONDS}::double precision * power(2, LEAST(${n} - 1, 10)), ${FAILURE_BACKOFF_MAX_SECONDS}::double precision)))`;
  return runOutsideDbContext(() => withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO topology_site_state (org_id, site_id, effective_settings)
    VALUES (${scope.orgId}::uuid, ${scope.siteId}::uuid, ${marker(sql`1`)})
    ON CONFLICT (org_id, site_id) DO UPDATE
      SET effective_settings = topology_site_state.effective_settings || ${marker(attempts)}, updated_at = now()
      WHERE topology_site_state.effective_settings->'legacyImport' IS NULL
  `), 'topology bootstrap failure marker'));
}

async function bootstrapSite(scope: TopologyScope, flags: TopologyFlags): Promise<SiteOutcome> {
  for (let attempt = 0; ; attempt++) {
    try {
      await runOutsideDbContext(() => withSystemDbAccessContext(
        () => withResolvedTopologyFlags({ orgId: scope.orgId, flags }, () => importLegacyTopologySite(scope, { batchSize: IMPORT_EVENT_BATCH })),
        'topology bootstrap import',
      ));
      return { kind: 'imported' };
    } catch (error) {
      if (error instanceof TopologyCaptureIncompleteError) return { kind: 'capture_incomplete', missing: error.missing };
      if (retryableTopologyTransaction(error)) {
        if (attempt < 2) { await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1))); continue; }
        return { kind: 'deferred', error };
      }
      if (transientTopologyInfrastructureError(error)) return { kind: 'deferred', error };
      // Site-specific (e.g. a malformed legacy row the import fails closed on).
      // The whole import rolled back; record the back-off so the UI can say so.
      // The durable marker is also what rate-limits this alert per site.
      try {
        await recordBootstrapFailure(scope);
      } catch (markerError) {
        return { kind: 'deferred', error: markerError };
      }
      captureException(error, undefined, { siteId: scope.siteId, stage: 'topology_bootstrap_import' });
      return { kind: 'failed' };
    }
  }
}

export async function runTopologyBootstrapPass(): Promise<void> {
  if (topologyGloballyDisabled() || Date.now() < captureBlockedUntil) return;
  const startedAt = Date.now();
  const candidates = await selectCandidates(deferredSiteIds());
  for (const row of candidates.slice(0, TOPOLOGY_BOOTSTRAP_SITE_BATCH)) {
    if (Date.now() - startedAt >= TOPOLOGY_BOOTSTRAP_PASS_BUDGET_MS) return;
    const flags = resolveTopologyFlags({ partnerSettings: row.partner_settings, orgSettings: row.org_settings });
    // Unreachable unless the SQL predicate drifts looser than the resolver;
    // defer so such a row cannot hold a batch slot every pass.
    if (!flags.materialization) { defer(row.site_id); continue; }
    const scope = { orgId: row.org_id, siteId: row.site_id };
    const outcome = await bootstrapSite(scope, flags);
    if (outcome.kind === 'deferred') defer(row.site_id, outcome.error);
    if (outcome.kind !== 'capture_incomplete') continue;
    captureBlockedUntil = Date.now() + CAPTURE_BACKOFF_MS;
    if (Date.now() - lastCaptureAlertAt >= CAPTURE_ALERT_INTERVAL_MS) {
      lastCaptureAlertAt = Date.now();
      const missing = outcome.missing.join(',') || 'capture functions';
      console.warn(`[topology] first-snapshot bootstrap paused: legacy capture is incomplete or disabled (missing: ${missing})`);
      captureException(new Error('Topology bootstrap paused: legacy capture is incomplete or disabled'), undefined, { missing });
    }
    return;
  }
}
