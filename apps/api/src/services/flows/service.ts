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
  type FlowDetailDto,
  type FlowDocumentV1,
  type FlowStatus,
  type FlowSummaryDto,
  type FlowValidationResult,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { flows, organizations, type FlowRow } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import { validateFlowDocument } from '../flowValidator';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';
import type { ToolOwnerRef } from '../toolSources/resolver';
import { resolveFlowOwnerForCaller } from './owner';
import { ownerForFlowRow, takenFlowSlugs } from './repository';

const FLOW_SLUG_MAX = 48;
const MAX_SLUG_ATTEMPTS = 100;

export interface SaveDraftFlowInput {
  document: unknown;
  flowId?: string;
  expectedVersion?: number;
  ownerScope?: 'organization' | 'partner';
  orgId?: string;
  slug?: string;
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

type SummaryRow = Pick<FlowRow, 'id' | 'slug' | 'name' | 'orgId' | 'partnerId' | 'status' | 'effectiveTier' | 'definitionVersion' | 'updatedAt'>;

function toSummaryDto(row: SummaryRow, triggerType: string): FlowSummaryDto {
  return {
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

function toDetailDto(row: FlowRow): FlowDetailDto {
  return {
    ...toSummaryDto(row, triggerTypeOf(row.definition)),
    description: row.description,
    definition: row.definition as unknown as FlowDocumentV1,
    createdByUserId: row.createdByUserId,
    aiSessionId: row.aiSessionId,
    createdAt: iso(row.createdAt),
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
 * this under `lockFlowSlugsForPartner(owner.partnerId)`.
 */
export async function assertFlowSlugAvailable(owner: ToolOwnerRef, slug: string): Promise<boolean> {
  return !(await takenFlowSlugs(owner, slug)).has(slug);
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
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
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

  const validation = await validateFlowDocument(input.document, { owner });
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
    if (isUniqueViolation(err)) return { saved: false, error: 'slug_conflict', validation: stripDocument(validation) };
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
  if (existing.status !== 'draft') return { saved: false, error: 'flow_not_draft' };
  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.definitionVersion) {
    return { saved: false, error: 'version_conflict' };
  }

  const owner = await ownerForFlowRow(existing);
  if (!owner) return { saved: false, error: 'flow_not_found' };
  const validation = await validateFlowDocument(input.document, { owner });
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
      updatedAt: new Date(),
    })
    .where(and(eq(flows.id, flowId), eq(flows.definitionVersion, existing.definitionVersion), eq(flows.status, 'draft')))
    .returning();
  if (!row) return { saved: false, error: 'version_conflict' };
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
  void auth; // reach is the caller's RLS context
  const [row] = await db.select().from(flows).where(eq(flows.id, flowId)).limit(1);
  if (!row) return null;
  const owner = await ownerForFlowRow(row);
  const validation: FlowValidationResult = owner
    ? stripDocument(await validateFlowDocument(row.definition, { owner }))
    : { valid: false, effectiveTier: null, steps: [], issues: [{ code: 'tool_not_found', severity: 'error', message: 'The flow owner no longer exists.' }] };
  return { flow: toDetailDto(row), validation };
}
