/**
 * `manage_billing_profiles` (full-control W14, #6784): the AI twin of
 * Settings → Billing → Rates (routes/billingProfiles.ts) and an org's rate-card
 * assignment (routes/orgBillingProfile.ts), through the same services
 * (billingProfileService.ts, workTypeService.ts, billingOrgAccess.ts).
 *
 * Classes (W14 plan, facts 1–4):
 *  - `list` / `get` / `list_work_types` / `get_org_profile` t1;
 *  - every other action supervised. Profiles and work types are partner-wide
 *    by construction (every org of the partner is billed from them), and an
 *    org assignment picks the card one org is billed by — the W02
 *    `manage_billing_catalog:set_org_price` precedent.
 *
 * Gates (REST parity, re-made at release because the handler runs then):
 * partner scope with a partnerId; MFA on every write; `canManagePartnerWidePolicies`
 * on every profile / work-type write (the services' own `assertWriter`); org
 * assignment through `resolveBillingConfigurableOrg` and, stronger than REST,
 * `canMutateOrgWideGovernance` (W14-D8).
 *
 * Not built (W14-D4): work-type archive (it clears every ticket category's
 * default work type, which reactivation does not restore — `update_work_type`
 * refuses `isActive: false`), the Rates-drawer `save` and AI price-list edits.
 */
import { createProfileSchema, createWorkTypeSchema, updateProfileSchema, updateWorkTypeSchema } from '@breeze/shared';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { mfaGatedToolError } from './aiToolMfaGate';
import {
  BillingProfileServiceError, assignProfileToOrg, clearOrgAssignment, cloneProfile, createProfile, getOrgAssignment,
  getProfile, listProfiles, replaceProfileRows, updateProfile,
} from './billingProfileService';
import { profileRowsSchema } from './billingProfileValidation';
import { WorkTypeServiceError, createWorkType, listWorkTypes, updateWorkType } from './workTypeService';
import { PartnerWideWriteDeniedError, canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';
import { resolveBillingConfigurableOrg } from './billingOrgAccess';
import { BILLING_PROFILE_ACTIONS } from './aiToolSchemasBilling';
import { auditToolWrite, bounded, jsonError, notFound, orgWideWriteDenied, thrown, verifiedUserIdOrNull } from './aiToolsSoftwareShared';

type Action = (typeof BILLING_PROFILE_ACTIONS)[number];
const TOOL = 'manage_billing_profiles';

const READS: ReadonlySet<Action> = new Set(['list', 'get', 'list_work_types', 'get_org_profile']);
const ORG_ACTIONS: ReadonlySet<Action> = new Set(['get_org_profile', 'set_org_profile', 'clear_org_profile']);

/** REST parity: an org-scoped token has no read path to rates at all (routes/billingProfiles.ts). */
export function billingPartnerScopeRefusal(auth: AuthContext, what: string): string | null {
  if (auth.scope === 'partner' && auth.partnerId) return null;
  return jsonError(`${what} needs a partner-scoped session; organization-scoped callers cannot reach the matching HTTP routes either`, 'PARTNER_SCOPE_REQUIRED');
}

type Card = Awaited<ReturnType<typeof getProfile>>;
type ProfileHead = Awaited<ReturnType<typeof updateProfile>>;

/** The one shape a profile reaches the model in. */
function presentProfile(p: ProfileHead | Card) {
  const card = p as Partial<Card>;
  return {
    id: p.id, name: p.name, notes: p.notes, currencyCode: p.currencyCode,
    baseCoverage: p.baseCoverage, baseHourlyRate: p.baseHourlyRate, baseMinimumMinutes: p.baseMinimumMinutes,
    roundingIncrementMinutes: p.roundingIncrementMinutes, isDefault: p.isDefault, isActive: p.isActive,
    aiCoverage: p.aiCoverage, aiMarkupPercent: p.aiMarkupPercent,
    ...(card.rules ? {
      rows: card.rules.map((r) => ({
        workTypeId: r.workTypeId, coverage: r.coverage, hourlyRate: r.hourlyRate, minimumMinutes: r.minimumMinutes,
        notes: 'notes' in r ? (r as { notes?: string | null }).notes ?? null : null,
      })),
    } : {}),
    ...(card.aiRates ? {
      aiRates: card.aiRates.map((r) => ({
        modelId: r.modelId, inputPricePerM: r.inputPricePerM, outputPricePerM: r.outputPricePerM,
        cacheReadPricePerM: r.cacheReadPricePerM, cacheWritePricePerM: r.cacheWritePricePerM,
      })),
    } : {}),
  };
}

function serviceError(err: unknown): string | null {
  if (err instanceof BillingProfileServiceError || err instanceof WorkTypeServiceError) {
    return jsonError(err.message, err.code);
  }
  if (err instanceof PartnerWideWriteDeniedError) return jsonError(err.message, 'ACCESS_DENIED');
  return null;
}

function invalid(issues: { message: string; path: PropertyKey[] }[] | undefined): string {
  const first = issues?.[0];
  const where = first?.path.length ? `${first.path.map(String).join('.')}: ` : '';
  return jsonError(`${where}${first?.message ?? 'Invalid input'}`, 'VALIDATION_ERROR');
}

function pick(input: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (input[key] !== undefined) out[key] = input[key];
  return out;
}

const PROFILE_FIELDS = [
  'name', 'notes', 'currencyCode', 'baseCoverage', 'baseHourlyRate', 'baseMinimumMinutes',
  'roundingIncrementMinutes', 'isDefault', 'aiCoverage', 'aiMarkupPercent',
] as const;

function auditProfile(auth: AuthContext, action: string, profileId: string, details: Record<string, unknown>): void {
  auditToolWrite(auth, {
    orgId: null, partnerId: auth.partnerId, action, resourceType: 'billing_profile', resourceId: profileId,
    details: { ...details, tool_name: TOOL },
  });
}

async function profileWrite(action: Action, input: Record<string, unknown>, auth: AuthContext, partnerId: string): Promise<string> {
  if (action === 'create') {
    const parsed = createProfileSchema.safeParse({ ...pick(input, PROFILE_FIELDS), ...(input.rows !== undefined ? { rows: input.rows } : {}) });
    if (!parsed.success) return invalid(parsed.error.issues);
    const profile = await createProfile(auth, partnerId, parsed.data);
    auditProfile(auth, 'billing_profile.create', profile.id, { before: null, after: presentProfile(profile) });
    return bounded({ profile: presentProfile(profile) });
  }
  if (action === 'create_work_type') {
    const parsed = createWorkTypeSchema.safeParse(pick(input, ['name', 'sortOrder', 'isAfterHours']));
    if (!parsed.success) return invalid(parsed.error.issues);
    const workType = await createWorkType(auth, partnerId, parsed.data);
    auditToolWrite(auth, {
      orgId: null, partnerId, action: 'work_type.create', resourceType: 'work_type', resourceId: workType.id,
      resourceName: workType.name, details: { after: workType, tool_name: TOOL },
    });
    return bounded({ workType });
  }
  if (action === 'update_work_type') {
    if (typeof input.workTypeId !== 'string') return jsonError('workTypeId is required', 'VALIDATION_ERROR');
    // W14-D4: deactivating through update skips archive's category-default clean-up; archive is web-app only.
    if (input.isActive === false) return jsonError('Archiving a work type is done in the web app (it also clears ticket-category defaults)', 'ACCESS_DENIED');
    const parsed = updateWorkTypeSchema.safeParse(pick(input, ['name', 'sortOrder', 'isActive', 'isAfterHours']));
    if (!parsed.success) return invalid(parsed.error.issues);
    const previous = (await listWorkTypes(partnerId, { includeInactive: true })).find((w) => w.id === input.workTypeId) ?? null;
    if (!previous) return notFound('Work type');
    const workType = await updateWorkType(auth, input.workTypeId, partnerId, parsed.data);
    auditToolWrite(auth, {
      orgId: null, partnerId, action: 'work_type.update', resourceType: 'work_type', resourceId: workType.id,
      resourceName: workType.name, details: { changedFields: Object.keys(parsed.data), before: previous, tool_name: TOOL },
    });
    return bounded({ workType, before: previous });
  }

  if (typeof input.profileId !== 'string') return jsonError('profileId is required', 'VALIDATION_ERROR');
  const before = presentProfile(await getProfile(input.profileId, partnerId));
  if (action === 'update' || action === 'archive') {
    // Quorum QW3: moving AI coverage off billable deletes the AI price list and markup, which this tool cannot put back.
    if (action === 'update' && input.aiCoverage !== undefined && input.aiCoverage !== 'billable'
      && ((before.aiRates?.length ?? 0) > 0 || before.aiMarkupPercent !== null)) {
      return jsonError('This would delete the card\'s AI price list and markup; change AI coverage in the web app', 'ACCESS_DENIED');
    }
    const patch = action === 'archive' ? { isActive: false } : pick(input, [...PROFILE_FIELDS, 'isActive']);
    const parsed = updateProfileSchema.safeParse(patch);
    if (!parsed.success) return invalid(parsed.error.issues);
    const profile = await updateProfile(auth, input.profileId, partnerId, parsed.data);
    auditProfile(auth, action === 'archive' ? 'billing_profile.archive' : 'billing_profile.update', profile.id, { before, after: presentProfile(profile) });
    return bounded({ profile: presentProfile(profile), before });
  }
  if (action === 'set_rows') {
    const parsed = profileRowsSchema.safeParse({ rows: input.rows });
    if (!parsed.success) return invalid(parsed.error.issues);
    const profile = await replaceProfileRows(auth, input.profileId, partnerId, parsed.data.rows);
    auditProfile(auth, 'billing_profile.rows.replace', profile.id, { before, after: presentProfile(profile) });
    return bounded({ profile: presentProfile(profile), before });
  }
  // clone
  const parsed = createProfileSchema.shape.name.safeParse(input.name);
  if (!parsed.success) return invalid(parsed.error.issues);
  const profile = await cloneProfile(auth, input.profileId, partnerId, parsed.data);
  auditProfile(auth, 'billing_profile.clone', profile.id, { sourceProfileId: input.profileId, before: null, after: presentProfile(profile) });
  return bounded({ profile: presentProfile(profile) });
}

async function orgProfile(action: Action, input: Record<string, unknown>, auth: AuthContext): Promise<string> {
  if (typeof input.orgId !== 'string') return jsonError('orgId is required', 'VALIDATION_ERROR');
  const org = await resolveBillingConfigurableOrg(auth, input.orgId);
  if (!org) return notFound('Organization');
  if (action === 'get_org_profile') {
    return bounded({ orgId: org.id, assignment: await getOrgAssignment(org.id, org.partnerId) });
  }
  const denied = orgWideWriteDenied(auth, 'An organization\'s rate card');
  if (denied) return denied;
  const before = await getOrgAssignment(org.id, org.partnerId);
  if (action === 'clear_org_profile') {
    await clearOrgAssignment(org.id, org.partnerId);
    auditToolWrite(auth, {
      orgId: org.id, action: 'organization.billing_profile.clear', resourceType: 'organization', resourceId: org.id,
      details: { before, after: null, tool_name: TOOL },
    });
    return bounded({ orgId: org.id, assignment: null, before });
  }
  if (typeof input.profileId !== 'string') return jsonError('profileId is required', 'VALIDATION_ERROR');
  // W14-D7: assigned_by is a users FK — a verified user or NULL.
  const assignment = await assignProfileToOrg(org.id, org.partnerId, input.profileId, await verifiedUserIdOrNull(auth));
  auditToolWrite(auth, {
    orgId: org.id, action: 'organization.billing_profile.assign', resourceType: 'organization', resourceId: org.id,
    details: { before, after: assignment, tool_name: TOOL },
  });
  return bounded({ orgId: org.id, assignment, before });
}

export function registerBillingProfileTools(aiTools: Map<string, AiTool>): void {
  aiTools.set(TOOL, {
    tier: 1,
    deviceArgs: [],
    domain: 'billing',
    searchHint: 'rate cards (billing profiles), hourly rates per work type, work types, which rate card bills an org',
    definition: {
      name: TOOL,
      description: 'Rate cards that price time entries, their per-work-type rows, work types and the card an org is billed by. Actions: list, get, list_work_types, get_org_profile, create, update, archive, set_rows, clone, create_work_type, update_work_type, set_org_profile, clear_org_profile (writes need approval).',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: [...BILLING_PROFILE_ACTIONS], description: 'The action to perform' },
          profileId: { type: 'string', description: 'Rate card UUID (get, update, archive, set_rows, clone, set_org_profile)' },
          workTypeId: { type: 'string', description: 'update_work_type: work type UUID' },
          orgId: { type: 'string', description: 'get_org_profile / set_org_profile / clear_org_profile: org UUID' },
          includeInactive: { type: 'boolean', description: 'list_work_types: include archived work types' },
          name: { type: 'string', description: 'create / update / clone / create_work_type / update_work_type' },
          notes: { type: ['string', 'null'] },
          currencyCode: { type: 'string', description: 'create: ISO 4217 code; a priced card cannot change currency' },
          baseCoverage: { type: 'string', enum: ['billable', 'included', 'non_billable'] },
          baseHourlyRate: { type: ['string', 'null'], description: 'Decimal string in the card currency (billable only)' },
          baseMinimumMinutes: { type: ['integer', 'null'] },
          roundingIncrementMinutes: { type: ['integer', 'null'] },
          isDefault: { type: 'boolean', description: 'Make this the partner default for its currency' },
          isActive: { type: 'boolean', description: 'update: false archives a card; update_work_type: true only (reactivate)' },
          aiCoverage: { type: 'string', enum: ['billable', 'included', 'non_billable'] },
          aiMarkupPercent: { type: ['string', 'null'] },
          rows: {
            type: 'array',
            description: 'create / set_rows: the COMPLETE per-work-type row list (set_rows replaces every row)',
            items: {
              type: 'object',
              properties: {
                workTypeId: { type: 'string' },
                coverage: { type: 'string', enum: ['billable', 'included', 'non_billable'] },
                hourlyRate: { type: ['string', 'null'] },
                minimumMinutes: { type: ['integer', 'null'] },
                notes: { type: ['string', 'null'] },
              },
              required: ['workTypeId', 'coverage', 'hourlyRate', 'minimumMinutes'],
            },
          },
          sortOrder: { type: 'integer' },
          isAfterHours: { type: 'boolean' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    handler: async (input, auth) => {
      const action = input.action as Action;
      if (!BILLING_PROFILE_ACTIONS.includes(action)) return jsonError(`Unknown action: ${String(action)}`);
      const refusal = billingPartnerScopeRefusal(auth, 'Rate cards');
      if (refusal) return refusal;
      const partnerId = auth.partnerId!;
      try {
        if (!READS.has(action)) {
          const mfa = mfaGatedToolError(TOOL, action, auth);
          if (mfa) return mfa;
        }
        if (ORG_ACTIONS.has(action)) return await orgProfile(action, input, auth);
        if (action === 'list') return bounded({ profiles: (await listProfiles(partnerId)).map(presentProfile) });
        if (action === 'get') {
          if (typeof input.profileId !== 'string') return jsonError('profileId is required', 'VALIDATION_ERROR');
          return bounded({ profile: presentProfile(await getProfile(input.profileId, partnerId)) });
        }
        if (action === 'list_work_types') {
          return bounded({ workTypes: await listWorkTypes(partnerId, { includeInactive: input.includeInactive === true }) });
        }
        // Every remaining action writes partner-wide rates (fact 1); the services re-check this gate.
        if (!canManagePartnerWidePolicies(auth)) return jsonError(PARTNER_WIDE_WRITE_DENIED_MESSAGE, 'ACCESS_DENIED');
        return await profileWrite(action, input, auth, partnerId);
      } catch (error) {
        return serviceError(error) ?? thrown(TOOL, error);
      }
    },
  });
}
