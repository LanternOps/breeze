import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CONFIGURABLE_AI_SURFACE_ROLES,
  type AiModelsSnapshotDto,
  type AiOfferingDto,
  type AiSurface,
  type AiSurfaceDefaultsDto,
  type PartnerAssignmentInput,
} from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, ActionError } from '../../../lib/runAction';
import { showToast } from '../../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { ROLE_LABEL_KEYS, SURFACE_LABEL_KEYS, registryFriendly, unavailableIds, unavailableModelLabel } from './surfaceLabels';
import { FallbackListEditor } from './FallbackListEditor';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const onUnauthorized = () => { void navigateTo('/login', { replace: true }); };

type Effort = NonNullable<NonNullable<PartnerAssignmentInput['options']>['effort']>;
type Display = NonNullable<NonNullable<PartnerAssignmentInput['options']>['thinkingDisplay']>;
type Speed = NonNullable<NonNullable<PartnerAssignmentInput['options']>['speed']>;

// Literal key maps: the i18n keyUsage test cannot check template keys.
const EFFORT_KEYS: Record<Effort, string> = {
  low: 'aiModels.defaults.effortValues.low',
  medium: 'aiModels.defaults.effortValues.medium',
  high: 'aiModels.defaults.effortValues.high',
  xhigh: 'aiModels.defaults.effortValues.xhigh',
  max: 'aiModels.defaults.effortValues.max',
};
const DISPLAY_KEYS: Record<Display, string> = {
  omitted: 'aiModels.defaults.displayValues.omitted',
  summarized: 'aiModels.defaults.displayValues.summarized',
  updates: 'aiModels.defaults.displayValues.updates',
};
const SPEED_KEYS: Record<Speed, string> = {
  standard: 'aiModels.defaults.speedValues.standard',
  fast: 'aiModels.defaults.speedValues.fast',
};

interface RowDraft {
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

/** Drafts are keyed by (surface, role): `ai_agents` carries the three escalation roles beside `default`. */
const roleKey = (surface: AiSurface, role: string) => `${surface}/${role}`;
const entryKey = (d: AiSurfaceDefaultsDto) => roleKey(d.surface, d.role);
/** Test-id suffix: `${surface}` for a default row (W04's form), `${surface}-${role}` for a role sub-row. */
const idOf = (d: AiSurfaceDefaultsDto) => (d.role === 'default' ? d.surface : `${d.surface}-${d.role}`);
const isRoleRow = (d: AiSurfaceDefaultsDto) => d.role !== 'default';

function fromSnapshot(d: AiSurfaceDefaultsDto): RowDraft {
  const p = d.partner;
  return {
    defaultOfferingId: p?.defaultOfferingId ?? '',
    mode: p?.permittedOfferingIds ? 'list' : 'all',
    permitted: p?.permittedOfferingIds ?? [],
    allowUserChoice: p?.allowUserChoice ?? true,
    effort: p?.options?.effort ?? '',
    display: p?.options?.thinkingDisplay ?? '',
    speed: p?.options?.speed ?? '',
    fallbacks: p?.fallbackOfferingIds ?? [],
    crossFunding: p?.fallbackMayCrossFunding ?? false,
  };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v) => b.includes(v));

function rowEquals(a: RowDraft, b: RowDraft): boolean {
  return a.defaultOfferingId === b.defaultOfferingId && a.mode === b.mode && sameList(a.permitted, b.permitted)
    && a.allowUserChoice === b.allowUserChoice && a.effort === b.effort && a.display === b.display && a.speed === b.speed
    && a.crossFunding === b.crossFunding && a.fallbacks.length === b.fallbacks.length && a.fallbacks.every((v, i) => v === b.fallbacks[i]);
}

/** Enabled offerings a surface may use (tool-capable when the surface calls tools). */
function eligibleOfferings(snapshot: AiModelsSnapshotDto, requiresTools: boolean): AiOfferingDto[] {
  return snapshot.offerings.filter((o) => o.id !== null && o.enabled && (!requiresTools || o.supportsTools));
}

/** Models the Default select may offer: eligible, narrowed by a non-empty "Only these" set. */
function defaultChoices(eligible: AiOfferingDto[], draft: RowDraft): AiOfferingDto[] {
  if (draft.mode === 'list' && draft.permitted.length > 0) return eligible.filter((o) => draft.permitted.includes(o.id as string));
  return eligible;
}

interface OptionChoices { effort: Effort[]; display: Display[]; speed: Speed[] }

/** Effort/display/speed the chosen default supports AND allows; fast only when the model has a fast rate. */
function optionChoices(model: AiOfferingDto | undefined): OptionChoices {
  if (!model) return { effort: [], display: [], speed: [] };
  const allowed = model.allowedOptions;
  const effort = model.optionSupport.effort.filter((v) => !allowed?.effort || allowed.effort.includes(v));
  const display = model.optionSupport.thinkingDisplay.filter((v) => !allowed?.thinkingDisplay || allowed.thinkingDisplay.includes(v));
  const speed = model.optionSupport.speed.filter((v) => (v !== 'fast' || model.fastRates !== null) && (!allowed?.speed || allowed.speed.includes(v)));
  return { effort, display, speed };
}

const BLANK_ROLE_DRAFT: RowDraft = {
  defaultOfferingId: '', mode: 'all', permitted: [], allowUserChoice: true, effort: '', display: '', speed: '', fallbacks: [], crossFunding: false,
};

const fundingOf = (snapshot: AiModelsSnapshotDto, id: string) => snapshot.offerings.find((o) => o.id === id)?.funding;

/** After an edit, keep the draft internally valid: default inside the choices, options inside the default's support, backups legal. */
function normalize(draft: RowDraft, eligible: AiOfferingDto[], d: AiSurfaceDefaultsDto, snapshot: AiModelsSnapshotDto): RowDraft {
  // A role row left on "Same as AI agents default" carries nothing else (saves as a clear).
  if (isRoleRow(d) && draft.defaultOfferingId === '') return { ...BLANK_ROLE_DRAFT, allowUserChoice: draft.allowUserChoice };
  const choices = defaultChoices(eligible, draft);
  let next = draft;
  if (draft.defaultOfferingId && !choices.some((o) => o.id === draft.defaultOfferingId) && choices.length > 0) {
    next = { ...next, defaultOfferingId: choices[0].id as string };
  }
  const model = eligible.find((o) => o.id === next.defaultOfferingId);
  const opts = optionChoices(model);
  const refFunding = model?.funding ?? null;
  const fallbacks = next.fallbacks.filter((id) =>
    id !== next.defaultOfferingId && (next.crossFunding || refFunding === null || fundingOf(snapshot, id) === undefined || fundingOf(snapshot, id) === refFunding));
  return {
    ...next,
    fallbacks,
    effort: next.effort && opts.effort.includes(next.effort) ? next.effort : '',
    display: next.display && opts.display.includes(next.display) ? next.display : '',
    speed: next.speed && opts.speed.includes(next.speed) ? next.speed : '',
  };
}

function toInput(draft: RowDraft, d: AiSurfaceDefaultsDto): PartnerAssignmentInput {
  const options = {
    ...(draft.effort ? { effort: draft.effort } : {}),
    ...(draft.display ? { thinkingDisplay: draft.display } : {}),
    ...(draft.speed ? { speed: draft.speed } : {}),
  };
  const set = draft.defaultOfferingId !== '';
  return {
    surface: d.surface,
    role: d.role as PartnerAssignmentInput['role'],
    defaultOfferingId: draft.defaultOfferingId || null, // '' on a role sub-row = clear (inherit)
    permittedOfferingIds: set ? (draft.mode === 'all' ? null : draft.permitted) : null,
    allowUserChoice: draft.allowUserChoice,
    options: set && Object.keys(options).length > 0 ? options : null,
    fallbackOfferingIds: set ? draft.fallbacks : null,
    fallbackMayCrossFunding: draft.crossFunding,
    expectedUpdatedAt: d.partner?.updatedAt ?? null,
  };
}

interface Tracked {
  base: Record<string, RowDraft>;
  stamps: Record<string, string | null>;
  drafts: Record<string, RowDraft>;
  conflicts: Record<string, boolean>;
}

function rowsOf(snapshot: AiModelsSnapshotDto): AiSurfaceDefaultsDto[] {
  return CONFIGURABLE_AI_SURFACE_ROLES
    .map((r) => snapshot.defaults.find((d) => d.surface === r.surface && d.role === r.role))
    .filter((d): d is AiSurfaceDefaultsDto => d !== undefined);
}

function initial(snapshot: AiModelsSnapshotDto): Tracked {
  const base: Tracked['base'] = {};
  const stamps: Tracked['stamps'] = {};
  for (const d of rowsOf(snapshot)) {
    base[entryKey(d)] = fromSnapshot(d);
    stamps[entryKey(d)] = d.partner?.updatedAt ?? null;
  }
  return { base, stamps, drafts: { ...base }, conflicts: {} };
}

/** Merge a reloaded snapshot: clean rows re-initialise, dirty rows keep their draft (marked when the stored row moved). */
function merge(prev: Tracked, snapshot: AiModelsSnapshotDto): Tracked {
  const next = initial(snapshot);
  const drafts: Tracked['drafts'] = {};
  const conflicts: Tracked['conflicts'] = {};
  for (const k of Object.keys(next.base)) {
    const had = prev.drafts[k];
    const dirty = had !== undefined && prev.base[k] !== undefined && !rowEquals(had, prev.base[k]);
    if (dirty) {
      drafts[k] = had;
      conflicts[k] = prev.conflicts[k] === true || prev.stamps[k] !== next.stamps[k];
    } else {
      drafts[k] = next.base[k];
    }
  }
  return { base: next.base, stamps: next.stamps, drafts, conflicts };
}

export default function FeatureDefaultsCard({
  snapshot,
  onSaved,
}: {
  snapshot: AiModelsSnapshotDto;
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useTranslation('settings');
  const [state, setState] = useState<Tracked>(() => initial(snapshot));
  const [saving, setSaving] = useState(false);
  const [invalidRow, setInvalidRow] = useState<string | null>(null);
  const seen = useRef(snapshot);

  useEffect(() => {
    if (seen.current === snapshot) return;
    seen.current = snapshot;
    setState((prev) => merge(prev, snapshot));
  }, [snapshot]);

  const rows = rowsOf(snapshot);
  const dirtyRows = rows.filter((d) => {
    const k = entryKey(d);
    return state.drafts[k] && state.base[k] && !rowEquals(state.drafts[k], state.base[k]);
  });
  const friendly = registryFriendly(t);

  const edit = (d: AiSurfaceDefaultsDto, patch: Partial<RowDraft>) => {
    const eligible = eligibleOfferings(snapshot, d.requiresTools);
    const k = entryKey(d);
    setState((prev) => ({
      ...prev,
      drafts: { ...prev.drafts, [k]: normalize({ ...prev.drafts[k], ...patch }, eligible, d, snapshot) },
    }));
  };

  const handleDiscard = () => {
    setInvalidRow(null);
    setState((prev) => ({ ...prev, drafts: { ...prev.base }, conflicts: {} }));
  };

  const handleSave = async () => {
    const inputs = dirtyRows.map((d) => toInput(state.drafts[entryKey(d)], d));
    if (dirtyRows.some((d) => !isRoleRow(d) && !state.drafts[entryKey(d)].defaultOfferingId)) {
      showToast({ type: 'error', message: t('aiModels.defaults.needsDefault') });
      return;
    }
    if (inputs.some((r) => r.permittedOfferingIds !== null && r.permittedOfferingIds.length === 0)) {
      showToast({ type: 'error', message: t('aiModels.defaults.needsPermitted') });
      return;
    }
    const savedKeys = dirtyRows.map(entryKey);
    setSaving(true);
    setInvalidRow(null);
    try {
      await runAction({
        request: () => fetchWithAuth('/ai/models/assignments', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ assignments: inputs }) }),
        successMessage: t('aiModels.defaults.saved'),
        errorFallback: t('aiModels.defaults.saveFailed'),
        friendly,
        onUnauthorized,
      });
      // Saved rows are the new baseline; the reload below then refreshes their stamps.
      setState((prev) => ({
        ...prev,
        base: { ...prev.base, ...Object.fromEntries(savedKeys.map((k) => [k, prev.drafts[k]])) },
        conflicts: Object.fromEntries(Object.entries(prev.conflicts).filter(([k]) => !savedKeys.includes(k))),
      }));
      await onSaved();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError) {
        // Already toasted by runAction.
        const details = (err.body as { details?: { surface?: string; role?: string } } | undefined)?.details;
        if (details?.surface) setInvalidRow(roleKey(details.surface as AiSurface, details.role ?? 'default'));
        if (err.code === 'stale_write') await onSaved();
        return;
      }
      showToast({ type: 'error', message: t('aiModels.defaults.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section data-testid="ai-defaults-card" className="space-y-3 rounded-md border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t('aiModels.defaults.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('aiModels.defaults.subtitle')}</p>
      </div>

      <ul className="space-y-3">
        {rows.map((d) => {
          const k = entryKey(d);
          const draft = state.drafts[k];
          if (!draft) return null;
          const roleRow = isRoleRow(d);
          const eligible = eligibleOfferings(snapshot, d.requiresTools);
          const choices = defaultChoices(eligible, draft);
          const model = eligible.find((o) => o.id === draft.defaultOfferingId);
          const opts = optionChoices(model);
          const invalid = invalidRow === k;
          const id = idOf(d);
          const nameOf = (offeringId: string) => snapshot.offerings.find((o) => o.id === offeringId)?.displayName;
          // Stored ids that are no longer enabled/eligible stay listed so they can be unticked (the API accepts them as stored).
          const stale = unavailableIds(state.base[k]?.permitted ?? [], draft.permitted, new Set(eligible.map((o) => o.id as string)));
          const staleDefault = draft.defaultOfferingId !== '' && !choices.some((o) => o.id === draft.defaultOfferingId);
          const togglePermitted = (offeringId: string, on: boolean) => edit(d, {
            permitted: on ? [...draft.permitted, offeringId] : draft.permitted.filter((p) => p !== offeringId),
          });
          const setBlank = roleRow && draft.defaultOfferingId === '';
          const fallbackOptions = eligible.filter((o) => o.id !== draft.defaultOfferingId);
          const toggleCrossFunding = (on: boolean) => edit(d, { crossFunding: on });
          return (
            <li
              key={k}
              data-testid={`ai-defaults-row-${id}`}
              aria-invalid={invalid ? 'true' : undefined}
              className={`space-y-3 rounded-md border p-3 ${roleRow ? 'ml-6 ' : ''}${invalid ? 'border-destructive' : ''}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">
                  {roleRow ? t(/* i18n-dynamic */ ROLE_LABEL_KEYS[d.role as keyof typeof ROLE_LABEL_KEYS]) : t(/* i18n-dynamic */ SURFACE_LABEL_KEYS[d.surface])}
                </span>
                {d.requiresTools && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t('aiModels.defaults.needsTools')}</span>
                )}
                {state.conflicts[k] && (
                  <span data-testid={`ai-defaults-conflict-${id}`} className="rounded-full bg-warning/10 px-2 py-0.5 text-xs text-warning">
                    {t('aiModels.defaults.changedElsewhere')}
                  </span>
                )}
                {d.orgOverrideCount > 0 && (
                  <a
                    data-testid={`ai-defaults-org-overrides-${id}`}
                    href="/settings/organizations"
                    className="text-xs text-primary hover:underline"
                  >
                    {t('aiModels.defaults.orgOverrides', { count: d.orgOverrideCount })}
                  </a>
                )}
              </div>
              {d.surface === 'script_reviewer' && (
                <p className="text-xs text-muted-foreground">{t('aiModels.defaults.reviewerHelp')}</p>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-medium">
                  <span>{t('aiModels.defaults.default')}</span>
                  <select
                    data-testid={`ai-defaults-default-${id}`}
                    value={draft.defaultOfferingId}
                    onChange={(e) => edit(d, { defaultOfferingId: e.target.value })}
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm font-normal"
                  >
                    {draft.defaultOfferingId === '' && (
                      <option value="">{roleRow ? t('aiModels.defaults.roleInherit') : t('aiModels.defaults.chooseDefault')}</option>
                    )}
                    {roleRow && draft.defaultOfferingId !== '' && <option value="">{t('aiModels.defaults.roleInherit')}</option>}
                    {staleDefault && (
                      <option value={draft.defaultOfferingId}>{unavailableModelLabel(t, nameOf(draft.defaultOfferingId))}</option>
                    )}
                    {choices.map((o) => <option key={o.id as string} value={o.id as string}>{o.displayName}</option>)}
                  </select>
                </label>

                {!setBlank && (
                <label className="space-y-1 text-xs font-medium">
                  <span>{t('aiModels.defaults.permitted')}</span>
                  <select
                    data-testid={`ai-defaults-permitted-mode-${id}`}
                    value={draft.mode}
                    onChange={(e) => edit(d, e.target.value === 'list' ? { mode: 'list', permitted: [] } : { mode: 'all', permitted: [] })}
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm font-normal"
                  >
                    <option value="all">{t('aiModels.defaults.permittedAll')}</option>
                    <option value="list">{t('aiModels.defaults.permittedList')}</option>
                  </select>
                </label>
                )}
              </div>

              {!setBlank && draft.mode === 'list' && (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {eligible.map((o) => (
                    <label key={o.id as string} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        data-testid={`ai-defaults-permitted-${id}-${o.id}`}
                        checked={draft.permitted.includes(o.id as string)}
                        onChange={(e) => togglePermitted(o.id as string, e.target.checked)}
                      />
                      {o.displayName}
                    </label>
                  ))}
                  {stale.map((sid) => (
                    <label key={sid} className="flex items-center gap-2 text-sm text-muted-foreground">
                      <input
                        type="checkbox"
                        data-testid={`ai-defaults-permitted-${id}-${sid}`}
                        checked={draft.permitted.includes(sid)}
                        onChange={(e) => togglePermitted(sid, e.target.checked)}
                      />
                      {unavailableModelLabel(t, nameOf(sid))}
                    </label>
                  ))}
                </div>
              )}

              {!setBlank && (
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-xs font-medium">
                  <span>{t('aiModels.defaults.effort')}</span>
                  <select
                    data-testid={`ai-defaults-effort-${id}`}
                    value={draft.effort}
                    onChange={(e) => edit(d, { effort: e.target.value as Effort | '' })}
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm font-normal"
                  >
                    <option value="">{t('aiModels.defaults.modelDefault')}</option>
                    {opts.effort.map((v) => <option key={v} value={v}>{t(/* i18n-dynamic */ EFFORT_KEYS[v])}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-xs font-medium">
                  <span>{t('aiModels.defaults.display')}</span>
                  <select
                    data-testid={`ai-defaults-display-${id}`}
                    value={draft.display}
                    onChange={(e) => edit(d, { display: e.target.value as Display | '' })}
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm font-normal"
                  >
                    <option value="">{t('aiModels.defaults.modelDefault')}</option>
                    {opts.display.map((v) => <option key={v} value={v}>{t(/* i18n-dynamic */ DISPLAY_KEYS[v])}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-xs font-medium">
                  <span>{t('aiModels.defaults.speed')}</span>
                  <select
                    data-testid={`ai-defaults-speed-${id}`}
                    value={draft.speed}
                    onChange={(e) => edit(d, { speed: e.target.value as Speed | '' })}
                    className="h-9 w-full rounded-md border bg-background px-2 text-sm font-normal"
                  >
                    <option value="">{t('aiModels.defaults.modelDefault')}</option>
                    {opts.speed.map((v) => <option key={v} value={v}>{t(/* i18n-dynamic */ SPEED_KEYS[v])}</option>)}
                  </select>
                </label>
              </div>
              )}

              {!roleRow && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid={`ai-defaults-user-choice-${id}`}
                    checked={draft.allowUserChoice}
                    onChange={(e) => edit(d, { allowUserChoice: e.target.checked })}
                  />
                  {t('aiModels.defaults.userChoice')}
                </label>
              )}

              {!setBlank && (
                <div className="space-y-2">
                  <span className="text-xs font-medium">{t('aiModels.defaults.fallbacks')}</span>
                  <FallbackListEditor
                    rowKey={id}
                    value={draft.fallbacks}
                    options={fallbackOptions}
                    referenceFunding={model?.funding ?? null}
                    crossFunding={draft.crossFunding}
                    onChange={(next) => edit(d, { fallbacks: next })}
                  />
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      data-testid={`ai-defaults-cross-funding-${id}`}
                      checked={draft.crossFunding}
                      onChange={(e) => toggleCrossFunding(e.target.checked)}
                    />
                    <span>
                      {t('aiModels.defaults.crossFunding')}
                      <span className="block text-xs text-muted-foreground">{t('aiModels.defaults.crossFundingHelp')}</span>
                    </span>
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {dirtyRows.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-3">
          <span data-testid="ai-defaults-dirty" className="text-xs text-muted-foreground">{t('aiModels.defaults.unsaved')}</span>
          <button
            type="button"
            data-testid="ai-defaults-discard"
            disabled={saving}
            onClick={handleDiscard}
            className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
          >
            {t('aiModels.defaults.discard')}
          </button>
          <button
            type="button"
            data-testid="ai-defaults-save"
            disabled={saving}
            onClick={() => { void handleSave(); }}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? t('common:states.saving') : t('common:actions.save')}
          </button>
        </div>
      )}
    </section>
  );
}
