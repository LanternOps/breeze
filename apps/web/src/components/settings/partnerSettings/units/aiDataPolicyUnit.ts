import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';
import { runAction } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';
import { VALID_TAB, type TabValidity } from '../saveUnits';
import { saveSlice, useDraftSaveUnit, useDraftSlice, usePartnerSettingsDraftStore, type Loader } from '../partnerSettingsDraftStore';

export type Level = 'off' | 'no_user_profiles' | 'any_with_approval';
export type AiDataPolicyDefaults = {
  deviceFileReadLevel: Level;
  toolOutputRetentionDays: number | null;
  /** Technician AI transcript window (#4342 W4). Optional: an older API omits it. */
  transcriptRetentionDays?: number | null;
};

/**
 * The partner AI data policy as the card edits it. `level: null` = the Breeze
 * default. Both retention windows (tool outputs, technician AI transcripts):
 * on a partner row NULL means keep forever; the Breeze default applies only
 * while no row exists (`hasRow: false`).
 */
export type AiDataPolicyValue = {
  defaults: AiDataPolicyDefaults;
  canManage: boolean;
  hasRow: boolean;
  level: Level | null;
  retentionMode: 'days' | 'forever';
  /** The days box as typed, so an invalid entry survives a tab switch. */
  daysText: string;
  transcriptMode: 'days' | 'forever';
  /** The transcript days box as typed. */
  transcriptDaysText: string;
};

export const RETENTION_FIELD_ID = 'partner-ai-data-policy-retention';
export const TRANSCRIPT_FIELD_ID = 'partner-ai-data-policy-transcript-retention';
const MIN_DAYS = 1;
const MAX_DAYS = 3650;

export function defaultDays(value: Pick<AiDataPolicyValue, 'defaults'>): number {
  return value.defaults.toolOutputRetentionDays ?? 30;
}

export function defaultTranscriptDays(value: Pick<AiDataPolicyValue, 'defaults'>): number {
  return value.defaults.transcriptRetentionDays ?? 365;
}

type Dto = {
  deviceFileReadLevel: Level | null;
  toolOutputRetentionDays: number | null;
  transcriptRetentionDays?: number | null;
} | null;

export const loadAiDataPolicy: Loader<AiDataPolicyValue> = async () => {
  const res = await fetchWithAuth('/partner/ai/data-policy');
  if (!res.ok) throw new Error(`AI data policy load failed: ${res.status}`);
  const data = (await res.json()) as { policy: Dto; defaults: AiDataPolicyDefaults; canManage?: boolean };
  const { policy, defaults } = data;
  const stored = policy ? policy.toolOutputRetentionDays : defaults.toolOutputRetentionDays;
  // An absent field (older API) reads as the Breeze default, never as forever.
  const storedTranscript = policy && policy.transcriptRetentionDays !== undefined
    ? policy.transcriptRetentionDays
    : defaultTranscriptDays({ defaults });
  return {
    value: {
      defaults,
      canManage: Boolean(data.canManage),
      hasRow: policy !== null,
      level: policy?.deviceFileReadLevel ?? null,
      retentionMode: stored === null ? 'forever' : 'days',
      daysText: stored === null ? '' : String(stored ?? defaultDays({ defaults })),
      transcriptMode: storedTranscript === null ? 'forever' : 'days',
      transcriptDaysText: storedTranscript === null ? '' : String(storedTranscript),
    },
  };
};

export function useAiDataPolicyDraft() {
  return useDraftSlice<AiDataPolicyValue>('aiDataPolicy', loadAiDataPolicy);
}

function daysTextValid(raw: string): boolean {
  const text = raw.trim();
  const n = Number(text);
  return text !== '' && Number.isInteger(n) && n >= MIN_DAYS && n <= MAX_DAYS;
}

export function retentionDaysValid(value: AiDataPolicyValue): boolean {
  return value.retentionMode === 'forever' || daysTextValid(value.daysText);
}

export function transcriptDaysValid(value: AiDataPolicyValue): boolean {
  return value.transcriptMode === 'forever' || daysTextValid(value.transcriptDaysText);
}

function validate(value: AiDataPolicyValue): TabValidity {
  const invalid = [
    retentionDaysValid(value) ? null : RETENTION_FIELD_ID,
    transcriptDaysValid(value) ? null : TRANSCRIPT_FIELD_ID,
  ].filter((id): id is string => id !== null);
  return invalid.length === 0 ? VALID_TAB : { isValid: false, invalidCount: invalid.length, firstInvalidFieldId: invalid[0] };
}

const retentionOf = (value: AiDataPolicyValue): number | null =>
  (value.retentionMode === 'forever' ? null : Number(value.daysText.trim()));

const transcriptOf = (value: AiDataPolicyValue): number | null =>
  (value.transcriptMode === 'forever' ? null : Number(value.transcriptDaysText.trim()));

/** The PUT is a patch: only the fields that changed from what was loaded. */
export function aiDataPolicyPatch(value: AiDataPolicyValue, baseline: AiDataPolicyValue): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (value.level !== baseline.level) patch.deviceFileReadLevel = value.level;
  if (retentionOf(value) !== retentionOf(baseline)) patch.toolOutputRetentionDays = retentionOf(value);
  if (transcriptOf(value) !== transcriptOf(baseline)) patch.transcriptRetentionDays = transcriptOf(value);
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
  return {
    value: {
      ...value,
      hasRow: true,
      daysText: value.retentionMode === 'forever' ? '' : String(retentionOf(value)),
      transcriptDaysText: value.transcriptMode === 'forever' ? '' : String(transcriptOf(value)),
    },
  };
}, { errorFallback: i18n.t('settings:aiDataPolicy.failedToSave') });

/** Partner AI data policy defaults (`PUT /partner/ai/data-policy`) as a header-Save unit. */
export function useAiDataPolicyUnit() {
  return useDraftSaveUnit<AiDataPolicyValue>('aiDataPolicy', save, { validate });
}
