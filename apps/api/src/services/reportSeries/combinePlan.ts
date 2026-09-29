/**
 * Multi-org report series W04 (Combine) — the pure planning half: which rows
 * are combinable, how they group, which row per org is adopted in place, and
 * how the internal CC is resolved (spec §3.8). `combine.ts` supplies the rows
 * and performs the writes; nothing here touches the database.
 */
import type { ReportType } from '@breeze/shared';
import {
  combineGroupKey,
  normalizeCombineConfig,
  normalizeEmail,
  seriesConfigFrom,
  type CombineCadence,
  type CombineFormat,
} from './combineKey';
import { ReportSeriesError } from './errors';
import { assertSeriesConfigOrgAgnostic, assertSeriesTypeSupported } from './validation';

/** One `reports` row as `combine.ts` selects it (org name joined in). */
export interface CombineSourceRow {
  id: string;
  orgId: string | null;
  orgName: string;
  name: string;
  type: ReportType;
  format: CombineFormat;
  schedule: CombineCadence | 'one_time';
  config: unknown;
  lastGeneratedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  portalSelfService: boolean;
  sourceAiAgentScheduleId: string | null;
  /** Always null for a combinable row (org-owned); read for the scope rule. */
  partnerId: string | null;
  executionScopeVersion: number | null;
  executionScopeKind: string | null;
  executionScopeSiteIds: string[] | null;
  executionScopeUserId: string | null;
  executionScopeFingerprint: string | null;
  executionScopeCapturedAt: Date | null;
  executionScopePrincipalKind: string | null;
  seriesId: string | null;
  /** Set on a standalone copy detached from a series (W02). */
  detachedFromSeriesId: string | null;
  archivedAt: Date | null;
}

export type EligibleCombineRow = CombineSourceRow & { orgId: string; schedule: CombineCadence };

export type CombineExclusion =
  | 'partner_owned'
  | 'archived'
  | 'in_series'
  | 'detached_from_series'
  | 'one_time'
  | 'portal_self_service'
  | 'narrative'
  | 'system_managed'
  | 'site_restricted_scope'
  | 'incomplete_execution_scope'
  | 'type_unsupported'
  | 'config_invalid'
  | 'config_org_specific';

export interface KeyedCombineRow {
  row: EligibleCombineRow;
  groupKey: string;
  emailRecipients: string[];
}

/**
 * The pure twin of reportScheduleWorker's completeExecutableScopePredicate()
 * (same column rules, kind by kind). A row that fails it is never polled by
 * findDueReports, so it is not sending today; adopting it would capture a
 * fresh scope and restart it (W04 final review F1b).
 */
function hasCompleteExecutionScope(row: CombineSourceRow): boolean {
  if (row.executionScopeVersion !== 1) return false;
  if (row.executionScopeUserId === null || row.executionScopeFingerprint === null || row.executionScopeCapturedAt === null) {
    return false;
  }
  switch (row.executionScopeKind) {
    case 'unrestricted':
      return row.executionScopeSiteIds === null && row.orgId !== null;
    case 'restricted':
      return row.executionScopeSiteIds !== null && row.orgId !== null;
    case 'partner_wide':
      return row.executionScopeSiteIds === null && row.partnerId !== null;
    default:
      return false;
  }
}

/**
 * First matching exclusion wins. The row-level signals come first; the TYPE
 * and CONFIG gates reuse W02's series validators so Combine can never adopt a
 * row into a series that `POST /reports/series` would have refused.
 *  - portal_self_service also covers the org's managed evidence definition
 *    (`isManagedEvidenceType(type) AND portal_self_service`,
 *    routes/reports/helpers.ts isSystemManagedReportDefinition).
 *  - site_restricted_scope: adoption captures the owner's unrestricted scope;
 *    a restricted row would silently start covering every site.
 *  - incomplete_execution_scope: see hasCompleteExecutionScope. Such a row
 *    stays standalone, exactly as it is today.
 */
export function keyCombineRow(
  row: CombineSourceRow,
): { ok: true; keyed: KeyedCombineRow } | { ok: false; reason: CombineExclusion } {
  if (row.orgId === null) return { ok: false, reason: 'partner_owned' };
  if (row.archivedAt !== null) return { ok: false, reason: 'archived' };
  if (row.seriesId !== null) return { ok: false, reason: 'in_series' };
  // A copy deliberately detached from a series stays standalone: adopting it
  // would silently re-attach it (and its detached marker must be cleared with
  // series_id in one UPDATE — reports_series_child_detached_chk).
  if (row.detachedFromSeriesId !== null) return { ok: false, reason: 'detached_from_series' };
  if (row.schedule === 'one_time') return { ok: false, reason: 'one_time' };
  if (row.portalSelfService) return { ok: false, reason: 'portal_self_service' };
  if (row.sourceAiAgentScheduleId !== null) return { ok: false, reason: 'narrative' };
  if (row.executionScopePrincipalKind === 'system') return { ok: false, reason: 'system_managed' };
  if (row.executionScopeKind === 'restricted') return { ok: false, reason: 'site_restricted_scope' };
  if (!hasCompleteExecutionScope(row)) return { ok: false, reason: 'incomplete_execution_scope' };
  try {
    assertSeriesTypeSupported(row.type);
  } catch {
    return { ok: false, reason: 'type_unsupported' };
  }
  const normalized = normalizeCombineConfig(row.type, row.schedule, row.config);
  if (normalized === null) return { ok: false, reason: 'config_invalid' };
  try {
    assertSeriesConfigOrgAgnostic(row.config);
  } catch {
    return { ok: false, reason: 'config_org_specific' };
  }
  const eligible = row as EligibleCombineRow;
  return {
    ok: true,
    keyed: {
      row: eligible,
      groupKey: combineGroupKey({
        type: eligible.type,
        format: eligible.format,
        schedule: eligible.schedule,
        canonicalConfig: normalized.canonical,
      }),
      emailRecipients: normalized.emailRecipients,
    },
  };
}

export function combineExclusionReason(row: CombineSourceRow): CombineExclusion | null {
  const result = keyCombineRow(row);
  return result.ok ? null : result.reason;
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface CombineRowGroup {
  groupKey: string;
  type: ReportType;
  format: CombineFormat;
  schedule: CombineCadence;
  /** Sorted by report id. */
  rows: KeyedCombineRow[];
}

/** Eligible rows grouped by key; only groups spanning >= 2 distinct orgs. */
export function groupCombineRows(rows: readonly CombineSourceRow[]): CombineRowGroup[] {
  const byKey = new Map<string, KeyedCombineRow[]>();
  for (const candidate of rows) {
    const result = keyCombineRow(candidate);
    if (!result.ok) continue;
    const list = byKey.get(result.keyed.groupKey) ?? [];
    list.push(result.keyed);
    byKey.set(result.keyed.groupKey, list);
  }
  const groups: CombineRowGroup[] = [];
  for (const [groupKey, keyed] of byKey) {
    if (new Set(keyed.map((k) => k.row.orgId)).size < 2) continue;
    keyed.sort((a, b) => compareIds(a.row.id, b.row.id));
    const first = keyed[0]!.row;
    groups.push({ groupKey, type: first.type, format: first.format, schedule: first.schedule, rows: keyed });
  }
  return groups.sort((a, b) => compareIds(a.groupKey, b.groupKey));
}

export interface PlannedCombineOrg {
  orgId: string;
  orgName: string;
  adopt: EligibleCombineRow;
  archive: EligibleCombineRow[];
}

export interface PlannedCombineGroup extends CombineRowGroup {
  /** Sorted by org name (en), then org id. */
  orgs: PlannedCombineOrg[];
  seriesConfig: Record<string, unknown>;
  suggestedName: string;
}

/** Adoption priority: deliverable-linked, newest run (NULL last), newest
 *  created, smallest id. */
function adoptionOrder(linked: ReadonlySet<string>) {
  return (a: EligibleCombineRow, b: EligibleCombineRow): number => {
    const la = linked.has(a.id) ? 0 : 1;
    const lb = linked.has(b.id) ? 0 : 1;
    if (la !== lb) return la - lb;
    const ga = a.lastGeneratedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const gb = b.lastGeneratedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (ga !== gb) return gb > ga ? 1 : -1;
    const ca = a.createdAt.getTime();
    const cb = b.createdAt.getTime();
    if (ca !== cb) return cb - ca;
    return compareIds(a.id, b.id);
  };
}

/**
 * The lastGeneratedAt the adopted row must carry (W04 final review F1a): the
 * NEWEST non-null value among the org's rows in the locked group (the adopted
 * row plus its archived duplicates). An adopted row keeps its own schedule
 * position otherwise, so a stalled row adopted next to a duplicate that
 * already sent this occurrence would be overdue and send it a second time.
 * Never lower than the adopted row's own value (it is one of the inputs);
 * null only when no row of the org ever ran. Values are the column's raw
 * reads, compared as adoptionOrder compares them.
 */
export function carriedLastGeneratedAt(org: Pick<PlannedCombineOrg, 'adopt' | 'archive'>): Date | null {
  let newest: Date | null = null;
  for (const row of [org.adopt, ...org.archive]) {
    const value = row.lastGeneratedAt;
    if (value !== null && (newest === null || value.getTime() > newest.getTime())) newest = value;
  }
  return newest;
}

/** A worker scope denial (reportScheduleWorker deny()): a failed run whose
 *  error is a `scope_*` reason. */
export function isScopeDenialRun(run: { status: string; errorMessage: string | null }): boolean {
  return run.status === 'failed' && (run.errorMessage ?? '').startsWith('scope_');
}

function suggestName(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))[0]![0];
}

export function planGroupAdoption(
  group: CombineRowGroup,
  deliverableLinkedReportIds: ReadonlySet<string>,
): PlannedCombineGroup {
  const byOrg = new Map<string, EligibleCombineRow[]>();
  for (const { row } of group.rows) byOrg.set(row.orgId, [...(byOrg.get(row.orgId) ?? []), row]);
  const order = adoptionOrder(deliverableLinkedReportIds);
  const orgs = [...byOrg.entries()]
    .map(([orgId, orgRows]): PlannedCombineOrg => {
      const [adopt, ...archive] = [...orgRows].sort(order);
      return { orgId, orgName: adopt!.orgName, adopt: adopt!, archive };
    })
    .sort((a, b) => a.orgName.localeCompare(b.orgName, 'en') || compareIds(a.orgId, b.orgId));
  const source = orgs
    .map((o) => o.adopt)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || compareIds(a.id, b.id))[0]!;
  return {
    ...group,
    orgs,
    seriesConfig: seriesConfigFrom(source.config as Record<string, unknown>),
    suggestedName: suggestName(group.rows.map((k) => k.row.name)),
  };
}

export interface CcSplit {
  /** On EVERY row of the group; becomes the series internal CC. Sorted. */
  shared: string[];
  /** On some rows only; must be resolved. Sorted by email; reportIds sorted. */
  conflicting: { email: string; reportIds: string[] }[];
}

export function splitCombineCc(group: { rows: readonly KeyedCombineRow[] }): CcSplit {
  const holders = new Map<string, string[]>();
  for (const { row, emailRecipients } of group.rows) {
    for (const email of emailRecipients) holders.set(email, [...(holders.get(email) ?? []), row.id]);
  }
  const shared: string[] = [];
  const conflicting: CcSplit['conflicting'] = [];
  for (const [email, reportIds] of [...holders.entries()].sort((a, b) => compareIds(a[0], b[0]))) {
    if (reportIds.length === group.rows.length) shared.push(email);
    else conflicting.push({ email, reportIds: [...reportIds].sort(compareIds) });
  }
  return { shared, conflicting };
}

export interface CcResolution {
  include: readonly string[];
  drop: readonly string[];
}

export type CcResolveResult =
  | { ok: true; internalCc: string[]; addedCc: string[] }
  | { ok: false; shared: string[]; unresolved: CcSplit['conflicting']; unexpected: string[] };

/** Every conflicting address must be in exactly one of include/drop, and
 *  nothing else may be named (a typo or a stale dialog). */
export function resolveCombineCc(split: CcSplit, resolution: CcResolution): CcResolveResult {
  const include = new Set(resolution.include.map(normalizeEmail));
  const drop = new Set(resolution.drop.map(normalizeEmail));
  const conflictEmails = new Set(split.conflicting.map((c) => c.email));
  const unexpected = [...new Set([...include, ...drop])]
    .filter((email) => !conflictEmails.has(email) || (include.has(email) && drop.has(email)))
    .sort(compareIds);
  const unresolved = split.conflicting.filter((c) => !include.has(c.email) && !drop.has(c.email));
  if (unresolved.length > 0 || unexpected.length > 0) {
    return { ok: false, shared: split.shared, unresolved, unexpected };
  }
  const addedCc = split.conflicting.filter((c) => include.has(c.email)).map((c) => c.email);
  return { ok: true, internalCc: [...split.shared, ...addedCc].sort(compareIds), addedCc };
}

/** `legacyReportConfigSchema.emailRecipients` caps a config at 50 addresses;
 *  every child receives the internal CC as `config.emailRecipients`. */
export const MAX_INTERNAL_CC = 50;

export type CombineErrorCode =
  | 'combine_group_changed'
  | 'combine_cc_conflict'
  | 'combine_cc_too_many'
  | 'recipients_need_export_and_mfa'
  | 'series_owner_ineligible';

/**
 * A Combine refusal. A subclass of W02's ReportSeriesError, never a parallel
 * class: routes map it through the one `seriesErrorResponse`, which answers
 * `status` with `body` verbatim. It narrows `code` to the Combine codes and
 * makes `body` required, because the dialog reads its fields (`unresolved`,
 * `orgIds`).
 */
export class CombineError extends ReportSeriesError {
  declare readonly code: CombineErrorCode;
  declare readonly body: Record<string, unknown>;

  constructor(code: CombineErrorCode, status: 400 | 403 | 409, body: Record<string, unknown>) {
    super(code, status, body);
    this.name = 'CombineError';
  }
}

export interface CombineContactRecipient {
  contactId: string;
  name: string | null;
  email: string | null;
}

export interface CombineCandidateRow {
  reportId: string;
  name: string;
  lastGeneratedAt: string | null;
  action: 'adopt' | 'archive';
  deliverableLinked: boolean;
  /** Its most recent run was a worker scope denial (isScopeDenialRun): it is
   *  not sending today, and combining resumes it (W04 final review F1c). */
  stalled: boolean;
  contactRecipients: CombineContactRecipient[];
  emailRecipients: string[];
}

export interface CombineCandidateOrg {
  orgId: string;
  orgName: string;
  rows: CombineCandidateRow[];
}

export interface CombineCandidateGroup {
  groupKey: string;
  type: ReportType;
  format: CombineFormat;
  schedule: CombineCadence;
  suggestedName: string;
  orgs: CombineCandidateOrg[];
  sharedCc: string[];
  conflictingCc: CcSplit['conflicting'];
}

export function toCandidateGroup(
  plan: PlannedCombineGroup,
  recipientsByReport: ReadonlyMap<string, CombineContactRecipient[]>,
  linked: ReadonlySet<string>,
  stalled: ReadonlySet<string>,
): CombineCandidateGroup {
  const split = splitCombineCc(plan);
  const emails = new Map(plan.rows.map((k) => [k.row.id, k.emailRecipients]));
  const toRow = (row: EligibleCombineRow, action: 'adopt' | 'archive'): CombineCandidateRow => ({
    reportId: row.id,
    name: row.name,
    lastGeneratedAt: row.lastGeneratedAt ? row.lastGeneratedAt.toISOString() : null,
    action,
    deliverableLinked: linked.has(row.id),
    stalled: stalled.has(row.id),
    contactRecipients: recipientsByReport.get(row.id) ?? [],
    emailRecipients: emails.get(row.id) ?? [],
  });
  return {
    groupKey: plan.groupKey,
    type: plan.type,
    format: plan.format,
    schedule: plan.schedule,
    suggestedName: plan.suggestedName,
    orgs: plan.orgs.map((o) => ({
      orgId: o.orgId,
      orgName: o.orgName,
      rows: [toRow(o.adopt, 'adopt'), ...o.archive.map((r) => toRow(r, 'archive'))],
    })),
    sharedCc: split.shared,
    conflictingCc: split.conflicting,
  };
}
