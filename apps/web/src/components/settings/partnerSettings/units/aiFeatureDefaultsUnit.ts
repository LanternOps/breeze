import {
  CONFIGURABLE_AI_SURFACE_ROLES,
  type AiModelsSnapshotDto,
  type AiSurface,
  type AiSurfaceDefaultsDto,
  type PartnerAssignmentInput,
} from '@breeze/shared';
import { fetchWithAuth } from '../../../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';
import { navigateTo } from '@/lib/navigation';
import { registryFriendly } from '../../aiModels/surfaceLabels';
import { VALID_TAB, type TabValidity } from '../saveUnits';
import { saveSlice, useDraftSaveUnit, usePartnerSettingsDraftStore } from '../partnerSettingsDraftStore';

export type Effort = NonNullable<NonNullable<PartnerAssignmentInput['options']>['effort']>;
export type Display = NonNullable<NonNullable<PartnerAssignmentInput['options']>['thinkingDisplay']>;
export type Speed = NonNullable<NonNullable<PartnerAssignmentInput['options']>['speed']>;

export interface RowDraft {
  defaultOfferingId: string;
  mode: 'all' | 'list';
  permitted: string[];
  allowUserChoice: boolean;
  effort: Effort | '';
  display: Display | '';
  speed: Speed | '';
  /** Ordered backup models (order matters). */
  fallbacks: string[];
  crossFunding: boolean;
}

/**
 * The AI feature-defaults card as the draft store holds it. Rows are keyed by
 * (surface, role): `ai_agents` carries three escalation roles beside `default`.
 * `stamps` are the per-row `updatedAt` sent as `expectedUpdatedAt`; `conflicts`
 * marks a dirty row whose stored row changed elsewhere; `invalidRow` is the row
 * a 422 named.
 */
export type AiFeatureDefaultsValue = {
  rows: Record<string, RowDraft>;
  stamps: Record<string, string | null>;
  conflicts: Record<string, boolean>;
  invalidRow: string | null;
};

export const roleKey = (surface: AiSurface, role: string) => `${surface}/${role}`;
export const entryKey = (d: AiSurfaceDefaultsDto) => roleKey(d.surface, d.role);
const parseKey = (key: string) => { const [surface, role] = key.split('/'); return { surface: surface as AiSurface, role }; };
/** Test-id suffix: `${surface}` for a default row, `${surface}-${role}` for a role sub-row. */
export const idOfKey = (key: string) => { const { surface, role } = parseKey(key); return role === 'default' ? surface : `${surface}-${role}`; };
const isRoleKey = (key: string) => parseKey(key).role !== 'default';

export function fromSnapshot(d: AiSurfaceDefaultsDto): RowDraft {
  const p = d.partner;
  return {
    defaultOfferingId: p?.defaultOfferingId ?? '',
    mode: p?.permittedOfferingIds ? 'list' : 'all',
    permitted: p?.permittedOfferingIds ?? [],
    allowUserChoice: p?.allowUserChoice ?? true,
    effort: p?.options?.effort ?? '',
    display: p?.options?.thinkingDisplay ?? '',
    speed: p?.options?.speed ?? '',
    // A legacy /ai/provider remap can leave the default inside its own list
    // (inert: the walk skips the primary). Never echo it back: the write rejects it.
    fallbacks: (p?.fallbackOfferingIds ?? []).filter((id) => id !== p?.defaultOfferingId),
    crossFunding: p?.fallbackMayCrossFunding ?? false,
  };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v) => b.includes(v));

export function rowEquals(a: RowDraft, b: RowDraft): boolean {
  return a.defaultOfferingId === b.defaultOfferingId && a.mode === b.mode && sameList(a.permitted, b.permitted)
    && a.allowUserChoice === b.allowUserChoice && a.effort === b.effort && a.display === b.display && a.speed === b.speed
    && a.crossFunding === b.crossFunding && a.fallbacks.length === b.fallbacks.length && a.fallbacks.every((v, i) => v === b.fallbacks[i]);
}

export function rowsOf(snapshot: AiModelsSnapshotDto): AiSurfaceDefaultsDto[] {
  return CONFIGURABLE_AI_SURFACE_ROLES
    .map((r) => snapshot.defaults.find((d) => d.surface === r.surface && d.role === r.role))
    .filter((d): d is AiSurfaceDefaultsDto => d !== undefined);
}

function initial(snapshot: AiModelsSnapshotDto): AiFeatureDefaultsValue {
  const rows: AiFeatureDefaultsValue['rows'] = {};
  const stamps: AiFeatureDefaultsValue['stamps'] = {};
  for (const d of rowsOf(snapshot)) {
    rows[entryKey(d)] = fromSnapshot(d);
    stamps[entryKey(d)] = d.partner?.updatedAt ?? null;
  }
  return { rows, stamps, conflicts: {}, invalidRow: null };
}

export function dirtyKeys(baseline: AiFeatureDefaultsValue, draft: AiFeatureDefaultsValue): string[] {
  return Object.keys(draft.rows).filter((k) => baseline.rows[k] !== undefined && !rowEquals(draft.rows[k], baseline.rows[k]));
}

/**
 * Takes a (re)loaded snapshot into the slice: clean rows re-initialise, dirty
 * rows keep their draft and are marked when the stored row moved. A reload is
 * never allowed to drop an unsaved edit.
 */
export function syncAiFeatureDefaults(snapshot: AiModelsSnapshotDto): void {
  const store = usePartnerSettingsDraftStore.getState();
  const slice = store.slices.aiFeatureDefaults;
  const next = initial(snapshot);
  if (slice.status !== 'ready' || !slice.baseline || !slice.draft) {
    store.rebaseline('aiFeatureDefaults', next);
    return;
  }
  const prevBase = slice.baseline as AiFeatureDefaultsValue;
  const prev = slice.draft as AiFeatureDefaultsValue;
  const rows: AiFeatureDefaultsValue['rows'] = {};
  const conflicts: AiFeatureDefaultsValue['conflicts'] = {};
  for (const k of Object.keys(next.rows)) {
    const had = prev.rows[k];
    const dirty = had !== undefined && prevBase.rows[k] !== undefined && !rowEquals(had, prevBase.rows[k]);
    if (dirty) {
      rows[k] = had;
      conflicts[k] = prev.conflicts[k] === true || prev.stamps[k] !== next.stamps[k];
    } else {
      rows[k] = next.rows[k];
    }
  }
  store.rebaseline('aiFeatureDefaults', next);
  store.setDraft<AiFeatureDefaultsValue>('aiFeatureDefaults', { rows, stamps: next.stamps, conflicts, invalidRow: prev.invalidRow });
}

export function toInput(draft: RowDraft, key: string, stamp: string | null): PartnerAssignmentInput {
  const { surface, role } = parseKey(key);
  const options = {
    ...(draft.effort ? { effort: draft.effort } : {}),
    ...(draft.display ? { thinkingDisplay: draft.display } : {}),
    ...(draft.speed ? { speed: draft.speed } : {}),
  };
  const set = draft.defaultOfferingId !== '';
  return {
    surface,
    role: role as PartnerAssignmentInput['role'],
    defaultOfferingId: draft.defaultOfferingId || null, // '' on a role sub-row = clear (inherit)
    permittedOfferingIds: set ? (draft.mode === 'all' ? null : draft.permitted) : null,
    allowUserChoice: draft.allowUserChoice,
    options: set && Object.keys(options).length > 0 ? options : null,
    fallbackOfferingIds: set ? draft.fallbacks.filter((id) => id !== draft.defaultOfferingId) : null,
    fallbackMayCrossFunding: draft.crossFunding,
    expectedUpdatedAt: stamp,
  };
}

export type RowProblem = 'needsDefault' | 'needsPermitted';

/** A dirty row the write would refuse; shown inline and blocks the header Save. */
export function rowProblem(key: string, draft: RowDraft): RowProblem | null {
  if (!isRoleKey(key) && !draft.defaultOfferingId) return 'needsDefault';
  if (draft.defaultOfferingId && draft.mode === 'list' && draft.permitted.length === 0) return 'needsPermitted';
  return null;
}

/** The field a problem points the status-line link at. */
export const problemFieldId = (key: string, problem: RowProblem) =>
  (problem === 'needsDefault' ? `ai-defaults-default-${idOfKey(key)}` : `ai-defaults-permitted-mode-${idOfKey(key)}`);

function invalidRows(baseline: AiFeatureDefaultsValue, draft: AiFeatureDefaultsValue): string[] {
  return dirtyKeys(baseline, draft).filter((k) => rowProblem(k, draft.rows[k]) !== null);
}

function validityOf(baseline: AiFeatureDefaultsValue | null, draft: AiFeatureDefaultsValue): TabValidity {
  if (!baseline) return VALID_TAB;
  const bad = invalidRows(baseline, draft);
  if (bad.length === 0) return VALID_TAB;
  return { isValid: false, invalidCount: bad.length, firstInvalidFieldId: problemFieldId(bad[0], rowProblem(bad[0], draft.rows[bad[0]])!) };
}

const toLogin = () => { void navigateTo('/login', { replace: true }); };

const save = () => saveSlice<AiFeatureDefaultsValue>('aiFeatureDefaults', async (value) => {
  const baseline = usePartnerSettingsDraftStore.getState().slices.aiFeatureDefaults.baseline as AiFeatureDefaultsValue;
  const inputs = dirtyKeys(baseline, value).map((k) => toInput(value.rows[k], k, value.stamps[k] ?? null));
  try {
    await runAction({
      request: () => fetchWithAuth('/ai/models/assignments', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: inputs }),
      }),
      // No successMessage: the header Save shows one aggregate success toast.
      errorFallback: i18n.t('settings:aiModels.defaults.saveFailed'),
      friendly: registryFriendly(i18n.getFixedT(null, 'settings')),
      onUnauthorized: toLogin,
    });
  } catch (err) {
    if (err instanceof ActionError) {
      const details = (err.body as { details?: { surface?: string; role?: string } } | undefined)?.details;
      if (details?.surface) {
        const invalidRow = roleKey(details.surface as AiSurface, details.role ?? 'default');
        usePartnerSettingsDraftStore.getState().setDraft<AiFeatureDefaultsValue>('aiFeatureDefaults', (v) => ({ ...v, invalidRow }));
      }
    }
    throw err;
  }
  // Saved rows are the new baseline; the card reloads the snapshot to refresh their stamps.
  return { value: { ...value, conflicts: {}, invalidRow: null } };
}, {
  // Another session wrote a row first: keep the draft; the card reloads the
  // snapshot, which marks the moved rows "changed elsewhere".
  classifyError: (err) => (err instanceof ActionError && err.code === 'stale_write' ? 'conflict' : 'failed'),
  errorFallback: i18n.t('settings:aiModels.defaults.saveFailed'),
});

const isDirty = (baseline: AiFeatureDefaultsValue, draft: AiFeatureDefaultsValue) => dirtyKeys(baseline, draft).length > 0;
const validate = (draft: AiFeatureDefaultsValue) =>
  validityOf(usePartnerSettingsDraftStore.getState().slices.aiFeatureDefaults.baseline as AiFeatureDefaultsValue | null, draft);

/** Partner AI feature model defaults (`PUT /ai/models/assignments`) as a header-Save unit. */
export function useAiFeatureDefaultsUnit() {
  return useDraftSaveUnit<AiFeatureDefaultsValue>('aiFeatureDefaults', save, { validate, isDirty });
}
