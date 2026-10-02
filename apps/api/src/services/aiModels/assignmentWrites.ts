/**
 * Assignment writes for /ai/models (W04, #7602): partner "Defaults by feature"
 * (this file) and org "Model defaults" overrides (Task 6). Tighten-only is
 * enforced HERE at write time (spec §5.4), not just clamped at read time by
 * mergeEffectiveAssignment. The fallback columns (W09) are never written, and
 * role is always 'default' until W09 widens it.
 *
 * The route gates every call (BILLING_MANAGE + canManagePartnerWidePolicies +
 * MFA, plus approvals:decide for script_reviewer) and runs ensurePartnerCutover
 * first. The read-validate-write sequence then runs in ONE system transaction
 * behind the partner registry lock (inPartnerRegistryWrite), so it serialises
 * with W03's compatRemap. Every statement is pinned to input.partnerId (auth).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { TOOL_REQUIRING_SURFACES, type AiAssignmentWriteRole, type AiSurface, type OfferingOptions, type OrgAssignmentInput, type PartnerAssignmentInput } from '@breeze/shared';
import { db } from '../../db';
import { aiModelAssignments, type AiModelAssignmentRow } from '../../db/schema';
import { loadOfferingCandidate, type LoadedCandidate } from './candidateLoader';
import { checkEnableEligibility, type EnableEligibilityContext } from './eligibility';
import { enableEligibilityContext, inPartnerRegistryWrite, OPTION_KEYS, sameVersion, supportedOptionValues } from './offeringWrites';
import { listAssignmentRows } from './assignmentRows';
import { clampOrgOptions } from './assignments';
import { RegistryWriteError } from './registryWriteErrors';

export { listAssignmentRows };

const TOOL_SURFACES = new Set<AiSurface>(TOOL_REQUIRING_SURFACES);
const STALE_MESSAGE = 'These defaults were changed by someone else. Reload and try again.';

/** The shared write-role list (AI_ASSIGNMENT_WRITE_ROLES); W09 (#7607) widens it there. */
type AssignmentRole = AiAssignmentWriteRole;

/**
 * The offering must belong to the partner, be enabled, pass the shared rule
 * table (checkEnableEligibility) and, on a tool surface, support tools.
 * Shared by partner and org validation (Task 6).
 */
export async function assertOfferingUsableForSurface(input: {
  partnerId: string; offeringId: string; surface: AiSurface; field: string;
  ctx: EnableEligibilityContext; cache: Map<string, LoadedCandidate | null>;
}): Promise<LoadedCandidate> {
  const { offeringId, surface, field } = input;
  let c = input.cache.get(offeringId);
  if (c === undefined) {
    c = await loadOfferingCandidate(offeringId, input.partnerId);
    input.cache.set(offeringId, c);
  }
  if (!c) throw new RegistryWriteError('That model is not available.', 'not_eligible', 422, { surface, field, offeringId, reason: 'not_found' });
  if (!c.facts.enabled) throw new RegistryWriteError('That model is not enabled.', 'not_eligible', 422, { surface, field, offeringId, reason: 'disabled' });
  const reason = checkEnableEligibility(c.facts, input.ctx);
  if (reason) throw new RegistryWriteError('That model is not available.', 'not_eligible', 422, { surface, field, offeringId, reason });
  if (TOOL_SURFACES.has(surface) && !c.facts.supportsTools) {
    throw new RegistryWriteError('This feature needs a model that can use tools.', 'tools_unsupported', 422, { surface, field, offeringId });
  }
  return c;
}

/** Each set option must be supported by the model (fast only when rated) and inside its allowed list. */
export function assertOptionsSupported(surface: AiSurface, model: LoadedCandidate, options: OfferingOptions | null): void {
  if (!options) return;
  for (const key of OPTION_KEYS) {
    const value = options[key] as string | undefined;
    if (value === undefined) continue;
    const support = supportedOptionValues(model, key);
    const allow = model.allowedOptions?.[key] as readonly string[] | undefined;
    if (!support.includes(value) || (allow && !allow.includes(value))) {
      throw new RegistryWriteError('The default model does not support that option.', 'invalid', 422, { surface, field: 'options', key });
    }
  }
}

/** expectedUpdatedAt must match the stored row at ms precision, or be null when there is none. */
export function assertNotStale(surface: AiSurface, existing: AiModelAssignmentRow | undefined, expected: string | null): void {
  const matches = existing
    ? expected !== null && sameVersion(existing.updatedAt, expected)
    : expected === null;
  if (!matches) throw new RegistryWriteError(STALE_MESSAGE, 'stale_write', 409, { surface });
}

/**
 * Permitted ids not already stored on the row being replaced. Only these are
 * validated: an id that was valid when saved and has since been disabled (or
 * otherwise become ineligible) must not make the whole row unsaveable; the
 * read-time merge already filters it out. Stored ids come from a row pinned to
 * the same partner (and, for org rows, the same org), so they are the partner's
 * by construction; a foreign id can only arrive as a new id, which is checked.
 */
function newlyAddedIds(ids: string[] | null, stored: AiModelAssignmentRow | undefined): string[] {
  const kept = new Set(stored?.permittedOfferingIds ?? []);
  return (ids ?? []).filter((id) => !kept.has(id));
}

/** All-or-nothing: validates every row, then upserts in one transaction. Never writes fallback columns (W09). */
export async function putPartnerAssignments(input: { partnerId: string; rows: PartnerAssignmentInput[] }): Promise<AiModelAssignmentRow[]> {
  const { partnerId } = input;
  return inPartnerRegistryWrite(partnerId, 'aiModels.putPartnerAssignments', 'Could not save the defaults.', async () => {
    const existing = await listAssignmentRows({ partnerId });
    const ctx = await enableEligibilityContext(partnerId);
    const cache = new Map<string, LoadedCandidate | null>();

    // Validate every row before writing anything.
    for (const row of input.rows) {
      const stored = existing.find((e) => e.surface === row.surface && e.role === row.role);
      assertNotStale(row.surface, stored, row.expectedUpdatedAt);
      // W09 Task 1 stub: the contract now lets a role row clear its default; the write path for that lands with the escalation-role task.
      if (row.defaultOfferingId === null) {
        throw new RegistryWriteError('Choose a default model.', 'invalid', 422, { surface: row.surface, field: 'defaultOfferingId' });
      }
      const def = await assertOfferingUsableForSurface({ partnerId, offeringId: row.defaultOfferingId, surface: row.surface, field: 'defaultOfferingId', ctx, cache });
      for (const id of newlyAddedIds(row.permittedOfferingIds, stored)) {
        await assertOfferingUsableForSurface({ partnerId, offeringId: id, surface: row.surface, field: 'permittedOfferingIds', ctx, cache });
      }
      if (row.permittedOfferingIds && !row.permittedOfferingIds.includes(row.defaultOfferingId)) {
        throw new RegistryWriteError('The default must be one of the permitted models.', 'invalid', 422, { surface: row.surface, field: 'defaultOfferingId' });
      }
      assertOptionsSupported(row.surface, def, row.options);
    }

    // A stale row throws and rolls back the whole transaction.
    const out: AiModelAssignmentRow[] = [];
    for (const row of input.rows) {
      out.push(await conditionalUpsert({ kind: 'partner', partnerId }, row, {
        defaultOfferingId: row.defaultOfferingId,
        permittedOfferingIds: row.permittedOfferingIds,
        allowUserChoice: row.allowUserChoice,
        options: row.options as Record<string, unknown> | null,
      }));
    }
    return out;
  });
}

export type AssignmentOwner = { kind: 'partner'; partnerId: string } | { kind: 'org'; orgId: string; partnerId: string };
/** The only columns W04 writes besides the key; fallback_* belong to W09. */
export type AssignmentValues = {
  defaultOfferingId: string | null; permittedOfferingIds: string[] | null;
  allowUserChoice: boolean | null; options: Record<string, unknown> | null;
};
type AssignmentKey = { surface: AiSurface; role: AssignmentRole; expectedUpdatedAt: string | null };

function ownerCondition(owner: AssignmentOwner) {
  return owner.kind === 'partner'
    ? and(isNull(aiModelAssignments.orgId), eq(aiModelAssignments.partnerId, owner.partnerId))
    : and(eq(aiModelAssignments.orgId, owner.orgId), eq(aiModelAssignments.offeringPartnerId, owner.partnerId));
}

/** ms-precision version match (see offeringWrites.sameVersion). */
function versionMatches(expectedIso: string) {
  return sql`date_trunc('milliseconds', ${aiModelAssignments.updatedAt}) = ${new Date(expectedIso).toISOString()}::timestamptz`;
}

/**
 * Optimistic-concurrency write in the ambient (locked, system) transaction —
 * callers run it inside inPartnerRegistryWrite:
 *  - "no row expected" → INSERT … ON CONFLICT DO NOTHING; a concurrent insert wins → stale;
 *  - "row at version V" → UPDATE … WHERE updated_at ≈ V; a concurrent update wins → stale.
 * Never writes fallback_offering_ids / fallback_may_cross_funding (W09).
 */
export async function conditionalUpsert(owner: AssignmentOwner, row: AssignmentKey, values: AssignmentValues): Promise<AiModelAssignmentRow> {
  const now = new Date();
  const stale = () => new RegistryWriteError(STALE_MESSAGE, 'stale_write', 409, { surface: row.surface });
  if (row.expectedUpdatedAt === null) {
    const [inserted] = await db
      .insert(aiModelAssignments)
      .values({
        orgId: owner.kind === 'org' ? owner.orgId : null,
        partnerId: owner.kind === 'partner' ? owner.partnerId : null,
        offeringPartnerId: owner.partnerId,
        surface: row.surface,
        role: row.role,
        ...values,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) throw stale();
    return inserted;
  }
  const [updated] = await db
    .update(aiModelAssignments)
    .set({ ...values, updatedAt: now })
    .where(and(
      ownerCondition(owner),
      eq(aiModelAssignments.surface, row.surface),
      eq(aiModelAssignments.role, row.role),
      versionMatches(row.expectedUpdatedAt),
    ))
    .returning();
  if (!updated) throw stale();
  return updated;
}

/** Clears an org override at version V (no-op when there was none). Runs in the ambient locked transaction. */
export async function conditionalDeleteOrgRow(orgId: string, partnerId: string, row: AssignmentKey): Promise<void> {
  if (row.expectedUpdatedAt === null) return;
  const deleted = await db
    .delete(aiModelAssignments)
    .where(and(
      eq(aiModelAssignments.orgId, orgId),
      eq(aiModelAssignments.offeringPartnerId, partnerId),
      eq(aiModelAssignments.surface, row.surface),
      eq(aiModelAssignments.role, row.role),
      versionMatches(row.expectedUpdatedAt),
    ))
    .returning({ id: aiModelAssignments.id });
  if (deleted.length === 0) throw new RegistryWriteError(STALE_MESSAGE, 'stale_write', 409, { surface: row.surface });
}

/** True when any row in the batch writes `surface` (routes gate script_reviewer on approvals:decide). */
export function touchesSurface(rows: Array<{ surface: string }>, surface: AiSurface): boolean {
  return rows.some((r) => r.surface === surface);
}

function widens(surface: AiSurface, field: string, extra: Record<string, unknown> = {}): never {
  throw new RegistryWriteError('An organization can only narrow the partner’s defaults.', 'widens_partner', 422, { surface, field, ...extra });
}

function isBlank(row: OrgAssignmentInput): boolean {
  return row.defaultOfferingId === null && row.permittedOfferingIds === null && row.allowUserChoice === null && row.options === null;
}

/**
 * Writes one org's override rows (spec §5.4 tighten-only). An all-null row
 * deletes the override (blank = inherit). Every widening is a 422
 * widens_partner — never a silent clamp — so an admin never saves a value the
 * read-time merge would ignore. `partnerId` is the org's partner (the route
 * resolves it with readOrgPartnerId); every org statement is pinned to it via
 * offering_partner_id, and the composite FK (org_id, offering_partner_id) →
 * organizations(id, partner_id) refuses a mismatched insert.
 */
export async function putOrgAssignments(input: { partnerId: string; orgId: string; rows: OrgAssignmentInput[] }): Promise<AiModelAssignmentRow[]> {
  const { partnerId, orgId } = input;
  return inPartnerRegistryWrite(partnerId, 'aiModels.putOrgAssignments', 'Could not save the organization’s model defaults.', async () => {
    const partnerRows = await listAssignmentRows({ partnerId });
    const orgRows = await listAssignmentRows({ partnerId, orgId });
    const ctx = await enableEligibilityContext(partnerId);
    const cache = new Map<string, LoadedCandidate | null>();

    // Validate every row before writing anything.
    for (const row of input.rows) {
      const stored = orgRows.find((r) => r.surface === row.surface && r.role === row.role);
      assertNotStale(row.surface, stored, row.expectedUpdatedAt);
      if (isBlank(row)) continue;
      await assertOrgRowNarrows(row, partnerRows.find((r) => r.surface === row.surface && r.role === row.role), stored, { partnerId, ctx, cache });
    }

    // A stale row throws and rolls back the whole transaction.
    const out: AiModelAssignmentRow[] = [];
    for (const row of input.rows) {
      if (isBlank(row)) {
        await conditionalDeleteOrgRow(orgId, partnerId, row);
        continue;
      }
      out.push(await conditionalUpsert({ kind: 'org', orgId, partnerId }, row, {
        defaultOfferingId: row.defaultOfferingId,
        permittedOfferingIds: row.permittedOfferingIds,
        allowUserChoice: row.allowUserChoice,
        options: row.options as Record<string, unknown> | null,
      }));
    }
    return out;
  });
}

/** Throws 422 widens_partner on any widening of the partner row `p` (absent = no partner default for the surface). */
async function assertOrgRowNarrows(
  row: OrgAssignmentInput,
  p: AiModelAssignmentRow | undefined,
  stored: AiModelAssignmentRow | undefined,
  env: { partnerId: string; ctx: EnableEligibilityContext; cache: Map<string, LoadedCandidate | null> },
): Promise<void> {
  const { surface } = row;
  const usable = (offeringId: string, field: string) =>
    assertOfferingUsableForSurface({ partnerId: env.partnerId, offeringId, surface, field, ctx: env.ctx, cache: env.cache });
  const partnerSet = p?.permittedOfferingIds ?? null; // null = every enabled offering
  const inEffectiveSet = (id: string) =>
    (!partnerSet || partnerSet.includes(id)) && (!row.permittedOfferingIds || row.permittedOfferingIds.includes(id));

  // zod admits only false|null; guard the service boundary anyway.
  if ((row.allowUserChoice as boolean | null) === true) widens(surface, 'allowUserChoice');

  // Already-stored ids skip both checks: one the partner has since dropped or
  // disabled is filtered by the read-time merge (it never widens the effective
  // set), and refusing it would leave the override unsaveable.
  for (const id of newlyAddedIds(row.permittedOfferingIds, stored)) {
    if (partnerSet && !partnerSet.includes(id)) widens(surface, 'permittedOfferingIds', { offeringId: id });
    await usable(id, 'permittedOfferingIds');
  }

  let effectiveDefault: LoadedCandidate | null = null;
  if (row.defaultOfferingId !== null) {
    if (!p || !inEffectiveSet(row.defaultOfferingId)) widens(surface, 'defaultOfferingId');
    effectiveDefault = await usable(row.defaultOfferingId, 'defaultOfferingId');
  } else if (p?.defaultOfferingId) {
    // A narrowed set that drops the inherited default would leave the org on a
    // model outside its own permitted list (the merge keeps the partner default).
    if (!inEffectiveSet(p.defaultOfferingId)) widens(surface, 'defaultOfferingId', { reason: 'inherited_default_not_permitted' });
    let inherited = env.cache.get(p.defaultOfferingId);
    if (inherited === undefined) {
      inherited = await loadOfferingCandidate(p.defaultOfferingId, env.partnerId);
      env.cache.set(p.defaultOfferingId, inherited);
    }
    effectiveDefault = inherited;
  }

  if (row.options) {
    // clampOrgOptions only emits the three clamp warnings; zod already rejected malformed options.
    const { warnings } = clampOrgOptions((p?.options ?? {}) as OfferingOptions, row.options);
    if (warnings.includes('org_effort_clamped')) widens(surface, 'options', { key: 'effort' });
    if (warnings.includes('org_speed_clamped')) widens(surface, 'options', { key: 'speed' });
    if (warnings.includes('org_budget_thinking_clamped')) widens(surface, 'options', { key: 'budgetThinking' });
    if (effectiveDefault) assertOptionsSupported(surface, effectiveDefault, row.options);
  }
}
