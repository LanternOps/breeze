import { and, asc, eq, inArray } from 'drizzle-orm';
import { isRepresentableInCurrency } from '@breeze/shared';
import { db } from '../db';
import { isPgUniqueViolation } from '../utils/pgErrors';
import { billingProfiles, billingProfileRules, orgBillingProfileAssignments } from '../db/schema/billingProfiles';
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
type Card = Profile & ResolvedCard;
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
  return { ...profile, rules };
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
    const { rows, ...fields } = data;
    const values = { ...fields, partnerId, baseHourlyRate: data.baseHourlyRate ?? null,
      baseMinimumMinutes: data.baseMinimumMinutes ?? null, isDefault: false };
    validateBase(values);
    const profile = await insertProfile(tx, values);
    if (rows !== undefined) await replaceRows(tx, profile, rows);
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
async function updateProfileInTransaction(tx: DbExecutor, id: string, partnerId: string, data: UpdateProfileInput): Promise<Profile> {
  const profile = await profileById(tx, id, partnerId, true);
  if (profile.isDefault && profile.isActive && (data.isActive === false || data.isDefault === false ||
    (data.currencyCode !== undefined && data.currencyCode !== profile.currencyCode))) {
    throw new BillingProfileServiceError('Set another default profile first', 409, 'DEFAULT_PROFILE_REQUIRED');
  }
  if (data.currencyCode && data.currencyCode !== profile.currencyCode) {
    if (profile.baseHourlyRate !== null || (await withRules(tx, profile)).rules.some(row => row.hourlyRate !== null)) {
      throw new BillingProfileServiceError('A priced profile cannot change currency', 409, 'PROFILE_CURRENCY_LOCKED');
    }
    await assertCurrency(tx, data.currencyCode);
  }
  validateBase({ ...profile, ...data });
  const { isDefault, ...changes } = data;
  const [updated] = await tx.update(billingProfiles).set({ ...changes, updatedAt: new Date() })
    .where(and(eq(billingProfiles.id, id), eq(billingProfiles.partnerId, partnerId))).returning();
  if (!updated) throw missing();
  return isDefault === true ? switchDefault(tx, updated) : updated;
}
/** Save the entire Rates drawer under the same profile lock and savepoint. */
export async function saveProfile(caller: WorkTypeCaller, id: string, partnerId: string, input: SaveProfileInput): Promise<Card> {
  assertWriter(caller);
  const { rows, ...changes } = parsed(saveProfileSchema.safeParse(input));
  return db.transaction(async tx => {
    const profile = await updateProfileInTransaction(tx, id, partnerId, changes);
    return replaceRows(tx, profile, rows);
  }).catch(mapProfileWriteError);
}
/** One driver-owned transaction/savepoint; every operation uses its handle.
 * A failed insert rolls back the deletion before the route maps the error. */
export async function replaceProfileRows(caller: WorkTypeCaller, id: string, partnerId: string, rows: RowInput[]): Promise<Card> {
  assertWriter(caller);
  const data = parsed(profileRowsSchema.safeParse({ rows })).rows;
  return db.transaction(async tx => replaceRows(tx, await profileById(tx, id, partnerId, true), data));
}
async function replaceRows(tx: DbExecutor, profile: Profile, rows: RowInput[]): Promise<Card> {
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
  return { ...profile, rules: rows };
}

export async function cloneProfile(caller: WorkTypeCaller, id: string, partnerId: string, name: string): Promise<Profile> {
  assertWriter(caller);
  const cleanName = parsed(createProfileSchema.shape.name.safeParse(name));
  return db.transaction(async tx => {
    const original = await withRules(tx, await profileById(tx, id, partnerId, true));
    const { id: _id, createdAt: _created, updatedAt: _updated, rules, ...fields } = original;
    const clone = await insertProfile(tx, { ...fields, name: cleanName, isDefault: false, isActive: true });
    if (rules.length) await tx.insert(billingProfileRules).values(rules.map(row => ({
      partnerId, billingProfileId: clone.id, workTypeId: row.workTypeId,
      coverage: row.coverage, hourlyRate: row.hourlyRate, minimumMinutes: row.minimumMinutes,
      notes: 'notes' in row ? row.notes as string | null : null,
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
export async function loadCardsForOrg(orgId: string, partnerId: string, orgCurrency: string): Promise<{ assignedCard: Card | null; partnerDefaultCard: Card | null }> {
  const assignment = await getOrgAssignment(orgId, partnerId);
  const [assigned] = assignment ? await db.select().from(billingProfiles).where(and(
    eq(billingProfiles.id, assignment.billingProfileId), eq(billingProfiles.partnerId, partnerId), eq(billingProfiles.isActive, true))).limit(1) : [];
  const [fallback] = await db.select().from(billingProfiles).where(and(eq(billingProfiles.partnerId, partnerId),
    eq(billingProfiles.currencyCode, orgCurrency), eq(billingProfiles.isDefault, true), eq(billingProfiles.isActive, true))).limit(1);
  return { assignedCard: assigned ? await withRules(db, assigned) : null, partnerDefaultCard: fallback ? await withRules(db, fallback) : null };
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
