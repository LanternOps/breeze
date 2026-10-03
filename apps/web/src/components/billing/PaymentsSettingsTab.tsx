import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import RemindersSettingsSection, { reminderDraft, reminderPatch, reminderDraftInvalid, type ReminderDraft } from './RemindersSettingsSection';
import InheritedField from '../shared/InheritedField';
import type {PaymentValues,PaymentSettingsView} from '@breeze/shared';
export type {PaymentValues,PaymentSettingsView} from '@breeze/shared';
export type FeeAffirmations = { notified: boolean; cost: boolean };
export function feeValuesInvalid(v: Pick<PaymentValues, 'cardFeeBps' | 'achFeeAmount'>): boolean {
  return (v.cardFeeBps !== null && (!Number.isInteger(v.cardFeeBps) || v.cardFeeBps < 0 || v.cardFeeBps > 300))
    || (v.achFeeAmount !== null && (!/^(0|[1-9]\d?)\.\d{2}$/.test(v.achFeeAmount)
      || BigInt(v.achFeeAmount.replace('.', '')) > 2500n));
}
export function FeeFields({ view, setValues, disabled, affirmations, setAffirmations }: {
  view: PaymentSettingsView; setValues: (patch: Partial<PaymentValues>) => void; disabled: boolean;
  affirmations?: FeeAffirmations; setAffirmations?: (value: FeeAffirmations) => void;
}) {
  const { t } = useTranslation('billing');
  const [requesting, setRequesting] = useState(false);
  const requestAuthorization = async (orgId: string) => {
    setRequesting(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/billing/autopay/requests', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orgIds: [orgId], mode: 'reauthorize' }) }),
        parseSuccess: data => {
          if (!(data as { requested?: string[] })?.requested?.includes(orgId)) throw new Error(t('autopay.fees.requestFailed'));
          return data;
        },
        errorFallback: t('autopay.fees.requestFailed'), successMessage: t('autopay.fees.requested'),
      });
    } catch (error) { handleActionError(error, t('autopay.fees.requestFailed')); }
    finally { setRequesting(false); }
  };
  if (!view.autopayEnabled) return null;
  const bps = view.values.cardFeeBps ?? view.inherited.cardFeeBps.value;
  const percent = Number.isInteger(bps) ? `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, '0')}%` : '—';
  return <fieldset disabled={disabled} data-testid="autopay-fees" className="space-y-4 border-t pt-4">
    <legend className="font-semibold">{t('autopay.fees.title')}</legend>
    <InheritedField id="autopay-card-fee-bps" data-testid="autopay-card-fee-bps"
      label={t('autopay.fees.cardBps')} value={view.values.cardFeeBps === null ? '' : String(view.values.cardFeeBps)}
      onChange={value => setValues({ cardFeeBps: value === '' ? null : Number(value) })}
      inheritedValue={String(view.inherited.cardFeeBps.value)}
      inheritedSource={t(/* i18n-dynamic */ `autopay.source.${view.inherited.cardFeeBps.source}`)} type="number" min={0} max={300} step="1" />
    <p data-testid="autopay-fee-percent">{percent}</p>
    <InheritedField id="autopay-ach-fee" data-testid="autopay-ach-fee" label={t('autopay.fees.ach')}
      value={view.values.achFeeAmount ?? ''} onChange={value => setValues({ achFeeAmount: value === '' ? null : value })}
      inheritedValue={view.inherited.achFeeAmount.value} inheritedSource={t(/* i18n-dynamic */ `autopay.source.${view.inherited.achFeeAmount.source}`)} />
    {!view.effective.feeAttested && <p data-testid="autopay-fee-inactive">{t('autopay.fees.inactive')}</p>}
    {affirmations && setAffirmations && <>
      <label className="flex gap-2"><input type="checkbox" data-testid="autopay-attest-notified" checked={affirmations.notified}
        onChange={event => setAffirmations({ ...affirmations, notified: event.target.checked })} />{t('autopay.fees.notified')}</label>
      <label className="flex gap-2"><input type="checkbox" data-testid="autopay-attest-cost" checked={affirmations.cost}
        onChange={event => setAffirmations({ ...affirmations, cost: event.target.checked })} />{t('autopay.fees.cost')}</label>
    </>}
    {view.feeAuthorizationGaps !== undefined && <div data-testid="autopay-fee-authorization-gaps" className="space-y-3">
      <p>{t('autopay.fees.lowerAuthorization', { count: view.feeAuthorizationGaps.length })}</p>
      <ul className="space-y-3">{view.feeAuthorizationGaps.map(client => <li key={client.orgId} className="flex flex-wrap items-center justify-between gap-2">
        <span>{client.orgName} — {client.methodType === 'card'
          ? t('autopay.fees.authorizedCard', { accepted: client.authorizedCardFeeBps, configured: client.cardFeeBps })
          : t('autopay.fees.authorizedAch', { accepted: client.authorizedAchFeeAmount, configured: client.achFeeAmount })}</span>
        <button type="button" data-testid={`autopay-reauthorize-${client.orgId}`} disabled={disabled || requesting}
          onClick={() => void requestAuthorization(client.orgId)}>{t('autopay.fees.requestAuthorization')}</button>
      </li>)}</ul>
    </div>}
    <p>{t('autopay.fees.rules')}</p><p>{t('autopay.fees.legal')}</p><p>{t('autopay.achRisk')}</p>
  </fieldset>;
}

export function usePaymentSettings(orgId?: string) {
  const { t } = useTranslation('billing');
  const path = orgId ? `/orgs/${orgId}/billing/payment-settings` : '/partner/billing/payment-settings';
  // Each identity owns its requests, including save-triggered reloads.
  const scope = useMemo(() => ({ path, active: false, request: 0 }), [path]);
  const [state, setState] = useState({ scope, view: null as PaymentSettingsView | null, reminders: null as ReminderDraft | null,
    affirmations: { notified: false, cost: false }, error: false, loading: true, saving: false });
  const { view, reminders, affirmations, error, loading, saving } = state.scope === scope
    ? state : { view: null, reminders: null, affirmations: { notified: false, cost: false }, error: false, loading: true, saving: false };
  const load = useCallback(async () => {
    if (!scope.active) return;
    const request = ++scope.request;
    const isCurrent = () => scope.active && scope.request === request;
    setState(current => ({ ...current, scope, view: null, reminders: null, loading: true, error: false }));
    try {
      const response = await fetchWithAuth(scope.path);
      if (!response.ok) throw new Error('load');
      const nextView: PaymentSettingsView = await response.json();
      if (!nextView.values || !nextView.effective?.remindersEnabled || !nextView.inherited?.remindersEnabled) throw new Error('shape');
      if (isCurrent()) setState(current => ({ ...current, view: nextView,
        reminders: reminderDraft(nextView.effective, orgId ? 'org' : 'partner') }));
    } catch {
      if (isCurrent()) setState(current => ({ ...current, view: null, reminders: null, error: true }));
    } finally {
      if (isCurrent()) setState(current => ({ ...current, loading: false }));
    }
  }, [scope, orgId]);
  useEffect(() => {
    scope.active = true;
    setState({ scope, view: null, reminders: null, affirmations: { notified: false, cost: false }, error: false, loading: true, saving: false });
    void load();
    return () => { scope.active = false; ++scope.request; };
  }, [scope, load]);
  const values = view?.values;
  const autopayInvalid = !!view?.autopayEnabled && !!values && ((values.autopayOffsetDays !== null &&
    (!Number.isInteger(values.autopayOffsetDays) || values.autopayOffsetDays < 0 || values.autopayOffsetDays > 60)) ||
    (values.autopayCapEnabled === true && (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(values.autopayCapAmount ?? '') ||
      !/[1-9]/.test(values.autopayCapAmount ?? '') || !/^[A-Z]{3}$/.test(values.autopayCapCurrency ?? ''))));
  const feesInvalid = !!view?.autopayEnabled && !!values && feeValuesInvalid(values);
  const attestationIncomplete = !!view?.autopayEnabled && !orgId && affirmations.notified !== affirmations.cost;
  const invalid = !view || !reminders || reminderDraftInvalid(reminders) || autopayInvalid || feesInvalid || attestationIncomplete;
  const save = async () => {
    if (!scope.active || !view || !reminders || invalid || loading || saving) return;
    const payload = { ...view.values };
    if (payload.autopayCapEnabled === true && payload.autopayCapAmount !== null) {
      const [whole, fraction = ''] = payload.autopayCapAmount.split('.');
      payload.autopayCapAmount = `${whole}.${fraction.padEnd(2, '0')}`;
    }
    const body = { ...(view.autopayEnabled ? payload : {}), ...reminderPatch(reminders),
      ...(view.autopayEnabled && !orgId && affirmations.notified && affirmations.cost ? {
        feeAttestation: { acquirerAndNetworksNotified30DaysAgo: true, doesNotExceedAcceptanceCost: true },
      } : {}) };
    setState(current => ({ ...current, saving: true }));
    try {
      await runAction({ request: () => fetchWithAuth(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        errorFallback: t('reminders.saveFailed'), successMessage: t('reminders.saved') });
      if (scope.active) setState(current => current.scope === scope
        ? { ...current, affirmations: { notified: false, cost: false } } : current);
      await load();
    } finally {
      if (scope.active) setState(current => ({ ...current, saving: false }));
    }
  };
  return { view, reminders, affirmations, loading, saving, invalid, error, load, save,
    setAffirmations: (value: FeeAffirmations) => setState(current =>
      scope.active && current.scope === scope ? { ...current, affirmations: value } : current),
    setReminders: (value: ReminderDraft) => setState(current =>
      scope.active && current.scope === scope ? { ...current, reminders: value } : current),
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
  if (!model.view || !model.reminders) return null;
  return <div className="space-y-6" data-testid="autopay-payments-shell">
    <RemindersSettingsSection scope={orgId ? 'org' : 'partner'} value={model.reminders}
      inherited={model.view.inherited} onChange={model.setReminders} disabled={!canManage || model.saving} />
    {model.view.autopayEnabled && <section data-testid="autopay-settings-section" className="space-y-4">
      <h2>{t('autopay.title')}</h2>
      <PaymentFields view={model.view} setValues={model.setValues} disabled={!canManage || model.saving} />
      <FeeFields view={model.view} setValues={model.setValues} disabled={!canManage || model.saving}
        affirmations={orgId ? undefined : model.affirmations} setAffirmations={orgId ? undefined : model.setAffirmations} />
    </section>}
    {model.invalid && <p role="alert">{t('autopay.invalid')}</p>}
    {canManage && <button data-testid="autopay-settings-save" disabled={model.invalid || model.saving}
      onClick={() => void model.save().catch(e => handleActionError(e, t('reminders.saveFailed')))}>
      {model.saving ? t('reminders.saving') : t('reminders.save')}
    </button>}
  </div>;
}
