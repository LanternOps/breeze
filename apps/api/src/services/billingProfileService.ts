import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { isRepresentableInCurrency, type AiRateRowInput } from '@breeze/shared';
import { db } from '../db';
import { isPgUniqueViolation } from '../utils/pgErrors';
import {
  billingProfiles, billingProfileRules, billingProfileAiRates, orgBillingProfileAssignments,
} from '../db/schema/billingProfiles';
import { organizations } from '../db/schema/orgs';
import { supportedCurrencies } from '../db/schema/currency';
import { workTypes } from '../db/schema/workTypes';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from './partnerWideAccess';
import { readOrgStampingDefaults, OrgCurrencyServiceError, type DbExecutor } from './orgCurrencyCore';
import type { WorkTypeCaller } from './workTypeService';
import type { ResolvedCard } from './billingRuleResolver';
import { createProfileSchema, updateProfileSchema, profileRowsSchema, saveProfileSchema,
  type CreateProfileInput, type UpdateProfileInput, type SaveProfileInput, type RowInput } from './billingProfileValidation';
export type { CreateProfileInput, UpdateProfileInput, SaveProfileInput, RowInput } from './billingProfileValidation';

type Profile = typeof billingProfiles.$inferSelect;
type Assignment = typeof orgBillingProfileAssignments.$inferSelect;
type AiRate = typeof billingProfileAiRates.$inferSelect;
type Card = Profile & ResolvedCard & { aiRates: AiRate[] };
export type AiModelChoice = { modelId: string; label: string; source: 'offering' | 'recent_usage' };
export class BillingProfileServiceError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message); this.name = 'BillingProfileServiceError';
  }
}
const missing = () => new BillingProfileServiceError('Billing profile not found', 404, 'PROFILE_NOT_FOUND');
function assertWriter(caller: WorkTypeCaller) {
  if (!canManagePartnerWidePolicies(caller)) throw new PartnerWideWriteDeniedError();
}
function parsed<T>(result: { success: true; data: T } | { success: false }): T {
  if (!result.success) throw new BillingProfileServiceError('Invalid billing profile', 400, 'INVALID_PROFILE');
  return result.data;
}
function validateBase(profile: Pick<Profile, 'baseCoverage' | 'baseHourlyRate' | 'baseMinimumMinutes' | 'currencyCode'>) {
  if (profile.baseCoverage !== 'billable' && (profile.baseHourlyRate !== null || profile.baseMinimumMinutes !== null)) {
    throw new BillingProfileServiceError('Only billable rows may have a rate or minimum', 400, 'INVALID_PROFILE');
  }
  validateRate(profile.baseHourlyRate, profile.currencyCode);
}
function validateRate(rate: string | null, currency: string) {
  if (rate !== null && !isRepresentableInCurrency(rate, currency)) {
    throw new BillingProfileServiceError('Rate is not representable in this currency', 400, 'INVALID_RATE');
  }
}
/** A markup and a price list are prices, so (like base_hourly_rate) they exist only on a billable AI coverage. */
function validateAiTerms(p: Pick<Profile, 'aiCoverage' | 'aiMarkupPercent'>, aiRates?: readonly unknown[]) {
  if (p.aiCoverage !== 'billable' && (p.aiMarkupPercent !== null || (aiRates?.length ?? 0) > 0)) {
    throw new BillingProfileServiceError('Only billable AI usage may carry a markup or a price list', 400, 'INVALID_AI_TERMS');
  }
}
async function assertCurrency(tx: DbExecutor, currency: string) {
  const [row] = await tx.select().from(supportedCurrencies).where(eq(supportedCurrencies.code, currency)).limit(1);
  if (!row) throw new BillingProfileServiceError('Unsupported currency', 400, 'INVALID_CURRENCY');
}
async function profileById(tx: DbExecutor, id: string, partnerId: string, lock = false): Promise<Profile> {
  const query = tx.select().from(billingProfiles)
    .where(and(eq(billingProfiles.id, id), eq(billingProfiles.partnerId, partnerId))).limit(1);
  const [profile] = await (lock ? query.for('update') : query);
  if (!profile) throw missing();
  return profile;
}
async function withRules(tx: DbExecutor, profile: Profile): Promise<Card> {
  const rules = await tx.select().from(billingProfileRules).where(and(
    eq(billingProfileRules.billingProfileId, profile.id), eq(billingProfileRules.partnerId, profile.partnerId)));
  const aiRates = await tx.select().from(billingProfileAiRates).where(and(
    eq(billingProfileAiRates.billingProfileId, profile.id), eq(billingProfileAiRates.partnerId, profile.partnerId)))
    .orderBy(asc(billingProfileAiRates.modelId));
  return { ...profile, rules, aiRates };
}
async function replaceAiRates(tx: DbExecutor, profile: Profile, rates: AiRateRowInput[]): Promise<void> {
  await tx.delete(billingProfileAiRates).where(and(
    eq(billingProfileAiRates.billingProfileId, profile.id), eq(billingProfileAiRates.partnerId, profile.partnerId)));
  if (rates.length) {
    await tx.insert(billingProfileAiRates).values(rates.map((r) => ({
      partnerId: profile.partnerId, billingProfileId: profile.id, modelId: r.modelId,
      inputPricePerM: r.inputPricePerM, outputPricePerM: r.outputPricePerM,
      cacheReadPricePerM: r.cacheReadPricePerM, cacheWritePricePerM: r.cacheWritePricePerM, notes: r.notes ?? null,
    })));
  }
}
export async function getProfile(id: string, partnerId: string): Promise<Card> {
  return withRules(db, await profileById(db, id, partnerId));
}
export async function listProfiles(partnerId: string): Promise<Card[]> {
  const profiles = await db.select().from(billingProfiles).where(eq(billingProfiles.partnerId, partnerId)).orderBy(asc(billingProfiles.name));
  return Promise.all(profiles.map(profile => withRules(db, profile)));
}
async function switchDefault(tx: DbExecutor, profile: Profile): Promise<Profile> {
  if (!profile.isActive) throw new BillingProfileServiceError('An archived profile cannot be the default', 409, 'PROFILE_INACTIVE');
  await tx.update(billingProfiles).set({ isDefault: false, updatedAt: new Date() }).where(and(
    eq(billingProfiles.partnerId, profile.partnerId), eq(billingProfiles.currencyCode, profile.currencyCode), eq(billingProfiles.isDefault, true)));
  const [updated] = await tx.update(billingProfiles).set({ isDefault: true, updatedAt: new Date() })
    .where(and(eq(billingProfiles.id, profile.id), eq(billingProfiles.partnerId, profile.partnerId))).returning();
  if (!updated) throw missing();
  return updated;
}
async function insertProfile(tx: DbExecutor, values: typeof billingProfiles.$inferInsert): Promise<Profile> {
  // Do not catch a unique violation in the ambient request transaction.
  const [profile] = await tx.insert(billingProfiles).values(values).onConflictDoNothing().returning();
  if (!profile) throw new BillingProfileServiceError('A profile with that name already exists', 409, 'PROFILE_NAME_TAKEN');
  return profile;
}
export async function createProfile(caller: WorkTypeCaller, partnerId: string, input: CreateProfileInput): Promise<Profile> {
  assertWriter(caller);
  const data = parsed(createProfileSchema.safeParse(input));
  return db.transaction(async tx => {
    await assertCurrency(tx, data.currencyCode);
    const { rows, aiRates, ...fields } = data;
    const values = { ...fields, partnerId, baseHourlyRate: data.baseHourlyRate ?? null,
      baseMinimumMinutes: data.baseMinimumMinutes ?? null, isDefault: false,
      aiCoverage: data.aiCoverage ?? 'non_billable', aiMarkupPercent: data.aiMarkupPercent ?? null };
    validateBase(values);
    validateAiTerms(values, aiRates);
    const profile = await insertProfile(tx, values);
    if (rows !== undefined) await replaceRows(tx, profile, rows);
    if (aiRates !== undefined) await replaceAiRates(tx, profile, aiRates);
    return data.isDefault ? switchDefault(tx, profile) : profile;
  });
}
export async function updateProfile(caller: WorkTypeCaller, id: string, partnerId: string, input: UpdateProfileInput): Promise<Profile> {
  assertWriter(caller);
  const data = parsed(updateProfileSchema.safeParse(input));
  return db.transaction(async tx => {
    return updateProfileInTransaction(tx, id, partnerId, data);
  }).catch(mapProfileWriteError);
}
function mapProfileWriteError(error: unknown): never {
  // The driver has rolled the savepoint back before mapping a SQL error.
  if (isPgUniqueViolation(error)) {
    throw new BillingProfileServiceError('A profile with that name or default already exists', 409, 'PROFILE_NAME_TAKEN');
  }
  throw error;
}
async function updateProfileInTransaction(tx: DbExecutor, id: string, partnerId: string, inputData: UpdateProfileInput): Promise<Profile> {
  let data = inputData;
  const profile = await profileById(tx, id, partnerId, true);
  if (data.aiCoverage !== undefined && data.aiCoverage !== 'billable') {
    // Dependent prices go with the coverage, exactly as the UI clears them.
    data = { ...data, aiMarkupPercent: null };
    await replaceAiRates(tx, profile, []);
  }
  if (profile.isDefault && profile.isActive && (data.isActive === false || data.isDefault === false ||
    (data.currencyCode !== undefined && data.currencyCode !== profile.currencyCode))) {
    throw new BillingProfileServiceError('Set another default profile first', 409, 'DEFAULT_PROFILE_REQUIRED');
  }
  if (data.currencyCode && data.currencyCode !== profile.currencyCode) {
    // An AI markup is a price too (#7608): after a currency change a markup-only
    // card would silently stamp 'unpriced' (markup applies to USD cards only).
    const priced = profile.baseHourlyRate !== null
      || profile.aiMarkupPercent !== null
      || (await withRules(tx, profile)).rules.some(row => row.hourlyRate !== null)
      || (await tx.select({ id: billingProfileAiRates.id }).from(billingProfileAiRates)
        .where(eq(billingProfileAiRates.billingProfileId, profile.id)).limit(1)).length > 0;
    if (priced) {
      throw new BillingProfileServiceError('A priced profile cannot change currency', 409, 'PROFILE_CURRENCY_LOCKED');
    }
    await assertCurrency(tx, data.currencyCode);
  }
  validateBase({ ...profile, ...data });
  validateAiTerms({ ...profile, ...data });
  const { isDefault, ...changes } = data;
  const [updated] = await tx.update(billingProfiles).set({ ...changes, updatedAt: new Date() })
    .where(and(eq(billingProfiles.id, id), eq(billingProfiles.partnerId, partnerId))).returning();
  if (!updated) throw missing();
  return isDefault === true ? switchDefault(tx, updated) : updated;
}
/** Save the entire Rates drawer under the same profile lock and savepoint. */
export async function saveProfile(caller: WorkTypeCaller, id: string, partnerId: string, input: SaveProfileInput): Promise<Card> {
  assertWriter(caller);
  const { rows, aiRates, ...changes } = parsed(saveProfileSchema.safeParse(input));
  return db.transaction(async tx => {
    const profile = await updateProfileInTransaction(tx, id, partnerId, changes);
    validateAiTerms(profile, aiRates);
    await replaceRows(tx, profile, rows);
    if (aiRates !== undefined && profile.aiCoverage === 'billable') await replaceAiRates(tx, profile, aiRates);
    return withRules(tx, profile);
  }).catch(mapProfileWriteError);
}
/** One driver-owned transaction/savepoint; every operation uses its handle.
 * A failed insert rolls back the deletion before the route maps the error. */
export async function replaceProfileRows(caller: WorkTypeCaller, id: string, partnerId: string, rows: RowInput[]): Promise<Card> {
  assertWriter(caller);
  const data = parsed(profileRowsSchema.safeParse({ rows })).rows;
  return db.transaction(async tx => {
    const profile = await profileById(tx, id, partnerId, true);
    await replaceRows(tx, profile, data);
    return withRules(tx, profile);
  });
}
async function replaceRows(tx: DbExecutor, profile: Profile, rows: RowInput[]): Promise<void> {
  const { id, partnerId } = profile;
  if (new Set(rows.map(row => row.workTypeId)).size !== rows.length) {
    throw new BillingProfileServiceError('Duplicate work type', 400, 'DUPLICATE_WORK_TYPE');
  }
  if (rows.length) {
    const types = await tx.select({ id: workTypes.id }).from(workTypes).where(and(
      eq(workTypes.partnerId, partnerId), inArray(workTypes.id, rows.map(row => row.workTypeId))));
    if (types.length !== rows.length) throw new BillingProfileServiceError('Work type not found', 404, 'WORK_TYPE_NOT_FOUND');
  }
  rows.forEach(row => validateRate(row.hourlyRate, profile.currencyCode));
  await tx.delete(billingProfileRules).where(and(eq(billingProfileRules.billingProfileId, id), eq(billingProfileRules.partnerId, partnerId)));
  if (rows.length) await tx.insert(billingProfileRules).values(rows.map(row => ({ ...row, billingProfileId: id, partnerId })));
}

export async function cloneProfile(caller: WorkTypeCaller, id: string, partnerId: string, name: string): Promise<Profile> {
  assertWriter(caller);
  const cleanName = parsed(createProfileSchema.shape.name.safeParse(name));
  return db.transaction(async tx => {
    const original = await withRules(tx, await profileById(tx, id, partnerId, true));
    const { id: _id, createdAt: _created, updatedAt: _updated, rules, aiRates, ...fields } = original;
    const clone = await insertProfile(tx, { ...fields, name: cleanName, isDefault: false, isActive: true });
    if (rules.length) await tx.insert(billingProfileRules).values(rules.map(row => ({
      partnerId, billingProfileId: clone.id, workTypeId: row.workTypeId,
      coverage: row.coverage, hourlyRate: row.hourlyRate, minimumMinutes: row.minimumMinutes,
      notes: 'notes' in row ? row.notes as string | null : null,
    })));
    if (aiRates.length) await tx.insert(billingProfileAiRates).values(aiRates.map(row => ({
      partnerId, billingProfileId: clone.id, modelId: row.modelId,
      inputPricePerM: row.inputPricePerM, outputPricePerM: row.outputPricePerM,
      cacheReadPricePerM: row.cacheReadPricePerM, cacheWritePricePerM: row.cacheWritePricePerM, notes: row.notes,
    })));
    return clone;
  });
}
export async function setDefaultProfile(caller: WorkTypeCaller, id: string, partnerId: string): Promise<Profile> {
  assertWriter(caller);
  return db.transaction(async tx => switchDefault(tx, await profileById(tx, id, partnerId, true))).catch(error => {
    if (isPgUniqueViolation(error)) {
      throw new BillingProfileServiceError('The default profile changed concurrently; retry', 409, 'PROFILE_DEFAULT_CONFLICT');
    }
    throw error;
  });
}
/** Assignment readers require the caller's org-axis check in addition to partner RLS. */
export async function getOrgAssignment(orgId: string, partnerId: string): Promise<Assignment | null> {
  const [row] = await db.select().from(orgBillingProfileAssignments).where(and(
    eq(orgBillingProfileAssignments.orgId, orgId), eq(orgBillingProfileAssignments.partnerId, partnerId))).limit(1);
  return row ?? null;
}
/** Reuse a supplied transaction so assignment and surrounding settings commit together. */
export async function assignProfileToOrg(orgId: string, partnerId: string, profileId: string, assignedBy: string, executor?: DbExecutor): Promise<Assignment> {
  const assign = async (tx: DbExecutor): Promise<Assignment> => {
    // Canonical org SHARE barrier pairs with changeOrgCurrency's UPDATE lock.
    const { currencyCode } = await readOrgStampingDefaults(tx, orgId);
    const profile = await profileById(tx, profileId, partnerId, true);
    if (!profile.isActive) throw missing();
    if (profile.currencyCode !== currencyCode) {
      throw new BillingProfileServiceError('Profile currency must match the organization', 409, 'PROFILE_CURRENCY_MISMATCH');
    }
    // Structural composite FK enforces ownership; check it before writing too.
    const [org] = await tx.select({ id: organizations.id }).from(organizations)
      .where(and(eq(organizations.id, orgId), eq(organizations.partnerId, partnerId))).limit(1);
    if (!org) throw new BillingProfileServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
    const [assignment] = await tx.insert(orgBillingProfileAssignments)
      .values({ orgId, partnerId, billingProfileId: profileId, assignedBy })
      .onConflictDoUpdate({ target: orgBillingProfileAssignments.orgId,
        set: { billingProfileId: profileId, assignedBy, updatedAt: new Date() },
        setWhere: eq(orgBillingProfileAssignments.partnerId, partnerId) }).returning();
    if (!assignment) throw new BillingProfileServiceError('Organization not found', 404, 'ORG_NOT_FOUND');
    return assignment;
  };
  return (executor ? assign(executor) : db.transaction(assign)).catch(error => {
    if (error instanceof OrgCurrencyServiceError && error.code === 'ORG_NOT_FOUND') {
      throw new BillingProfileServiceError(error.message, 404, 'ORG_NOT_FOUND');
    }
    throw error;
  });
}
export async function clearOrgAssignment(orgId: string, partnerId: string, executor: DbExecutor = db): Promise<void> {
  await executor.delete(orgBillingProfileAssignments).where(and(eq(orgBillingProfileAssignments.orgId, orgId), eq(orgBillingProfileAssignments.partnerId, partnerId)));
}
/** THE card-candidate predicates, in one place: the org's assigned card if it
 *  is active, and the partner's active default in the org currency. Profile
 *  rows only, no rules or AI rates; selectCard (billingRuleResolver) chooses
 *  between the two. AI chargeback stamping (#7608) uses this directly because
 *  it re-reads the chosen card's terms and price list in one statement. */
export async function loadCardHeadsForOrg(orgId: string, partnerId: string, orgCurrency: string): Promise<{ assignedCard: Profile | null; partnerDefaultCard: Profile | null }> {
  const assignment = await getOrgAssignment(orgId, partnerId);
  const [assigned] = assignment ? await db.select().from(billingProfiles).where(and(
    eq(billingProfiles.id, assignment.billingProfileId), eq(billingProfiles.partnerId, partnerId), eq(billingProfiles.isActive, true))).limit(1) : [];
  const [fallback] = await db.select().from(billingProfiles).where(and(eq(billingProfiles.partnerId, partnerId),
    eq(billingProfiles.currencyCode, orgCurrency), eq(billingProfiles.isDefault, true), eq(billingProfiles.isActive, true))).limit(1);
  return { assignedCard: assigned ?? null, partnerDefaultCard: fallback ?? null };
}
export async function loadCardsForOrg(orgId: string, partnerId: string, orgCurrency: string): Promise<{ assignedCard: Card | null; partnerDefaultCard: Card | null }> {
  const { assignedCard, partnerDefaultCard } = await loadCardHeadsForOrg(orgId, partnerId, orgCurrency);
  return {
    assignedCard: assignedCard ? await withRules(db, assignedCard) : null,
    partnerDefaultCard: partnerDefaultCard ? await withRules(db, partnerDefaultCard) : null,
  };
}
/** Internal creation primitive, using the caller's transaction and RLS scope.
 * ON CONFLICT keeps concurrent creation from poisoning the request transaction.
 * Names are unique across currencies, so suffix only when the plain name is taken. */
export async function ensureDefaultProfile(partnerId: string, currencyCode: string, executor: DbExecutor = db): Promise<Profile> {
  for (let suffix = 0; ; suffix++) {
    const [existing] = await executor.select().from(billingProfiles).where(and(
      eq(billingProfiles.partnerId, partnerId), eq(billingProfiles.currencyCode, currencyCode),
      eq(billingProfiles.isDefault, true), eq(billingProfiles.isActive, true))).limit(1);
    if (existing) return existing;
    const name = suffix === 0 ? 'Standard rates' : suffix === 1 ? `Standard rates (${currencyCode})` : `Standard rates (${currencyCode} ${suffix})`;
    const [created] = await executor.insert(billingProfiles).values({ partnerId, currencyCode, name,
      isDefault: true, isActive: true, baseCoverage: 'billable', baseHourlyRate: null }).onConflictDoNothing().returning();
    if (created) return created;
  }
}

/**
 * Models a price-list row can name (#7608): the partner's enabled offerings
 * (their wire model id) plus every model that actually SERVED one of the
 * caller's orgs in the last 31 days (catalog offerings serve a providerModel
 * that differs from their logical id, and the price list keys on served_model).
 * An offering on a soft-disconnected connection is provenance only (#7700
 * finding 1) and is never offered, whatever its enabled flag says.
 * Free text is still accepted on save; this only feeds the picker.
 * Runs in the caller's partner request context: partner_ai_models and
 * partner_ai_connections are partner-axis, and the ai_invocations /
 * organizations reads are RLS-limited to the caller's accessible orgs.
 */
export async function listAiModelChoices(partnerId: string): Promise<AiModelChoice[]> {
  const result = await db.execute<{ model_id: string; label: string; source: 'offering' | 'recent_usage' }>(sql`
    SELECT DISTINCT ON (c.model_id) c.model_id, c.label, c.source FROM (
      SELECT COALESCE(pm.model_id, o.model_id) AS model_id,
             COALESCE(o.display_name, pm.display_name, pm.model_id, o.model_id) AS label,
             'offering' AS source, 0 AS rank
      FROM partner_ai_models o
      LEFT JOIN ai_platform_models pm ON pm.id = o.platform_model_id
      WHERE o.partner_id = ${partnerId}::uuid AND o.enabled
        AND (o.connection_id IS NULL OR EXISTS (
          SELECT 1 FROM partner_ai_connections conn
          WHERE conn.id = o.connection_id AND conn.status <> 'disconnected'))
      UNION ALL
      SELECT i.served_model, i.served_model, 'recent_usage', 1
      FROM ai_invocations i
      JOIN organizations org ON org.id = i.org_id
      WHERE org.partner_id = ${partnerId}::uuid
        AND i.ledger_mode = 'authoritative'
        AND i.created_at >= now() - interval '31 days'
    ) c
    WHERE c.model_id IS NOT NULL
    ORDER BY c.model_id, c.rank`);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  return (rows as Array<{ model_id: string; label: string; source: 'offering' | 'recent_usage' }>)
    .map((r) => ({ modelId: r.model_id, label: r.label, source: r.source }));
}
