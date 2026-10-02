/**
 * Partner offering writes for /ai/models (W04, #7602).
 *
 * The route gates every call on BILLING_MANAGE + canManagePartnerWidePolicies
 * + MFA and runs ensurePartnerCutover first (routes/aiModels/shared.ts
 * registryWrite). Each write then runs in ONE system transaction behind the
 * per-partner registry lock (the key W03's lockPartnerRegistryReconcile, cutover
 * and compatRemap use; W04 try-locks it, a held lock → 503 registry_busy),
 * so it serialises with a concurrent
 * /ai/provider key or kind switch that remaps offering ids — the same pattern
 * as partnerLlmConfig.inRegistryWrite. System scope bypasses RLS, so every
 * statement is pinned to input.partnerId (from auth, never from the body).
 *
 * All gates reuse W03's rule table via checkEnableEligibility, and every DB
 * failure goes through toRegistryWriteError.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AiSurface, OfferingDetailsPatch, OfferingOptions } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiModelAssignments, partnerAiModels } from '../../db/schema';
import { isHosted } from '../../config/env';
import { loadOfferingCandidate, loadPartnerFacts, platformCandidateFacts, type LoadedCandidate } from './candidateLoader';
import { checkEnableEligibility, onDisconnectedConnection, type EnableEligibilityContext } from './eligibility';
import { tryLockPartnerRegistryWrite } from './registryWriteLock';
import { enableOffering, getOffering, offeringPriceSource, type Offering } from './offerings';
import { getPlatformInferenceGeo, getPlatformModelById, type PlatformModel } from './platformModels';
import { CONNECTION_DISCONNECTED_MESSAGE, REGISTRY_BUSY_MESSAGE, RegistryWriteError, toRegistryWriteError } from './registryWriteErrors';

export interface OfferingInUse { surface: AiSurface; level: 'partner' | 'org'; orgId: string | null }

/**
 * Runs `write` in a fresh system transaction holding the partner's registry
 * lock (try-locked: a concurrent holder makes this a 503 registry_busy rather
 * than parking pooled connections), mapping any failure through
 * toRegistryWriteError. Shared by every W04
 * registry write (offerings here, assignments in assignmentWrites.ts).
 * Internal helpers below assume they are already inside it and never
 * open a second one: a nested runOutsideDbContext would take a new connection
 * and block on the advisory lock this transaction holds.
 */
export async function inPartnerRegistryWrite<T>(partnerId: string, label: string, fallbackMessage: string, write: () => Promise<T>): Promise<T> {
  try {
    return await runOutsideDbContext(() =>
      withSystemDbAccessContext(async () => {
        // Try, never wait (registryWriteLock.ts): a held lock is a 503 the client retries.
        if (!(await tryLockPartnerRegistryWrite(partnerId))) {
          throw new RegistryWriteError(REGISTRY_BUSY_MESSAGE, 'registry_busy', 503);
        }
        return write();
      }, label));
  } catch (error) {
    toRegistryWriteError(error, fallbackMessage);
  }
}

/**
 * The loader reads through its own system transaction (committed state). It
 * is only ever called for rows committed before this write began — never for
 * a row this transaction inserted (Q13).
 */
async function loadOwned(partnerId: string, offeringId: string): Promise<LoadedCandidate> {
  const c = await loadOfferingCandidate(offeringId, partnerId);
  if (!c) throw new RegistryWriteError('Model not found.', 'not_found', 404);
  return c;
}

export async function enableEligibilityContext(partnerId: string): Promise<EnableEligibilityContext> {
  const { plan } = await loadPartnerFacts(partnerId);
  return { partnerId, partnerPlan: plan, hosted: isHosted() };
}

/** Assignments (partner or org level) whose default is this offering. Runs in the ambient DB context. */
export async function listOfferingDefaultUses(partnerId: string, offeringId: string): Promise<OfferingInUse[]> {
  const rows = await db
    .select({ surface: aiModelAssignments.surface, orgId: aiModelAssignments.orgId })
    .from(aiModelAssignments)
    .where(and(
      eq(aiModelAssignments.offeringPartnerId, partnerId),
      eq(aiModelAssignments.defaultOfferingId, offeringId),
    ));
  return rows.map((r) => ({
    surface: r.surface as AiSurface,
    level: r.orgId === null ? 'partner' : 'org',
    orgId: r.orgId,
  }));
}

/** Fast mode is selectable on this platform model (supported + rated). */
function platformFastSelectable(pm: PlatformModel): boolean {
  return pm.optionSupport.speed.includes('fast') && Boolean(pm.optionRates?.['speed:fast']);
}

/**
 * Adds the partner's platform offering, optionally enabled, in ONE statement.
 * The enable gate runs on facts built from the platform row (W03's
 * platformCandidateFacts, with the platform geography), NOT through
 * loadOfferingCandidate: the loader reads through its own system transaction
 * and cannot see a row this write inserted but has not committed yet (Q13).
 * Spec §15 #7: a new offering whose model supports fast mode starts with
 * allowed speed ['standard']. Fast is opted into deliberately in the drawer,
 * behind the premium permission (updateOfferingDetails).
 */
export async function ensurePlatformOffering(input: { partnerId: string; platformModelId: string; enabled: boolean }): Promise<Offering> {
  return inPartnerRegistryWrite(input.partnerId, 'aiModels.ensurePlatformOffering', 'Could not add the model.', async () => {
    const platform = await getPlatformModelById(input.platformModelId);
    if (!platform || !platform.platformOffered || platform.lifecycle !== 'available') {
      throw new RegistryWriteError('This model is not offered on the platform.', 'not_eligible', 409, { reason: 'model_unavailable' });
    }
    if (input.enabled) {
      const facts = platformCandidateFacts(input.partnerId, platform, await getPlatformInferenceGeo());
      const reason = checkEnableEligibility(facts, await enableEligibilityContext(input.partnerId));
      if (reason) throw new RegistryWriteError('This model cannot be enabled.', 'not_eligible', 409, { reason });
    }
    const [inserted] = await db
      .insert(partnerAiModels)
      .values({
        partnerId: input.partnerId,
        connectionId: null,
        platformModelId: input.platformModelId,
        modelId: null,
        source: 'platform',
        enabled: input.enabled,
        allowedOptions: platformFastSelectable(platform) ? { speed: ['standard'] } : null,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    // Already added (a row committed before this write): enable it through the
    // normal gated path, inside this same locked transaction.
    const [existing] = await db
      .select()
      .from(partnerAiModels)
      .where(and(
        eq(partnerAiModels.partnerId, input.partnerId),
        eq(partnerAiModels.platformModelId, input.platformModelId),
        isNull(partnerAiModels.connectionId),
      ))
      .limit(1);
    if (!existing) throw new RegistryWriteError('Could not add the model.', 'write_failed', 500);
    if (input.enabled && !existing.enabled) {
      return (await setOfferingEnabledLocked({ partnerId: input.partnerId, offeringId: existing.id, enabled: true, force: false })).offering;
    }
    return existing;
  });
}

/**
 * Enable runs checkEnableEligibility (an offering on a disconnected connection
 * is refused as connection_unavailable); disable refuses (409 offering_in_use)
 * while a surface defaults to it, unless force.
 */
export async function setOfferingEnabled(input: {
  partnerId: string; offeringId: string; enabled: boolean; force: boolean;
}): Promise<{ offering: Offering; inUse: OfferingInUse[] }> {
  return inPartnerRegistryWrite(input.partnerId, 'aiModels.setOfferingEnabled', 'Could not change the model.',
    () => setOfferingEnabledLocked(input));
}

async function setOfferingEnabledLocked(input: {
  partnerId: string; offeringId: string; enabled: boolean; force: boolean;
}): Promise<{ offering: Offering; inUse: OfferingInUse[] }> {
  const candidate = await loadOwned(input.partnerId, input.offeringId);
  let inUse: OfferingInUse[] = [];
  if (input.enabled) {
    const reason = checkEnableEligibility(candidate.facts, await enableEligibilityContext(input.partnerId));
    if (reason) throw new RegistryWriteError('This model cannot be enabled.', 'not_eligible', 409, { reason });
  } else {
    inUse = await listOfferingDefaultUses(input.partnerId, input.offeringId);
    if (inUse.length > 0 && !input.force) {
      throw new RegistryWriteError(
        'This model is the default for one or more features. Choose another default first, or confirm.',
        'offering_in_use', 409, { inUse },
      );
    }
  }
  const offering = await enableOffering({ partnerId: input.partnerId, offeringId: input.offeringId, enabled: input.enabled });
  return { offering, inUse };
}

type OptionKey = 'effort' | 'thinkingDisplay' | 'speed';
export const OPTION_KEYS: readonly OptionKey[] = ['effort', 'thinkingDisplay', 'speed'];

/**
 * Support for one option key; `fast` only counts when the model has a fast
 * rate (§8). The loader already strips unrated fast from optionSupport
 * (withPricedSpeeds); the rate check is kept so this never depends on that.
 * Shared with assignmentWrites.
 */
export function supportedOptionValues(c: LoadedCandidate, key: OptionKey): readonly string[] {
  const base = (c.optionSupport[key] ?? []) as readonly string[];
  if (key === 'speed') return base.filter((s) => s !== 'fast' || Boolean(c.optionRates?.['speed:fast']));
  return base;
}

type ProposedAllowed = OfferingDetailsPatch['allowedOptions'] | null;

/**
 * Validates the COMPLETE proposed option state, whichever fields the patch
 * touches:
 *  - allowed lists must intersect support, and defaults must lie in allowed ∩ support;
 *  - fast counts as supported only while a fast rate will exist after the write
 *    (W03 loader, Q14: own prices carry no option rates; a BYOK offering with no
 *    own price inherits the linked platform row's option rates);
 *  - spec §15 #7: on a PLATFORM-funded offering, a selectable fast mode needs
 *    the premium permission. Rows that already break this rule exist: the W02
 *    projection (legacyReconcile) inserts platform offerings with
 *    allowedOptions and requiredPermission null. So the rule is enforced only
 *    when this patch is what makes fast selectable without the permission —
 *    the stored state was compliant, or the patch edits allowedOptions /
 *    requiredPermission, or it sets a fast default. A rename, a price edit or
 *    an unrelated option edit on such a row is never refused by it.
 */
function validateProposedOptions(
  c: LoadedCandidate,
  proposed: { allowed: ProposedAllowed; defaults: OfferingOptions | null; requiredPermission: string | null; fastRated: boolean },
  stored: { allowed: ProposedAllowed; requiredPermission: string | null; fastRated: boolean },
  patch: OfferingDetailsPatch,
): void {
  for (const key of OPTION_KEYS) {
    const support = key === 'speed'
      ? ((c.optionSupport.speed ?? []) as readonly string[]).filter((s) => s !== 'fast' || proposed.fastRated)
      : supportedOptionValues(c, key);
    const allow = proposed.allowed?.[key] as readonly string[] | undefined;
    if (allow && !allow.some((v) => support.includes(v))) {
      throw new RegistryWriteError('None of those options is supported by this model.', 'invalid', 422, { field: 'allowedOptions', key });
    }
    const value = proposed.defaults?.[key] as string | undefined;
    if (value !== undefined && (!support.includes(value) || (allow && !allow.includes(value)))) {
      throw new RegistryWriteError('That default is not available for this model.', 'invalid', 422, { field: 'defaultOptions', key });
    }
  }
  const fastNeedsPermission = (state: { allowed: ProposedAllowed; requiredPermission: string | null; fastRated: boolean }) =>
    c.funding === 'platform'
    && state.fastRated
    && ((c.optionSupport.speed ?? []) as readonly string[]).includes('fast')
    && (!state.allowed?.speed || state.allowed.speed.includes('fast'))
    && state.requiredPermission === null;
  const patchOwnsFastGate = !fastNeedsPermission(stored)
    || patch.allowedOptions !== undefined
    || patch.requiredPermission !== undefined
    || patch.defaultOptions?.speed === 'fast';
  if (fastNeedsPermission(proposed) && patchOwnsFastGate) {
    throw new RegistryWriteError(
      'Fast mode on Breeze credits needs the premium-model permission. Require it, or allow only standard speed.',
      'invalid', 422, { field: 'requiredPermission', reason: 'fast_requires_permission' },
    );
  }
}

async function validateRefusalFallback(partnerId: string, self: LoadedCandidate, fallbackId: string): Promise<void> {
  const fail = (reason: string): never => {
    throw new RegistryWriteError('That model cannot be the refusal fallback.', 'not_eligible', 422, { field: 'refusalFallbackOfferingId', reason });
  };
  if (fallbackId === self.offeringId) fail('self');
  const fb = await loadOfferingCandidate(fallbackId, partnerId);
  if (!fb) return fail('not_found');
  if (fb.connectionId !== self.connectionId || fb.funding !== self.funding) fail('different_connection');
  if (!fb.facts.enabled) fail('disabled');
  const reason = checkEnableEligibility(fb.facts, await enableEligibilityContext(partnerId));
  if (reason) fail(reason);
}

/**
 * Version token for optimistic concurrency. Postgres stores microseconds and
 * the DTO carries ISO milliseconds, so the comparison is made at ms precision
 * on both sides. W04 writes `updatedAt: new Date()` (ms precision), so every
 * row W04 has written compares exactly. Two writes inside one millisecond are
 * the only residual window; accepted, because a version column would need a
 * migration this wave does not take.
 */
export function sameVersion(stored: Date, expectedIso: string): boolean {
  return stored.toISOString() === new Date(expectedIso).toISOString();
}

export async function updateOfferingDetails(input: {
  partnerId: string; offeringId: string; patch: OfferingDetailsPatch;
}): Promise<Offering> {
  return inPartnerRegistryWrite(input.partnerId, 'aiModels.updateOfferingDetails', 'Could not save the model.',
    () => updateOfferingDetailsLocked(input));
}

async function updateOfferingDetailsLocked(input: {
  partnerId: string; offeringId: string; patch: OfferingDetailsPatch;
}): Promise<Offering> {
  const { patch } = input;
  const current = await getOffering(input.offeringId);
  if (!current || current.partnerId !== input.partnerId) throw new RegistryWriteError('Model not found.', 'not_found', 404);
  if (!sameVersion(current.updatedAt, patch.expectedUpdatedAt)) {
    throw new RegistryWriteError('This model was changed by someone else. Reload and try again.', 'stale_write', 409);
  }
  const candidate = await loadOwned(input.partnerId, input.offeringId);
  // Its offerings stay as ledger provenance (W03 soft-disconnect) and are
  // hidden from every list, so no edit of one is meaningful.
  if (onDisconnectedConnection(candidate.facts)) {
    throw new RegistryWriteError(CONNECTION_DISCONNECTED_MESSAGE, 'not_eligible', 409, { reason: 'connection_unavailable' });
  }

  const set: Partial<typeof partnerAiModels.$inferInsert> = { updatedAt: new Date() };
  if (patch.displayName !== undefined) set.displayName = patch.displayName;

  let fastRated = Boolean(candidate.optionRates?.['speed:fast']);
  if (patch.prices !== undefined) {
    const editable = current.source === 'discovered' || current.source === 'manual';
    if (!editable) {
      throw new RegistryWriteError('This model’s price comes from the platform or the catalog.', 'invalid', 422, { field: 'prices' });
    }
    if (patch.prices === null && current.enabled) {
      // §8 precedence after clearing the offering's own price: catalog
      // snapshot, then the linked platform row.
      const linked = current.platformModelId ? await getPlatformModelById(current.platformModelId) : null;
      const remaining = offeringPriceSource({ ...current, priceInputCentsPerM: null }, {
        platformRowPriced: Boolean(linked?.rates),
        catalogMapsAndVerifies: candidate.facts.catalog?.usable === true,
      });
      if (!remaining) throw new RegistryWriteError('An enabled model needs a price. Disable it first.', 'unpriced', 409);
    }
    // Own prices carry no fast-mode rate (Q14). Setting them makes fast
    // unselectable. Clearing them is judged against the current candidate
    // (conservative): fast from the linked row becomes selectable on the next
    // save, once the cleared price is committed.
    if (patch.prices !== null) fastRated = false;
    set.priceInputCentsPerM = patch.prices?.inputCentsPerM ?? null;
    set.priceOutputCentsPerM = patch.prices?.outputCentsPerM ?? null;
    set.priceCacheReadCentsPerM = patch.prices?.cacheReadCentsPerM ?? null;
    set.priceCacheWriteCentsPerM = patch.prices?.cacheWriteCentsPerM ?? null;
  }

  // Always validate the full proposed state, not only the fields in the patch.
  validateProposedOptions(candidate, {
    allowed: patch.allowedOptions !== undefined ? patch.allowedOptions : (current.allowedOptions as ProposedAllowed),
    defaults: patch.defaultOptions !== undefined ? patch.defaultOptions : (current.defaultOptions as OfferingOptions | null),
    requiredPermission: patch.requiredPermission !== undefined ? patch.requiredPermission : current.requiredPermission,
    fastRated,
  }, {
    allowed: current.allowedOptions as ProposedAllowed,
    requiredPermission: current.requiredPermission,
    fastRated: Boolean(candidate.optionRates?.['speed:fast']),
  }, patch);
  if (patch.allowedOptions !== undefined) set.allowedOptions = patch.allowedOptions as Record<string, unknown> | null;
  if (patch.defaultOptions !== undefined) set.defaultOptions = patch.defaultOptions as Record<string, unknown> | null;
  if (patch.requiredPermission !== undefined) set.requiredPermission = patch.requiredPermission;

  if (patch.refusalFallbackOfferingId !== undefined) {
    if (patch.refusalFallbackOfferingId !== null) {
      await validateRefusalFallback(input.partnerId, candidate, patch.refusalFallbackOfferingId);
    }
    set.refusalFallbackOfferingId = patch.refusalFallbackOfferingId;
  }

  const [updated] = await db
    .update(partnerAiModels)
    .set(set)
    .where(and(
      eq(partnerAiModels.id, input.offeringId),
      eq(partnerAiModels.partnerId, input.partnerId),
      sql`date_trunc('milliseconds', ${partnerAiModels.updatedAt}) = ${new Date(patch.expectedUpdatedAt).toISOString()}::timestamptz`,
    ))
    .returning();
  if (!updated) throw new RegistryWriteError('This model was changed by someone else. Reload and try again.', 'stale_write', 409);
  return updated;
}
