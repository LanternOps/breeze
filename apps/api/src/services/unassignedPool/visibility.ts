import { notInArray, sql, type AnyColumn, type SQL } from 'drizzle-orm';
import { organizations } from '../../db/schema';
import { UNASSIGNED_POOL_ORG_TYPE } from './orgType';

/**
 * VISIBILITY: org types that exist as real `organizations` rows but are never
 * shown to people — never listed, counted, reported, billed, offered in a
 * picker or chosen as a default. Quick Support (a stranger's machine mid
 * support session) and the pre-assignment holding org agree on this.
 *
 * NEVER use this list to decide what may RUN: Quick Support devices are
 * hidden but remote-capable; holding-org devices are hidden and
 * execution-denied. Execution sites keep their own Quick Support exclusion
 * plus a parked-device predicate (./selectorPredicate.ts), and
 * parkedFanout.contract.test.ts refuses this list in any execution module.
 *
 * `src/__tests__/unassignedPoolVisibility.contract.test.ts` requires every
 * route and service that hides Quick Support to hide the holding org with it.
 */
export const HIDDEN_ORG_TYPES = ['quick_support', UNASSIGNED_POOL_ORG_TYPE] as const;

export type HiddenOrgType = (typeof HIDDEN_ORG_TYPES)[number];

export function isHiddenOrgType(type: string | null | undefined): boolean {
  return (HIDDEN_ORG_TYPES as readonly string[]).includes(type ?? '');
}

/** For queries over `organizations`: hidden org types are left out. */
export function notHiddenOrgType(): SQL {
  return notInArray(organizations.type, [...HIDDEN_ORG_TYPES]);
}

/**
 * For queries over a table that carries only an org id (sites, a child
 * table): rows of a hidden org are left out. Raw SQL on purpose, so a route's
 * positionally mocked db.select() chain is not consumed by a subquery.
 */
export function notInHiddenOrgCondition(orgIdColumn: AnyColumn | SQL): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM organizations hidden_org WHERE hidden_org.id = ${orgIdColumn} AND hidden_org.type IN ('quick_support', 'unassigned_pool'))`;
}
