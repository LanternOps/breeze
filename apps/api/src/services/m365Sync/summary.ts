import { and, desc, eq, inArray } from 'drizzle-orm';
import { M365_SYNC_DOMAINS, type M365SyncDomain } from '@breeze/shared/m365';
import { isM365TenantSyncEnabled } from '../../config/env';
import { db } from '../../db';
import { m365PostureRollups, m365SyncState } from '../../db/schema';
import { M365_SYNC_PRIMARY_SOURCE_KEY, type M365SyncOutcome } from './types';

const STATUSES: readonly M365SyncOutcome[] = ['success', 'partial', 'needs_consent', 'throttled', 'error'];

export interface M365SyncDomainSummary {
  domain: M365SyncDomain;
  /** The stored m365_sync_status, or 'never' when the domain has not run. */
  status: M365SyncOutcome | 'never';
  /** last_complete_snapshot_at — the honest "as of" for this fact (spec §6). */
  asOf: string | null;
  truncated: boolean;
 /** The domain's own primary source is 'unlicensed': the tenant has no Entra ID P1. */
  unlicensed: boolean;
}

export interface M365SyncSummary {
  /** Newest successful run across all domains — the card's "last synced". */
  lastSuccessAt: string | null;
  /** users_total / devices_total from the newest posture rollup of the current tenant, or null. */
  users: number | null;
  devices: number | null;
  domains: M365SyncDomainSummary[];
}

function status(value: unknown): M365SyncOutcome | 'never' {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? value as M365SyncOutcome
    : 'never';
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function count(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Keyed on the DOMAIN's own primary source, not on the literal `signInActivity`.
 *
 * #5784 W05: this helper predates the second sign-in domain and hardcoded the
 * one key it knew about, so `signin_events` — whose primary source is
 * `signinEvents` — would read `unlicensed: false` for a tenant that genuinely
 * has no Entra ID P1, and the card would show a domain succeeding forever with
 * nothing in it and no explanation. `M365_SYNC_PRIMARY_SOURCE_KEY` is the
 * existing single source of truth for that mapping.
 */
function isUnlicensed(domain: M365SyncDomain, sources: unknown): boolean {
  if (sources === null || typeof sources !== 'object') return false;
  return (sources as Record<string, unknown>)[M365_SYNC_PRIMARY_SOURCE_KEY[domain]] === 'unlicensed';
}

/**
 * Raw per-domain freshness, as a report generator needs it (#5784 W03/W06).
 *
 * Why not reuse `loadSyncSummary`: it returns `null` outright when the sync flag
 * is off and shapes its output for the UI card, iterating ALL domains. A report
 * generator needs the freshness of the two or three domains it actually reads,
 * and needs to tell "sync disabled" from "never ran" so its data-gap line can
 * say which — so the flag check stays with the caller here.
 *
 * `asOf` is `last_complete_snapshot_at` and NOTHING else. `last_success_at`
 * also advances for a `partial` outcome — a run that succeeded without
 * enumerating the tenant — so quoting it would claim a freshness the data does
 * not have. `sources` is returned verbatim (normalized to a string map) so a
 * caller can name the actual gap (`needs_consent`, `throttled`) instead of
 * printing zeros for an unmeasured population.
 *
 * Read on the REQUEST's own DB context: shape-1 RLS is the tenant boundary, and
 * the statement is also keyed on the org.
 */
export interface DomainFreshness {
  asOf: string | null;
  lastStatus: string | null;
  truncated: boolean;
  sources: Record<string, string> | null;
  /** The domain's OWN primary source came back 'unlicensed'. */
  unlicensed: boolean;
}

type SyncStateRow = {
  domain: unknown;
  lastStatus: unknown;
  lastSuccessAt: Date | string | null;
  lastCompleteSnapshotAt: Date | string | null;
  truncated: unknown;
  sources: unknown;
};

/**
 * The ONE m365_sync_state read both public readers below share. Kept private so
 * neither caller can drift onto its own column list — `lastSuccessAt` is
 * selected here for `loadSyncSummary`'s card only and is deliberately absent
 * from `DomainFreshness`.
 *
 * Read on the REQUEST's own DB context, so shape-1 RLS is the tenant boundary;
 * every statement is also keyed on the org.
 */
async function selectSyncStateRows(
  orgId: string,
  domains?: readonly M365SyncDomain[],
): Promise<SyncStateRow[]> {
  const where = domains
    ? and(eq(m365SyncState.orgId, orgId), inArray(m365SyncState.domain, [...domains]))
    : eq(m365SyncState.orgId, orgId);
  return db
    .select({
      domain: m365SyncState.domain,
      lastStatus: m365SyncState.lastStatus,
      lastSuccessAt: m365SyncState.lastSuccessAt,
      lastCompleteSnapshotAt: m365SyncState.lastCompleteSnapshotAt,
      truncated: m365SyncState.truncated,
      sources: m365SyncState.sources,
    })
    .from(m365SyncState)
    .where(where) as unknown as Promise<SyncStateRow[]>;
}

function sourceMap(value: unknown): Record<string, string> | null {
  if (value === null || typeof value !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

/**
 * Per-domain freshness for the domains a caller actually reads (#5784 W03/W06).
 *
 * TOTAL over `domains`: a domain with no state row comes back as
 * `asOf: null`, never as a missing key, so a caller cannot mistake
 * "never scheduled" for "fresh and empty". Unlike `loadSyncSummary` this does
 * NOT short-circuit on `isM365TenantSyncEnabled()` — a report generator has to
 * tell "sync is switched off" from "scheduled but never completed" and says so
 * in its own data-gap line, so it checks the flag itself.
 */
export async function loadDomainFreshness(
  orgId: string,
  domains: readonly M365SyncDomain[],
): Promise<Record<M365SyncDomain, DomainFreshness>> {
  const rows = domains.length === 0 ? [] : await selectSyncStateRows(orgId, domains);
  const byDomain = new Map(rows.map((row) => [row.domain as M365SyncDomain, row]));
  const out = {} as Record<M365SyncDomain, DomainFreshness>;
  for (const domain of domains) {
    const row = byDomain.get(domain);
    out[domain] = {
      asOf: iso(row?.lastCompleteSnapshotAt ?? null),
      lastStatus: typeof row?.lastStatus === 'string' ? row.lastStatus : null,
      truncated: row?.truncated === true,
      sources: sourceMap(row?.sources ?? null),
      unlicensed: isUnlicensed(domain, row?.sources ?? null),
    };
  }
  return out;
}

/**
 * Per-domain freshness for the Customer Graph Read card. Read on the REQUEST's
 * own DB context, so shape-1 RLS is the tenant boundary — no system context,
 * no cross-org read — and every statement is also keyed on the org.
 *
 * Every domain is represented even without a state row, so the UI can say
 * "never synced" for one domain without implying the whole connection is idle.
 * `asOf` is `last_complete_snapshot_at`, NOT `last_success_at`: a partial run
 * succeeds without enumerating the tenant, and its timestamp would claim a
 * freshness the data does not have.
 *
 * The entity counts come from the newest posture rollup — the one place those
 * totals are already assembled (spec §5.9) — filtered to the connection's
 * CURRENT tenant, because rollups outlive a rebind and must not report the
 * previous tenant's headcount. No COUNT over the entity tables on a page load.
 */
export async function loadSyncSummary(orgId: string, tenantId: string | null): Promise<M365SyncSummary | null> {
  if (!isM365TenantSyncEnabled()) return null;

  const rows = await selectSyncStateRows(orgId);

  if (rows.length === 0) return null;

  const [rollup] = tenantId
    ? await db
      .select({ users: m365PostureRollups.usersTotal, devices: m365PostureRollups.devicesTotal })
      .from(m365PostureRollups)
      .where(and(eq(m365PostureRollups.orgId, orgId), eq(m365PostureRollups.tenantId, tenantId)))
      .orderBy(desc(m365PostureRollups.rollupDate))
      .limit(1)
    : [];

  const byDomain = new Map(rows.map((row) => [row.domain as M365SyncDomain, row]));
  const domains: M365SyncDomainSummary[] = M365_SYNC_DOMAINS.map((domain) => {
    const row = byDomain.get(domain);
    return {
      domain,
      status: status(row?.lastStatus),
      asOf: iso(row?.lastCompleteSnapshotAt ?? null),
      truncated: row?.truncated === true,
      unlicensed: isUnlicensed(domain, row?.sources ?? null),
    };
  });

  const successes = rows
    .map((row) => iso(row.lastSuccessAt))
    .filter((value): value is string => value !== null)
    .sort();

  return {
    lastSuccessAt: successes.at(-1) ?? null,
    users: count(rollup?.users),
    devices: count(rollup?.devices),
    domains,
  };
}
