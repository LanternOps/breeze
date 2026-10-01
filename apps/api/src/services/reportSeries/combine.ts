/**
 * Multi-org report series W04 — Combine (spec §3.8, decision D4: opt-in only).
 *
 * `findCombineCandidates` lists groups of near-identical org-owned reports of
 * ONE partner; `combineIntoSeries` turns one group into a series in ONE
 * transaction, adopting a row per org IN PLACE (id, runs, evidence and contact
 * recipients survive) and archiving same-org duplicates.
 *
 * Both functions trust their caller for the partner-wide gate
 * (routes/reports/seriesCombine.ts); combineIntoSeries re-checks it as a belt.
 * Every `reports` read here is org-owned only (isNotNull(reports.orgId)) and
 * joined to organizations of ONE partner; see the allowlist entries in
 * partnerOwnedVisibility.scan.test.ts.
 */
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  contacts,
  organizations,
  reportRuns,
  reportScheduleRecipients,
  reportSeries,
  reportSeriesOrgTargets,
  reports,
  serviceDeliverables,
} from '../../db/schema';
import type { db } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from '../partnerWideAccess';
import { notHiddenOrgType } from '../unassignedPool/visibility';
import { assertSeriesOwnerEligible, captureChildExecutionScope } from './authority';
import {
  CombineError,
  MAX_INTERNAL_CC,
  carriedLastGeneratedAt,
  combinePlanFingerprint,
  groupCombineRows,
  isScopeDenialRun,
  planGroupAdoption,
  resolveCombineCc,
  splitCombineCc,
  toCandidateGroup,
  type CcResolution,
  type CombineCandidateGroup,
  type CombineContactRecipient,
  type CombineSourceRow,
  type EligibleCombineRow,
} from './combinePlan';
import { reconcileSeries } from './reconcile';
import type { SeriesTx } from './types';
import { assertSeriesConfigOrgAgnostic, assertSeriesTypeSupported } from './validation';

/** W02's SeriesTx plus DISTINCT ON (loadStalledReportIds); `db` and every
 *  transaction handle have it. */
type Tx = SeriesTx & Pick<typeof db, 'selectDistinctOn'>;
type ChildScopeColumns = Exclude<Awaited<ReturnType<typeof captureChildExecutionScope>>, 'no_authority'>;

export interface CombineInput {
  groupKey: string;
  /** combinePlanFingerprint of the plan the dialog showed (candidate DTO). */
  planFingerprint: string;
  /** Every row the dialog showed for the group (adopt + archive). */
  reportIds: string[];
  name: string;
  targetMode: 'selected' | 'all';
  ccResolution: CcResolution;
  /** Server-derived (routes/reports/recipientGate.ts): reports:export AND a
   *  satisfied MFA session. NEVER read from the request body. */
  callerMaySetEmailRecipients: boolean;
}

export type CombineAuth = Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'> & { user: { id: string } };

export interface CombineResult {
  seriesId: string;
  adopted: { reportId: string; orgId: string }[];
  archived: { reportId: string; orgId: string }[];
  repointedDeliverableIds: string[];
}

const COMBINE_ROW_COLUMNS = {
  id: reports.id,
  orgId: reports.orgId,
  orgName: organizations.name,
  name: reports.name,
  type: reports.type,
  format: reports.format,
  schedule: reports.schedule,
  config: reports.config,
  lastGeneratedAt: reports.lastGeneratedAt,
  createdAt: reports.createdAt,
  updatedAt: reports.updatedAt,
  portalSelfService: reports.portalSelfService,
  sourceAiAgentScheduleId: reports.sourceAiAgentScheduleId,
  partnerId: reports.partnerId,
  executionScopeVersion: reports.executionScopeVersion,
  executionScopeKind: reports.executionScopeKind,
  executionScopeSiteIds: reports.executionScopeSiteIds,
  executionScopeUserId: reports.executionScopeUserId,
  executionScopeFingerprint: reports.executionScopeFingerprint,
  executionScopeCapturedAt: reports.executionScopeCapturedAt,
  executionScopePrincipalKind: reports.executionScopePrincipalKind,
  seriesId: reports.seriesId,
  detachedFromSeriesId: reports.detachedFromSeriesId,
  archivedAt: reports.archivedAt,
};

/** Series-eligible orgs only (spec §3.3, targets.ts eligiblePartnerOrgs): a
 *  row in any other org would be archived by the reconciler the moment it was
 *  adopted. Hidden org types (Quick Support, the holding org) are never
 *  eligible. */
function eligibleOrgCondition() {
  return and(
    inArray(organizations.status, ['active', 'trial']),
    isNull(organizations.deletedAt),
    notHiddenOrgType(),
  );
}

async function loadCandidateRows(partnerId: string, tx: Tx): Promise<CombineSourceRow[]> {
  return tx
    .select(COMBINE_ROW_COLUMNS)
    .from(reports)
    .innerJoin(organizations, eq(organizations.id, reports.orgId))
    .where(and(
      eq(organizations.partnerId, partnerId),
      eligibleOrgCondition(),
      isNotNull(reports.orgId),
      isNull(reports.seriesId),
      isNull(reports.archivedAt),
    ));
}

/** Re-reads the caller's rows under lock. Deliberately NO series/archived
 *  filter: a row combined meanwhile must come back so it can fail
 *  `keyCombineRow` ('in_series') and turn the call into combine_group_changed. */
async function loadLockedGroupRows(partnerId: string, reportIds: readonly string[], tx: Tx): Promise<CombineSourceRow[]> {
  return tx
    .select(COMBINE_ROW_COLUMNS)
    .from(reports)
    .innerJoin(organizations, eq(organizations.id, reports.orgId))
    .where(and(
      inArray(reports.id, [...reportIds]),
      eq(organizations.partnerId, partnerId),
      eligibleOrgCondition(),
      isNotNull(reports.orgId),
    ))
    .for('update', { of: reports });
}

async function loadDeliverableLinks(reportIds: readonly string[], tx: Tx) {
  if (reportIds.length === 0) return [];
  return tx
    .select({ id: serviceDeliverables.id, orgId: serviceDeliverables.orgId, reportId: serviceDeliverables.autoEvidenceReportId })
    .from(serviceDeliverables)
    .where(inArray(serviceDeliverables.autoEvidenceReportId, [...reportIds]));
}

function linkedReportIds(links: readonly { reportId: string | null }[]): Set<string> {
  return new Set(links.flatMap((l) => (l.reportId ? [l.reportId] : [])));
}

async function loadContactRecipients(reportIds: readonly string[], tx: Tx): Promise<Map<string, CombineContactRecipient[]>> {
  const byReport = new Map<string, CombineContactRecipient[]>();
  if (reportIds.length === 0) return byReport;
  const rows = await tx
    .select({
      reportId: reportScheduleRecipients.reportId,
      contactId: reportScheduleRecipients.contactId,
      name: contacts.name,
      email: contacts.email,
    })
    .from(reportScheduleRecipients)
    .innerJoin(contacts, and(eq(contacts.id, reportScheduleRecipients.contactId), eq(contacts.orgId, reportScheduleRecipients.orgId)))
    .where(and(inArray(reportScheduleRecipients.reportId, [...reportIds]), eq(reportScheduleRecipients.mode, 'add')));
  for (const r of rows) {
    byReport.set(r.reportId, [...(byReport.get(r.reportId) ?? []), { contactId: r.contactId, name: r.name, email: r.email }]);
  }
  for (const list of byReport.values()) list.sort((a, b) => (a.contactId < b.contactId ? -1 : 1));
  return byReport;
}

/**
 * Rows whose MOST RECENT run is a worker scope denial (isScopeDenialRun): not
 * sending today. ONE query for every grouped id — DISTINCT ON (report_id)
 * over the (report_id, created_at DESC, id DESC) index order.
 */
async function loadStalledReportIds(reportIds: readonly string[], tx: Tx): Promise<Set<string>> {
  if (reportIds.length === 0) return new Set();
  const latest = await tx
    .selectDistinctOn([reportRuns.reportId], {
      reportId: reportRuns.reportId,
      status: reportRuns.status,
      errorMessage: reportRuns.errorMessage,
    })
    .from(reportRuns)
    .where(inArray(reportRuns.reportId, [...reportIds]))
    .orderBy(reportRuns.reportId, desc(reportRuns.createdAt), desc(reportRuns.id));
  return new Set(latest.filter(isScopeDenialRun).map((run) => run.reportId));
}

/**
 * Groups of >= 2 orgs whose rows could be combined. Read-only. The caller must
 * already have passed the partner-wide gate for `partnerId`.
 */
export async function findCombineCandidates(partnerId: string, tx: Tx): Promise<CombineCandidateGroup[]> {
  const groups = groupCombineRows(await loadCandidateRows(partnerId, tx));
  if (groups.length === 0) return [];
  const groupedIds = groups.flatMap((g) => g.rows.map((k) => k.row.id));
  const linked = linkedReportIds(await loadDeliverableLinks(groupedIds, tx));
  const recipients = await loadContactRecipients(groupedIds, tx);
  const stalled = await loadStalledReportIds(groupedIds, tx);
  return groups
    .map((g) => toCandidateGroup(planGroupAdoption(g, linked), recipients, linked, stalled))
    .sort((a, b) => b.orgs.length - a.orgs.length
      || a.suggestedName.localeCompare(b.suggestedName, 'en')
      || (a.groupKey < b.groupKey ? -1 : 1));
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === a.length && sb.size === b.length && sa.size === sb.size && [...sa].every((id) => sb.has(id));
}

const groupChanged = () => new CombineError('combine_group_changed', 409, { error: 'combine_group_changed' });

/** Copies the archived duplicates' contact recipients onto the adopted row, so
 *  the org's customers keep receiving exactly what they receive today. */
async function copyDuplicateRecipients(adoptedId: string, orgId: string, duplicateIds: readonly string[], tx: Tx): Promise<void> {
  const rows = await tx
    .select({ contactId: reportScheduleRecipients.contactId })
    .from(reportScheduleRecipients)
    .where(and(
      inArray(reportScheduleRecipients.reportId, [...duplicateIds]),
      eq(reportScheduleRecipients.orgId, orgId),
      eq(reportScheduleRecipients.mode, 'add'),
    ));
  const contactIds = [...new Set(rows.map((r) => r.contactId))];
  if (contactIds.length === 0) return;
  await tx
    .insert(reportScheduleRecipients)
    .values(contactIds.map((contactId) => ({ reportId: adoptedId, orgId, contactId, mode: 'add' as const })))
    .onConflictDoNothing();
}

/** A deliverable fed by a duplicate now feeds from the adopted row (same org,
 *  same type, same normalized config). Past evidence rows are not touched. */
async function repointDeliverables(adoptedId: string, orgId: string, duplicateIds: readonly string[], tx: Tx): Promise<string[]> {
  const rows = await tx
    .update(serviceDeliverables)
    .set({ autoEvidenceReportId: adoptedId, updatedAt: new Date() })
    .where(and(eq(serviceDeliverables.orgId, orgId), inArray(serviceDeliverables.autoEvidenceReportId, [...duplicateIds])))
    .returning({ id: serviceDeliverables.id });
  return rows.map((r) => r.id);
}

async function archiveCombineExtras(orgId: string, duplicateIds: readonly string[], tx: Tx): Promise<void> {
  const rows = await tx
    .update(reports)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(
      inArray(reports.id, [...duplicateIds]),
      eq(reports.orgId, orgId),
      isNull(reports.seriesId),
      isNull(reports.archivedAt),
    ))
    .returning({ id: reports.id });
  if (rows.length !== duplicateIds.length) throw groupChanged();
}

/**
 * Adopts one row: links it to the series at revision 0 (always older than the
 * series' revision, which starts at 1) and stores the owner's execution scope
 * for this org. `reconcileSeries` then overwrites the shared fields through
 * its stale-child branch — the reconciler stays the ONE writer of a child's
 * shared fields.
 *
 * `lastGeneratedAt` is the org's newest run in the locked group
 * (carriedLastGeneratedAt, W04 final review F1a): the fresh scope makes a
 * stalled row executable, and without the carried value it would be overdue
 * for an occurrence its duplicate already sent. It is the column's own read,
 * written back through the same Drizzle column mapping (an exact round trip);
 * only a newer value is written.
 */
async function adoptCombineRow(
  row: EligibleCombineRow,
  seriesId: string,
  scope: ChildScopeColumns,
  lastGeneratedAt: Date | null,
  tx: Tx,
): Promise<void> {
  const carried = lastGeneratedAt !== null
    && (row.lastGeneratedAt === null || lastGeneratedAt.getTime() > row.lastGeneratedAt.getTime())
    ? { lastGeneratedAt }
    : {};
  const rows = await tx
    .update(reports)
    // detachedFromSeriesId is already null (keyCombineRow excludes detached
    // standalones); cleared defensively per reports_series_child_detached_chk.
    .set({ seriesId, seriesRevision: 0, detachedFromSeriesId: null, ...scope, ...carried, updatedAt: new Date() })
    .where(and(
      eq(reports.id, row.id),
      eq(reports.orgId, row.orgId),
      isNull(reports.seriesId),
      isNull(reports.archivedAt),
    ))
    .returning({ id: reports.id });
  if (rows.length !== 1) throw groupChanged();
}

export async function combineIntoSeries(input: CombineInput, auth: CombineAuth, tx: Tx): Promise<CombineResult> {
  if (auth.scope !== 'partner' || !auth.partnerId || !canManagePartnerWidePolicies(auth)) {
    throw new PartnerWideWriteDeniedError();
  }
  const partnerId = auth.partnerId;

  const locked = await loadLockedGroupRows(partnerId, input.reportIds, tx);
  const group = groupCombineRows(locked).find((g) => g.groupKey === input.groupKey);
  if (!group || !sameIdSet(group.rows.map((k) => k.row.id), input.reportIds)) throw groupChanged();

  assertSeriesTypeSupported(group.type);
  const links = await loadDeliverableLinks(input.reportIds, tx);
  const plan = planGroupAdoption(group, linkedReportIds(links));
  assertSeriesConfigOrgAgnostic(plan.seriesConfig);

  // Same key and ids, different plan (a CC edit, or a run that changed which
  // row is adopted): not what the user approved. Checked before the CC
  // resolution, so a stale dialog refreshes instead of looping on cc_conflict.
  const split = splitCombineCc(plan);
  if (combinePlanFingerprint(plan, split) !== input.planFingerprint) throw groupChanged();
  const cc = resolveCombineCc(split, input.ccResolution);
  if (!cc.ok) {
    throw new CombineError('combine_cc_conflict', 409, {
      error: 'combine_cc_conflict', shared: cc.shared, unresolved: cc.unresolved, unexpected: cc.unexpected,
    });
  }
  if (cc.internalCc.length > MAX_INTERNAL_CC) {
    throw new CombineError('combine_cc_too_many', 400, { error: 'combine_cc_too_many', max: MAX_INTERNAL_CC });
  }
  const addsDeliveries = cc.addedCc.length > 0 || (input.targetMode === 'all' && cc.internalCc.length > 0);
  if (addsDeliveries && !input.callerMaySetEmailRecipients) {
    throw new CombineError('recipients_need_export_and_mfa', 403, { error: 'recipients_need_export_and_mfa' });
  }

  await assertSeriesOwnerEligible(auth.user.id, partnerId, tx);
  const scopes = new Map<string, ChildScopeColumns>();
  const blocked: string[] = [];
  for (const org of plan.orgs) {
    const scope = await captureChildExecutionScope(auth.user.id, org.orgId, tx);
    if (scope === 'no_authority') blocked.push(org.orgId);
    else scopes.set(org.orgId, scope);
  }
  if (blocked.length > 0) {
    throw new CombineError('series_owner_ineligible', 400, { error: 'series_owner_ineligible', orgIds: blocked });
  }

  const [series] = await tx
    .insert(reportSeries)
    .values({
      partnerId,
      name: input.name,
      type: plan.type,
      format: plan.format,
      schedule: plan.schedule,
      config: plan.seriesConfig,
      targetMode: input.targetMode,
      recipientRule: { primaryContact: false, roles: [] },
      internalCc: cc.internalCc,
      enabled: true,
      ownerUserId: auth.user.id,
      createdBy: auth.user.id,
    })
    .returning({ id: reportSeries.id });
  const seriesId = series!.id;
  if (input.targetMode === 'selected') {
    await tx.insert(reportSeriesOrgTargets).values(plan.orgs.map((o) => ({ seriesId, orgId: o.orgId })));
  }

  const archived: CombineResult['archived'] = [];
  const repointedDeliverableIds: string[] = [];
  for (const org of plan.orgs) {
    const duplicateIds = org.archive.map((r) => r.id);
    if (duplicateIds.length > 0) {
      await copyDuplicateRecipients(org.adopt.id, org.orgId, duplicateIds, tx);
      repointedDeliverableIds.push(...await repointDeliverables(org.adopt.id, org.orgId, duplicateIds, tx));
      await archiveCombineExtras(org.orgId, duplicateIds, tx);
      archived.push(...duplicateIds.map((reportId) => ({ reportId, orgId: org.orgId })));
    }
    await adoptCombineRow(org.adopt, seriesId, scopes.get(org.orgId)!, carriedLastGeneratedAt(org), tx);
  }

  // Writes every adopted child's shared fields (revision 0 → series.revision),
  // and in 'all' mode creates children for the partner's other eligible orgs.
  await reconcileSeries(seriesId, tx);

  return {
    seriesId,
    adopted: plan.orgs.map((o) => ({ reportId: o.adopt.id, orgId: o.orgId })),
    archived,
    repointedDeliverableIds,
  };
}
