/**
 * Tool Catalog W06 (#5221) Task B1 — converting a standalone legacy Job
 * ("automation") into a flow: preview, create (one or all of an owner's Jobs),
 * and the conversion ledger reads. Switch and revert are later tasks (B3, B4).
 *
 * Creating a conversion starts its shadow (plan Decision 3): the draft flow is
 * saved and the ledger row inserted; nothing executes and the Job keeps
 * running on the legacy engine until a separate interactive switch.
 *
 * Reach and ownership (Partner-Wide First, plan Decision 4):
 *  - Every read and write runs in the CALLER's DB context (the request
 *    transaction): RLS decides which Job, flow and ledger row a caller sees.
 *    On top of RLS, an org token never sees a partner-wide Job (automations
 *    has no partner-wide read branch, routes/automations.ts) nor its
 *    conversion, and a site-limited caller sees only Jobs whose targets stay
 *    within their sites (the GET /automations/:id rule). Preview, create, get
 *    and list all apply that one reach rule (`readReachableAutomation`).
 *  - The draft's owner is exactly the Job's owner axis: an org Job's org, or
 *    a partner-wide Job's partner (org_id NULL). A partner-wide Job needs
 *    `canManagePartnerWidePolicies(auth)`.
 *  - Create needs an interactive user session (plan Global Constraints).
 *
 * The converter's facts (`loadConversionContext`) are read in system context
 * with explicit owner predicates before the row lock; the locked row is
 * re-converted with them, so the stored document is the one the locked
 * source produces.
 */
import { and, count, desc, eq, inArray, isNotNull, isNull, ne, type SQL } from 'drizzle-orm';
import {
  CONVERSION_MIN_SHADOW_MS,
  CONVERSION_SHADOW_MIN_MS,
  CONVERSION_SHADOW_MIN_RUNS,
  type FlowConversionDto,
  type FlowConversionFinding,
  type FlowConversionPreviewDto,
  type FlowConversionState,
  type FlowConversionSwitchBlocker,
  type FlowValidationResult,
} from '@breeze/shared';
import { db, withDbTransaction } from '../../../db';
import { automations, flowAutomationConversions, type FlowAutomationConversionRow } from '../../../db/schema';
import { isInteractiveUserSession, type AuthContext } from '../../../middleware/auth';
import { isPgUniqueViolation } from '../../../utils/pgErrors';
import { resolveWritableToolOrgId } from '../../aiToolWriteOrg';
import { requestLikeFromSnapshot, writeAuditEvent } from '../../auditEvents';
import { checkAutomationTargetsWithinSiteScope } from '../../automationRuntime';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../partnerWideAccess';
import { captureException } from '../../sentry';
import { hasSiteCeiling } from '../../siteCeilingAccess';
import { saveDraftFlow } from '../service';
import { loadConversionContext } from './context';
import { automationSourceDigest, convertAutomation } from './convertAutomation';
import { flowDocumentDigest } from './ledger';

export { resetShadowIfChanged } from './ledger';

type AutomationRow = typeof automations.$inferSelect;

export type CreateConversionResult =
  | { ok: true; conversion: FlowConversionDto }
  | { ok: false; error: 'automation_not_found' | 'partner_wide_forbidden' | 'interactive_session_required' | 'source_changed' }
  | { ok: false; error: 'conversion_exists'; conversionId: string | null }
  | { ok: false; error: 'unconvertible'; findings: FlowConversionFinding[] }
  | { ok: false; error: 'draft_rejected'; reason: string | null; validation?: FlowValidationResult };

export type BulkConversionResult =
  | { ok: true; created: number; skipped: Record<string, number> }
  | { ok: false; error: 'interactive_session_required' | 'partner_wide_forbidden' | 'owner_forbidden'; message?: string };

/** Bulk converts at most this many of an owner's Jobs per request; the rest are counted as `bulk_limit`. */
export const BULK_CONVERSION_LIMIT = 200;
const LIVE_UQ = 'flow_automation_conversions_live_uq';
/** Rows per batch when a site-limited caller's conversion list is scanned. */
const SITE_SCAN_BATCH = 100;

// ── reach ──────────────────────────────────────────────────────────────────

/** Mirrors routes/automations.ts canAccessAutomation: org tokens never reach a partner-wide Job. */
function canReachAutomation(auth: AuthContext, row: Pick<AutomationRow, 'orgId' | 'partnerId'>): boolean {
  if (row.orgId !== null) return auth.canAccessOrg(row.orgId);
  if (auth.scope === 'system') return true;
  return auth.scope === 'partner' && !!auth.partnerId && row.partnerId === auth.partnerId;
}

/** A site-limited caller reaches only Jobs whose targets stay within their sites (GET /automations/:id). */
async function withinSiteCeiling(auth: AuthContext, row: AutomationRow): Promise<boolean> {
  if (!hasSiteCeiling(auth)) return true;
  const check = await checkAutomationTargetsWithinSiteScope(row, { allowedSiteIds: auth.allowedSiteIds });
  return check.ok;
}

async function readReachableAutomation(auth: AuthContext, automationId: string, lock: boolean): Promise<AutomationRow | null> {
  const q = db.select().from(automations).where(eq(automations.id, automationId));
  const [row] = lock ? await q.for('update').limit(1) : await q.limit(1);
  if (!row || !canReachAutomation(auth, row)) return null;
  if (!(await withinSiteCeiling(auth, row))) return null;
  return row;
}

/** An org-scope caller never sees a partner-wide generation (its Job is invisible to them). */
function conversionReachCondition(auth: AuthContext): SQL | undefined {
  return auth.scope === 'organization' ? isNotNull(flowAutomationConversions.orgId) : undefined;
}

async function liveConversionId(automationId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: flowAutomationConversions.id })
    .from(flowAutomationConversions)
    // The live unique index's predicate.
    .where(and(eq(flowAutomationConversions.automationId, automationId), ne(flowAutomationConversions.state, 'reverted')))
    .limit(1);
  return row?.id ?? null;
}

// ── DTO ────────────────────────────────────────────────────────────────────

function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

/** What keeps a shadow from switching now (plan Decision 3); null for a non-shadow generation or a clear gate. */
export function switchBlockedBy(
  row: Pick<FlowAutomationConversionRow, 'state' | 'sourceDigest' | 'shadowStartedAt' | 'shadowRuns' | 'shadowDivergences'>,
  liveSourceDigest: string | null,
  now: Date,
): FlowConversionSwitchBlocker | null {
  if (row.state !== 'shadow') return null;
  if (liveSourceDigest !== row.sourceDigest) return 'source_changed';
  const age = now.getTime() - new Date(row.shadowStartedAt).getTime();
  if (age < CONVERSION_MIN_SHADOW_MS) return 'shadow_too_new';
  if (row.shadowDivergences > 0) return 'shadow_divergent';
  if (row.shadowRuns < CONVERSION_SHADOW_MIN_RUNS || age < CONVERSION_SHADOW_MIN_MS) return 'shadow_too_short';
  return null;
}

export function toConversionDto(row: FlowAutomationConversionRow, liveSourceDigest: string | null, now = new Date()): FlowConversionDto {
  return {
    id: row.id,
    automationId: row.automationId,
    flowId: row.flowId,
    state: row.state,
    fidelity: row.fidelity,
    findings: row.findings ?? [],
    createdAt: iso(row.createdAt),
    switchAt: row.switchAt ? iso(row.switchAt) : null,
    revertAt: row.revertAt ? iso(row.revertAt) : null,
    shadow: {
      runs: row.shadowRuns,
      divergences: row.shadowDivergences,
      startedAt: iso(row.shadowStartedAt),
      lastAt: row.shadowLastAt ? iso(row.shadowLastAt) : null,
      lastDivergence: row.shadowLastDivergence ?? null,
    },
    switchBlockedBy: switchBlockedBy(row, liveSourceDigest, now),
  };
}

/** Live source digests of the given Jobs, read in the caller's context (absent = not visible). */
async function liveSourceDigests(automationIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(automationIds)];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: automations.id,
      trigger: automations.trigger,
      conditions: automations.conditions,
      actions: automations.actions,
      onFailure: automations.onFailure,
      notificationTargets: automations.notificationTargets,
    })
    .from(automations)
    .where(inArray(automations.id, ids));
  for (const r of rows) out.set(r.id, automationSourceDigest(r));
  return out;
}

// ── preview ────────────────────────────────────────────────────────────────

/** The converter's answer for one Job the caller can read; null when it is not visible to them. */
export async function previewConversion(auth: AuthContext, automationId: string): Promise<FlowConversionPreviewDto | null> {
  const row = await readReachableAutomation(auth, automationId, false);
  if (!row) return null;
  const ctx = await loadConversionContext(row);
  const r = convertAutomation(row, ctx);
  return {
    automationId: row.id,
    fidelity: r.fidelity,
    findings: r.findings,
    document: r.document,
    preApprovalCandidates: r.preApprovalCandidates,
    generatedScripts: r.generatedScripts,
    sourceDigest: r.sourceDigest,
    documentDigest: r.documentDigest,
    targetCount: ctx.currentTargets?.count ?? null,
    estimatedMonthlyRuns: r.estimatedMonthlyRuns,
  };
}

// ── create ─────────────────────────────────────────────────────────────────

/** Unwinds the savepoint with a refusal (nothing the attempt wrote survives). */
class ConversionRefused extends Error {
  constructor(readonly result: Exclude<CreateConversionResult, { ok: true }>) {
    super(result.error);
  }
}

function auditCreated(auth: AuthContext, row: AutomationRow, conversion: FlowAutomationConversionRow): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: row.orgId,
      ...(row.orgId ? {} : { partnerId: row.partnerId }),
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'flow.conversion.created',
      resourceType: 'flow_automation_conversion',
      resourceId: conversion.id,
      resourceName: row.name,
      result: 'success',
      // Ids and codes only: never the source, the document or a finding's detail.
      details: {
        automationId: row.id,
        flowId: conversion.flowId,
        fidelity: conversion.fidelity,
        findingCodes: (conversion.findings ?? []).map((f) => f.code),
        ownerScope: row.orgId ? 'organization' : 'partner',
      },
    });
  } catch (err) {
    console.error('[flows] conversion audit write failed', err);
    captureException(
      err,
      undefined,
      { ...(row.orgId ? { org_id: row.orgId } : {}), flow_site: 'conversion.create_audit' },
      { fingerprint: ['flow', 'conversion.create_audit'] },
    );
  }
}

/**
 * Convert one Job into a draft flow and start its shadow. In ONE savepoint of
 * the caller's transaction: lock the Job `FOR UPDATE`, re-check its source
 * digest against `expectedSourceDigest` (what the caller previewed), refuse an
 * unconvertible Job, save the draft through `saveDraftFlow` on the Job's owner
 * axis and insert the ledger row. Any refusal after the lock rolls the whole
 * attempt back. A second live generation is refused by the pre-check and, for
 * a race, by `flow_automation_conversions_live_uq`.
 */
export async function createConversion(
  auth: AuthContext,
  automationId: string,
  req: { expectedSourceDigest: string },
): Promise<CreateConversionResult> {
  if (!isInteractiveUserSession(auth)) return { ok: false, error: 'interactive_session_required' };

  const pre = await readReachableAutomation(auth, automationId, false);
  if (!pre) return { ok: false, error: 'automation_not_found' };
  if (!pre.orgId && !canManagePartnerWidePolicies(auth)) return { ok: false, error: 'partner_wide_forbidden' };
  if (automationSourceDigest(pre) !== req.expectedSourceDigest) return { ok: false, error: 'source_changed' };
  const existing = await liveConversionId(pre.id);
  if (existing) return { ok: false, error: 'conversion_exists', conversionId: existing };

  // System reads with explicit owner predicates, before the lock is taken.
  const ctx = await loadConversionContext(pre);
  const preview = convertAutomation(pre, ctx);
  if (preview.fidelity === 'unconvertible' || !preview.document) {
    return { ok: false, error: 'unconvertible', findings: preview.findings };
  }

  try {
    return await withDbTransaction(async (): Promise<CreateConversionResult> => {
      const row = await readReachableAutomation(auth, automationId, true);
      if (!row) throw new ConversionRefused({ ok: false, error: 'automation_not_found' });
      // The context was read for `pre`'s owner and source; both must still hold.
      if (row.orgId !== pre.orgId || row.partnerId !== pre.partnerId || automationSourceDigest(row) !== req.expectedSourceDigest) {
        throw new ConversionRefused({ ok: false, error: 'source_changed' });
      }
      const live = await liveConversionId(row.id);
      if (live) throw new ConversionRefused({ ok: false, error: 'conversion_exists', conversionId: live });

      const result = convertAutomation(row, ctx);
      if (result.fidelity === 'unconvertible' || !result.document) {
        throw new ConversionRefused({ ok: false, error: 'unconvertible', findings: result.findings });
      }

      const saved = await saveDraftFlow(auth, {
        document: result.document,
        ownerScope: row.orgId ? 'organization' : 'partner',
        ...(row.orgId ? { orgId: row.orgId } : {}),
      });
      if (!saved.saved) {
        throw new ConversionRefused({
          ok: false,
          error: 'draft_rejected',
          reason: saved.error ?? null,
          ...(saved.validation ? { validation: saved.validation } : {}),
        });
      }

      let inserted: FlowAutomationConversionRow | undefined;
      try {
        [inserted] = await db
          .insert(flowAutomationConversions)
          .values({
            orgId: row.orgId,
            partnerId: row.orgId ? null : row.partnerId,
            automationId: row.id,
            flowId: saved.flow.id,
            fidelity: result.fidelity === 'exact' ? 'exact' : 'needs_review',
            findings: result.findings,
            sourceDigest: result.sourceDigest,
            sourceSnapshot: result.sourceSnapshot,
            documentDigest: flowDocumentDigest(saved.flow.definition),
            convertedBy: auth.user.id,
          })
          .returning();
      } catch (err) {
        if (isPgUniqueViolation(err, LIVE_UQ)) {
          throw new ConversionRefused({ ok: false, error: 'conversion_exists', conversionId: null });
        }
        throw err;
      }
      if (!inserted) throw new Error('flow conversion insert returned no row');
      auditCreated(auth, row, inserted);
      return { ok: true, conversion: toConversionDto(inserted, result.sourceDigest) };
    });
  } catch (err) {
    if (err instanceof ConversionRefused) return err.result;
    throw err;
  }
}

/** The bulk skip reason: an unconvertible Job counts under its first blocker. */
function skipReason(r: Exclude<CreateConversionResult, { ok: true }>): string {
  if (r.error === 'unconvertible') return r.findings.find((f) => f.severity === 'blocker')?.code ?? 'unconvertible';
  return r.error;
}

/**
 * "Convert all convertible" for one owner (plan Decision 2): creates shadow
 * conversions only, never switches. Each Job is its own savepoint, so one
 * refusal never undoes another Job's conversion. Retired Jobs are not listed.
 */
export async function createConversionsForOwner(
  auth: AuthContext,
  req: { ownerScope: 'organization' | 'partner'; orgId?: string },
): Promise<BulkConversionResult> {
  if (!isInteractiveUserSession(auth)) return { ok: false, error: 'interactive_session_required' };

  let ownerCondition: SQL;
  if (req.ownerScope === 'partner') {
    if (req.orgId || auth.scope !== 'partner' || !auth.partnerId) {
      return { ok: false, error: 'owner_forbidden', message: 'Partner-wide conversions require a partner-scoped caller' };
    }
    if (!canManagePartnerWidePolicies(auth)) {
      return { ok: false, error: 'partner_wide_forbidden', message: PARTNER_WIDE_WRITE_DENIED_MESSAGE };
    }
    ownerCondition = and(isNull(automations.orgId), eq(automations.partnerId, auth.partnerId)) as SQL;
  } else {
    const resolved = resolveWritableToolOrgId(auth, req.orgId, { useWriteDefault: false });
    if (!resolved.orgId) return { ok: false, error: 'owner_forbidden', message: resolved.error };
    ownerCondition = eq(automations.orgId, resolved.orgId);
  }

  const rows = await db
    .select()
    .from(automations)
    .where(and(ownerCondition, isNull(automations.retiredAt)))
    .orderBy(automations.createdAt, automations.id)
    .limit(BULK_CONVERSION_LIMIT + 1);

  let created = 0;
  const skipped: Record<string, number> = {};
  for (const [i, row] of rows.entries()) {
    if (i >= BULK_CONVERSION_LIMIT) {
      skipped.bulk_limit = (skipped.bulk_limit ?? 0) + 1;
      continue;
    }
    const r = await createConversion(auth, row.id, { expectedSourceDigest: automationSourceDigest(row) });
    if (r.ok) {
      created += 1;
      continue;
    }
    const reason = skipReason(r);
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  }
  return { ok: true, created, skipped };
}

// ── read ───────────────────────────────────────────────────────────────────

export async function getConversion(auth: AuthContext, id: string): Promise<FlowConversionDto | null> {
  const reach = conversionReachCondition(auth);
  const [row] = await db
    .select()
    .from(flowAutomationConversions)
    .where(reach ? and(eq(flowAutomationConversions.id, id), reach) : eq(flowAutomationConversions.id, id))
    .limit(1);
  if (!row) return null;
  // The same reach as preview and create: a conversion is visible only with its Job
  // (owner rule and, for a site-limited caller, the site ceiling).
  const automation = await readReachableAutomation(auth, row.automationId, false);
  if (!automation) return null;
  return toConversionDto(row, automationSourceDigest(automation));
}

export async function listConversions(
  auth: AuthContext,
  f: { state?: FlowConversionState; automationId?: string; limit?: number; offset?: number },
): Promise<{ conversions: FlowConversionDto[]; total: number }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
  const offset = Math.max(f.offset ?? 0, 0);
  const conditions: SQL[] = [];
  const reach = conversionReachCondition(auth);
  if (reach) conditions.push(reach);
  if (f.state) conditions.push(eq(flowAutomationConversions.state, f.state));
  if (f.automationId) conditions.push(eq(flowAutomationConversions.automationId, f.automationId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const now = new Date();

  // A site-limited caller sees a conversion only when its Job is within their
  // sites (the preview/create rule). The ceiling is resolved per Job by the
  // automation target resolver, not in SQL, so scan in bounded batches and
  // page and count over the visible rows (the GET /automations pattern).
  if (hasSiteCeiling(auth)) {
    const visible: FlowAutomationConversionRow[] = [];
    const reachable = new Map<string, AutomationRow | null>();
    let total = 0;
    let databaseOffset = 0;
    for (;;) {
      const batch = await db
        .select()
        .from(flowAutomationConversions)
        .where(where)
        .orderBy(desc(flowAutomationConversions.createdAt), desc(flowAutomationConversions.id))
        .limit(SITE_SCAN_BATCH)
        .offset(databaseOffset);
      if (batch.length === 0) break;
      for (const r of batch) {
        if (!reachable.has(r.automationId)) {
          reachable.set(r.automationId, await readReachableAutomation(auth, r.automationId, false));
        }
        if (!reachable.get(r.automationId)) continue;
        if (total >= offset && visible.length < limit) visible.push(r);
        total += 1;
      }
      databaseOffset += batch.length;
      if (batch.length < SITE_SCAN_BATCH) break;
    }
    return {
      conversions: visible.map((r) => {
        const automation = reachable.get(r.automationId);
        return toConversionDto(r, automation ? automationSourceDigest(automation) : null, now);
      }),
      total,
    };
  }

  const [total] = await db.select({ n: count() }).from(flowAutomationConversions).where(where);
  const rows = await db
    .select()
    .from(flowAutomationConversions)
    .where(where)
    .orderBy(desc(flowAutomationConversions.createdAt), desc(flowAutomationConversions.id))
    .limit(limit)
    .offset(offset);
  const digests = await liveSourceDigests(rows.map((r) => r.automationId));
  return {
    conversions: rows.map((r) => toConversionDto(r, digests.get(r.automationId) ?? null, now)),
    total: Number(total?.n ?? 0),
  };
}
