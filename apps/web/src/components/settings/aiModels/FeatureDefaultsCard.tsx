import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiModelsSnapshotDto, AiOfferingDto, AiSurfaceDefaultsDto } from '@breeze/shared';
import { ROLE_LABEL_KEYS, SURFACE_LABEL_KEYS, unavailableIds, unavailableModelLabel } from './surfaceLabels';
import { FallbackListEditor } from './FallbackListEditor';
import { usePartnerSettingsDraftStore, type Slice } from '../partnerSettings/partnerSettingsDraftStore';
import {
  entryKey, rowProblem, rowsOf, syncAiFeatureDefaults,
  dirtyKeys, type AiFeatureDefaultsValue, type Display, type Effort, type RowDraft, type Speed,
} from '../partnerSettings/units/aiFeatureDefaultsUnit';

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

/** Test-id suffix: `${surface}` for a default row (W04's form), `${surface}-${role}` for a role sub-row. */
const idOf = (d: AiSurfaceDefaultsDto) => (d.role === 'default' ? d.surface : `${d.surface}-${d.role}`);
const isRoleRow = (d: AiSurfaceDefaultsDto) => d.role !== 'default';

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

export default function FeatureDefaultsCard({
  snapshot,
  onSaved,
}: {
  snapshot: AiModelsSnapshotDto;
  /** Refetches the snapshot; called after a header Save of this card (saved or stale write). */
  onSaved: () => void | Promise<void>;
}) {
  const { t } = useTranslation('settings');
  // The draft lives in the page-scoped store (W2): it survives a tab switch,
  // and the partner settings header Save sends it (aiFeatureDefaultsUnit.ts).
  const slice = usePartnerSettingsDraftStore((s) => s.slices.aiFeatureDefaults) as Slice<AiFeatureDefaultsValue>;
  const setDraft = (next: (v: AiFeatureDefaultsValue) => AiFeatureDefaultsValue) =>
    usePartnerSettingsDraftStore.getState().setDraft<AiFeatureDefaultsValue>('aiFeatureDefaults', next);

  // Every snapshot (first load and each reload after a model or connection
  // change) merges into the slice without dropping unsaved rows.
  useEffect(() => { syncAiFeatureDefaults(snapshot); }, [snapshot]);

  // After a header Save of this unit (saved, or a stale write), refetch the
  // snapshot: it refreshes the row stamps and marks rows changed elsewhere.
  const outcome = slice.lastOutcome;
  const seenOutcome = useRef(outcome);
  useEffect(() => {
    if (outcome === seenOutcome.current) return;
    seenOutcome.current = outcome;
    if (outcome?.status === 'saved' || outcome?.status === 'conflict') void onSaved();
  }, [outcome, onSaved]);

  if (slice.status !== 'ready' || !slice.draft || !slice.baseline) return null;
  const state = slice.draft;
  const base = slice.baseline;
  const rows = rowsOf(snapshot);
  const dirty = new Set(dirtyKeys(base, state));

  const edit = (d: AiSurfaceDefaultsDto, patch: Partial<RowDraft>) => {
    const eligible = eligibleOfferings(snapshot, d.requiresTools);
    const k = entryKey(d);
    setDraft((prev) => ({
      ...prev,
      rows: { ...prev.rows, [k]: normalize({ ...prev.rows[k], ...patch }, eligible, d, snapshot) },
      invalidRow: prev.invalidRow === k ? null : prev.invalidRow,
    }));
  };

  const handleDiscard = () => {
    setDraft((prev) => ({ ...prev, rows: { ...base.rows }, conflicts: {}, invalidRow: null }));
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
          const draft = state.rows[k];
          if (!draft) return null;
          const roleRow = isRoleRow(d);
          const eligible = eligibleOfferings(snapshot, d.requiresTools);
          const choices = defaultChoices(eligible, draft);
          const model = eligible.find((o) => o.id === draft.defaultOfferingId);
          const opts = optionChoices(model);
          const problem = dirty.has(k) ? rowProblem(k, draft) : null;
          const invalid = state.invalidRow === k || problem !== null;
          const id = idOf(d);
          const nameOf = (offeringId: string) => snapshot.offerings.find((o) => o.id === offeringId)?.displayName;
          // Stored ids that are no longer enabled/eligible stay listed so they can be unticked (the API accepts them as stored).
          const stale = unavailableIds(base.rows[k]?.permitted ?? [], draft.permitted, new Set(eligible.map((o) => o.id as string)));
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
              {problem && (
                <p data-testid={`ai-defaults-row-error-${id}`} className="text-xs text-destructive">
                  {problem === 'needsDefault' ? t('aiModels.defaults.needsDefault') : t('aiModels.defaults.needsPermitted')}
                </p>
              )}
              {d.surface === 'script_reviewer' && (
                <p className="text-xs text-muted-foreground">{t('aiModels.defaults.reviewerHelp')}</p>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-medium">
                  <span>{t('aiModels.defaults.default')}</span>
                  <select
                    id={`ai-defaults-default-${id}`}
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
                    id={`ai-defaults-permitted-mode-${id}`}
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

      {dirty.size > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-3">
          <span data-testid="ai-defaults-dirty" className="text-xs text-muted-foreground">{t('aiModels.defaults.unsaved')}</span>
          <button
            type="button"
            data-testid="ai-defaults-discard"
            onClick={handleDiscard}
            className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
          >
            {t('aiModels.defaults.discard')}
          </button>
        </div>
      )}
    </section>
  );
}
