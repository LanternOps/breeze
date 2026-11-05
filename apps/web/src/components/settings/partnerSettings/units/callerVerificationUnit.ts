import { i18n } from '@/lib/i18n';
import { getPolicy, putPolicy, type PolicyDraft, type PolicyResponse, type PolicyValues } from '@/lib/api/callerVerification';
import { saveSlice, useDraftSaveUnit, useDraftSlice, type Loader } from '../partnerSettingsDraftStore';

/** [min, max, tightening direction] — mirrors the shared validator and the server resolver. */
export const NUMERIC = {
  requiredTierResetPassword: [0, 3, 'max'], requiredTierDisableUser: [0, 3, 'max'],
  verificationTtlMinutes: [5, 240, 'min'], workstationTimeoutSeconds: [30, 300, 'min'],
  destinationMinAgeDays: [0, 90, 'max'], maxAttemptsPerHour: [1, 100, 'min'], coolingOffHours: [1, 720, 'max'],
} as const;
/** 'or' = an org can only turn it on; 'and' = an org can only turn it off. */
export const BOOLEANS = { requireAttestedDestination: 'or', requireTicket: 'or', allowCrossTechnicianUse: 'and', allowAdministrativeDisable: 'and' } as const;
export const SETS = {
  allowedMethods: ['workstation', 'sms', 'email', 'callback_attestation'],
  disableUserAuthorizerRoles: ['billing', 'technical', 'escalation', 'admin', 'site', 'after_hours', 'portal'],
} as const;
export const POLICY_KEYS = [...Object.keys(NUMERIC), ...Object.keys(BOOLEANS), ...Object.keys(SETS)] as (keyof PolicyValues)[];
export const TIER_KEYS = ['requiredTierResetPassword', 'requiredTierDisableUser'] as const;

export function inheritedDraft(): PolicyDraft {
  return Object.fromEntries(POLICY_KEYS.map((k) => [k, null])) as PolicyDraft;
}

/** Picks only policy fields: the stored row carries server columns the strict PUT schema rejects. */
export function draftFrom(row: PolicyResponse['row']): PolicyDraft {
  return Object.fromEntries(POLICY_KEYS.map((k) => [k, row?.[k] ?? null])) as PolicyDraft;
}

/** Tier 3 needs the workstation tier; the server refuses it while that is dark. */
export function tierCap(data: PolicyResponse, key: (typeof TIER_KEYS)[number]): number {
  return (key === 'requiredTierResetPassword' ? data.maxAchievableTierResetPassword : data.maxAchievableTierDisableUser) ?? data.maxAchievableTier ?? 3;
}

/** The PUT body: a stored tier above what is achievable would be refused, so send the achievable one. */
export function policyBody(draft: PolicyDraft, data: PolicyResponse): PolicyDraft {
  const body = { ...draft };
  for (const k of TIER_KEYS) if (body[k] !== null && body[k]! > tierCap(data, k)) body[k] = tierCap(data, k);
  return body;
}

/** The partner baseline as the draft store holds it: the server response plus the editable draft. */
export type CallerVerificationValue = { response: PolicyResponse; draft: PolicyDraft };

const PARTNER = { ownerScope: 'partner' } as const;

export const loadCallerVerification: Loader<CallerVerificationValue> = async () => {
  const response = await getPolicy(PARTNER);
  return { value: { response, draft: draftFrom(response.row) } };
};

/** The partner caller-verification panel's view of its draft. */
export function useCallerVerificationDraft() {
  return useDraftSlice<CallerVerificationValue>('callerVerification', loadCallerVerification);
}

const save = () => saveSlice<CallerVerificationValue>('callerVerification', async (value) => {
  // The header Save shows one aggregate success toast, so this request omits its own.
  const result = await putPolicy(PARTNER, policyBody(value.draft, value.response), { silentSuccess: true });
  return { value: { response: result, draft: draftFrom(result.row) } };
}, { errorFallback: i18n.t('callerVerificationTech:errors.saveFailed') });

/** Partner caller-verification baseline (`PUT /partner/caller-verification-policy`) as a header-Save unit. */
export function useCallerVerificationUnit() {
  return useDraftSaveUnit<CallerVerificationValue>('callerVerification', save);
}
