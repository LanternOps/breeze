import { and, eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../middleware/auth';

/**
 * Query-parameter scoping shared by the Analytics page's fleet aggregates
 * (`GET /metrics`, `/metrics/trends`, `/analytics/capacity`,
 * `/analytics/executive-summary`, `/analytics/os-distribution`).
 */

type ScopeAuth = Partial<Pick<AuthContext, 'scope' | 'orgId' | 'orgCondition' | 'canAccessOrg'>> | undefined;

export type OrgConditionFor = (column: PgColumn) => SQL | undefined;

export type AnalyticsOrgScope =
  | { ok: true; orgId: string | null; orgCondition: OrgConditionFor }
  | { ok: false; status: 400 | 403; error: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The token's own org reach, exactly as these routes applied it before #9648. */
function tokenOrgCondition(auth: ScopeAuth): OrgConditionFor {
  return (column) =>
    typeof auth?.orgCondition === 'function'
      ? auth.orgCondition(column)
      : auth?.orgId
        ? eq(column, auth.orgId)
        : undefined;
}

function canReachOrg(auth: ScopeAuth, orgId: string): boolean {
  if (auth?.scope === 'organization') return auth.orgId === orgId;
  if (auth?.scope === 'partner') return typeof auth.canAccessOrg === 'function' && auth.canAccessOrg(orgId);
  if (auth?.scope === 'system') return true;
  return false;
}

/**
 * Resolve the org filter for a request that may carry `?orgId=` (the web
 * client injects the org switcher's selection into every call, #9648).
 *
 * - No `orgId`: the token's full reach, unchanged.
 * - `orgId` the caller can reach: narrowed to that org. The token condition is
 *   still ANDed in, so the selection can only ever narrow — never widen.
 * - Malformed: 400. Unreachable: 403 (same wording as `/alerts/summary`).
 */
export function resolveAnalyticsOrgScope(auth: ScopeAuth, requestedOrgId: string | undefined): AnalyticsOrgScope {
  const base = tokenOrgCondition(auth);
  if (!requestedOrgId) {
    return { ok: true, orgId: null, orgCondition: base };
  }
  if (!UUID_PATTERN.test(requestedOrgId)) {
    return { ok: false, status: 400, error: 'Invalid orgId' };
  }
  if (!canReachOrg(auth, requestedOrgId)) {
    return { ok: false, status: 403, error: 'Access to this organization denied' };
  }
  return {
    ok: true,
    orgId: requestedOrgId,
    orgCondition: (column) => and(eq(column, requestedOrgId), base(column)),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Longest custom window accepted, in days. Daily rollups are retained far longer (>= 730 days). */
export const MAX_CUSTOM_RANGE_DAYS = 366;

export type AnalyticsDateWindow =
  | { ok: true; since: Date; until: Date | null }
  | { ok: false; status: 400; error: string };

function parseBoundary(value: string, endOfDay: boolean): Date | null {
  if (DATE_ONLY_PATTERN.test(value)) {
    const start = new Date(`${value}T00:00:00.000Z`);
    // Reject calendar overflow (e.g. 2026-02-31 rolling into March).
    if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== value) return null;
    return endOfDay ? new Date(start.getTime() + DAY_MS) : start;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Resolve the time window for a trend/capacity query (#9649).
 *
 * `startDate`/`endDate` (the page's "Custom range") win over `range`. A
 * date-only `endDate` is inclusive: the window runs to the start of the next
 * UTC day, and callers bound with `< until`. Both dates are required, and an
 * invalid, inverted or over-long window is a 400 rather than a silent fall
 * back to the preset — that fallback is what made Custom range look applied
 * while it showed the last 30 days.
 *
 * Without custom dates, `presetDays` maps `range` to a day count ending now
 * (`until: null`).
 */
export function resolveAnalyticsDateWindow(
  query: { range?: string; startDate?: string; endDate?: string },
  presetDays: (range: string | undefined) => number,
  now: Date = new Date()
): AnalyticsDateWindow {
  const { startDate, endDate } = query;
  if (!startDate && !endDate) {
    return { ok: true, since: new Date(now.getTime() - presetDays(query.range) * DAY_MS), until: null };
  }
  if (!startDate || !endDate) {
    return { ok: false, status: 400, error: 'startDate and endDate are both required for a custom range' };
  }
  const since = parseBoundary(startDate, false);
  const until = parseBoundary(endDate, true);
  if (!since || !until) {
    return { ok: false, status: 400, error: 'startDate and endDate must be valid dates (YYYY-MM-DD)' };
  }
  if (since.getTime() >= until.getTime()) {
    return { ok: false, status: 400, error: 'startDate must be on or before endDate' };
  }
  if (until.getTime() - since.getTime() > MAX_CUSTOM_RANGE_DAYS * DAY_MS) {
    return { ok: false, status: 400, error: `Custom range cannot exceed ${MAX_CUSTOM_RANGE_DAYS} days` };
  }
  return { ok: true, since, until };
}
