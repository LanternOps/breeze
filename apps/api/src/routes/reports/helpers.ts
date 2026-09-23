import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { isManagedEvidenceType } from '../../services/managedEvidenceRegistry';
import { db } from '../../db';
import { portalBranding, reports, reportRuns } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies } from '../../services/partnerWideAccess';
import {
  reportAudienceCondition,
  reportTypeHiddenByPermission,
  reportTypeHiddenFromCaller,
  reportTypePermissionCondition,
  type GrantedReportPermissions,
} from '../../services/reportTypePermissions';
import {
  decodeSiteScope,
  isSiteScopeSubset,
  reportDefinitionScopeSqlPredicate,
  reportAnyPartnerWideScopeSqlPredicate,
  reportPartnerWideScopeSqlPredicate,
  reportRunScopeSqlPredicate,
  resolveRequestPartnerReportAuthority,
  resolveRequestReportAuthority,
  type LiveReportAuthorityResult,
  type LiveSiteScopeV1,
  type PartnerWideScopeSqlTarget,
  type PersistedSiteScopeColumns,
  type ReportAction,
  type ReportExecutionAuthority,
  type ReportOwner,
} from '../../services/siteScope';

export { getPagination } from '../../utils/pagination';

/**
 * #4562 W10 — a 409, not a 403, for the same reason as `system_managed_report`:
 * the caller's permissions are fine, it is the definition's OWNERSHIP that
 * makes the mutation impossible while the customer portal exposes it.
 */
export const PORTAL_SELF_SERVICE_REPORT = {
  error: 'portal_self_service_report',
} as const;

/**
 * #4562 W10 — is this definition the org's canonical customer-portal report
 * (`portal_self_service`) while that org currently exposes portal reports?
 *
 * While `portal_branding.enable_reports` is on, the portal lists EVERY
 * completed run of the definition and downloads it as the customer's own
 * report (`portalRunListPredicate` keys on org + marker + status only), so
 * the MSP must not rewrite its customer-safe config (PUT), generate a run
 * under a tech's — possibly site-restricted — authority (POST /:id/generate),
 * or delete it (DELETE). Once the flag is off the definition is an ordinary
 * MSP-owned report again and every mutation is allowed. Spec §8.2 / R10-3.
 *
 * Takes the transaction (or `db`) so the write routes evaluate it on the
 * same connection that holds the `FOR UPDATE` lock.
 */
export async function isPortalSelfServiceLocked(
  tx: Pick<typeof db, 'select'>,
  definition: { portalSelfService: boolean; orgId: string | null },
): Promise<boolean> {
  // A partner-owned row (#3198 W01) has no org and is never the portal's
  // definition (portal_self_service is false by construction).
  if (!definition.portalSelfService || !definition.orgId) return false;
  const [branding] = await tx
    .select({ enableReports: portalBranding.enableReports })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, definition.orgId))
    .limit(1);
  return branding?.enableReports === true;
}

export async function ensureOrgAccess(
  orgId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'canAccessOrg'>
) {
  if (auth.scope === 'organization') {
    return auth.orgId === orgId;
  }

  if (auth.scope === 'partner') {
    return auth.canAccessOrg(orgId);
  }

  // system scope has access to all
  return true;
}

/**
 * #3198 W01 (spec 3.1a). The ONE predicate that may reach partner-owned rows.
 * Returns `partner_id = auth.partnerId` only for a caller who may administer
 * partner-wide state (partner scope with org_access='all'); TRUE for system
 * scope; FALSE for everyone else, including org tokens (which DO carry a
 * partnerId) and 'selected' partner users. There is no database backstop for
 * the org_access rule — `breeze_has_partner_access` is flat membership — so
 * partnerOwnedVisibility.scan.test.ts, a TEXTUAL scan of routes/,
 * services/, jobs/, fails a Drizzle read or mutation of `reports` /
 * `reportRuns` / `reportRunDeliveries`, a table interpolated into a sql
 * template, a raw-SQL FROM/JOIN/UPDATE/USING/DELETE/INSERT/MERGE/TRUNCATE
 * (incl. `"public".`-qualified, quoted and comma-joined forms) on
 * report_runs / report_run_deliveries / reports inside template text, or a
 * `sql.identifier('<table>')` / `sql.raw('…<table>…')` literal, when the
 * enclosing function neither reaches this (directly or through a verified
 * guard entrypoint) nor is allowlisted for that scope with a reason, an
 * audience posture (ruling F1) and a pinned site count; it also fails any
 * re-binding of those table symbols. It cannot see a table passed as a
 * function argument (`fn(reports)` → `.from(table)`), SQL assembled from
 * concatenated strings or variables, comma joins after a subselect or an
 * ON clause, or code outside those three directories — those still rely on
 * review and the route suites (full list in the scan's header).
 */
export function partnerOwnedReportVisibility(
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'>,
): SQL<unknown> {
  if (auth.scope === 'system') return sql<unknown>`TRUE`;
  return canManagePartnerWidePolicies(auth) && auth.partnerId
    ? eq(reports.partnerId, auth.partnerId)
    : sql<unknown>`FALSE`;
}

/**
 * #3198 W01. The partner axis of a multi-org list predicate
 * (`report{Definition,Run}MultiOrgScopeSqlPredicate`'s `partnerWide` arg), or
 * undefined for every caller who may not administer partner-wide state. Lives
 * here, next to `partnerOwnedReportVisibility`, so a raw `reports.partnerId`
 * predicate never appears in a route file (the scan test polices that).
 */
export function partnerWideListTarget(
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'>,
): PartnerWideScopeSqlTarget | undefined {
  return canManagePartnerWidePolicies(auth) && auth.partnerId
    ? { rowPartnerId: reports.partnerId, partnerId: auth.partnerId }
    : undefined;
}

/**
 * #3198 W02 (addendum B7, ruling P9). The SYSTEM-scope (platform admin) list
 * arm for partner-owned rows: any partner's row with a well-formed
 * partner_wide envelope on `columns` (`reports` for the definition list,
 * `reportRuns` for the run list; the owner is always `reports.partner_id`).
 * Undefined for every non-system caller. Lives here so the raw
 * `reports.partnerId` predicate stays out of route files (scan test).
 */
export function systemPartnerWideListArm(
  auth: Pick<AuthContext, 'scope'>,
  columns: typeof reports | typeof reportRuns,
): SQL<unknown> | undefined {
  return auth.scope === 'system'
    ? reportAnyPartnerWideScopeSqlPredicate(columns, reports.partnerId)
    : undefined;
}

/**
 * #3198 W01 — a 409 for the same reason as `system_managed_report`: the
 * caller may administer the definition, but its PARTNER ownership makes the
 * org-axis mutation (recipients, artifact attachment) impossible.
 */
export const PARTNER_OWNED_REPORT = { error: 'partner_owned_report' } as const;

export function partnerOwnedRefusal(row: { partnerId?: string | null }) {
  return row.partnerId ? PARTNER_OWNED_REPORT : null;
}

/**
 * #3198 W01. Live authority for a report's owner axis. A partner owner is
 * refused up front unless the caller may administer partner-wide state — the
 * resolver re-checks org_access live, this is the token-side gate that makes
 * EVERY operation on a partner-owned report (not only create) require it.
 */
export async function resolveReportOwnerAuthority(
  auth: AuthContext,
  owner: ReportOwner,
  action: ReportAction,
): Promise<LiveReportAuthorityResult> {
  if (owner.partnerId !== undefined) {
    if (!canManagePartnerWidePolicies(auth)) {
      return { ok: false, reason: 'partner_access_not_all' };
    }
    return resolveRequestPartnerReportAuthority(auth, owner.partnerId, action);
  }
  return resolveRequestReportAuthority(auth, owner.orgId, action);
}

/**
 * The owner axis of a `reports` row (or a projection carrying `orgId` +
 * `partnerId`), or null when the row names neither or both
 * (`reports_one_owner_chk` makes that corruption). Same rule as siteScope's
 * `reportOwnerOf`, but non-throwing and local: every caller here answers
 * "not found" for a malformed row, and the report route suites stub the
 * siteScope module wholesale.
 */
export function reportOwnerOfRow(row: {
  orgId?: string | null;
  partnerId?: string | null;
}): ReportOwner | null {
  const hasOrg = typeof row.orgId === 'string' && row.orgId.length > 0;
  const hasPartner = typeof row.partnerId === 'string' && row.partnerId.length > 0;
  if (hasOrg === hasPartner) return null;
  return hasOrg ? { orgId: row.orgId as string } : { partnerId: row.partnerId as string };
}

/**
 * The owner argument for `decodeSiteScope`. An org owner decodes under its
 * bare org id — byte-for-byte the pre-W01 call — and a partner owner under
 * the `ReportOwner` object, the only form that can decode partner_wide.
 */
export function decodeOwnerKey(owner: ReportOwner): string | ReportOwner {
  return owner.partnerId !== undefined ? owner : owner.orgId;
}

/** The owner-axis row condition on `reports` for an already-resolved owner. */
export function reportOwnerCondition(owner: ReportOwner): SQL<unknown> {
  return owner.partnerId !== undefined
    ? eq(reports.partnerId, owner.partnerId)
    : eq(reports.orgId, owner.orgId);
}

/**
 * The execution-scope predicate for a definition (`columns = reports`) or a
 * run (`columns = reportRuns`, joined to `reports`) under the caller's live
 * scope. A partner owner matches only a complete partner_wide envelope on a
 * row of that partner; an org owner keeps today's single-scope predicate.
 */
export function reportOwnerScopePredicate(
  columns: typeof reports | typeof reportRuns,
  owner: ReportOwner,
  scope: LiveSiteScopeV1,
): SQL<unknown> {
  if (owner.partnerId !== undefined) {
    return reportPartnerWideScopeSqlPredicate(columns, {
      rowPartnerId: reports.partnerId,
      partnerId: owner.partnerId,
    });
  }
  return columns === reports
    ? reportDefinitionScopeSqlPredicate(reports, scope)
    : reportRunScopeSqlPredicate(reportRuns, scope);
}

/**
 * The by-id definition loader. `permissions` is REQUIRED (ruling P8b): the
 * caller's resolved permission set (`c.get('permissions')`), so a row whose
 * type needs a read permission the caller lacks answers null (→ 404), exactly
 * like a row outside the caller's tenancy.
 */
export async function getReportWithOwnerCheck(
  reportId: string,
  auth: AuthContext,
  permissions: GrantedReportPermissions,
) {
  const metadataCondition = tenantAuthorizedReportCondition(reportId, auth, permissions);
  const [metadata] = await db
    .select(reportDefinitionMetadataProjection)
    .from(reports)
    .where(metadataCondition)
    .limit(1);

  if (!metadata) {
    return null;
  }
  // Ruling F1, defense in depth: the tenant condition above already excludes
  // msp_staff types for an org-scope caller.
  if (reportTypeHiddenFromCaller(metadata.type, auth)) return null;
  // Ruling P8b, defense in depth: likewise for a type whose underlying read
  // permissions the caller lacks.
  if (reportTypeHiddenByPermission(metadata.type, permissions)) return null;

  const owner = reportOwnerOfRow(metadata);
  if (!owner) return null;

  const authorityResult = await resolveReportOwnerAuthority(auth, owner, 'read');
  if (!authorityResult.ok || authorityResult.authority.scope.kind === 'legacy_unscoped') {
    return null;
  }
  const liveScope: LiveSiteScopeV1 = authorityResult.authority.scope;

  try {
    const storedScope = decodeSiteScope(
      metadata as unknown as PersistedSiteScopeColumns,
      decodeOwnerKey(owner),
    );
    if (!isSiteScopeSubset(storedScope, liveScope)) {
      return null;
    }
  } catch {
    return null;
  }

  const [report] = await db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.id, reportId),
        reportOwnerCondition(owner),
        reportOwnerScopePredicate(reports, owner, liveScope),
      ),
    )
    .limit(1);

  if (!report) return null;

  try {
    const storedScope = decodeSiteScope(
      report as unknown as PersistedSiteScopeColumns,
      decodeOwnerKey(owner),
    );
    return isSiteScopeSubset(storedScope, liveScope)
      ? { ...report, owner }
      : null;
  } catch {
    return null;
  }
}

/** @deprecated #3198 W01 alias — remove in W02 once every caller uses the owner-aware name. */
export const getReportWithOrgCheck = getReportWithOwnerCheck;

export const reportDefinitionMetadataProjection = {
  id: reports.id,
  orgId: reports.orgId,
  // #3198 W01: the other owner axis (reports_one_owner_chk). Without it every
  // partner-owned row decodes as ownerless.
  partnerId: reports.partnerId,
  // P2-3 (#4190): `type` rides along so the write routes can refuse a
  // system-managed definition from the SAME row they already read for scope
  // metadata — no extra query, and the refusal happens before any authority
  // resolution. See `isSystemManagedReportDefinition`.
  type: reports.type,
  executionScopeVersion: reports.executionScopeVersion,
  executionScopeKind: reports.executionScopeKind,
  executionScopeSiteIds: reports.executionScopeSiteIds,
  executionScopeUserId: reports.executionScopeUserId,
  executionScopeFingerprint: reports.executionScopeFingerprint,
  executionScopeCapturedAt: reports.executionScopeCapturedAt,
  executionScopePrincipalKind: reports.executionScopePrincipalKind,
  portalSelfService: reports.portalSelfService,
};

/**
 * P2-3 (#4190) — is this definition owned by the platform rather than by a
 * human?
 *
 * TWO independent signals, deliberately OR-ed. `execution_scope_principal_kind
 * = 'system'` is the provenance the scheduled-report worker also keys on;
 * `type = 'ai_org_narrative'` (or, since Fleet Designer W01 #5651,
 * `'ai_fleet_design'`) is the report's identity. Either alone would leave a
 * gap: a row whose principal was somehow rewritten to 'user' is still a
 * narrative/design nobody can regenerate, and a future system-managed report
 * of an ordinary type would still have no acting user to mutate on behalf of.
 *
 * Reads and downloads never consult this — a system-managed report exists to be
 * read. Only the four mutation routes do.
 */
export function isSystemManagedReportDefinition(
  row: { type: string | null; executionScopePrincipalKind: string | null; portalSelfService?: boolean | null },
): boolean {
  return row.executionScopePrincipalKind === 'system'
    || row.type === 'ai_org_narrative'
    || row.type === 'ai_fleet_design'
    // #5784 W01: the org's ONE managed evidence definition — DEFINITION-based,
    // not type-based, because a managed evidence type also has ordinary
    // user-authored definitions a technician must keep full control of.
    || (row.type !== null && isManagedEvidenceType(row.type) && row.portalSelfService === true);
}

/**
 * The by-id `reports` tenant condition. Ruling P8b: on EVERY scope it also
 * excludes the types whose underlying read permissions `permissions` lacks
 * (`reportTypePermissionCondition`; no predicate when it holds them all).
 */
export function tenantAuthorizedReportCondition(
  reportId: string,
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'partnerId' | 'partnerOrgAccess'>,
  permissions: GrantedReportPermissions,
): SQL<unknown> {
  const idCondition = and(
    eq(reports.id, reportId),
    reportTypePermissionCondition(permissions, reports.type),
  )!;

  // Organization scope never gains a partner_id predicate (#3198 W01): its
  // `org_id = auth.orgId` filter is one no partner-owned row can satisfy.
  // Ruling F1: nor does it ever see an msp_staff (business) type.
  if (auth.scope === 'organization') {
    return auth.orgId
      ? and(idCondition, eq(reports.orgId, auth.orgId), reportAudienceCondition(auth, reports.type))!
      : sql<unknown>`FALSE`;
  }

  if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    if (!canManagePartnerWidePolicies(auth)) {
      return orgIds.length > 0
        ? and(idCondition, inArray(reports.orgId, orgIds))!
        : sql<unknown>`FALSE`;
    }
    const orgCondition = orgIds.length > 0
      ? inArray(reports.orgId, orgIds)
      : sql<unknown>`FALSE`;
    return and(idCondition, or(orgCondition, partnerOwnedReportVisibility(auth)))!;
  }

  return idCondition;
}

/**
 * The `report_runs ⋈ reports` tenant condition shared by the run routes.
 * `null` = the caller can reach nothing (answer empty / 404 without querying).
 */
export function tenantAuthorizedRunCondition(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'partnerId' | 'partnerOrgAccess'>,
  permissions: GrantedReportPermissions,
): SQL<unknown> | undefined | null {
  // Ruling P8b: every scope loses the types whose read permissions it lacks.
  const typePermission = reportTypePermissionCondition(permissions, reports.type);
  if (auth.scope === 'organization') {
    // Ruling F1: an org-scope caller never sees a run of an msp_staff type.
    return auth.orgId
      ? and(eq(reports.orgId, auth.orgId), reportAudienceCondition(auth, reports.type), typePermission)!
      : null;
  }
  if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    if (!canManagePartnerWidePolicies(auth)) {
      return orgIds.length > 0 ? and(inArray(reports.orgId, orgIds), typePermission)! : null;
    }
    const orgCondition = orgIds.length > 0
      ? inArray(reports.orgId, orgIds)
      : sql<unknown>`FALSE`;
    return and(or(orgCondition, partnerOwnedReportVisibility(auth)), typePermission)!;
  }
  return typePermission;
}

/**
 * The by-id run loader. `permissions` is REQUIRED (ruling P8b) — see
 * `getReportWithOwnerCheck`.
 */
export async function getReportRunWithOwnerCheck(
  runId: string,
  auth: AuthContext,
  action: ReportAction,
  permissions: GrantedReportPermissions,
) {
  const tenantConditions: SQL<unknown>[] = [eq(reportRuns.id, runId)];
  const tenantCondition = tenantAuthorizedRunCondition(auth, permissions);
  if (tenantCondition === null) return null;
  if (tenantCondition) tenantConditions.push(tenantCondition);

  const [metadata] = await db
    .select(reportRunMetadataProjection)
    .from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(and(...tenantConditions))
    .limit(1);

  if (!metadata) return null;
  // Ruling F1 / P8b, defense in depth (see getReportWithOwnerCheck).
  if (reportTypeHiddenFromCaller(metadata.type, auth)) return null;
  if (reportTypeHiddenByPermission(metadata.type, permissions)) return null;

  const owner = reportOwnerOfRow(metadata);
  if (!owner) return null;

  const authorityResult = await resolveReportOwnerAuthority(auth, owner, action);
  if (!authorityResult.ok || authorityResult.authority.scope.kind === 'legacy_unscoped') {
    return null;
  }
  const liveScope: LiveSiteScopeV1 = authorityResult.authority.scope;

  try {
    const storedScope = decodeSiteScope(
      metadata as unknown as PersistedSiteScopeColumns,
      decodeOwnerKey(owner),
    );
    if (!isSiteScopeSubset(storedScope, liveScope)) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    metadata,
    owner,
    /** `reports` row condition for the owner — join-side twin of the run predicate. */
    ownerCondition: reportOwnerCondition(owner),
    authority: authorityResult.authority as ReportExecutionAuthority & {
      scope: LiveSiteScopeV1;
    },
    runScopePredicate: reportOwnerScopePredicate(reportRuns, owner, liveScope),
  };
}

/** @deprecated #3198 W01 alias — remove in W02 once every caller uses the owner-aware name. */
export const getReportRunWithOrgCheck = getReportRunWithOwnerCheck;

export const reportRunMetadataProjection = {
  id: reportRuns.id,
  reportId: reportRuns.reportId,
  orgId: reports.orgId,
  partnerId: reports.partnerId,
  // Ruling F1: the loader's audience belt reads the definition's type.
  type: reports.type,
  executionScopeVersion: reportRuns.executionScopeVersion,
  executionScopeKind: reportRuns.executionScopeKind,
  executionScopeSiteIds: reportRuns.executionScopeSiteIds,
  executionScopeUserId: reportRuns.executionScopeUserId,
  executionScopeFingerprint: reportRuns.executionScopeFingerprint,
  executionScopeCapturedAt: reportRuns.executionScopeCapturedAt,
  executionScopePrincipalKind: reportRuns.executionScopePrincipalKind,
};

export async function getOrgIdsForAuth(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds'>
): Promise<string[] | null> {
  if (auth.scope === 'organization') {
    if (!auth.orgId) return null;
    return [auth.orgId];
  }

  if (auth.scope === 'partner') {
    return auth.accessibleOrgIds ?? [];
  }

  // system scope - return null to indicate no filtering needed
  return null;
}
