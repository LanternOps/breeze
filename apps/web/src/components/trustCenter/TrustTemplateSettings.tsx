// Owner: W02g (#8770, spec §18.8, §19 item 33). Settings → Partner → Trust Center: the partner's default for every
// inheritable trust page setting. An organization's own value always wins (page → template → Breeze default,
// `resolveEffectiveTrustSettings`), and publish freezes the resolved values, so an edit here reaches a published
// page only when that page is republished. A form card of the partner settings page: the header Save sends it
// (settings rule 7, trustCenterUnit.ts); a blank field inherits and shows the Breeze default it falls through to (rule 4).
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import {
  FRAMEWORK_META, TRUST_CONTROL_CATALOG, TRUST_INTRO_MAX_CHARS,
  type TelemetryControlId, type TrustFramework, type TrustTemplateSettings as TemplateSettings,
} from '@breeze/shared';
import RichTextEditor from '@/components/common/RichTextEditor';
import { usePartnerSettingsDraftStore } from '@/components/settings/partnerSettings/partnerSettingsDraftStore';
import { TRUST_INTRO_FIELD_ID, useTrustCenterDraft, type TrustCenterValue } from '@/components/settings/partnerSettings/units/trustCenterUnit';
import { useTrustControlCopy } from './trustControlCopy';

type BoolKey = 'showManagedBy' | 'showPercentages' | 'showDeviceCount' | 'searchIndexable' | 'showHistory';
const BOOL_KEYS: BoolKey[] = ['showManagedBy', 'showPercentages', 'showDeviceCount', 'searchIndexable', 'showHistory'];
type TriState = 'inherit' | 'on' | 'off';

const toTri = (v: boolean | null): TriState => (v === null ? 'inherit' : v ? 'on' : 'off');
const fromTri = (v: TriState): boolean | null => (v === 'inherit' ? null : v === 'on');

export default function TrustTemplateSettings() {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.${key}`, vars ?? {}),
    [t],
  );
  const copy = useTrustControlCopy();
  // The draft lives in the page-scoped store (W2) so it survives a tab switch.
  const { slice, setDraft: setValue, retry } = useTrustCenterDraft();
  const reloadTheirs = () => { void usePartnerSettingsDraftStore.getState().reloadFromServer('trustCenter'); };
  const keepEditing = () => usePartnerSettingsDraftStore.getState().markOutcome('trustCenter', null);

  const catalog = useMemo(() => [...TRUST_CONTROL_CATALOG].sort((a, b) => a.insurerRank - b.insurerRank), []);

  if (slice.status === 'error') {
    return (
      <section className="rounded-lg border bg-card p-6 text-sm" role="alert" data-testid="trust-template-load-error">
        <p>{tr('inheritance.template.loadFailed')}</p>
        <button type="button" onClick={retry} className="mt-2 rounded-md border px-3 py-1.5 hover:bg-muted" data-testid="trust-template-retry">
          {tr('retry')}
        </button>
      </section>
    );
  }
  if (slice.status !== 'ready' || !slice.draft) {
    return (
      <section className="flex justify-center rounded-lg border bg-card p-6" data-testid="trust-template-loading">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </section>
    );
  }

  const { meta: state, draft, intro } = slice.draft;
  const { defaults, canManage } = state;
  const disabled = !canManage;
  const introTooLong = intro.length > TRUST_INTRO_MAX_CHARS;
  const conflict = slice.lastOutcome?.status === 'conflict';
  const onOff = (v: boolean) => tr(v ? 'inheritance.template.on' : 'inheritance.template.off');
  const frameworkNames = (list: readonly TrustFramework[]) => list.map((fw) => FRAMEWORK_META[fw].shortName).join(', ');
  const availableFrameworks = state.frameworkOptions.filter((o) => o.available);
  const set = <K extends keyof TemplateSettings>(key: K, value: TemplateSettings[K]) =>
    setValue((v: TrustCenterValue) => ({ ...v, draft: { ...v.draft, [key]: value } }));
  const setIntro = (html: string) => setValue((v: TrustCenterValue) => ({ ...v, intro: html }));
  const toggleIn = <T extends string>(list: T[] | null, item: T): T[] => {
    const cur = list ?? [];
    return cur.includes(item) ? cur.filter((x) => x !== item) : [...cur, item];
  };
  const boolLabel = (key: BoolKey) => (key === 'showHistory'
    ? { label: tr('inheritance.template.showHistoryLabel'), description: tr('inheritance.template.showHistoryDescription') }
    : { label: tr(`controls.toggles.${key}.label`), description: tr(`controls.toggles.${key}.description`) });

  return (
    <section className="space-y-5 rounded-lg border bg-card p-6 shadow-xs" data-testid="trust-template-settings">
      <div>
        <h3 className="text-base font-semibold">{tr('inheritance.template.heading')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{tr('inheritance.template.description')}</p>
        {!canManage && (
          <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="trust-template-readonly">
            {tr('inheritance.template.readOnly')}
          </p>
        )}
      </div>

      {conflict && (
        <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm" data-testid="partner-settings-trust-conflict">
          <p>{tr('inheritance.template.conflictNotice')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={reloadTheirs} className="rounded-md border bg-background px-3 py-1.5 hover:bg-muted">
              {tr('inheritance.template.reloadTheirs')}
            </button>
            <button type="button" onClick={keepEditing} className="rounded-md px-3 py-1.5 underline">
              {tr('inheritance.template.keepEditing')}
            </button>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {BOOL_KEYS.map((key) => {
          const { label, description } = boolLabel(key);
          return (
            <label key={key} className="block rounded-md border p-3 text-sm">
              <span className="font-medium">{label}</span>
              <span className="block text-xs text-muted-foreground">{description}</span>
              <select
                value={toTri(draft[key])}
                disabled={disabled}
                onChange={(e) => set(key, fromTri(e.target.value as TriState))}
                className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm disabled:opacity-60"
                data-testid={`trust-template-${key}`}
              >
                <option value="inherit" data-testid={`trust-template-${key}-inherit`}>
                  {tr('inheritance.template.inheritOption', { value: onOff(defaults[key]) })}
                </option>
                <option value="on">{onOff(true)}</option>
                <option value="off">{onOff(false)}</option>
              </select>
            </label>
          );
        })}
      </div>

      <div id={TRUST_INTRO_FIELD_ID} tabIndex={-1} className={canManage ? '' : 'opacity-60'} inert={!canManage} data-testid="trust-template-intro-wrap">
        <div className="mb-1 text-sm font-medium">{tr('inheritance.template.introLabel')}</div>
        <p className="mb-2 text-xs text-muted-foreground">{tr('inheritance.template.introHint')}</p>
        <RichTextEditor value={intro} onChange={setIntro} ariaLabel={tr('inheritance.template.introLabel')} testId="trust-template-intro" />
        <div className={`mt-1 text-xs ${introTooLong ? 'text-destructive' : 'text-muted-foreground'}`} data-testid="trust-template-intro-counter">
          {intro.length.toLocaleString('en-US')} / {TRUST_INTRO_MAX_CHARS.toLocaleString('en-US')}
        </div>
        {introTooLong && <p className="mt-1 text-xs text-destructive" data-testid="trust-template-intro-error">{tr('errors.introTooLong')}</p>}
      </div>

      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-sm font-medium">{tr('inheritance.template.hiddenLabel')}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="trust-template-hidden-mode" checked={draft.hiddenControlIds === null}
            onChange={() => set('hiddenControlIds', null)} data-testid="trust-template-hidden-mode-default" />
          {tr('inheritance.template.hiddenDefault')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="trust-template-hidden-mode" checked={draft.hiddenControlIds !== null}
            onChange={() => set('hiddenControlIds', draft.hiddenControlIds ?? [])} data-testid="trust-template-hidden-mode-custom" />
          {tr('inheritance.template.hiddenCustom')}
        </label>
        {draft.hiddenControlIds !== null && (
          <div className="grid gap-1 pl-6 sm:grid-cols-2">
            {catalog.map((def) => (
              <label key={def.id} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.hiddenControlIds?.includes(def.id) ?? false}
                  onChange={() => set('hiddenControlIds', toggleIn<TelemetryControlId>(draft.hiddenControlIds, def.id))}
                  data-testid={`trust-template-hidden-${def.id}`} />
                {copy.controlTitle(def.id)}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-sm font-medium">{tr('inheritance.template.frameworksLabel')}</legend>
        <label className="flex items-center gap-2 text-sm" data-testid="trust-template-frameworks-mode-default">
          <input type="radio" name="trust-template-frameworks-mode" checked={draft.frameworkView === null}
            onChange={() => set('frameworkView', null)} data-testid="trust-template-frameworks-mode-default-input" />
          {tr('inheritance.template.inheritOption', { value: frameworkNames(defaults.frameworkView) })}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="trust-template-frameworks-mode" checked={draft.frameworkView !== null}
            onChange={() => set('frameworkView', draft.frameworkView ?? [])} data-testid="trust-template-frameworks-mode-custom" />
          {tr('inheritance.template.frameworksCustom')}
        </label>
        {draft.frameworkView !== null && (
          <div className="flex flex-wrap gap-3 pl-6">
            {availableFrameworks.map(({ framework }) => (
              <label key={framework} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft.frameworkView?.includes(framework) ?? false}
                  onChange={() => set('frameworkView', toggleIn<TrustFramework>(draft.frameworkView, framework))}
                  data-testid={`trust-template-framework-${framework}`} />
                {FRAMEWORK_META[framework].shortName}
              </label>
            ))}
          </div>
        )}
      </fieldset>

    </section>
  );
}
