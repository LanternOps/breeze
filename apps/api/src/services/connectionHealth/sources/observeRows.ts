import type { SQL, SQLWrapper } from 'drizzle-orm';
import type { HealthVerdict } from '../../integrationStates';
import type { Permission } from '../../permissions';
import { sanitizeHealthDetail } from '../sanitize';
import type { ConnectionSourceKind, HealthObservation, HealthSource } from '../types';

// Shared plumbing for the row-per-connection sources (W2). Each source supplies
// two loaders over the same select: its index-backed broken query and a
// primary-key lookup of the tracked ids (spec §1.1). This module owns the rest
// of the contract: only broken or tracked rows are reported, a tracked id that
// no longer exists is simply absent (the reconciler retires it), and a query
// failure propagates so the kind's incidents stay untouched.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Spec §1.2 onboarding grace. */
export const ONBOARDING_GRACE_MS = 2 * 60 * 60 * 1000;

/** Tracked ids that can be looked up by uuid primary key, deduplicated; anything else is dropped (absent → retired). */
export function validUuids(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => UUID_RE.test(id)))];
}

/** A transient failure on a connection created under 2 hours ago is unknown, not broken (permanent ones are not delayed). */
export function applyGrace(verdict: HealthVerdict, createdAt: Date | null, now: Date): HealthVerdict {
  if (verdict.state !== 'broken' || verdict.severity !== 'transient' || createdAt === null) return verdict;
  return now.getTime() - createdAt.getTime() < ONBOARDING_GRACE_MS ? { state: 'unknown' } : verdict;
}

export function toHealthObservation(input: {
  kind: ConnectionSourceKind;
  verdict: HealthVerdict;
  now: Date;
  createdAt: Date | null;
  sourceId: string;
  partnerId: string;
  orgId: string | null;
  displayName: string;
  /** Raw provider text; sanitized here, and only reported while broken. */
  rawDetail: unknown;
  fixHref: string;
  viewPermission: Permission;
  repairPermission: Permission;
}): HealthObservation {
  const v = applyGrace(input.verdict, input.createdAt, input.now);
  const broken = v.state === 'broken';
  return {
    sourceKind: input.kind,
    sourceId: input.sourceId,
    partnerId: input.partnerId,
    orgId: input.orgId,
    ownerUserId: null,
    state: v.state,
    // Ignored by the reconciler unless broken.
    severity: broken ? v.severity : 'transient',
    condition: broken ? v.condition : v.state,
    detail: broken ? sanitizeHealthDetail(input.rawDetail) : null,
    displayName: input.displayName,
    fixHref: input.fixHref,
    ownerFixHref: null,
    viewPermission: input.viewPermission,
    repairPermission: input.repairPermission,
    observedAt: input.now,
  };
}

export async function observeRows<Row>(opts: {
  now: Date;
  trackedSourceIds: readonly string[];
  loadBroken: () => Promise<Row[]>;
  loadTracked: (ids: string[]) => Promise<Row[]>;
  sourceIdOf: (row: Row) => string;
  toObservation: (row: Row, now: Date) => HealthObservation;
}): Promise<HealthObservation[]> {
  const ids = validUuids(opts.trackedSourceIds);
  const [brokenRows, trackedRows] = await Promise.all([
    opts.loadBroken(),
    ids.length > 0 ? opts.loadTracked(ids) : Promise.resolve([] as Row[]),
  ]);
  const tracked = new Set(opts.trackedSourceIds);
  const out = new Map<string, HealthObservation>();
  for (const row of [...brokenRows, ...trackedRows]) {
    const id = opts.sourceIdOf(row);
    if (out.has(id)) continue;
    const o = opts.toObservation(row, opts.now);
    // Spec §1.3: an untracked row matters only while broken.
    if (o.state === 'broken' || tracked.has(id)) out.set(id, o);
  }
  return [...out.values()];
}

/** A select over one source's rows: awaitable (rows) and EXPLAIN-able (SQL). Drizzle select builders are both. */
export type RowQuery<Row> = PromiseLike<Row[]> & SQLWrapper;

/**
 * A HealthSource whose broken query and tracked lookup are the same select
 * with different WHEREs, so the query the index contract EXPLAINs is exactly
 * the one observe() runs. `brokenWhere` must state the partial-index predicate
 * with literal constants (sql.raw), or the planner cannot match the index.
 */
export function defineRowSource<Row>(def: {
  kind: ConnectionSourceKind;
  intervalMinutes: number;
  tables: readonly string[];
  fixHrefs: readonly string[];
  select: (where: SQL) => RowQuery<Row>;
  brokenWhere: SQL;
  trackedWhere: (ids: string[]) => SQL;
  sourceIdOf: (row: Row) => string;
  toObservation: (row: Row, now: Date) => HealthObservation;
}): HealthSource {
  return {
    kind: def.kind,
    intervalMinutes: def.intervalMinutes,
    tables: def.tables,
    fixHrefs: def.fixHrefs,
    brokenQuery: () => def.select(def.brokenWhere),
    observe: (now, trackedSourceIds) => observeRows<Row>({
      now,
      trackedSourceIds,
      loadBroken: async () => def.select(def.brokenWhere),
      loadTracked: async (ids) => def.select(def.trackedWhere(ids)),
      sourceIdOf: def.sourceIdOf,
      toObservation: def.toObservation,
    }),
  };
}
