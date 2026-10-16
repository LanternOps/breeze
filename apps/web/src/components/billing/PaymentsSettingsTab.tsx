import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { usePermissions } from '../../lib/permissions';
import RemindersSettingsSection, { reminderDraft, reminderPatch, reminderDraftInvalid, type ReminderDraft } from './RemindersSettingsSection';
import InheritedField from '../shared/InheritedField';
import { formatDateTime } from '../../lib/dateTimeFormat';
import { autopayButton } from './autopayUi';
import { useBillingStepUp, suppressBillingStepUpToast } from './useBillingStepUp';
import type {FeeAuthorizationGap,PaymentValues,PaymentSettingsView} from '@breeze/shared';
export type {PaymentValues,PaymentSettingsView} from '@breeze/shared';
export type FeeAffirmations = { notified: boolean; cost: boolean };
export function feeValuesInvalid(v: Pick<PaymentValues, 'cardFeeBps' | 'achFeeAmount'>): boolean {
  return (v.cardFeeBps !== null && (!Number.isInteger(v.cardFeeBps) || v.cardFeeBps < 0 || v.cardFeeBps > 300))
    || (v.achFeeAmount !== null && (!/^(0|[1-9]\d?)\.\d{2}$/.test(v.achFeeAmount)
      || BigInt(v.achFeeAmount.replace('.', '')) > 2500n));
}
export function FeeFields({ view, setValues, disabled, scope, affirmations, setAffirmations }: {
  view: PaymentSettingsView; setValues: (patch: Partial<PaymentValues>) => void; disabled: boolean;
  scope: 'partner' | 'org'; affirmations?: FeeAffirmations; setAffirmations?: (value: FeeAffirmations) => void;
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
  // The attestation lives on the partner row only, so only the partner view shows it.
  const attestation = scope === 'partner' ? view.feeAttestation ?? null : null;
  const attestedOn = attestation ? formatDateTime(attestation.attestedAt, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const gaps = view.feeAuthorizationGaps ?? [];
  // null = no authorization on file, which must not read like an authorized 0. Such a client
  // cannot be charged at all (consent_required), so it is its own group, not a "lower fee".
  const unauthorized = (client: FeeAuthorizationGap) => client.methodType === 'card'
    ? client.authorizedCardFeeBps === null : client.authorizedAchFeeAmount === null;
  const missing = gaps.filter(unauthorized);
  const lower = gaps.filter(client => !unauthorized(client));
  const feeText = (client: FeeAuthorizationGap) => client.methodType === 'card'
    ? client.authorizedCardFeeBps === null
      ? t('autopay.fees.authorizedCardNone', { configured: client.cardFeeBps })
      : t('autopay.fees.authorizedCard', { accepted: client.authorizedCardFeeBps, configured: client.cardFeeBps })
    : client.authorizedAchFeeAmount === null
      ? t('autopay.fees.authorizedAchNone', { configured: client.achFeeAmount })
      : t('autopay.fees.authorizedAch', { accepted: client.authorizedAchFeeAmount, configured: client.achFeeAmount });
  // A client is listed for a lower fee, a narrower accepted cap (2a-1), or both: name only what differs.
  const feeLower = (client: FeeAuthorizationGap) => unauthorized(client) || (client.methodType === 'card'
    ? client.authorizedCardFeeBps! < client.cardFeeBps
    : BigInt(client.authorizedAchFeeAmount!.replace('.', '')) < BigInt(client.achFeeAmount.replace('.', '')));
  const capText = ({ capGap }: FeeAuthorizationGap) => capGap ? t('autopay.fees.authorizedCap', {
    accepted: `${capGap.authorized.currency} ${capGap.authorized.amount}`,
    configured: capGap.configured.enabled ? `${capGap.configured.currency} ${capGap.configured.amount}` : t('autopay.fees.noCap') }) : '';
  const gapText = (client: FeeAuthorizationGap) => [feeLower(client) || !client.capGap ? feeText(client) : '', capText(client)]
    .filter(Boolean).join('. ');
  const gapRow = (client: FeeAuthorizationGap, action: string) => <li key={client.orgId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
    <span className="min-w-0 break-words">{scope === 'org' ? gapText(client) : <>{client.orgName} — {gapText(client)}</>}</span>
    <button type="button" data-testid={`autopay-reauthorize-${client.orgId}`} disabled={disabled || requesting}
      className={autopayButton.secondary} onClick={() => void requestAuthorization(client.orgId)}>{action}</button>
  </li>;
  return <fieldset disabled={disabled} data-testid="autopay-fees" className="min-w-0 space-y-4 border-t pt-4">
    <legend className="pr-2 font-semibold">{t('autopay.fees.title')}</legend>
    <InheritedField id="autopay-card-fee-bps" data-testid="autopay-card-fee-bps"
      label={t('autopay.fees.cardBps')} value={view.values.cardFeeBps === null ? '' : String(view.values.cardFeeBps)}
      onChange={value => setValues({ cardFeeBps: value === '' ? null : Number(value) })}
      inheritedValue={String(view.inherited.cardFeeBps.value)}
      inheritedSource={t(/* i18n-dynamic */ `autopay.source.${view.inherited.cardFeeBps.source}`)} type="number" min={0} max={300} step="1" />
    <p data-testid="autopay-fee-percent" className="text-sm text-muted-foreground">{percent}</p>
    <InheritedField id="autopay-ach-fee" data-testid="autopay-ach-fee" label={t('autopay.fees.ach')}
      value={view.values.achFeeAmount ?? ''} onChange={value => setValues({ achFeeAmount: value === '' ? null : value })}
      inheritedValue={view.inherited.achFeeAmount.value} inheritedSource={t(/* i18n-dynamic */ `autopay.source.${view.inherited.achFeeAmount.source}`)} />
    <p className="text-xs text-muted-foreground" data-testid="autopay-fee-blank-help">
      {scope === 'org' ? t('autopay.fees.blankOrg') : t('autopay.fees.blankPartner')}</p>
    {/* The affirmations render below only on the partner page; the org page points there. */}
    {!view.effective.feeAttested && <p data-testid="autopay-fee-inactive" className="text-sm text-amber-800 dark:text-amber-200">
      {scope === 'org' ? t('autopay.fees.inactiveOrg') : t('autopay.fees.inactive')}</p>}
    {attestation && <div className="space-y-1 rounded-md border bg-muted/40 px-3 py-2">
      <p data-testid="autopay-fee-attestation" className="text-sm">{attestation.attestedByName
        ? t('autopay.fees.attestationOnFile', { name: attestation.attestedByName, date: attestedOn })
        : t('autopay.fees.attestationOnFileUnknown', { date: attestedOn })}</p>
      {affirmations && <p data-testid="autopay-fee-reattest-help" className="text-xs text-muted-foreground">{t('autopay.fees.reattestHelp')}</p>}
    </div>}
    {affirmations && setAffirmations && <div className="space-y-2">
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 shrink-0" data-testid="autopay-attest-notified" checked={affirmations.notified}
        onChange={event => setAffirmations({ ...affirmations, notified: event.target.checked })} /><span className="min-w-0">{t('autopay.fees.notified')}</span></label>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 shrink-0" data-testid="autopay-attest-cost" checked={affirmations.cost}
        onChange={event => setAffirmations({ ...affirmations, cost: event.target.checked })} /><span className="min-w-0">{t('autopay.fees.cost')}</span></label>
    </div>}
    {missing.length > 0 && <div data-testid="autopay-fee-authorization-missing" className="space-y-3">
      <p className="text-sm">{scope === 'org' ? t('autopay.fees.missingAuthorizationOrg') : t('autopay.fees.missingAuthorization', { count: missing.length })}</p>
      <ul className="space-y-3">{missing.map(client => gapRow(client, t('autopay.fees.requestMissingAuthorization')))}</ul>
    </div>}
    {lower.length > 0 && <div data-testid="autopay-fee-authorization-gaps" className="space-y-3">
      <p className="text-sm">{scope === 'org' ? t('autopay.fees.lowerAuthorizationOrg') : t('autopay.fees.lowerAuthorization', { count: lower.length })}</p>
      <ul className="space-y-3">{lower.map(client => gapRow(client, t('autopay.fees.requestAuthorization')))}</ul>
    </div>}
    <p className="text-xs text-muted-foreground">{t('autopay.fees.rules')}</p>
    <p className="text-xs text-muted-foreground">{t('autopay.fees.legal')}</p>
  </fieldset>;
}

/** The PUT body for a draft: payment values (with autopay on), reminders, and the partner's fee attestation. */
function paymentSettingsBody(view: PaymentSettingsView, reminders: ReminderDraft, affirmations: FeeAffirmations, org: boolean) {
  const payload = { ...view.values };
  if (payload.autopayCapEnabled === true && payload.autopayCapAmount !== null) {
    const [whole, fraction = ''] = payload.autopayCapAmount.split('.');
    payload.autopayCapAmount = `${whole}.${fraction.padEnd(2, '0')}`;
  }
  return { ...(view.autopayEnabled ? payload : {}), ...reminderPatch(reminders),
    ...(view.autopayEnabled && !org && affirmations.notified && affirmations.cost ? {
      feeAttestation: { acquirerAndNetworksNotified30DaysAgo: true, doesNotExceedAcceptanceCost: true },
    } : {}) };
}
/** Key-order-independent form of a PUT body, to tell an edited draft from the loaded one. */
function bodyKey(body: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(body).sort().map(key => [key, body[key]]));
}
const NO_AFFIRMATIONS: FeeAffirmations = { notified: false, cost: false };
/**
 * `unchanged`: an organization draft equal to what was loaded, so no request
 * was sent (changing an organization's payment settings asks for a
 * second-factor confirmation, and a Save that changes none of them must not).
 * `cancelled`: the confirmation was closed, nothing was saved. `skipped`: there
 * was nothing valid to save.
 */
export type PaymentSettingsSaveResult = 'saved' | 'unchanged' | 'cancelled' | 'skipped';

export function usePaymentSettings(orgId?: string) {
  const { t } = useTranslation('billing');
  const path = orgId ? `/orgs/${orgId}/billing/payment-settings` : '/partner/billing/payment-settings';
  // Changing partner or organization payment settings asks for a second-factor confirmation bound to the saved values.
  const stepUp = useBillingStepUp();
  // Each identity owns its requests, including save-triggered reloads.
  const scope = useMemo(() => ({ path, active: false, request: 0 }), [path]);
  const [state, setState] = useState({ scope, view: null as PaymentSettingsView | null, reminders: null as ReminderDraft | null,
    /** bodyKey of the draft as loaded (organization scope only). */
    baseline: null as string | null,
    affirmations: { notified: false, cost: false }, error: false, loading: true, saving: false });
  const { view, reminders, baseline, affirmations, error, loading, saving } = state.scope === scope
    ? state : { view: null, reminders: null, baseline: null, affirmations: { notified: false, cost: false }, error: false, loading: true, saving: false };
  const load = useCallback(async () => {
    if (!scope.active) return;
    const request = ++scope.request;
    const isCurrent = () => scope.active && scope.request === request;
    setState(current => ({ ...current, scope, view: null, reminders: null, baseline: null, loading: true, error: false }));
    try {
      const response = await fetchWithAuth(scope.path);
      if (!response.ok) throw new Error('load');
      const nextView: PaymentSettingsView = await response.json();
      if (!nextView.values || !nextView.effective?.remindersEnabled || !nextView.inherited?.remindersEnabled) throw new Error('shape');
      const nextReminders = reminderDraft(nextView.effective, orgId ? 'org' : 'partner');
      const nextBaseline = orgId && !reminderDraftInvalid(nextReminders)
        ? bodyKey(paymentSettingsBody(nextView, nextReminders, NO_AFFIRMATIONS, true)) : null;
      if (isCurrent()) setState(current => ({ ...current, view: nextView, reminders: nextReminders, baseline: nextBaseline }));
    } catch {
      if (isCurrent()) setState(current => ({ ...current, view: null, reminders: null, baseline: null, error: true }));
    } finally {
      if (isCurrent()) setState(current => ({ ...current, loading: false }));
    }
  }, [scope, orgId]);
  useEffect(() => {
    scope.active = true;
    setState({ scope, view: null, reminders: null, baseline: null, affirmations: { notified: false, cost: false }, error: false, loading: true, saving: false });
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
  const save = async (): Promise<PaymentSettingsSaveResult> => {
    if (!scope.active || !view || !reminders || invalid || loading || saving) return 'skipped';
    const body: Record<string, unknown> = paymentSettingsBody(view, reminders, affirmations, !!orgId);
    // The server makes the same comparison against the stored values; this one only avoids a needless request.
    if (orgId && baseline !== null && bodyKey(body) === baseline) return 'unchanged';
    setState(current => ({ ...current, saving: true }));
    try {
      const outcome = await stepUp.run(stepUpGrant => runAction({
        request: () => fetchWithAuth(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(stepUpGrant ? { ...body, stepUpGrant } : body) }),
        errorFallback: t('reminders.saveFailed'), successMessage: t('reminders.saved'),
        suppressErrorToast: suppressBillingStepUpToast }));
      // Closed at the confirmation: nothing was saved, and the draft stays as it is.
      if (!outcome.confirmed) return 'cancelled';
      if (scope.active) setState(current => current.scope === scope
        ? { ...current, affirmations: { notified: false, cost: false } } : current);
      await load();
      return 'saved';
    } finally {
      if (scope.active) setState(current => ({ ...current, saving: false }));
    }
  };
  return { view, reminders, affirmations, loading, saving, invalid, error, load, save, stepUpPrompt: stepUp.prompt,
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
  // w-full lets a select with a long option shrink to the column instead of widening the page.
  const choice = (id: string, value: string, inheritedValue: string, inheritedSource: string,
    options: string[], onChange: (value: string) => void) => <div key={id}>
    <label htmlFor={`autopay-${id}-select`} className="text-sm font-medium">{t(/* i18n-dynamic */ `autopay.${id}`)}</label>
    <select id={`autopay-${id}-select`} data-testid={`autopay-${id}`} value={value} onChange={e => onChange(e.target.value)}
      className="mt-1 block w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-50">
      <option value="">{t('autopay.inherit', { value: inheritedValue, source: source(inheritedSource) })}</option>
      {options.map(option => <option key={option} value={option}>{t(/* i18n-dynamic */ `autopay.option.${option}`)}</option>)}
    </select>
    {/* Same caption contract as InheritedField: an explicit choice reads as an override. */}
    <p data-testid={`autopay-${id}-caption`} className="mt-1 text-xs text-muted-foreground">{value === ''
      ? t('common:inheritedField.inheritsFrom', { source: source(inheritedSource) })
      : t('common:inheritedField.overridingWithValue', { source: source(inheritedSource), value: inheritedValue })}</p>
  </div>;
  // A fieldset defaults to min-inline-size: min-content; min-w-0 lets it shrink at 390 px.
  return <fieldset disabled={disabled} className="min-w-0 space-y-4" data-testid="autopay-settings-fields">
    <InheritedField id="autopay-offset-days" data-testid="autopay-offset-days" label={t('autopay.offset-days')}
      value={v.autopayOffsetDays === null ? '' : String(v.autopayOffsetDays)}
      onChange={value => setValues({ autopayOffsetDays: value === '' ? null : Number(value) })}
      inheritedValue={String(inherited.autopayOffsetDays.value)} inheritedSource={source(inherited.autopayOffsetDays.source)} type="number" min={0} max={60} step="1" />
    {choice('offset-rule', v.autopayOffsetRule ?? '', t(/* i18n-dynamic */ `autopay.option.${inherited.autopayOffsetRule.value}`), inherited.autopayOffsetRule.source,
      ['earlier', 'later'], value => setValues({ autopayOffsetRule: value === '' ? null : value as 'earlier' | 'later' }))}
    {choice('cap-enabled', v.autopayCapEnabled === null ? '' : String(v.autopayCapEnabled), t(/* i18n-dynamic */ `autopay.option.${String(cap.enabled)}`), inherited.autopayCap.source,
      ['false', 'true'], value => setValues({ autopayCapEnabled: value === '' ? null : value === 'true', autopayCapAmount: null, autopayCapCurrency: null }))}
    {v.autopayCapEnabled === true && <div className="grid gap-4 sm:grid-cols-2">
      <InheritedField id="autopay-cap-amount" data-testid="autopay-cap-amount" label={t('autopay.cap-amount')}
        value={v.autopayCapAmount ?? ''} onChange={value => setValues({ autopayCapAmount: value || null })}
        inheritedValue={cap.enabled ? cap.amount : null} inheritedSource={source(inherited.autopayCap.source)} />
      <InheritedField id="autopay-cap-currency" data-testid="autopay-cap-currency" label={t('autopay.cap-currency')}
        value={v.autopayCapCurrency ?? ''} onChange={value => setValues({ autopayCapCurrency: value.trim().toUpperCase() || null })}
        inheritedValue={cap.enabled ? cap.currency : null} inheritedSource={source(inherited.autopayCap.source)} />
    </div>}
    {choice('ach-mode', v.achMode ?? '', t(/* i18n-dynamic */ `autopay.option.${inherited.achMode.value}`), inherited.achMode.source,
      ['ach_preferred', 'ach_only'], value => setValues({ achMode: value === '' ? null : value as 'ach_preferred' | 'ach_only' }))}
    <p className="text-sm text-muted-foreground">{t('autopay.achRisk')}</p>
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
    {model.view.autopayEnabled && <section data-testid="autopay-settings-section" className="min-w-0 space-y-4 rounded-lg border bg-card p-6">
      <h2 className="text-lg font-semibold">{t('autopay.title')}</h2>
      <PaymentFields view={model.view} setValues={model.setValues} disabled={!canManage || model.saving} />
      <FeeFields view={model.view} setValues={model.setValues} disabled={!canManage || model.saving} scope={orgId ? 'org' : 'partner'}
        affirmations={orgId ? undefined : model.affirmations} setAffirmations={orgId ? undefined : model.setAffirmations} />
    </section>}
    {model.invalid && <p role="alert" className="text-sm text-destructive">{t('autopay.invalid')}</p>}
    {model.stepUpPrompt}
    {canManage && <div className="flex justify-end"><button type="button" data-testid="autopay-settings-save" disabled={model.invalid || model.saving}
      className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
      onClick={() => void model.save().catch(e => handleActionError(e, t('reminders.saveFailed')))}>
      {model.saving ? t('reminders.saving') : t('reminders.save')}
    </button></div>}
  </div>;
}
