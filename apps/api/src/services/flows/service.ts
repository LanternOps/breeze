/**
 * Tool Catalog W03 (#5218) — draft / list / get for flows.
 *
 * Writes run in the CALLER's DB context: RLS (flows_isolation FOR ALL) decides
 * which rows an UPDATE can target, so an org token that can read a
 * partner-wide flow through flows_partner_wide_select can never change it.
 * Partner-wide creates and updates additionally require
 * `canManagePartnerWidePolicies(auth)` — RLS alone would let a selected-access
 * partner user write them.
 *
 * Invalid documents are never stored (quorum P2): a draft is saved only when
 * the validator returns no error-severity issue; `getFlow` re-validates live,
 * so catalog drift after save (a tenant tool disabled later) surfaces as an
 * issue on read rather than as a broken row.
 */
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  isValidFlowSlug,
  slugifyFlowName,
  flowUsagePeriodKey,
  type FlowConvertedFromDto,
  type FlowDetailDto,
  type FlowUsageDto,
  type FlowWebhookInfoDto,
  type FlowDocumentV1,
  type FlowStatus,
  type FlowSummaryDto,
  type FlowValidationResult,
  type PreApprovalEligibility,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { sqlTimestamptz } from '../../db/sqlValues';
import { flows, flowVersions, organizations, type FlowRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import { captureException } from '../sentry';
import { FlowStepPinError, flowPreApprovalBindingSchema, stepPinsFor, validateFlowDocument, type FlowDocumentValidation } from '../flowValidator';
import { readFlowUsage } from './budgets';
import { effectiveFlowMonthlyCap, resolveFlowLimits } from './flowLimits';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';
import type { ToolOwnerRef } from '../toolSources/resolver';
import { resolveFlowOwnerForCaller } from './owner';
import { assessPreApprovals } from './preApproval';
import {
  allowGeneratedScriptPlaceholders,
  convertedFromForFlow,
  generatedScriptPlaceholderIdsFor,
  hasScriptOwnershipRefusal,
  resetShadowIfChanged,
  shadowPlaceholderAllowance,
} from './conversion/ledger';
import type { ScriptReadExecutor } from './ownedReferences';
import { ownerForFlowRow, takenFlowSlugs } from './repository';

const FLOW_SLUG_MAX = 48;
const EDITABLE_STATUSES: readonly FlowStatus[] = ['draft', 'disabled', 'paused'];
const MAX_SLUG_ATTEMPTS = 100;

export interface SaveDraftFlowInput {
  document: unknown;
  flowId?: string;
  expectedVersion?: number;
  ownerScope?: 'organization' | 'partner';
  orgId?: string;
  slug?: string;
  /**
   * W06 (#5221) B3, the conversion switch only (never from a request body):
   * validate script ownership through the switch's own transaction, which
   * holds the scripts it just generated (flowValidator `scriptReadExecutor`).
   */
  scriptReadExecutor?: ScriptReadExecutor;
  /**
   * W06 (#5221), createConversion only (never from a request body): the Job
   * being converted, from its locked row. Its generated-script placeholders
   * are excused at this save (conversion/ledger.ts allowGeneratedScriptPlaceholders).
   */
  convertedFrom?: { automationId: string; actions: unknown };
}

export type SaveDraftFlowResult =
  | { saved: true; flow: FlowDetailDto; validation: FlowValidationResult }
  | { saved: false; error?: string; validation?: FlowValidationResult };

export interface ListFlowsFilter {
  orgId?: string;
  status?: FlowStatus;
  limit?: number;
  offset?: number;
}

// ── DTOs ───────────────────────────────────────────────────────────────────

function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function triggerTypeOf(definition: unknown): string {
  const t = (definition as { trigger?: { type?: unknown } } | null)?.trigger?.type;
  return typeof t === 'string' ? t : 'unknown';
}

type SummaryRow = Pick<FlowRow,
  | 'id' | 'slug' | 'name' | 'orgId' | 'partnerId' | 'status' | 'effectiveTier' | 'definitionVersion' | 'updatedAt'
  | 'lastAdmissionRefusalAt' | 'lastAdmissionRefusalCode'>;

function toSummaryDto(row: SummaryRow, triggerType: string): FlowSummaryDto {
  return {
    // W5: the last admission refusal (a monthly cap or the active queue), for the list badge and the banner.
    lastAdmissionRefusal: row.lastAdmissionRefusalAt && row.lastAdmissionRefusalCode
      ? { at: iso(row.lastAdmissionRefusalAt), code: row.lastAdmissionRefusalCode }
      : null,
    id: row.id,
    slug: row.slug,
    name: row.name,
    ownerScope: row.orgId ? 'organization' : 'partner',
    orgId: row.orgId,
    partnerId: row.partnerId,
    status: row.status,
    effectiveTier: row.effectiveTier as 1 | 2 | 3,
    triggerType,
    definitionVersion: row.definitionVersion,
    updatedAt: iso(row.updatedAt),
  };
}

export interface FlowDetailExtras {
  /** Rule-4 eligibility of every tier-3 step, computed live (`assessPreApprovals`). */
  preApprovalEligibility: Record<string, PreApprovalEligibility>;
  /** The step ids the LIVE publication binds (enabled or paused flows only). */
  preApprovedStepIds: string[];
  /** W05: this month's usage against the effective caps (getFlow computes it). */
  usage?: FlowUsageDto | null;
  /** W06 C3: the Job this flow was converted from (getFlow reads it). */
  convertedFrom?: FlowConvertedFromDto | null;
}

const NO_EXTRAS: FlowDetailExtras = { preApprovalEligibility: {}, preApprovedStepIds: [] };

/** The public ingress URL: PUBLIC_API_URL's origin when set, else the path alone. */
function flowWebhookUrl(flowId: string): string {
  const base = (process.env.PUBLIC_API_URL || process.env.API_URL || '').replace(/\/+$/, '');
  return `${base}/api/v1/webhooks/flows/${flowId}`;
}

/** W5: the webhook block of a flow whose DRAFT trigger is a webhook; else null. */
function webhookInfo(row: FlowRow): FlowWebhookInfoDto | null {
  const trigger = (row.definition as { trigger?: { type?: unknown; auth?: unknown } } | null)?.trigger;
  if (trigger?.type !== 'webhook') return null;
  return {
    url: flowWebhookUrl(row.id),
    authMode: trigger.auth === 'token' ? 'token' : 'hmac',
    secretFingerprint: row.webhookSecretFingerprint ?? null,
    secretRotatedAt: row.webhookSecretRotatedAt ? iso(row.webhookSecretRotatedAt) : null,
    lastAuthFailureAt: row.webhookLastAuthFailureAt ? iso(row.webhookLastAuthFailureAt) : null,
    lastAuthFailureReason: row.webhookLastAuthFailureReason ?? null,
  };
}

export function toDetailDto(row: FlowRow, extras: FlowDetailExtras = NO_EXTRAS): FlowDetailDto {
  return {
    ...toSummaryDto(row, triggerTypeOf(row.definition)),
    description: row.description,
    definition: row.definition as unknown as FlowDocumentV1,
    createdByUserId: row.createdByUserId,
    aiSessionId: row.aiSessionId,
    createdAt: iso(row.createdAt),
    enabledPublicationSeq: row.enabledPublicationSeq,
    enabledAt: row.enabledAt ? iso(row.enabledAt) : null,
    enabledByUserId: row.enabledByUserId,
    pausedReason: row.pausedReason,
    preApprovalEligibility: extras.preApprovalEligibility,
    preApprovedStepIds: extras.preApprovedStepIds,
    // Never the ciphertext: the webhook block carries the fingerprint only (W5 Task A5).
    webhook: webhookInfo(row),
    usage: extras.usage ?? null,
    convertedFrom: extras.convertedFrom ?? null,
  };
}

// ── slugs ──────────────────────────────────────────────────────────────────

function suffixedSlug(base: string, n: number): string {
  const suffix = `_${n}`;
  return `${base.slice(0, FLOW_SLUG_MAX - suffix.length).replace(/_+$/, '')}${suffix}`;
}

/**
 * Serializes slug check-and-insert per partner. One lock per partner covers
 * both shadow directions (org vs partner-wide). Transaction-scoped: released
 * when the caller's DB context commits.
 */
export async function lockFlowSlugsForPartner(partnerId: string): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`flows_slug:${partnerId}`}, 0))`);
}

/**
 * True when `slug` is free for `owner` under the shadow rule (see
 * `takenFlowSlugs`). W04's enable path and any future owner change must call
 * this under `lockFlowSlugsForPartner(owner.partnerId)`; enable passes
 * `excludeFlowId` so the flow's own row does not count as taking its slug.
 */
export async function assertFlowSlugAvailable(
  owner: ToolOwnerRef,
  slug: string,
  opts?: { excludeFlowId?: string },
): Promise<boolean> {
  const taken = opts ? await takenFlowSlugs(owner, slug, opts) : await takenFlowSlugs(owner, slug);
  return !taken.has(slug);
}

async function pickFlowSlug(owner: ToolOwnerRef, base: string): Promise<string | null> {
  const taken = await takenFlowSlugs(owner, base);
  if (!taken.has(base)) return base;
  for (let n = 2; n < MAX_SLUG_ATTEMPTS; n++) {
    const candidate = suffixedSlug(base, n);
    if (taken.has(candidate)) continue;
    // A cut base no longer shares the `base_<n>` prefix the first lookup matched.
    if (!candidate.startsWith(`${base}_`) && !(await assertFlowSlugAvailable(owner, candidate))) continue;
    return candidate;
  }
  return null;
}

// ── audit ──────────────────────────────────────────────────────────────────

function auditDraftSave(auth: AuthContext, row: FlowRow, stepCount: number): void {
  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: row.orgId,
      ...(row.orgId ? {} : { partnerId: row.partnerId }),
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'flow.draft.save',
      resourceType: 'flow',
      resourceId: row.id,
      resourceName: row.name,
      result: 'success',
      // Never the definition: it can carry ids and free text.
      details: {
        definitionVersion: row.definitionVersion,
        effectiveTier: row.effectiveTier,
        stepCount,
        ownerScope: row.orgId ? 'organization' : 'partner',
      },
    });
  } catch (err) {
    console.error('[flows] audit write failed', err);
    captureException(
      err,
      undefined,
      { ...(row.orgId ? { org_id: row.orgId } : {}), flow_id: row.id, flow_site: 'service.draft_audit' },
      { fingerprint: ['flow', 'service.draft_audit'] },
    );
  }
}

// ── save ───────────────────────────────────────────────────────────────────

export async function saveDraftFlow(auth: AuthContext, input: SaveDraftFlowInput): Promise<SaveDraftFlowResult> {
  return input.flowId ? updateDraft(auth, input.flowId, input) : createDraft(auth, input);
}

async function createDraft(auth: AuthContext, input: SaveDraftFlowInput): Promise<SaveDraftFlowResult> {
  const resolved = await resolveFlowOwnerForCaller(auth, { ownerScope: input.ownerScope, orgId: input.orgId }, 'write');
  if ('error' in resolved) return { saved: false, error: resolved.error };
  const { owner } = resolved;
  // Also gated in resolveFlowOwnerForCaller; named here because this file
  // performs the partner-axis insert (partner-wide-write-coverage.test.ts).
  if (!owner.orgId && !canManagePartnerWidePolicies(auth)) {
    return { saved: false, error: PARTNER_WIDE_WRITE_DENIED_MESSAGE };
  }

  const baseSlug = input.slug ?? null;
  if (baseSlug !== null && !isValidFlowSlug(baseSlug)) return { saved: false, error: 'invalid_slug' };

  // W06: a converted Job's draft names the scripts its switch will generate (save time only).
  const checked = await validateFlowDocument(input.document, { owner });
  const validation = input.convertedFrom && hasScriptOwnershipRefusal(checked)
    ? allowGeneratedScriptPlaceholders(checked, generatedScriptPlaceholderIdsFor(input.convertedFrom.automationId, input.convertedFrom.actions))
    : checked;
  const document = validation.document;
  if (!validation.valid || !document) return { saved: false, validation: stripDocument(validation) };

  await lockFlowSlugsForPartner(owner.partnerId);
  const slug = await pickFlowSlug(owner, baseSlug ?? slugifyFlowName(document.name));
  if (!slug) return { saved: false, error: 'slug_unavailable', validation: stripDocument(validation) };

  let row: FlowRow | undefined;
  try {
    [row] = await db
      .insert(flows)
      .values({
        orgId: owner.orgId,
        partnerId: owner.orgId ? null : owner.partnerId,
        slug,
        name: document.name,
        description: document.description ?? null,
        definition: document as unknown as Record<string, unknown>,
        definitionVersion: 1,
        effectiveTier: validation.effectiveTier ?? 3,
        status: 'draft',
        createdByUserId: auth.user.id,
      })
      .returning();
  } catch (err) {
    if (isPgUniqueViolation(err)) return { saved: false, error: 'slug_conflict', validation: stripDocument(validation) };
    throw err;
  }
  if (!row) throw new Error('Failed to save flow');
  auditDraftSave(auth, row, document.steps.length);
  return { saved: true, flow: toDetailDto(row), validation: stripDocument(validation) };
}

async function updateDraft(auth: AuthContext, flowId: string, input: SaveDraftFlowInput): Promise<SaveDraftFlowResult> {
  const [existing] = await db.select().from(flows).where(eq(flows.id, flowId)).limit(1);
  if (!existing) return { saved: false, error: 'flow_not_found' };
  if (!existing.orgId) {
    // An org token reads partner-wide rows through the SELECT-only branch but
    // can never target them for UPDATE; answer as if the row were absent.
    if (auth.scope !== 'partner' && auth.scope !== 'system') return { saved: false, error: 'flow_not_found' };
    if (!canManagePartnerWidePolicies(auth)) return { saved: false, error: PARTNER_WIDE_WRITE_DENIED_MESSAGE };
  }
  // W04 (Decision 2): editable unless enabled. A disabled or paused flow keeps
  // its status (and a paused flow its live publication) — re-enable publishes
  // the edited definition as a new publication.
  if (!EDITABLE_STATUSES.includes(existing.status)) return { saved: false, error: 'flow_not_draft' };
  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.definitionVersion) {
    return { saved: false, error: 'version_conflict' };
  }

  const owner = await ownerForFlowRow(existing);
  if (!owner) return { saved: false, error: 'flow_not_found' };
  const checked = await validateFlowDocument(
    input.document,
    input.scriptReadExecutor ? { owner, scriptReadExecutor: input.scriptReadExecutor } : { owner },
  );
  // W06: while the flow's conversion is in shadow, its own generated-script
  // placeholders are excused at save (never at enable).
  const validation = hasScriptOwnershipRefusal(checked)
    ? allowGeneratedScriptPlaceholders(checked, await shadowPlaceholderAllowance(db, flowId))
    : checked;
  const document = validation.document;
  if (!validation.valid || !document) return { saved: false, validation: stripDocument(validation) };

  const [row] = await db
    .update(flows)
    .set({
      name: document.name,
      description: document.description ?? null,
      definition: document as unknown as Record<string, unknown>,
      effectiveTier: validation.effectiveTier ?? 3,
      definitionVersion: sql`${flows.definitionVersion} + 1`,
      // Strictly after the webhook secret's rotated_at. versions.ts
      // webhookSecretSurvivesEnable treats "updated_at still equals rotated_at" as
      // "no edit since the mint". This timestamp is computed before the UPDATE can
      // wait on a mint's row lock, so the two can match to the millisecond; GREATEST
      // runs after the lock and rules that out (#10270). GREATEST ignores the NULL
      // when the flow has no secret.
      updatedAt: sql`GREATEST(${sqlTimestamptz(new Date())}, ${flows.webhookSecretRotatedAt} + interval '1 millisecond')`,
    })
    .where(and(eq(flows.id, flowId), eq(flows.definitionVersion, existing.definitionVersion), eq(flows.status, existing.status)))
    .returning();
  if (!row) return { saved: false, error: 'version_conflict' };
  // W06 (#5221, Decision 3): a converted Job's shadow restarts when its draft changes.
  await resetShadowIfChanged(db, { flowId });
  auditDraftSave(auth, row, document.steps.length);
  return { saved: true, flow: toDetailDto(row), validation: stripDocument(validation) };
}

function stripDocument(v: FlowValidationResult & { document?: unknown }): FlowValidationResult {
  const { document: _document, ...rest } = v;
  return rest;
}

/**
 * Chat provenance (spec §6.4): set by the chat post-tool hook from the
 * authenticated session, never from tool input, and only while unset. System
 * context with an explicit owner predicate — the session's org, or its
 * partner's partner-wide flows — because the chat hook's org-scoped context
 * cannot target a partner-wide row.
 */
export async function attachFlowToChatSession(flowId: string, aiSessionId: string, sessionOrgId: string): Promise<void> {
  await runOutsideDbContext(() =>
    withSystemDbAccessContext(async () => {
      const orgsPartner = sql`(select ${organizations.partnerId} from ${organizations} where ${organizations.id} = ${sessionOrgId})`;
      await db
        .update(flows)
        .set({ aiSessionId })
        .where(and(
          eq(flows.id, flowId),
          isNull(flows.aiSessionId),
          or(eq(flows.orgId, sessionOrgId), and(isNull(flows.orgId), sql`${flows.partnerId} = ${orgsPartner}`)),
        ));
    }, 'flows.attachFlowToChatSession'),
  );
}

// ── read ───────────────────────────────────────────────────────────────────

export async function listFlows(auth: AuthContext, f: ListFlowsFilter): Promise<{ flows: FlowSummaryDto[]; total: number }> {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
  const offset = Math.max(f.offset ?? 0, 0);
  const conditions: SQL[] = [];
  if (f.orgId) {
    if (!auth.canAccessOrg(f.orgId)) return { flows: [], total: 0 };
    const orgsPartner = sql`(select ${organizations.partnerId} from ${organizations} where ${organizations.id} = ${f.orgId})`;
    conditions.push(or(eq(flows.orgId, f.orgId), and(isNull(flows.orgId), sql`${flows.partnerId} = ${orgsPartner}`)) as SQL);
  }
  if (f.status) conditions.push(eq(flows.status, f.status));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(flows).where(where);
  const rows = await db
    .select({
      id: flows.id,
      slug: flows.slug,
      name: flows.name,
      orgId: flows.orgId,
      partnerId: flows.partnerId,
      status: flows.status,
      effectiveTier: flows.effectiveTier,
      definitionVersion: flows.definitionVersion,
      updatedAt: flows.updatedAt,
      lastAdmissionRefusalAt: flows.lastAdmissionRefusalAt,
      lastAdmissionRefusalCode: flows.lastAdmissionRefusalCode,
      triggerType: sql<string>`${flows.definition}->'trigger'->>'type'`,
    })
    .from(flows)
    .where(where)
    .orderBy(desc(flows.updatedAt), desc(flows.id))
    .limit(limit)
    .offset(offset);

  return {
    flows: rows.map((r) => toSummaryDto(r, r.triggerType ?? 'unknown')),
    total: Number(count?.n ?? 0),
  };
}

export async function getFlow(
  auth: AuthContext,
  flowId: string,
): Promise<{ flow: FlowDetailDto; validation: FlowValidationResult } | null> {
  // Reach is the caller's RLS context; `auth` only shapes the usage block.
  const [row] = await db.select().from(flows).where(eq(flows.id, flowId)).limit(1);
  if (!row) return null;
  const owner = await ownerForFlowRow(row);
  if (!owner) {
    const validation: FlowValidationResult = {
      valid: false, effectiveTier: null, steps: [], issues: [{ code: 'tool_not_found', severity: 'error', message: 'The flow owner no longer exists.' }],
    };
    return { flow: toDetailDto(row, { preApprovalEligibility: {}, preApprovedStepIds: await livePreApprovedStepIds(row) }), validation };
  }
  const validated = await validateFlowDocument(row.definition, { owner });
  const extras: FlowDetailExtras = {
    preApprovalEligibility: await liveEligibility(validated, owner),
    preApprovedStepIds: await livePreApprovedStepIds(row),
    usage: await usageFor(auth, row, owner),
    convertedFrom: await convertedFromForFlow(row.id),
  };
  return { flow: toDetailDto(row, extras), validation: stripDocument(validated) };
}

/**
 * W5 (Decision 15): this month's runs against the effective caps. The counts
 * are read in the CALLER's context; a partner-wide flow's counters are
 * partner-level rows an org token cannot read, so an org caller gets null
 * rather than a misleading zero. The flow cap uses the DRAFT document's
 * `limits` (the live publication's applies at admission).
 */
async function usageFor(auth: AuthContext, row: FlowRow, owner: ToolOwnerRef): Promise<FlowUsageDto | null> {
  if (!owner.orgId && auth.scope === 'organization') return null;
  const at = new Date();
  const limits = await resolveFlowLimits(owner);
  const { flowRuns, ownerRuns } = await readFlowUsage(row.id, owner, at);
  const doc = row.definition as { limits?: { monthlyRuns?: number } } | null;
  const monthlyRuns = doc?.limits?.monthlyRuns;
  return {
    periodKey: flowUsagePeriodKey(at),
    flowRuns,
    flowCap: effectiveFlowMonthlyCap(limits, { limits: typeof monthlyRuns === 'number' ? { monthlyRuns } : undefined }),
    ownerRuns,
    ownerCap: limits.monthlyRunsPerOwner,
  };
}

/**
 * Rule-4 eligibility of every tier-3 step, so the enable dialog never
 * guesses. Only for a document that validates now — enable refuses any other
 * — and empty if a step stopped resolving between the two catalog reads
 * (`FlowStepPinError`). Any other failure (DB, catalog) propagates: "nothing
 * eligible" would be a wrong answer, not a degraded one.
 */
async function liveEligibility(validated: FlowDocumentValidation, owner: ToolOwnerRef): Promise<Record<string, PreApprovalEligibility>> {
  if (!validated.valid || !validated.document) return {};
  let pins;
  try {
    pins = await stepPinsFor(validated.document, { owner });
  } catch (err) {
    if (!(err instanceof FlowStepPinError)) throw err;
    return {};
  }
  return (await assessPreApprovals(validated.document, pins, owner)).eligibility;
}

/**
 * The step ids the live publication pre-approved. Read in the caller's
 * context (flow_versions follows the flows RLS shape). A binding that does
 * not parse is not reported — the runner treats it as drift.
 */
async function livePreApprovedStepIds(row: FlowRow): Promise<string[]> {
  if (row.enabledPublicationSeq === null || row.enabledPublicationSeq === undefined) return [];
  if (!(['enabled', 'paused'] as FlowStatus[]).includes(row.status)) return [];
  const [pub] = await db
    .select({ preApprovals: flowVersions.preApprovals })
    .from(flowVersions)
    .where(and(eq(flowVersions.flowId, row.id), eq(flowVersions.publicationSeq, row.enabledPublicationSeq)))
    .limit(1);
  const out: string[] = [];
  for (const b of pub?.preApprovals ?? []) {
    const parsed = flowPreApprovalBindingSchema.safeParse(b);
    if (parsed.success) out.push(parsed.data.stepId);
  }
  return out;
}
