import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  db,
  getCurrentDbAccessContext,
  hasDbAccessContext,
  withSystemDbAccessContext,
} from '../db';
import { organizations } from '../db/schema';
import { UnexecutableReportScopeError } from './reportErrors';
import type { ReportGenerationAuthority, ReportOwner } from './siteScope';

/**
 * The tenancy input a report generator receives (#3198 spec §3.2). It replaces
 * the bare `orgId: string` the generators took before W02.
 *
 * `orgIds` on the partner variant is resolved LIVE at generation time (see
 * `resolvePartnerReportOrgIds`), never read from the stored definition.
 * Persisting it would freeze the report at creation-time membership: a
 * customer onboarded last week would silently vanish from this month's AR
 * aging (§3.1a).
 *
 * There is deliberately NO org cap. The design doc's 100-org cap exists for the
 * posture fan-out (~15 queries per org); business aggregates are single GROUP BY
 * queries, and a capped AR or SLA aggregate is simply a wrong number (§3.2).
 */
export type ReportScope =
  | { kind: 'organization'; orgId: string }
  | { kind: 'partner'; partnerId: string; orgIds: string[] };

/**
 * Raised when the owner axis of a `reports` row and the axis of the authority
 * resolved for it disagree, or when the ambient DB context cannot see the
 * scope a report is about to run under. It extends
 * `UnexecutableReportScopeError` (#3198 W02 ruling P11) so every route and
 * worker arm that already maps that class to 403 maps this one too: the
 * request is well-formed and the row exists, but no authority was produced
 * for the axis it is stored on, which is an access outcome.
 */
export class ReportScopeMismatchError extends UnexecutableReportScopeError {
  readonly code = 'report_scope_mismatch';

  constructor(message: string) {
    super(message);
    this.name = 'ReportScopeMismatchError';
  }
}

/** Sugar for the many org-scope call sites; there is no partner equivalent on
 *  purpose — a partner scope must come from `reportScopeFromAuthority`, which is
 *  the only place that resolves the org list. */
export function organizationScope(orgId: string): ReportScope {
  return { kind: 'organization', orgId };
}

/** The owner axis a scope came from. `assertReportExecutionPreflight` takes a
 *  `ReportOwner` after W01, so this is how a generator hands its scope back to
 *  the preflight without reconstructing the row. */
export function reportOwnerOfScope(scope: ReportScope): ReportOwner {
  return scope.kind === 'organization' ? { orgId: scope.orgId } : { partnerId: scope.partnerId };
}

/** What `runInReportScope` must be able to see. A partner scope whose org list
 *  is not resolved yet (the org-list query itself) is asserted on the partner
 *  id alone. */
type ReportScopeTarget =
  | ReportScope
  | { kind: 'partner'; partnerId: string; orgIds?: undefined };

function assertAmbientContextSeesScope(scope: ReportScopeTarget): void {
  const context = getCurrentDbAccessContext();
  if (!context) {
    // A transaction with no access metadata (only the test-only
    // __runInDbContextForTests does this) — RLS visibility is unknowable, so
    // refuse rather than risk a silent zero-row report.
    throw new ReportScopeMismatchError(
      'Report scope cannot run in an ambient DB context without access metadata',
    );
  }
  if (context.scope === 'system') return;

  if (scope.kind === 'partner') {
    if (context.scope !== 'partner' || !(context.accessiblePartnerIds ?? []).includes(scope.partnerId)) {
      throw new ReportScopeMismatchError(
        `Partner report scope cannot run in a ${context.scope}-scope DB context without access to that partner`,
      );
    }
    return;
  }

  if (!(context.accessibleOrgIds ?? []).includes(scope.orgId)) {
    throw new ReportScopeMismatchError(
      `Organization report scope cannot run in a ${context.scope}-scope DB context without access to that organization`,
    );
  }
}

/**
 * Run report work in a DB context that can see `scope` (#3198 W02 ruling P6).
 *
 * - Ambient context present (request path: the route's `withDbAccessContext`
 *   transaction; worker path: `runWithSystemDbAccess`): assert it can see the
 *   scope, then run IN it. A context that cannot see it THROWS — under forced
 *   RLS the query would otherwise return zero rows and ship a report whose
 *   totals are silently zero.
 * - No ambient context: open a system context.
 *
 * Never `runOutsideDbContext`: escaping the request transaction to open a
 * second one double-holds a pooled connection per request, which hangs the
 * pool at concurrency >= pool size (#1105, #2417, the 09-22 US deadlock).
 */
export async function runInReportScope<T>(
  scope: ReportScopeTarget,
  fn: () => Promise<T>,
): Promise<T> {
  if (getCurrentDbAccessContext() !== undefined || hasDbAccessContext()) {
    assertAmbientContextSeesScope(scope);
    return fn();
  }
  return withSystemDbAccessContext(fn);
}

/**
 * The organizations a partner-scope business report aggregates over: the
 * partner's active and trial customer orgs, ordered by id.
 *
 * Why this filter (and not "every org of the partner"): spec §3.2 says the
 * list is exactly the caller's accessible set, and the request middleware
 * builds that set from active/trial orgs only — suspended, archived and
 * soft-deleted orgs are not accessible even with `org_access = 'all'`, and
 * `organizations` RLS (`breeze_has_org_access(id)`) enforces the same on the
 * request path. Resolving the list with the same predicate on both paths keeps
 * a request-time report and a scheduled one identical, without escaping the
 * request transaction to read under system scope (the #1105/#2417 pool
 * double-hold). The cost — a suspended customer's AR is omitted from partner
 * AR aging — is disclosed in each report's notes. The partner's hidden
 * `quick_support` org IS in the accessible set, but it holds no customer data
 * (only ad-hoc support sessions, `middleware/auth.ts`), so it is excluded
 * rather than showing up as an empty "customer" row.
 *
 * Never derived from `auth.accessibleOrgIds`: platform admins carry `null`
 * there, and the worker path has no auth at all.
 *
 * `orderBy(id)`: the list lands in the stored `result.summary.scope.orgIds`
 * and in integration assertions; an unordered SELECT makes both flaky.
 */
export async function resolvePartnerReportOrgIds(partnerId: string): Promise<string[]> {
  const rows = await runInReportScope({ kind: 'partner', partnerId }, () =>
    db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(
        eq(organizations.partnerId, partnerId),
        inArray(organizations.status, ['active', 'trial']),
        isNull(organizations.deletedAt),
        ne(organizations.type, 'quick_support'),
      ))
      .orderBy(asc(organizations.id)),
  );
  return rows.map((r) => r.id);
}

/**
 * Derive the generator's scope from the report's owner axis and the authority
 * already resolved for it. The authority is the source of truth for WHICH
 * tenant, so a mismatch between the two is refused rather than silently
 * preferring one — that refusal is what stops a partner-owned row from being
 * generated under an org authority that happens to be lying around.
 */
export async function reportScopeFromAuthority(
  owner: ReportOwner,
  authority: ReportGenerationAuthority,
): Promise<ReportScope> {
  const scope = authority.scope;

  if (owner.partnerId !== undefined) {
    if (scope.kind !== 'partner_wide') {
      throw new ReportScopeMismatchError(
        `Partner-owned report requires a partner_wide authority, got ${scope.kind}`,
      );
    }
    if (scope.partnerId !== owner.partnerId) {
      throw new ReportScopeMismatchError('Report execution authority partner mismatch');
    }
    const orgIds = await resolvePartnerReportOrgIds(scope.partnerId);
    return { kind: 'partner', partnerId: scope.partnerId, orgIds };
  }

  if (scope.kind === 'partner_wide') {
    throw new ReportScopeMismatchError(
      'Org-owned report cannot be generated under a partner_wide authority',
    );
  }
  if (scope.orgId !== owner.orgId) {
    throw new ReportScopeMismatchError('Report execution authority organization mismatch');
  }
  return { kind: 'organization', orgId: owner.orgId };
}
