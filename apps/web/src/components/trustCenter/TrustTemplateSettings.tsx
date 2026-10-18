// Owner: W02g (#8770, spec §18.8, §19 item 33). Settings → Partner → Trust Center: the partner's default for every
// inheritable trust page setting. An organization's own value always wins (page → template → Breeze default,
// `resolveEffectiveTrustSettings`), and publish freezes the resolved values, so an edit here reaches a published
// page only when that page is republished. A form with one Save (settings rule 7); a blank field inherits and
// shows the Breeze default it falls through to (rule 4).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save } from 'lucide-react';
import {
  FRAMEWORK_META, TRUST_CONTROL_CATALOG, TRUST_INTRO_MAX_CHARS,
  type TelemetryControlId, type TrustFramework, type TrustTemplateSettings as TemplateSettings,
} from '@breeze/shared';
import RichTextEditor from '@/components/common/RichTextEditor';
import { fetchWithAuth } from '@/stores/auth';
import { navigateTo } from '@/lib/navigation';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import { getTrustPageTemplate, updateTrustPageTemplate, type TrustTemplateState } from '@/lib/api/trustPageTemplate';
import { useTrustControlCopy } from './trustControlCopy';

type BoolKey = 'showManagedBy' | 'showPercentages' | 'showDeviceCount' | 'searchIndexable' | 'showHistory';
const BOOL_KEYS: BoolKey[] = ['showManagedBy', 'showPercentages', 'showDeviceCount', 'searchIndexable', 'showHistory'];
type TriState = 'inherit' | 'on' | 'off';

const EMPTY: TemplateSettings = {
  introHtml: null, searchIndexable: null, showPercentages: null, showDeviceCount: null, showManagedBy: null,
  showHistory: null, hiddenControlIds: null, frameworkView: null,
};

/** The editor emits `<p></p>` for an empty document; on the template that is "no template intro" (null). */
function isEmptyHtml(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').trim() === '' && !/<(img|table|hr)\b/i.test(html);
}
const toTri = (v: boolean | null): TriState => (v === null ? 'inherit' : v ? 'on' : 'off');
const fromTri = (v: TriState): boolean | null => (v === 'inherit' ? null : v === 'on');

type LoadState = { failed: true } | TrustTemplateState | null;

export default function TrustTemplateSettings() {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.${key}`, vars ?? {}),
    [t],
  );
  const copy = useTrustControlCopy();
  const [state, setState] = useState<LoadState>(null);
  const [draft, setDraft] = useState<TemplateSettings>(EMPTY);
  const [intro, setIntro] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setState(null);
    try {
      const loaded = await getTrustPageTemplate(fetchWithAuth);
      setState(loaded);
      setDraft(loaded.template ?? EMPTY);
      setIntro(loaded.template?.introHtml ?? '');
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) { void navigateTo('/login', { replace: true }); return; }
      console.error('[TrustTemplateSettings] failed to load the partner template', err);
      setState({ failed: true });
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const catalog = useMemo(() => [...TRUST_CONTROL_CATALOG].sort((a, b) => a.insurerRank - b.insurerRank), []);

  if (state === null) {
    return (
      <section className="flex justify-center rounded-lg border bg-card p-6" data-testid="trust-template-loading">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </section>
    );
  }
  if ('failed' in state) {
    return (
      <section className="rounded-lg border bg-card p-6 text-sm" role="alert" data-testid="trust-template-load-error">
        <p>{tr('inheritance.template.loadFailed')}</p>
        <button type="button" onClick={() => void load()} className="mt-2 rounded-md border px-3 py-1.5 hover:bg-muted" data-testid="trust-template-retry">
          {tr('retry')}
        </button>
      </section>
    );
  }

  const { defaults, canManage, revision } = state;
  const disabled = !canManage || saving;
  const introTooLong = intro.length > TRUST_INTRO_MAX_CHARS;
  const onOff = (v: boolean) => tr(v ? 'inheritance.template.on' : 'inheritance.template.off');
  const frameworkNames = (list: readonly TrustFramework[]) => list.map((fw) => FRAMEWORK_META[fw].shortName).join(', ');
  const availableFrameworks = state.frameworkOptions.filter((o) => o.available);
  const set = <K extends keyof TemplateSettings>(key: K, value: TemplateSettings[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const toggleIn = <T extends string>(list: T[] | null, item: T): T[] => {
    const cur = list ?? [];
    return cur.includes(item) ? cur.filter((x) => x !== item) : [...cur, item];
  };
  const boolLabel = (key: BoolKey) => (key === 'showHistory'
    ? { label: tr('inheritance.template.showHistoryLabel'), description: tr('inheritance.template.showHistoryDescription') }
    : { label: tr(`controls.toggles.${key}.label`), description: tr(`controls.toggles.${key}.description`) });

  const save = async () => {
    if (disabled || introTooLong) return;
    setSaving(true);
    try {
      const body = { ...draft, introHtml: isEmptyHtml(intro) ? null : intro, expectedRevision: revision };
      const data = await runAction({
        request: () => updateTrustPageTemplate(fetchWithAuth, body),
        parseSuccess: (d) => (d as { data: { template: TemplateSettings; revision: number } }).data,
        successMessage: tr('inheritance.template.saved'),
        errorFallback: tr('inheritance.template.saveFailed'),
        friendly: (code) => ({
          REVISION_MISMATCH: tr('inheritance.template.revisionMismatch'),
          PARTNER_WIDE_REQUIRED: tr('inheritance.template.readOnly'),
          MFA_REQUIRED: tr('inheritance.template.mfaRequired'),
          INTRO_TOO_LONG: tr('errors.introTooLong'),
        } as Record<string, string>)[code],
        onUnauthorized: () => { void navigateTo('/login', { replace: true }); },
      });
      setState({ ...state, template: data.template, revision: data.revision });
      setDraft(data.template);
      setIntro(data.template.introHtml ?? '');
    } catch (err) {
      handleActionError(err, tr('inheritance.template.saveFailed'));
      // Saving again with the same stale revision would 409 forever: reload what the other admin saved.
      if (err instanceof ActionError && err.code === 'REVISION_MISMATCH') await load();
    } finally {
      setSaving(false);
    }
  };

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

      <div className={canManage ? '' : 'opacity-60'} inert={!canManage} data-testid="trust-template-intro-wrap">
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

      <button
        type="button"
        disabled={disabled || introTooLong}
        onClick={() => void save()}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="trust-template-save"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        {tr('inheritance.template.save')}
      </button>
    </section>
  );
}
