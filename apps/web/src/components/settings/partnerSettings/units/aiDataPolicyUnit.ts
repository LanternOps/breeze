import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { runAction } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';
import { VALID_TAB, type TabValidity } from '../saveUnits';
import { saveSlice, useDraftSaveUnit, useDraftSlice, usePartnerSettingsDraftStore, type Loader } from '../partnerSettingsDraftStore';

export type Level = 'off' | 'no_user_profiles' | 'any_with_approval';
export type AiDataPolicyDefaults = { deviceFileReadLevel: Level; toolOutputRetentionDays: number | null };

/**
 * The partner AI data policy as the card edits it. `level: null` = the Breeze
 * default. Retention: on a partner row NULL means keep forever; the Breeze
 * default applies only while no row exists (`hasRow: false`).
 */
export type AiDataPolicyValue = {
  defaults: AiDataPolicyDefaults;
  canManage: boolean;
  hasRow: boolean;
  level: Level | null;
  retentionMode: 'days' | 'forever';
  /** The days box as typed, so an invalid entry survives a tab switch. */
  daysText: string;
};

export const RETENTION_FIELD_ID = 'partner-ai-data-policy-retention';
const MIN_DAYS = 1;
const MAX_DAYS = 3650;

export function defaultDays(value: Pick<AiDataPolicyValue, 'defaults'>): number {
  return value.defaults.toolOutputRetentionDays ?? 30;
}

type Dto = { deviceFileReadLevel: Level | null; toolOutputRetentionDays: number | null } | null;

export const loadAiDataPolicy: Loader<AiDataPolicyValue> = async () => {
  const res = await fetchWithAuth('/partner/ai/data-policy');
  if (!res.ok) throw new Error(`AI data policy load failed: ${res.status}`);
  const data = (await res.json()) as { policy: Dto; defaults: AiDataPolicyDefaults; canManage?: boolean };
  const { policy, defaults } = data;
  const stored = policy ? policy.toolOutputRetentionDays : defaults.toolOutputRetentionDays;
  return {
    value: {
      defaults,
      canManage: Boolean(data.canManage),
      hasRow: policy !== null,
      level: policy?.deviceFileReadLevel ?? null,
      retentionMode: stored === null ? 'forever' : 'days',
      daysText: stored === null ? '' : String(stored ?? defaultDays({ defaults })),
    },
  };
};

export function useAiDataPolicyDraft() {
  return useDraftSlice<AiDataPolicyValue>('aiDataPolicy', loadAiDataPolicy);
}

export function retentionDaysValid(value: AiDataPolicyValue): boolean {
  if (value.retentionMode === 'forever') return true;
  const raw = value.daysText.trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= MIN_DAYS && n <= MAX_DAYS;
}

function validate(value: AiDataPolicyValue): TabValidity {
  return retentionDaysValid(value) ? VALID_TAB : { isValid: false, invalidCount: 1, firstInvalidFieldId: RETENTION_FIELD_ID };
}

const retentionOf = (value: AiDataPolicyValue): number | null =>
  (value.retentionMode === 'forever' ? null : Number(value.daysText.trim()));

/** The PUT is a patch: only the fields that changed from what was loaded. */
export function aiDataPolicyPatch(value: AiDataPolicyValue, baseline: AiDataPolicyValue): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (value.level !== baseline.level) patch.deviceFileReadLevel = value.level;
  if (retentionOf(value) !== retentionOf(baseline)) patch.toolOutputRetentionDays = retentionOf(value);
  return patch;
}

const save = () => saveSlice<AiDataPolicyValue>('aiDataPolicy', async (value) => {
  const baseline = usePartnerSettingsDraftStore.getState().slices.aiDataPolicy.baseline as AiDataPolicyValue;
  const patch = aiDataPolicyPatch(value, baseline);
  await runAction({
    request: () => fetchWithAuth('/partner/ai/data-policy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
    errorFallback: i18n.t('settings:aiDataPolicy.failedToSave'),
    // No successMessage: the header Save shows one aggregate success toast.
    onUnauthorized: handleSessionExpired,
  });
  // A save always leaves a partner row behind.
  return { value: { ...value, hasRow: true, daysText: value.retentionMode === 'forever' ? '' : String(retentionOf(value)) } };
}, { errorFallback: i18n.t('settings:aiDataPolicy.failedToSave') });

/** Partner AI data policy defaults (`PUT /partner/ai/data-policy`) as a header-Save unit. */
export function useAiDataPolicyUnit() {
  return useDraftSaveUnit<AiDataPolicyValue>('aiDataPolicy', save, { validate });
}
