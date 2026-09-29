/**
 * Multi-org report series — the store behind /reports/series (spec §3.6).
 *
 * Every entry point re-asserts the partner-wide gate (requireSeriesPartner:
 * partner scope + canManagePartnerWidePolicies) and takes partner_id from the
 * token, never the body. Every write reconciles in the same transaction
 * (spec §3.3 trigger 1). Whether a write ADDS a delivery is decided here,
 * against the locked current row (INDEX recipient delivery gate); the route
 * only supplies whether the caller may add one.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  reportRuns,
  reports,
  reportSeries,
  reportSeriesOrgTargets,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';
import { isUsableOrgStatus } from '../tenantStatus';
import { assertSeriesOwnerEligible, isSeriesOwnerEligible } from './authority';
import { ReportSeriesError, seriesNotFound } from './errors';
import { listSeriesChildren, reconcileSeries, type SeriesChildRow } from './reconcile';
import { materializeDetachedRecipients, resolveSeriesRecipientsForOrgs } from './recipients';
import {
  assertNoHiddenTargetOrgs,
  eligiblePartnerOrgs,
  listDetachedOrgIds,
  listSeriesDetailOrgs,
  listSeriesTargetRows,
  resolveSeriesTargetOrgIds,
  resolveTargetsForSeries,
} from './targets';
import {
  parseSeriesRecipientRule,
  recipientRuleIsActive,
  type ReconcileResult,
  type ReportDeliveryStatus,
  type ReportSeriesRow,
  type SeriesDetail,
  type SeriesOrgState,
  type SeriesOrgStatus,
  type SeriesRecipientPreview,
  type SeriesRecipientRule,
  type SeriesTargetMode,
  type SeriesTx,
} from './types';

export type SeriesAuth = Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess' | 'user'>;

const DELIVERY_GATE_MESSAGE =
  'Adding email recipients to a multi-org report requires the export permission and an MFA-verified session';

export function seriesWriteAllowed(
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'>,
): boolean {
  return auth.scope === 'partner'
    && typeof auth.partnerId === 'string'
    && auth.partnerId.length > 0
    && canManagePartnerWidePolicies(auth);
}

function requireSeriesPartner(auth: Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'>): string {
  if (!seriesWriteAllowed(auth)) {
    throw new ReportSeriesError('series_write_denied', 403, { message: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
  }
  return auth.partnerId as string;
}

function requireDeliveryGate(mayAddDelivery: boolean): void {
  if (!mayAddDelivery) {
    throw new ReportSeriesError('recipients_need_export_and_mfa', 403, { message: DELIVERY_GATE_MESSAGE });
  }
}

/** Defence in depth: internal CC is `internal_cc`; `emailRecipients` on a series config would be dropped by the child builder anyway. */
export function withoutEmailRecipients(config: Record<string, unknown>): Record<string, unknown> {
  const { emailRecipients: _dropped, ...rest } = config;
  return rest;
}

export function ccWidensDelivery(before: readonly string[], after: readonly string[]): boolean {
  const known = new Set(before.map((email) => email.trim().toLowerCase()));
  return after.some((email) => !known.has(email.trim().toLowerCase()));
}

export function ruleWidensDelivery(before: SeriesRecipientRule, after: SeriesRecipientRule): boolean {
  return (after.primaryContact && !before.primaryContact)
    || after.roles.some((role) => !before.roles.includes(role));
}

function deliversAnything(rule: SeriesRecipientRule, internalCc: readonly string[]): boolean {
  return recipientRuleIsActive(rule) || internalCc.length > 0;
}

export function seriesOrgState(input: {
  orgStatus: string | null;
  orgDeletedAt: Date | null;
  targeted: boolean;
  ownerEligible: boolean;
  ownerUserId: string | null;
  child: SeriesChildRow | undefined;
  customerCount: number;
  ccCount: number;
  /** A live standalone detached from this series exists in the org. */
  detached?: boolean;
}): SeriesOrgState {
  if (!isUsableOrgStatus(input.orgStatus) || input.orgDeletedAt !== null) return 'ineligible';
  if (input.detached) return 'detached';
  if (!input.targeted) return 'excluded';
  if (
    !input.ownerEligible
    || !input.child
    || input.child.executionScopeUserId === null
    || input.child.executionScopeUserId !== input.ownerUserId
  ) {
    return 'blocked_no_authority';
  }
  if (input.customerCount === 0 && input.ccCount === 0) return 'blocked_no_recipients';
  return 'active';
}

export interface CreateSeriesInput {
  name: string;
  type: ReportSeriesRow['type'];
  format: ReportSeriesRow['format'];
  schedule: ReportSeriesRow['schedule'];
  config: Record<string, unknown>;
  targetMode: SeriesTargetMode;
  orgIds: string[];
  recipientRule: SeriesRecipientRule;
  internalCc: string[];
  enabled: boolean;
  ownerUserId: string;
}

export async function createSeries(
  input: CreateSeriesInput,
  auth: SeriesAuth,
  tx: SeriesTx,
  options: { mayAddDelivery: boolean },
): Promise<{ series: ReportSeriesRow; reconcile: ReconcileResult }> {
  const partnerId = requireSeriesPartner(auth);
  if (deliversAnything(input.recipientRule, input.internalCc)) requireDeliveryGate(options.mayAddDelivery);
  await assertSeriesOwnerEligible(input.ownerUserId, partnerId, tx);
  await assertNoHiddenTargetOrgs(input.orgIds, tx);

  const [series] = await tx
    .insert(reportSeries)
    .values({
      partnerId,
      name: input.name,
      type: input.type,
      format: input.format,
      schedule: input.schedule,
      config: withoutEmailRecipients(input.config),
      targetMode: input.targetMode,
      recipientRule: input.recipientRule,
      internalCc: input.internalCc,
      enabled: input.enabled,
      ownerUserId: input.ownerUserId,
      createdBy: auth.user.id,
    })
    .returning();
  if (!series) throw new Error('report_series insert returned no row');
  if (input.orgIds.length > 0) {
    await tx.insert(reportSeriesOrgTargets).values(input.orgIds.map((orgId) => ({ seriesId: series.id, orgId })));
  }
  return { series, reconcile: await reconcileSeries(series.id, tx) };
}

export async function loadOwnSeries(
  seriesId: string,
  auth: Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'>,
  tx: SeriesTx = db,
): Promise<ReportSeriesRow> {
  const partnerId = requireSeriesPartner(auth);
  const [row] = await tx
    .select()
    .from(reportSeries)
    .where(and(eq(reportSeries.id, seriesId), eq(reportSeries.partnerId, partnerId)))
    .limit(1);
  if (!row) throw seriesNotFound();
  return row;
}

async function lockOwnSeries(seriesId: string, partnerId: string, tx: SeriesTx): Promise<ReportSeriesRow> {
  const [row] = await tx
    .select()
    .from(reportSeries)
    .where(and(eq(reportSeries.id, seriesId), eq(reportSeries.partnerId, partnerId)))
    .limit(1)
    .for('update');
  if (!row) throw seriesNotFound();
  return row;
}

export interface UpdateSeriesPatch {
  name?: string;
  format?: ReportSeriesRow['format'];
  schedule?: ReportSeriesRow['schedule'];
  config?: Record<string, unknown>;
  recipientRule?: SeriesRecipientRule;
  internalCc?: string[];
  enabled?: boolean;
}

/** Fields copied onto every child: changing one bumps the revision. */
const REVISION_FIELDS = ['name', 'format', 'schedule', 'config', 'internalCc'] as const;

export async function updateSeries(
  seriesId: string,
  patch: UpdateSeriesPatch,
  auth: SeriesAuth,
  tx: SeriesTx,
  options: { mayAddDelivery: boolean },
): Promise<{ series: ReportSeriesRow; reconcile: ReconcileResult }> {
  const partnerId = requireSeriesPartner(auth);
  const current = await lockOwnSeries(seriesId, partnerId, tx);
  const widens = (patch.internalCc !== undefined && ccWidensDelivery(current.internalCc, patch.internalCc))
    || (patch.recipientRule !== undefined
      && ruleWidensDelivery(parseSeriesRecipientRule(current.recipientRule), patch.recipientRule));
  if (widens) requireDeliveryGate(options.mayAddDelivery);

  const set: Partial<typeof reportSeries.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.format !== undefined) set.format = patch.format;
  if (patch.schedule !== undefined) set.schedule = patch.schedule;
  if (patch.config !== undefined) set.config = withoutEmailRecipients(patch.config);
  if (patch.recipientRule !== undefined) set.recipientRule = patch.recipientRule;
  if (patch.internalCc !== undefined) set.internalCc = patch.internalCc;
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (REVISION_FIELDS.some((field) => patch[field] !== undefined)) set.revision = current.revision + 1;

  const [series] = await tx.update(reportSeries).set(set).where(eq(reportSeries.id, seriesId)).returning();
  return { series: series!, reconcile: await reconcileSeries(seriesId, tx) };
}

export async function replaceSeriesTargets(
  seriesId: string,
  input: { targetMode: SeriesTargetMode; orgIds: string[] },
  auth: SeriesAuth,
  tx: SeriesTx,
  options: { mayAddDelivery: boolean },
): Promise<{ series: ReportSeriesRow; reconcile: ReconcileResult }> {
  const partnerId = requireSeriesPartner(auth);
  const current = await lockOwnSeries(seriesId, partnerId, tx);
  await assertNoHiddenTargetOrgs(input.orgIds, tx);
  const before = new Set(await resolveSeriesTargetOrgIds(current, tx));
  const eligible = await eligiblePartnerOrgs(partnerId, tx);
  const after = await resolveTargetsForSeries(
    seriesId, eligible.map((org) => org.id), input.targetMode, new Set(input.orgIds), tx,
  );
  const addsOrgs = after.some((orgId) => !before.has(orgId));
  if (addsOrgs && deliversAnything(parseSeriesRecipientRule(current.recipientRule), current.internalCc)) {
    requireDeliveryGate(options.mayAddDelivery);
  }

  // target_mode FIRST: a mode change fires report_series_target_mode_reset,
  // which clears EVERY target row of the series (including rows for orgs the
  // caller's RLS cannot see, whose exclusion would otherwise invert into an
  // inclusion). The rows below are then written on top of that.
  const [series] = await tx
    .update(reportSeries)
    .set({ targetMode: input.targetMode, revision: current.revision + 1, updatedAt: new Date() })
    .where(eq(reportSeries.id, seriesId))
    .returning();
  // Same mode: replace the rows the caller can see; rows of orgs outside the
  // caller's RLS were never in a list the caller was shown.
  await tx.delete(reportSeriesOrgTargets).where(eq(reportSeriesOrgTargets.seriesId, seriesId));
  if (input.orgIds.length > 0) {
    await tx
      .insert(reportSeriesOrgTargets)
      .values(input.orgIds.map((orgId) => ({ seriesId, orgId })))
      .onConflictDoNothing();
  }
  return { series: series!, reconcile: await reconcileSeries(seriesId, tx) };
}

export async function transferSeriesOwner(
  seriesId: string,
  ownerUserId: string,
  auth: SeriesAuth,
  tx: SeriesTx,
): Promise<{ series: ReportSeriesRow; previousOwnerUserId: string | null; reconcile: ReconcileResult }> {
  const partnerId = requireSeriesPartner(auth);
  const current = await lockOwnSeries(seriesId, partnerId, tx);
  await assertSeriesOwnerEligible(ownerUserId, partnerId, tx);
  const [series] = await tx
    .update(reportSeries)
    .set({ ownerUserId, updatedAt: new Date() })
    .where(eq(reportSeries.id, seriesId))
    .returning();
  // Every child's scope names the previous owner, so the reconciler
  // re-captures all of them (spec §3.4 "Transfer owner").
  return { series: series!, previousOwnerUserId: current.ownerUserId, reconcile: await reconcileSeries(seriesId, tx) };
}

export async function deleteSeries(
  seriesId: string,
  auth: SeriesAuth,
  tx: SeriesTx,
): Promise<{ series: ReportSeriesRow; archivedChildren: number }> {
  const partnerId = requireSeriesPartner(auth);
  const current = await lockOwnSeries(seriesId, partnerId, tx);
  const now = new Date();
  // The visible children; report_series_archive_children_before_delete
  // archives any the caller's RLS cannot see.
  const archived = await tx
    .update(reports)
    .set({ archivedAt: now, updatedAt: now })
    .where(and(eq(reports.seriesId, seriesId), isNull(reports.archivedAt)))
    .returning({ id: reports.id });
  await tx.delete(reportSeries).where(eq(reportSeries.id, seriesId));
  return { series: current, archivedChildren: archived.length };
}

export async function listSeries(auth: SeriesAuth): Promise<SeriesDetail[]> {
  const partnerId = requireSeriesPartner(auth);
  const rows = await db
    .select()
    .from(reportSeries)
    .where(eq(reportSeries.partnerId, partnerId))
    .orderBy(asc(reportSeries.name), asc(reportSeries.id));
  // Sequential: one request connection. A partner has tens of series, and
  // W03's grouped list needs every series' per-org status anyway.
  const details: SeriesDetail[] = [];
  for (const series of rows) details.push(await buildSeriesDetail(series));
  return details;
}

export async function getSeriesDetail(seriesId: string, auth: SeriesAuth): Promise<SeriesDetail> {
  return buildSeriesDetail(await loadOwnSeries(seriesId, auth));
}

/** Callers have already passed requireSeriesPartner and own `series`. */
async function buildSeriesDetail(series: ReportSeriesRow): Promise<SeriesDetail> {
  const seriesId = series.id;
  const partnerId = series.partnerId;
  const storedTargets = await listSeriesTargetRows(seriesId, db);
  const targeted = new Set(await resolveSeriesTargetOrgIds(series, db));
  const orgRows = await listSeriesDetailOrgs(partnerId, db);
  // A target row stored for a hidden org (before targets writes refused them)
  // is dropped too: the client echoes `targets` back on its next PUT, which
  // would now be refused, and that PUT's replace clears the stale row.
  const listedOrgIds = new Set(orgRows.map((org) => org.id));
  const targets = storedTargets.filter((orgId) => listedOrgIds.has(orgId));
  const activeChildren = (await listSeriesChildren(seriesId, db)).filter((child) => child.archivedAt === null);
  const childByOrg = new Map(activeChildren.map((child) => [child.orgId, child]));

  const lastRuns = activeChildren.length === 0
    ? []
    : await db
      .selectDistinctOn([reportRuns.reportId], {
        reportId: reportRuns.reportId,
        status: reportRuns.status,
        deliveryStatus: reportRuns.deliveryStatus,
        recipientCount: reportRuns.recipientCount,
        completedAt: reportRuns.completedAt,
      })
      .from(reportRuns)
      .where(inArray(reportRuns.reportId, activeChildren.map((child) => child.id)))
      .orderBy(reportRuns.reportId, desc(reportRuns.createdAt));
  const runByReport = new Map(lastRuns.map((run) => [run.reportId, run]));

  const ownerEligible = series.ownerUserId !== null
    && await isSeriesOwnerEligible(series.ownerUserId, partnerId, db);
  const detachedOrgIds = await listDetachedOrgIds(seriesId, db);
  const recipients = await resolveSeriesRecipientsForOrgs({
    orgIds: [...targeted],
    rule: parseSeriesRecipientRule(series.recipientRule),
    internalCc: series.internalCc,
    childReportIdByOrg: new Map(activeChildren.map((child) => [child.orgId, child.id])),
  });

  const orgs: SeriesOrgStatus[] = orgRows.map((org) => {
    const child = childByOrg.get(org.id);
    const resolved = recipients.get(org.id);
    const run = child ? runByReport.get(child.id) : undefined;
    return {
      orgId: org.id,
      orgName: org.name,
      state: seriesOrgState({
        orgStatus: org.status,
        orgDeletedAt: org.deletedAt,
        targeted: targeted.has(org.id),
        ownerEligible,
        ownerUserId: series.ownerUserId,
        child,
        customerCount: resolved?.customer.length ?? 0,
        ccCount: resolved?.cc.length ?? 0,
        detached: detachedOrgIds.has(org.id),
      }),
      childReportId: child?.id ?? null,
      lastRun: run
        ? {
          status: run.status,
          deliveryStatus: (run.deliveryStatus ?? null) as ReportDeliveryStatus | null,
          recipientCount: run.recipientCount ?? null,
          completedAt: run.completedAt ? run.completedAt.toISOString() : null,
        }
        : null,
    };
  });
  return { series, targets, orgs };
}

export async function previewSeriesRecipients(
  input: {
    targetMode: SeriesTargetMode;
    orgIds: string[];
    recipientRule: SeriesRecipientRule;
    internalCc: string[];
    seriesId: string | null;
  },
  auth: SeriesAuth,
): Promise<SeriesRecipientPreview> {
  const partnerId = requireSeriesPartner(auth);
  const eligible = await eligiblePartnerOrgs(partnerId, db);
  const targetIds = await resolveTargetsForSeries(
    input.seriesId, eligible.map((org) => org.id), input.targetMode, new Set(input.orgIds), db,
  );
  const childReportIdByOrg = new Map<string, string>();
  if (input.seriesId) {
    for (const child of await listSeriesChildren(input.seriesId, db)) {
      if (child.archivedAt === null) childReportIdByOrg.set(child.orgId, child.id);
    }
  }
  const byOrg = await resolveSeriesRecipientsForOrgs({
    orgIds: targetIds,
    rule: input.recipientRule,
    internalCc: input.internalCc,
    childReportIdByOrg,
  });
  const names = new Map(eligible.map((org) => [org.id, org.name]));
  let totalCustomerRecipients = 0;
  const orgsWithoutCustomerRecipient: Array<{ orgId: string; orgName: string }> = [];
  for (const orgId of targetIds) {
    const count = byOrg.get(orgId)?.customer.length ?? 0;
    totalCustomerRecipients += count;
    if (count === 0) orgsWithoutCustomerRecipient.push({ orgId, orgName: names.get(orgId) ?? '' });
  }
  return { totalCustomerRecipients, orgCount: targetIds.length, orgsWithoutCustomerRecipient };
}

export async function previewSavedSeriesRecipients(
  seriesId: string,
  auth: SeriesAuth,
): Promise<SeriesRecipientPreview> {
  const series = await loadOwnSeries(seriesId, auth);
  return previewSeriesRecipients({
    targetMode: series.targetMode,
    orgIds: await listSeriesTargetRows(seriesId, db),
    recipientRule: parseSeriesRecipientRule(series.recipientRule),
    internalCc: series.internalCc,
    seriesId,
  }, auth);
}

/**
 * Detach a series child (spec §3.6). LOCK ORDER (series, then child) matches
 * updateSeries / deleteSeries / reconcile: the caller passes the seriesId it
 * read WITHOUT a lock; this takes the SERIES row lock first, then the child
 * row lock, then re-checks the child is still an active child of that series
 * (else report_not_series_child). Never lock the child before the series: a
 * concurrent series edit would deadlock (40P01).
 */
export async function detachSeriesChild(
  tx: SeriesTx,
  args: { seriesId: string; orgId: string; reportId: string },
  auth: SeriesAuth,
): Promise<{ row: typeof reports.$inferSelect; recipients: { added: number; removedDropped: number } }> {
  const partnerId = requireSeriesPartner(auth);
  await lockOwnSeries(args.seriesId, partnerId, tx);
  const [locked] = await tx
    .select({ seriesId: reports.seriesId, archivedAt: reports.archivedAt })
    .from(reports)
    .where(and(eq(reports.id, args.reportId), eq(reports.orgId, args.orgId)))
    .limit(1)
    .for('update');
  if (!locked || locked.seriesId !== args.seriesId || locked.archivedAt !== null) {
    throw new ReportSeriesError('report_not_series_child', 409);
  }
  const [row] = await tx
    .update(reports)
    // detached_from_series_id remembers the detach (targets.ts), in the SAME
    // statement that clears series_id (reports_detached_from_series_chk).
    .set({ seriesId: null, seriesRevision: null, detachedFromSeriesId: args.seriesId, updatedAt: new Date() })
    .where(and(
      eq(reports.id, args.reportId),
      eq(reports.orgId, args.orgId),
      eq(reports.seriesId, args.seriesId),
      isNull(reports.archivedAt),
    ))
    .returning();
  if (!row) throw new ReportSeriesError('report_not_series_child', 409);
  const recipients = await finishDetach(tx, args, auth);
  return { row, recipients };
}

/**
 * Detach bookkeeping (plan Contract concern 7), called by POST
 * /reports/:id/detach inside its transaction AFTER it cleared series_id:
 * un-target the org without bumping the revision, then keep the org's current
 * customers receiving the now-standalone report.
 */
export async function finishDetach(
  tx: SeriesTx,
  args: { seriesId: string; orgId: string; reportId: string },
  auth: SeriesAuth,
): Promise<{ added: number; removedDropped: number }> {
  const partnerId = requireSeriesPartner(auth);
  const series = await lockOwnSeries(args.seriesId, partnerId, tx);
  if (series.targetMode === 'all') {
    await tx
      .insert(reportSeriesOrgTargets)
      .values({ seriesId: args.seriesId, orgId: args.orgId })
      .onConflictDoNothing();
  } else {
    await tx
      .delete(reportSeriesOrgTargets)
      .where(and(
        eq(reportSeriesOrgTargets.seriesId, args.seriesId),
        eq(reportSeriesOrgTargets.orgId, args.orgId),
      ));
  }
  return materializeDetachedRecipients(tx, {
    reportId: args.reportId,
    orgId: args.orgId,
    rule: parseSeriesRecipientRule(series.recipientRule),
  });
}
