/**
 * Assignment writes for /ai/models (W04, #7602): partner "Defaults by feature"
 * (this file) and org "Model defaults" overrides (Task 6). Tighten-only is
 * enforced HERE at write time (spec §5.4), not just clamped at read time by
 * mergeEffectiveAssignment.
 *
 * W09 (#7607): rows are keyed by (surface, role) — `ai_agents` carries the
 * triage / analysis / remediation escalation roles beside its default — and
 * carry an ordered failover list plus the cross-funding switch. Fallback
 * columns are written only when the payload carries them (omitted = keep the
 * stored value). Every fallback id passes the same usability gate as a
 * permitted id, must sit inside the row's permitted set, and may only change
 * funding (Breeze credits <-> the partner's own key) when the row's effective
 * cross-funding switch is on (spec §5.4, §9.1, F1). Every 422 names the role.
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
import { clampOrgOptions, selectRoleRows, type AssignmentRowInput } from './assignments';
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
  partnerId: string; offeringId: string; surface: AiSurface; role: AssignmentRole; field: string;
  ctx: EnableEligibilityContext; cache: Map<string, LoadedCandidate | null>;
}): Promise<LoadedCandidate> {
  const { offeringId, surface, role, field } = input;
  const c = await loadCached(input.partnerId, offeringId, input.cache);
  if (!c) throw new RegistryWriteError('That model is not available.', 'not_eligible', 422, { surface, role, field, offeringId, reason: 'not_found' });
  if (!c.facts.enabled) throw new RegistryWriteError('That model is not enabled.', 'not_eligible', 422, { surface, role, field, offeringId, reason: 'disabled' });
  const reason = checkEnableEligibility(c.facts, input.ctx);
  if (reason) throw new RegistryWriteError('That model is not available.', 'not_eligible', 422, { surface, role, field, offeringId, reason });
  if (TOOL_SURFACES.has(surface) && !c.facts.supportsTools) {
    throw new RegistryWriteError('This feature needs a model that can use tools.', 'tools_unsupported', 422, { surface, role, field, offeringId });
  }
  return c;
}

/** One candidate load per offering per write (null = not this partner's, or gone). */
async function loadCached(partnerId: string, offeringId: string, cache: Map<string, LoadedCandidate | null>): Promise<LoadedCandidate | null> {
  let c = cache.get(offeringId);
  if (c === undefined) {
    c = await loadOfferingCandidate(offeringId, partnerId);
    cache.set(offeringId, c);
  }
  return c;
}

/** Each set option must be supported by the model (fast only when rated) and inside its allowed list. */
export function assertOptionsSupported(surface: AiSurface, role: AssignmentRole, model: LoadedCandidate, options: OfferingOptions | null): void {
  if (!options) return;
  for (const key of OPTION_KEYS) {
    const value = options[key] as string | undefined;
    if (value === undefined) continue;
    const support = supportedOptionValues(model, key);
    const allow = model.allowedOptions?.[key] as readonly string[] | undefined;
    if (!support.includes(value) || (allow && !allow.includes(value))) {
      throw new RegistryWriteError('The default model does not support that option.', 'invalid', 422, { surface, role, field: 'options', key });
    }
  }
}

/** expectedUpdatedAt must match the stored row at ms precision, or be null when there is none. */
export function assertNotStale(surface: AiSurface, role: AssignmentRole, existing: AiModelAssignmentRow | undefined, expected: string | null): void {
  const matches = existing
    ? expected !== null && sameVersion(existing.updatedAt, expected)
    : expected === null;
  if (!matches) throw new RegistryWriteError(STALE_MESSAGE, 'stale_write', 409, { surface, role });
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

type FallbackFields = { fallbackOfferingIds?: string[] | null; fallbackMayCrossFunding?: boolean | null };

/**
 * W09: omitted -> not written (keep the stored value). On a PARTNER row [] and
 * NULL both mean "no failover", stored as NULL. On an ORG row they differ
 * (Codex review 8): NULL inherits the partner list, [] is an explicit "no
 * backups" override (mergeEffectiveAssignment honours an empty org list).
 */
function fallbackValues(row: FallbackFields, owner: AssignmentOwner['kind']): Partial<AssignmentValues> {
  return {
    ...(row.fallbackOfferingIds !== undefined
      ? { fallbackOfferingIds: owner === 'partner' && row.fallbackOfferingIds?.length === 0 ? null : row.fallbackOfferingIds }
      : {}),
    ...(row.fallbackMayCrossFunding !== undefined ? { fallbackMayCrossFunding: row.fallbackMayCrossFunding } : {}),
  };
}

/** The list the row holds after this write: the payload's, else the stored one it keeps. */
function effectiveFallbackIds(row: FallbackFields, stored: AiModelAssignmentRow | undefined): readonly string[] {
  return (row.fallbackOfferingIds !== undefined ? row.fallbackOfferingIds : stored?.fallbackOfferingIds) ?? [];
}

/**
 * W09: each fallback must be usable on the surface (as a permitted id is),
 * inside the row's permitted set, and on the reference default's funding
 * unless crossing is allowed. An id already stored on this row skips only the
 * usability gate: one disabled since it was saved must not make the row
 * unsaveable (same rule as newlyAddedIds; the resolver re-checks every hop
 * live, F2). It still faces the membership and funding rules.
 */
async function assertFallbacks(input: {
  partnerId: string; surface: AiSurface; role: AssignmentRole; ids: readonly string[]; storedIds: readonly string[] | null;
  inPermittedSet: (offeringId: string) => boolean; reference: LoadedCandidate | null; crossFunding: boolean;
  ctx: EnableEligibilityContext; cache: Map<string, LoadedCandidate | null>;
  onOutsidePermitted: (offeringId: string) => never;
  onCrossesFunding: (offeringId: string) => never;
}): Promise<void> {
  const stored = new Set(input.storedIds ?? []);
  for (const id of input.ids) {
    const fb = stored.has(id)
      ? await loadCached(input.partnerId, id, input.cache)
      : await assertOfferingUsableForSurface({
        partnerId: input.partnerId, offeringId: id, surface: input.surface, role: input.role, field: 'fallbackOfferingIds', ctx: input.ctx, cache: input.cache,
      });
    if (!input.inPermittedSet(id)) input.onOutsidePermitted(id);
    if (fb && input.reference && fb.funding !== input.reference.funding && !input.crossFunding) input.onCrossesFunding(id);
  }
}

/** The DB CHECK (ai_model_assignments_fallback_shape_chk) as a 422 instead of a 23514. */
function assertNotOwnFallback(surface: AiSurface, role: AssignmentRole, defaultOfferingId: string | null, ids: readonly string[]): void {
  if (defaultOfferingId && ids.includes(defaultOfferingId)) {
    throw new RegistryWriteError('A model cannot be its own fallback.', 'invalid', 422, { surface, role, field: 'fallbackOfferingIds', offeringId: defaultOfferingId });
  }
}

/**
 * All-or-nothing: validates every row, then writes in one transaction. A role
 * row (role other than 'default') with defaultOfferingId null is a delete: the
 * role inherits the feature default again.
 */
export async function putPartnerAssignments(input: { partnerId: string; rows: PartnerAssignmentInput[] }): Promise<AiModelAssignmentRow[]> {
  const { partnerId } = input;
  return inPartnerRegistryWrite(partnerId, 'aiModels.putPartnerAssignments', 'Could not save the defaults.', async () => {
    const existing = await listAssignmentRows({ partnerId });
    const ctx = await enableEligibilityContext(partnerId);
    const cache = new Map<string, LoadedCandidate | null>();

    // Validate every row before writing anything.
    for (const row of input.rows) {
      const { surface, role } = row;
      const stored = existing.find((e) => e.surface === surface && e.role === role);
      assertNotStale(surface, role, stored, row.expectedUpdatedAt);
      if (row.defaultOfferingId === null) {
        // zod admits a null default only on a role row; guard the service boundary anyway.
        if (role === 'default') throw new RegistryWriteError('Choose a default model.', 'invalid', 422, { surface, role, field: 'defaultOfferingId' });
        continue; // a cleared role row is a delete (inherit): nothing else to check
      }
      const def = await assertOfferingUsableForSurface({ partnerId, offeringId: row.defaultOfferingId, surface, role, field: 'defaultOfferingId', ctx, cache });
      for (const id of newlyAddedIds(row.permittedOfferingIds, stored)) {
        await assertOfferingUsableForSurface({ partnerId, offeringId: id, surface, role, field: 'permittedOfferingIds', ctx, cache });
      }
      if (row.permittedOfferingIds && !row.permittedOfferingIds.includes(row.defaultOfferingId)) {
        throw new RegistryWriteError('The default must be one of the permitted models.', 'invalid', 422, { surface, role, field: 'defaultOfferingId' });
      }
      assertOptionsSupported(surface, role, def, row.options);

      const fallbackIds = effectiveFallbackIds(row, stored);
      if (fallbackIds.length > 0) {
        assertNotOwnFallback(surface, role, row.defaultOfferingId, fallbackIds);
        const permitted = row.permittedOfferingIds;
        await assertFallbacks({
          partnerId, surface, role, ids: fallbackIds, storedIds: stored?.fallbackOfferingIds ?? null,
          inPermittedSet: (id) => !permitted || permitted.includes(id),
          reference: def,
          crossFunding: row.fallbackMayCrossFunding ?? stored?.fallbackMayCrossFunding ?? false,
          ctx, cache,
          onOutsidePermitted: (offeringId) => {
            throw new RegistryWriteError('A fallback must be one of the permitted models.', 'invalid', 422,
              { surface, role, field: 'fallbackOfferingIds', offeringId });
          },
          onCrossesFunding: (offeringId) => {
            throw new RegistryWriteError(
              'That backup model is paid from a different source. Allow failover between Breeze credits and your own API key first.',
              'crosses_funding', 422, { surface, role, field: 'fallbackOfferingIds', offeringId });
          },
        });
      }
    }

    // A stale row throws and rolls back the whole transaction.
    const out: AiModelAssignmentRow[] = [];
    for (const row of input.rows) {
      if (row.defaultOfferingId === null) {
        await conditionalDeletePartnerRoleRow(partnerId, row);
        continue;
      }
      out.push(await conditionalUpsert({ kind: 'partner', partnerId }, row, {
        defaultOfferingId: row.defaultOfferingId,
        permittedOfferingIds: row.permittedOfferingIds,
        allowUserChoice: row.allowUserChoice,
        options: row.options as Record<string, unknown> | null,
        ...fallbackValues(row, 'partner'),
      }));
    }
    return out;
  });
}

export type AssignmentOwner = { kind: 'partner'; partnerId: string } | { kind: 'org'; orgId: string; partnerId: string };
/** The columns an assignment write sets besides the key. */
export type AssignmentValues = {
  defaultOfferingId: string | null; permittedOfferingIds: string[] | null;
  allowUserChoice: boolean | null; options: Record<string, unknown> | null;
  /** W09: written only when the payload carried them (omitted = keep the stored value). */
  fallbackOfferingIds?: string[] | null;
  fallbackMayCrossFunding?: boolean | null;
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
 * Writes fallback columns only when the caller's values carry them (W09).
 */
export async function conditionalUpsert(owner: AssignmentOwner, row: AssignmentKey, values: AssignmentValues): Promise<AiModelAssignmentRow> {
  const now = new Date();
  const stale = () => new RegistryWriteError(STALE_MESSAGE, 'stale_write', 409, { surface: row.surface, role: row.role });
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
  if (deleted.length === 0) throw new RegistryWriteError(STALE_MESSAGE, 'stale_write', 409, { surface: row.surface, role: row.role });
}

/**
 * W09: clears a partner ROLE row at version V (no-op when there was none), so
 * the role inherits the feature default again. Never a `default` row. Runs in
 * the ambient locked transaction, pinned to the partner like conditionalUpsert.
 */
export async function conditionalDeletePartnerRoleRow(partnerId: string, row: AssignmentKey): Promise<void> {
  if (row.role === 'default') throw new Error('conditionalDeletePartnerRoleRow: a default row is never deleted');
  if (row.expectedUpdatedAt === null) return;
  const deleted = await db
    .delete(aiModelAssignments)
    .where(and(
      ownerCondition({ kind: 'partner', partnerId }),
      eq(aiModelAssignments.surface, row.surface),
      eq(aiModelAssignments.role, row.role),
      versionMatches(row.expectedUpdatedAt),
    ))
    .returning({ id: aiModelAssignments.id });
  if (deleted.length === 0) throw new RegistryWriteError(STALE_MESSAGE, 'stale_write', 409, { surface: row.surface, role: row.role });
}

/** True when any row in the batch writes `surface` (routes gate script_reviewer on approvals:decide). */
export function touchesSurface(rows: Array<{ surface: string }>, surface: AiSurface): boolean {
  return rows.some((r) => r.surface === surface);
}

function widens(surface: AiSurface, field: string, extra: Record<string, unknown> = {}): never {
  throw new RegistryWriteError('An organization can only narrow the partner’s defaults.', 'widens_partner', 422, { surface, field, ...extra });
}

/** Blank = inherit everything (delete the override). Absent or null fallback fields are blank (W09). */
function isBlank(row: OrgAssignmentInput): boolean {
  return row.defaultOfferingId === null && row.permittedOfferingIds === null && row.allowUserChoice === null && row.options === null
    && (row.fallbackOfferingIds ?? null) === null && (row.fallbackMayCrossFunding ?? null) === null;
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
      assertNotStale(row.surface, row.role, stored, row.expectedUpdatedAt);
      if (isBlank(row)) continue;
      // W09 (D2): the partner reference is the partner's role row, else its
      // default row, exactly as the resolver picks it, so an org may override a
      // role the partner left on the feature default.
      const p = selectRoleRows(partnerRows.filter((r) => r.surface === row.surface), row.role).partner;
      await assertOrgRowNarrows(row, p, stored, { partnerId, ctx, cache });
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
        ...fallbackValues(row, 'org'),
      }));
    }
    return out;
  });
}

/** Throws 422 widens_partner on any widening of the partner row `p` (absent = no partner default for the surface). */
async function assertOrgRowNarrows(
  row: OrgAssignmentInput,
  p: AssignmentRowInput | null,
  stored: AiModelAssignmentRow | undefined,
  env: { partnerId: string; ctx: EnableEligibilityContext; cache: Map<string, LoadedCandidate | null> },
): Promise<void> {
  const { surface, role } = row;
  const widen = (field: string, extra: Record<string, unknown> = {}): never => widens(surface, field, { role, ...extra });
  const usable = (offeringId: string, field: string) =>
    assertOfferingUsableForSurface({ partnerId: env.partnerId, offeringId, surface, role, field, ctx: env.ctx, cache: env.cache });
  const partnerSet = p?.permittedOfferingIds ?? null; // null = every enabled offering
  const inEffectiveSet = (id: string) =>
    (!partnerSet || partnerSet.includes(id)) && (!row.permittedOfferingIds || row.permittedOfferingIds.includes(id));

  // zod admits only false|null; guard the service boundary anyway.
  if ((row.allowUserChoice as boolean | null) === true) widen('allowUserChoice');

  // Already-stored ids skip both checks: one the partner has since dropped or
  // disabled is filtered by the read-time merge (it never widens the effective
  // set), and refusing it would leave the override unsaveable.
  for (const id of newlyAddedIds(row.permittedOfferingIds, stored)) {
    if (partnerSet && !partnerSet.includes(id)) widen('permittedOfferingIds', { offeringId: id });
    await usable(id, 'permittedOfferingIds');
  }

  let effectiveDefault: LoadedCandidate | null = null;
  if (row.defaultOfferingId !== null) {
    if (!p || !inEffectiveSet(row.defaultOfferingId)) widen('defaultOfferingId');
    effectiveDefault = await usable(row.defaultOfferingId, 'defaultOfferingId');
  } else if (p?.defaultOfferingId) {
    // A narrowed set that drops the inherited default would leave the org on a
    // model outside its own permitted list (the merge keeps the partner default).
    if (!inEffectiveSet(p.defaultOfferingId)) widen('defaultOfferingId', { reason: 'inherited_default_not_permitted' });
    effectiveDefault = await loadCached(env.partnerId, p.defaultOfferingId, env.cache);
  }

  if (row.options) {
    // clampOrgOptions only emits the three clamp warnings; zod already rejected malformed options.
    const { warnings } = clampOrgOptions((p?.options ?? {}) as OfferingOptions, row.options);
    if (warnings.includes('org_effort_clamped')) widen('options', { key: 'effort' });
    if (warnings.includes('org_speed_clamped')) widen('options', { key: 'speed' });
    if (warnings.includes('org_budget_thinking_clamped')) widen('options', { key: 'budgetThinking' });
    if (effectiveDefault) assertOptionsSupported(surface, role, effectiveDefault, row.options);
  }

  // W09: an org list narrows the partner's: every id inside the partner's and
  // the org row's own permitted set. Crossing funding needs the partner's
  // switch on and the org's not off (an org can only turn it off).
  const fallbackIds = effectiveFallbackIds(row, stored);
  if (fallbackIds.length > 0) {
    assertNotOwnFallback(surface, role, row.defaultOfferingId, fallbackIds);
    const orgCrossing = row.fallbackMayCrossFunding !== undefined ? row.fallbackMayCrossFunding : stored?.fallbackMayCrossFunding ?? null;
    await assertFallbacks({
      partnerId: env.partnerId, surface, role, ids: fallbackIds, storedIds: stored?.fallbackOfferingIds ?? null,
      inPermittedSet: inEffectiveSet, reference: effectiveDefault,
      crossFunding: (p?.fallbackMayCrossFunding ?? false) && orgCrossing !== false,
      ctx: env.ctx, cache: env.cache,
      onOutsidePermitted: (offeringId) => widen('fallbackOfferingIds', { offeringId }),
      onCrossesFunding: (offeringId) => widen('fallbackOfferingIds', { offeringId, key: 'crossFunding' }),
    });
  }
}
