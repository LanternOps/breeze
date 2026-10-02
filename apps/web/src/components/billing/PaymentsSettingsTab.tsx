import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import InheritedField from '../shared/InheritedField';
export interface PaymentValues {
  autopayOffsetDays: number | null; autopayOffsetRule: 'earlier' | 'later' | null;
  autopayCapEnabled: boolean | null; autopayCapAmount: string | null;
  autopayCapCurrency: string | null; achMode: 'ach_preferred' | 'ach_only' | null;
}
type Effective<T> = { value: T; source: 'org' | 'partner' | 'default' };
type Resolved = {
  autopayOffsetDays: Effective<number>; autopayOffsetRule: Effective<'earlier' | 'later'>;
  autopayCap: Effective<{ enabled: false } | { enabled: true; amount: string; currency: string }>;
  achMode: Effective<'ach_preferred' | 'ach_only'>;
};
export interface PaymentSettingsView { autopayEnabled: boolean; values: PaymentValues; inherited: Resolved; effective: Resolved }
export function usePaymentSettings(orgId?: string) {
  const { t } = useTranslation('billing');
  const path = orgId ? `/orgs/${orgId}/billing/payment-settings` : '/partner/billing/payment-settings';
  // Each identity owns its requests, including save-triggered reloads.
  const scope = useMemo(() => ({ path, active: false, request: 0 }), [path]);
  const [state, setState] = useState({ scope, view: null as PaymentSettingsView | null,
    error: false, loading: true, saving: false });
  const { view, error, loading, saving } = state.scope === scope
    ? state : { view: null, error: false, loading: true, saving: false };
  const load = useCallback(async () => {
    if (!scope.active) return;
    const request = ++scope.request;
    const isCurrent = () => scope.active && scope.request === request;
    setState(current => ({ ...current, scope, view: null, loading: true, error: false }));
    try {
      const response = await fetchWithAuth(scope.path);
      if (!response.ok) throw new Error('load');
      const nextView: PaymentSettingsView = await response.json();
      if (isCurrent()) setState(current => ({ ...current, view: nextView }));
    } catch {
      if (isCurrent()) setState(current => ({ ...current, view: null, error: true }));
    } finally {
      if (isCurrent()) setState(current => ({ ...current, loading: false }));
    }
  }, [scope]);
  useEffect(() => {
    scope.active = true;
    setState({ scope, view: null, error: false, loading: true, saving: false });
    void load();
    return () => { scope.active = false; ++scope.request; };
  }, [scope, load]);
  const values = view?.values;
  const invalid = !!values && ((values.autopayOffsetDays !== null &&
    (!Number.isInteger(values.autopayOffsetDays) || values.autopayOffsetDays < 0 || values.autopayOffsetDays > 60)) ||
    (values.autopayCapEnabled === true && (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(values.autopayCapAmount ?? '') ||
      !/[1-9]/.test(values.autopayCapAmount ?? '') || !/^[A-Z]{3}$/.test(values.autopayCapCurrency ?? ''))));
  const save = async () => {
    if (!scope.active || !view?.autopayEnabled || invalid || loading || saving) return;
    const payload = { ...view.values };
    if (payload.autopayCapEnabled === true && payload.autopayCapAmount !== null) {
      const [whole, fraction = ''] = payload.autopayCapAmount.split('.');
      payload.autopayCapAmount = `${whole}.${fraction.padEnd(2, '0')}`;
    }
    setState(current => ({ ...current, saving: true }));
    try {
      await runAction({ request: () => fetchWithAuth(path, { method: 'PUT', body: JSON.stringify(payload) }),
        errorFallback: t('autopay.error'), successMessage: t('autopay.saved') });
      await load();
    } finally {
      if (scope.active) setState(current => ({ ...current, saving: false }));
    }
  };
  return { view, loading, saving, invalid, error, load, save,
    setValues: (patch: Partial<PaymentValues>) => setState(current =>
      scope.active && current.scope === scope && current.view
        ? { ...current, view: { ...current.view, values: { ...current.view.values, ...patch } } } : current) };
}
export function PaymentFields({ view, setValues, disabled = false }: {
  view: PaymentSettingsView; setValues: (patch: Partial<PaymentValues>) => void; disabled?: boolean;
}) {
  const { t } = useTranslation('billing');
  const v = view.values; const inherited = view.inherited;
  const source = (s: string) => t(/* i18n-dynamic */ `autopay.source.${s}`);
  const cap = inherited.autopayCap.value;
  const choice = (id: string, value: string, inheritedValue: string, inheritedSource: string,
    options: string[], onChange: (value: string) => void) => <label className="block space-y-1" key={id}>
    <span>{t(/* i18n-dynamic */ `autopay.${id}`)}</span>
    <select data-testid={`autopay-${id}`} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">{t('autopay.inherit', { value: inheritedValue, source: source(inheritedSource) })}</option>
      {options.map(option => <option key={option} value={option}>{t(/* i18n-dynamic */ `autopay.option.${option}`)}</option>)}
    </select>
    <span className="block text-xs text-muted-foreground">{t('autopay.inherit', { value: inheritedValue, source: source(inheritedSource) })}</span>
  </label>;
  return <fieldset disabled={disabled} className="space-y-4" data-testid="autopay-settings-fields">
    <InheritedField id="autopay-offset-days" data-testid="autopay-offset-days" label={t('autopay.offset-days')}
      value={v.autopayOffsetDays === null ? '' : String(v.autopayOffsetDays)}
      onChange={value => setValues({ autopayOffsetDays: value === '' ? null : Number(value) })}
      inheritedValue={String(inherited.autopayOffsetDays.value)} inheritedSource={source(inherited.autopayOffsetDays.source)} type="number" min={0} max={60} step="1" />
    {choice('offset-rule', v.autopayOffsetRule ?? '', t(/* i18n-dynamic */ `autopay.option.${inherited.autopayOffsetRule.value}`), inherited.autopayOffsetRule.source,
      ['earlier', 'later'], value => setValues({ autopayOffsetRule: value === '' ? null : value as 'earlier' | 'later' }))}
    {choice('cap-enabled', v.autopayCapEnabled === null ? '' : String(v.autopayCapEnabled), t(/* i18n-dynamic */ `autopay.option.${String(cap.enabled)}`), inherited.autopayCap.source,
      ['false', 'true'], value => setValues({ autopayCapEnabled: value === '' ? null : value === 'true', autopayCapAmount: null, autopayCapCurrency: null }))}
    {v.autopayCapEnabled === true && <>
      <InheritedField id="autopay-cap-amount" data-testid="autopay-cap-amount" label={t('autopay.cap-amount')}
        value={v.autopayCapAmount ?? ''} onChange={value => setValues({ autopayCapAmount: value || null })}
        inheritedValue={cap.enabled ? cap.amount : null} inheritedSource={source(inherited.autopayCap.source)} />
      <InheritedField id="autopay-cap-currency" data-testid="autopay-cap-currency" label={t('autopay.cap-currency')}
        value={v.autopayCapCurrency ?? ''} onChange={value => setValues({ autopayCapCurrency: value.trim().toUpperCase() || null })}
        inheritedValue={cap.enabled ? cap.currency : null} inheritedSource={source(inherited.autopayCap.source)} />
    </>}
    {choice('ach-mode', v.achMode ?? '', t(/* i18n-dynamic */ `autopay.option.${inherited.achMode.value}`), inherited.achMode.source,
      ['ach_preferred', 'ach_only'], value => setValues({ achMode: value === '' ? null : value as 'ach_preferred' | 'ach_only' }))}
    <p>{t('autopay.achRisk')}</p>
  </fieldset>;
}
export default function PaymentsSettingsTab({ orgId }: { orgId?: string }) {
  const model = usePaymentSettings(orgId); const { t } = useTranslation('billing');
  const { can } = usePermissions(); const canManage = can('billing', 'manage');
  if (model.loading) return <p data-testid="autopay-settings-loading">{t('autopay.loading')}</p>;
  if (model.error) return <p role="alert" data-testid="autopay-settings-error">{t('autopay.error')}</p>;
  if (!model.view?.autopayEnabled) return null;
  return <section data-testid="autopay-settings" className="space-y-4">
    <h2>{t('autopay.title')}</h2>
    <PaymentFields view={model.view} setValues={model.setValues} disabled={!canManage || model.saving} />
    {model.invalid && <p role="alert">{t('autopay.invalid')}</p>}
    {canManage && <button data-testid="autopay-settings-save" disabled={model.invalid || model.saving}
      onClick={() => void model.save().catch(e => handleActionError(e, t('autopay.error')))}>{t('autopay.save')}</button>}
  </section>;
}
