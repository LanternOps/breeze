import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  CONFIGURABLE_AI_SURFACES,
  EFFORT_LEVELS,
  type AiOrgModelDefaultsDto,
  type AiOrgSurfaceDefaultsDto,
  type AiSurface,
  type EffortLevel,
  type OrgAssignmentInput,
} from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, ActionError } from '../../../lib/runAction';
import { showToast } from '../../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { DEFAULT_SOURCE_KEYS, SURFACE_LABEL_KEYS, registryFriendly, unavailableIds, unavailableModelLabel } from './surfaceLabels';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const onUnauthorized = () => { void navigateTo('/login', { replace: true }); };

type Options = NonNullable<OrgAssignmentInput['options']>;
type Display = NonNullable<Options['thinkingDisplay']>;
type Speed = NonNullable<Options['speed']>;
type Offering = AiOrgModelDefaultsDto['offerings'][number];

// Literal key maps: the i18n keyUsage test cannot check template keys.
const EFFORT_KEYS: Record<EffortLevel, string> = {
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

const EFFORT_RANK = Object.fromEntries(EFFORT_LEVELS.map((e, i) => [e, i])) as Record<EffortLevel, number>;
const effortChoices = (inheritedEffort: EffortLevel | undefined, supported: EffortLevel[]) =>
  supported.filter((e) => inheritedEffort === undefined || EFFORT_RANK[e] <= EFFORT_RANK[inheritedEffort]);

interface RowDraft {
  /** '' = inherit the partner default. */
  defaultOfferingId: string;
  mode: 'inherit' | 'list';
  permitted: string[];
  lock: boolean;
  effort: EffortLevel | '';
  display: Display | '';
  speed: Speed | '';
}

const isReviewer = (s: AiSurface) => s === 'script_reviewer';

function fromRow(d: AiOrgSurfaceDefaultsDto): RowDraft {
  const o = d.org;
  return {
    defaultOfferingId: o?.defaultOfferingId ?? '',
    mode: o?.permittedOfferingIds ? 'list' : 'inherit',
    permitted: o?.permittedOfferingIds ?? [],
    lock: o?.allowUserChoice === false,
    effort: o?.options?.effort ?? '',
    display: o?.options?.thinkingDisplay ?? '',
    speed: o?.options?.speed ?? '',
  };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v) => b.includes(v));
const rowEquals = (a: RowDraft, b: RowDraft) =>
  a.defaultOfferingId === b.defaultOfferingId && a.mode === b.mode && sameList(a.permitted, b.permitted)
  && a.lock === b.lock && a.effort === b.effort && a.display === b.display && a.speed === b.speed;

/** Offerings an org override may pick from: the partner's permitted set, tool-capable when the surface needs tools. */
function partnerChoices(dto: AiOrgModelDefaultsDto, d: AiOrgSurfaceDefaultsDto): Offering[] {
  const inherited = d.inherited.permittedOfferingIds;
  return dto.offerings.filter((o) => o.id !== null && (!d.requiresTools || o.supportsTools) && (!inherited || inherited.includes(o.id as string)));
}

/** The org's own permitted set narrows further (an empty "Only these" list narrows nothing yet). */
function effectiveSet(dto: AiOrgModelDefaultsDto, d: AiOrgSurfaceDefaultsDto, draft: RowDraft): Offering[] {
  const base = partnerChoices(dto, d);
  return draft.mode === 'list' && draft.permitted.length > 0 ? base.filter((o) => draft.permitted.includes(o.id as string)) : base;
}

/** The model whose supported options bound the option selects: the org's pick, else the inherited default. */
function modelFor(dto: AiOrgModelDefaultsDto, d: AiOrgSurfaceDefaultsDto, draft: RowDraft): Offering | undefined {
  const id = draft.defaultOfferingId || d.inherited.defaultOfferingId;
  return dto.offerings.find((o) => o.id === id);
}

interface OptionChoices { effort: EffortLevel[]; display: Display[]; speed: Speed[] }

/** Narrowing-only choices: effort <= inherited, fast only when the partner already allows it. */
function optionChoices(dto: AiOrgModelDefaultsDto, d: AiOrgSurfaceDefaultsDto, draft: RowDraft): OptionChoices {
  const model = modelFor(dto, d, draft);
  if (!model) return { effort: [], display: [], speed: [] };
  const inh = d.inherited.options;
  return {
    effort: effortChoices(inh.effort, model.optionSupport.effort),
    display: model.optionSupport.thinkingDisplay,
    speed: model.optionSupport.speed.filter((v) => v !== 'fast' || inh.speed === 'fast'),
  };
}

/** After an edit, keep the draft internally valid: default inside the permitted set, options inside the model's support. */
function normalize(dto: AiOrgModelDefaultsDto, d: AiOrgSurfaceDefaultsDto, draft: RowDraft): RowDraft {
  const next = draft.defaultOfferingId && !effectiveSet(dto, d, draft).some((o) => o.id === draft.defaultOfferingId)
    ? { ...draft, defaultOfferingId: '' }
    : draft;
  const opts = optionChoices(dto, d, next);
  return {
    ...next,
    effort: next.effort && opts.effort.includes(next.effort) ? next.effort : '',
    display: next.display && opts.display.includes(next.display) ? next.display : '',
    speed: next.speed && opts.speed.includes(next.speed) ? next.speed : '',
  };
}

function toInput(surface: AiSurface, draft: RowDraft, d: AiOrgSurfaceDefaultsDto): OrgAssignmentInput {
  const options = {
    ...(draft.effort ? { effort: draft.effort } : {}),
    ...(draft.display ? { thinkingDisplay: draft.display } : {}),
    ...(draft.speed ? { speed: draft.speed } : {}),
  };
  return {
    surface,
    role: 'default',
    defaultOfferingId: draft.defaultOfferingId || null,
    permittedOfferingIds: draft.mode === 'inherit' ? null : draft.permitted,
    allowUserChoice: draft.lock ? false : null,
    options: Object.keys(options).length > 0 ? options : null,
    expectedUpdatedAt: d.org?.updatedAt ?? null,
  };
}

/** True when "Only these" would drop the partner's default and the org has picked no replacement. */
function inheritedDefaultDropped(d: AiOrgSurfaceDefaultsDto, draft: RowDraft): boolean {
  const inh = d.inherited.defaultOfferingId;
  return Boolean(inh) && !draft.defaultOfferingId && draft.mode === 'list' && draft.permitted.length > 0 && !draft.permitted.includes(inh as string);
}

type FieldKey = 'default' | 'permitted' | 'lock' | 'effort' | 'display' | 'speed';
interface FieldError { surface: AiSurface; field: FieldKey; pickDefault: boolean }

/** Map a 422 widens_partner `details` to the control it names. */
function fieldErrorFrom(body: unknown): FieldError | null {
  const details = (body as { details?: { surface?: string; field?: string; key?: string; reason?: string } } | undefined)?.details;
  if (!details?.surface || !(CONFIGURABLE_AI_SURFACES as readonly string[]).includes(details.surface)) return null;
  const surface = details.surface as AiSurface;
  const pickDefault = details.reason === 'inherited_default_not_permitted';
  switch (details.field) {
    case 'defaultOfferingId': return { surface, field: 'default', pickDefault };
    case 'permittedOfferingIds': return { surface, field: 'permitted', pickDefault };
    case 'allowUserChoice': return { surface, field: 'lock', pickDefault };
    case 'options': return { surface, field: details.key === 'speed' ? 'speed' : details.key === 'effort' ? 'effort' : 'display', pickDefault };
    default: return null;
  }
}

function modelName(dto: AiOrgModelDefaultsDto, id: string | null): string | null {
  return dto.offerings.find((o) => o.id === id)?.displayName ?? null;
}

interface Tracked { base: Record<string, RowDraft>; drafts: Record<string, RowDraft> }

const initial = (dto: AiOrgModelDefaultsDto): Tracked => {
  const base: Record<string, RowDraft> = {};
  for (const d of dto.surfaces) base[d.surface] = fromRow(d);
  return { base, drafts: { ...base } };
};

const inheritLabel = (t: TFunction, value: string | null) =>
  value ? t('aiModels.org.inheritValue', { value }) : t('aiModels.org.inheritModelDefault');

export default function OrgModelDefaultsCard({ orgId }: { orgId: string }) {
  const { t } = useTranslation('settings');
  const [dto, setDto] = useState<AiOrgModelDefaultsDto | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [state, setState] = useState<Tracked>({ base: {}, drafts: {} });
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<FieldError | null>(null);
  const url = `/ai/models/orgs/${orgId}/assignments`;

  const load = useCallback(async () => {
    try {
      const res = await fetchWithAuth(url);
      if (res.status === 401) { onUnauthorized(); return; }
      // A forged/foreign org (403/404) or a role without organizations:read: the card simply is not there.
      if (res.status === 403 || res.status === 404) { setHidden(true); setDto(null); return; }
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as AiOrgModelDefaultsDto;
      if (!Array.isArray(body?.surfaces) || !Array.isArray(body.offerings)) throw new Error('malformed');
      setHidden(false);
      setLoadFailed(false);
      setDto(body);
      setState(initial(body));
    } catch (err) {
      console.error('[OrgModelDefaultsCard] failed to load the org model defaults', err);
      setLoadFailed(true);
    }
  }, [url]);

  useEffect(() => {
    setDto(null);
    setHidden(false);
    setFieldError(null);
    void load();
  }, [load]);

  if (hidden) return null;
  if (loadFailed && !dto) {
    return (
      <section data-testid="org-model-defaults-card" className="rounded-md border p-4 text-sm text-muted-foreground">
        {t('aiModels.org.loadFailed')}
      </section>
    );
  }
  if (!dto) return null;

  const friendly = registryFriendly(t);
  const rows = CONFIGURABLE_AI_SURFACES
    .map((s) => dto.surfaces.find((d) => d.surface === s))
    .filter((d): d is AiOrgSurfaceDefaultsDto => d !== undefined);
  const dirtyRows = rows.filter((d) => state.drafts[d.surface] && state.base[d.surface] && !rowEquals(state.drafts[d.surface], state.base[d.surface]));
  const rowDisabled = (s: AiSurface) => saving || !dto.canEdit || (isReviewer(s) && !dto.canEditReviewer);

  const edit = (d: AiOrgSurfaceDefaultsDto, patch: Partial<RowDraft>) => {
    setFieldError((cur) => (cur?.surface === d.surface ? null : cur));
    setState((prev) => ({ ...prev, drafts: { ...prev.drafts, [d.surface]: normalize(dto, d, { ...prev.drafts[d.surface], ...patch }) } }));
  };

  const handleDiscard = () => {
    setFieldError(null);
    setState((prev) => ({ ...prev, drafts: { ...prev.base } }));
  };

  const handleSave = async () => {
    const inputs = dirtyRows.map((d) => toInput(d.surface, state.drafts[d.surface], d));
    if (inputs.some((r) => r.permittedOfferingIds !== null && r.permittedOfferingIds.length === 0)) {
      showToast({ type: 'error', message: t('aiModels.defaults.needsPermitted') });
      return;
    }
    setSaving(true);
    setFieldError(null);
    try {
      await runAction({
        request: () => fetchWithAuth(url, { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ assignments: inputs }) }),
        successMessage: t('aiModels.org.saved'),
        errorFallback: t('aiModels.org.saveFailed'),
        friendly,
        onUnauthorized,
      });
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError) {
        // Already toasted by runAction; show the cause on the field the API named.
        if (err.code === 'widens_partner') setFieldError(fieldErrorFrom(err.body));
        if (err.code === 'stale_write') await load();
        return;
      }
      showToast({ type: 'error', message: t('aiModels.org.saveFailed') });
    } finally {
      setSaving(false);
    }
  };

  const selectCls = 'h-9 w-full rounded-md border bg-background px-2 text-sm font-normal disabled:opacity-60';
  const errCls = (s: AiSurface, f: FieldKey) => (fieldError?.surface === s && fieldError.field === f ? ' border-destructive' : '');
  const invalid = (s: AiSurface, f: FieldKey) => (fieldError?.surface === s && fieldError.field === f ? 'true' : undefined);

  return (
    <section data-testid="org-model-defaults-card" className="space-y-3 rounded-md border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t('aiModels.org.title')}</h3>
        <p className="text-xs text-muted-foreground">{t('aiModels.org.subtitle')}</p>
        <a data-testid="org-model-defaults-partner-link" href="/settings/partner#ai-provider" className="text-xs text-primary hover:underline">
          {t('aiModels.org.partnerLink')}
        </a>
      </div>
      {!dto.canEdit && (
        <p data-testid="org-model-defaults-readonly" className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t('aiModels.org.readonly')}
        </p>
      )}

      <ul className="space-y-3">
        {rows.map((d) => {
          const s = d.surface;
          const draft = state.drafts[s];
          if (!draft) return null;
          const disabled = rowDisabled(s);
          const base = partnerChoices(dto, d);
          const choices = effectiveSet(dto, d, draft);
          const opts = optionChoices(dto, d, draft);
          const inhModel = modelName(dto, d.inherited.defaultOfferingId);
          const effModel = modelName(dto, d.effective.defaultOfferingId);
          const needsDefault = inheritedDefaultDropped(d, draft) || (fieldError?.surface === s && fieldError.pickDefault);
          const lockedByPartner = !d.inherited.allowUserChoice;
          const inhOpts = d.inherited.options;
          const fieldMsg = fieldError?.surface === s && !fieldError.pickDefault;
          // Stored ids no longer offered (disabled, or dropped by the partner) stay listed so they can be unticked.
          const stale = unavailableIds(state.base[s]?.permitted ?? [], draft.permitted, new Set(base.map((o) => o.id as string)));
          const staleDefault = draft.defaultOfferingId !== '' && !choices.some((o) => o.id === draft.defaultOfferingId);
          const togglePermitted = (offeringId: string, on: boolean) => edit(d, {
            permitted: on ? [...draft.permitted, offeringId] : draft.permitted.filter((p) => p !== offeringId),
          });
          return (
            <li
              key={s}
              data-testid={`org-model-defaults-row-${s}`}
              className={`space-y-3 rounded-md border p-3${fieldError?.surface === s ? ' border-destructive' : ''}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t(/* i18n-dynamic */ SURFACE_LABEL_KEYS[s])}</span>
                {d.requiresTools && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t('aiModels.defaults.needsTools')}</span>
                )}
              </div>
              <p data-testid={`org-model-defaults-inherited-${s}`} className="text-xs text-muted-foreground">
                {inhModel ? t('aiModels.org.inheritedFrom', { model: inhModel }) : t('aiModels.org.inheritedNone')}
              </p>
              {isReviewer(s) && <p className="text-xs text-muted-foreground">{t('aiModels.defaults.reviewerHelp')}</p>}

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-xs font-medium">
                  <span>{t('aiModels.defaults.default')}</span>
                  <select
                    data-testid={`org-model-defaults-default-${s}`}
                    value={draft.defaultOfferingId}
                    disabled={disabled}
                    aria-invalid={invalid(s, 'default') ?? (needsDefault ? 'true' : undefined)}
                    onChange={(e) => edit(d, { defaultOfferingId: e.target.value })}
                    className={selectCls + (needsDefault ? ' border-destructive' : errCls(s, 'default'))}
                  >
                    <option value="">{inhModel ? t('aiModels.org.inheritModel', { model: inhModel }) : t('aiModels.org.inheritNone')}</option>
                    {staleDefault && (
                      <option value={draft.defaultOfferingId}>{unavailableModelLabel(t, modelName(dto, draft.defaultOfferingId))}</option>
                    )}
                    {choices.map((o) => <option key={o.id as string} value={o.id as string}>{o.displayName}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-xs font-medium">
                  <span>{t('aiModels.defaults.permitted')}</span>
                  <select
                    data-testid={`org-model-defaults-permitted-mode-${s}`}
                    value={draft.mode}
                    disabled={disabled}
                    aria-invalid={invalid(s, 'permitted')}
                    onChange={(e) => edit(d, { mode: e.target.value === 'list' ? 'list' : 'inherit', permitted: [] })}
                    className={selectCls + errCls(s, 'permitted')}
                  >
                    <option value="inherit">{t('aiModels.org.inherit')}</option>
                    <option value="list">{t('aiModels.defaults.permittedList')}</option>
                  </select>
                </label>
              </div>
              {needsDefault && (
                <p data-testid={`org-model-defaults-pick-default-${s}`} role="alert" className="text-xs text-destructive">
                  {t('aiModels.org.pickDefault', { model: inhModel ?? '' })}
                </p>
              )}

              {draft.mode === 'list' && (
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {base.map((o) => (
                    <label key={o.id as string} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        data-testid={`org-model-defaults-permitted-${s}-${o.id}`}
                        checked={draft.permitted.includes(o.id as string)}
                        disabled={disabled}
                        onChange={(e) => togglePermitted(o.id as string, e.target.checked)}
                      />
                      {o.displayName}
                    </label>
                  ))}
                  {stale.map((sid) => (
                    <label key={sid} className="flex items-center gap-2 text-sm text-muted-foreground">
                      <input
                        type="checkbox"
                        data-testid={`org-model-defaults-permitted-${s}-${sid}`}
                        checked={draft.permitted.includes(sid)}
                        disabled={disabled}
                        onChange={(e) => togglePermitted(sid, e.target.checked)}
                      />
                      {unavailableModelLabel(t, modelName(dto, sid))}
                    </label>
                  ))}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-xs font-medium">
                  <span>{t('aiModels.defaults.effort')}</span>
                  <select
                    data-testid={`org-model-defaults-effort-${s}`}
                    value={draft.effort}
                    disabled={disabled}
                    aria-invalid={invalid(s, 'effort')}
                    onChange={(e) => edit(d, { effort: e.target.value as EffortLevel | '' })}
                    className={selectCls + errCls(s, 'effort')}
                  >
                    <option value="">{inheritLabel(t, inhOpts.effort ? t(/* i18n-dynamic */ EFFORT_KEYS[inhOpts.effort]) : null)}</option>
                    {opts.effort.map((v) => <option key={v} value={v}>{t(/* i18n-dynamic */ EFFORT_KEYS[v])}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-xs font-medium">
                  <span>{t('aiModels.defaults.display')}</span>
                  <select
                    data-testid={`org-model-defaults-display-${s}`}
                    value={draft.display}
                    disabled={disabled}
                    aria-invalid={invalid(s, 'display')}
                    onChange={(e) => edit(d, { display: e.target.value as Display | '' })}
                    className={selectCls + errCls(s, 'display')}
                  >
                    <option value="">{inheritLabel(t, inhOpts.thinkingDisplay ? t(/* i18n-dynamic */ DISPLAY_KEYS[inhOpts.thinkingDisplay]) : null)}</option>
                    {opts.display.map((v) => <option key={v} value={v}>{t(/* i18n-dynamic */ DISPLAY_KEYS[v])}</option>)}
                  </select>
                </label>
                <label className="space-y-1 text-xs font-medium">
                  <span>{t('aiModels.defaults.speed')}</span>
                  <select
                    data-testid={`org-model-defaults-speed-${s}`}
                    value={draft.speed}
                    disabled={disabled}
                    aria-invalid={invalid(s, 'speed')}
                    onChange={(e) => edit(d, { speed: e.target.value as Speed | '' })}
                    className={selectCls + errCls(s, 'speed')}
                  >
                    <option value="">{inheritLabel(t, inhOpts.speed ? t(/* i18n-dynamic */ SPEED_KEYS[inhOpts.speed]) : null)}</option>
                    {opts.speed.map((v) => <option key={v} value={v}>{t(/* i18n-dynamic */ SPEED_KEYS[v])}</option>)}
                  </select>
                </label>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  data-testid={`org-model-defaults-lock-choice-${s}`}
                  checked={draft.lock || lockedByPartner}
                  disabled={disabled || lockedByPartner}
                  aria-invalid={invalid(s, 'lock')}
                  onChange={(e) => edit(d, { lock: e.target.checked })}
                />
                {t('aiModels.org.lockChoice')}
                {lockedByPartner && <span className="text-xs text-muted-foreground">{t('aiModels.org.lockedByPartner')}</span>}
              </label>

              {fieldMsg && (
                <p data-testid={`org-model-defaults-field-error-${s}`} role="alert" className="text-xs text-destructive">
                  {t('aiModels.org.widensField')}
                </p>
              )}
              <p data-testid={`org-model-defaults-effective-${s}`} className="text-xs text-muted-foreground">
                {effModel
                  ? t('aiModels.org.effective', { model: effModel, source: t(/* i18n-dynamic */ DEFAULT_SOURCE_KEYS[d.effective.defaultSource]) })
                  : t('aiModels.org.effectiveNone')}
              </p>
            </li>
          );
        })}
      </ul>

      {dirtyRows.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-3 border-t pt-3">
          <span className="text-xs text-muted-foreground">{t('aiModels.defaults.unsaved')}</span>
          <button
            type="button"
            data-testid="org-model-defaults-discard"
            disabled={saving}
            onClick={handleDiscard}
            className="rounded-md border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
          >
            {t('aiModels.defaults.discard')}
          </button>
          <button
            type="button"
            data-testid="org-model-defaults-save"
            disabled={saving || !dto.canEdit}
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
