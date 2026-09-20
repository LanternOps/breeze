import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { currencyLabel, currencyOptions } from '../../lib/currencies';
import { showToast } from '../shared/Toast';
import { Drawer } from '../shared/Drawer';
import WorkTypesCard, { type WorkTypesCardHandle } from '../settings/WorkTypesCard';
import type { WorkTypeOption } from '../shared/WorkTypeSelect';

type Coverage = 'billable' | 'included' | 'non_billable';
interface Rule { workTypeId: string; coverage: Coverage; hourlyRate: string | null; minimumMinutes: number | null; notes?: string | null }
interface Profile {
  id: string; name: string; notes: string | null; currencyCode: string; isDefault: boolean; isActive: boolean;
  baseCoverage: Coverage; baseHourlyRate: string | null; baseMinimumMinutes: number | null;
  roundingIncrementMinutes: number | null; rules: Rule[];
}
const inputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';
const buttonClass = 'rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';
const unauthorized = () => void navigateTo(loginPathWithNext(), { replace: true });
const metadata = (p: Profile) => ({ name: p.name.trim(), notes: p.notes, currencyCode: p.currencyCode, roundingIncrementMinutes: p.roundingIncrementMinutes, baseCoverage: p.baseCoverage, baseHourlyRate: p.baseHourlyRate, baseMinimumMinutes: p.baseMinimumMinutes });

/** The profile drawer saves all work-type rules together. The API stores base pricing
 * and profile metadata separately; those changes need a PATCH before the rows PUT. */
export default function BillingRatesTab({ currencyCode = 'USD' }: { currencyCode?: string }) {
  const { t, i18n } = useTranslation('billing');
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [workTypes, setWorkTypes] = useState<WorkTypeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [original, setOriginal] = useState<Profile | null>(null);
  const [cloneId, setCloneId] = useState<string | null>(null);
  const [partialSave, setPartialSave] = useState(false);
  const workTypeManager = useRef<WorkTypesCardHandle>(null);
  const activeTypes = workTypes.filter(type => type.isActive);
  const load = useCallback(async () => {
    setLoading(true); setFailed(false);
    try {
      const response = await fetchWithAuth('/billing-profiles');
      if (response.status === 401) return unauthorized();
      if (!response.ok) throw new Error('Billing profiles unavailable');
      const data = await response.json();
      if (!Array.isArray(data.profiles)) throw new Error('Invalid billing profiles response');
      setProfiles(data.profiles);
    } catch { setFailed(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const acceptWorkTypes = useCallback((types: WorkTypeOption[]) => setWorkTypes(types), []);
  const edit = (p: Profile, clone = false) => {
    setOriginal(p); setDraft({ ...p, name: clone ? '' : p.name, rules: p.rules.map(rule => ({ ...rule })) });
    setCloneId(clone ? p.id : null); setPartialSave(false);
  };
  const create = () => {
    setOriginal(null); setCloneId(null); setPartialSave(false);
    setDraft({ id: '', name: '', notes: null, currencyCode, isDefault: false, isActive: true, baseCoverage: 'billable', baseHourlyRate: null, baseMinimumMinutes: null, roundingIncrementMinutes: null, rules: [] });
  };
  const request = (url: string, method: string, body?: unknown, success = true) => runAction<{ profile: Profile }>({
    request: () => fetchWithAuth(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    errorFallback: t('rates.saveError'), successMessage: success ? t('rates.saved') : undefined, onUnauthorized: unauthorized,
  });
  const catchAction = (err: unknown) => {
    if (err instanceof ActionError && err.status === 401) return;
    if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('rates.saveError') });
  };
  async function save() {
    if (!draft || busy) return;
    setBusy(true);
    let metadataSaved = false;
    try {
      if (cloneId) {
        await request(`/billing-profiles/${cloneId}/clone`, 'POST', { name: draft.name.trim() });
      } else {
        let id = draft.id;
        if (!id) {
          const result = await request('/billing-profiles', 'POST', metadata(draft), false);
          id = result.profile.id;
          // Keep the server-created identity if the later rows save fails, so retry
          // updates this profile instead of creating a duplicate.
          const persisted = { ...draft, id };
          setDraft(persisted); setOriginal({ ...persisted, rules: [] });
          metadataSaved = true;
        } else if (JSON.stringify(metadata(draft)) !== JSON.stringify(metadata(original!))) {
          await request(`/billing-profiles/${id}`, 'PATCH', metadata(draft), false);
          setOriginal({ ...draft, rules: original?.rules ?? [] }); metadataSaved = true;
        }
        await request(`/billing-profiles/${id}/rows`, 'PUT', { rows: draft.rules.map(({ workTypeId, coverage, hourlyRate, minimumMinutes, notes }) => ({ workTypeId, coverage, hourlyRate, minimumMinutes, ...(notes === undefined ? {} : { notes }) })) });
      }
      setPartialSave(false); setDraft(null); await load();
    } catch (err) {
      setPartialSave(previous => previous || metadataSaved); catchAction(err);
    } finally { setBusy(false); }
  }
  async function rowAction(p: Profile, archive: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      await request(`/billing-profiles/${p.id}`, archive ? 'DELETE' : 'PATCH', archive ? undefined : { isDefault: true });
      await load();
    } catch (err) { catchAction(err); } finally { setBusy(false); }
  }
  function outcome(coverage: Coverage, rate: string | null, minimum: number | null, currency: string) {
    if (coverage === 'included') return t('rates.included');
    if (coverage === 'non_billable') return t('rates.nonBillable');
    const price = rate === null ? t('rates.noRate') : t('rates.billableAt', { rate: new Intl.NumberFormat(i18n.language, { style: 'currency', currency }).format(Number(rate)) });
    return minimum ? `${price} · ${t('rates.minimumSummary', { minutes: minimum })}` : price;
  }
  function updateRule(id: string, update: Partial<Rule> | null) {
    if (!draft) return;
    if (id === 'base') {
      if (!update) return;
      setDraft({ ...draft, baseCoverage: update.coverage ?? draft.baseCoverage,
        baseHourlyRate: 'hourlyRate' in update ? update.hourlyRate! : draft.baseHourlyRate,
        baseMinimumMinutes: 'minimumMinutes' in update ? update.minimumMinutes! : draft.baseMinimumMinutes });
      return;
    }
    const old = draft.rules.find(rule => rule.workTypeId === id);
    const rules = draft.rules.filter(rule => rule.workTypeId !== id);
    if (update) rules.push({ workTypeId: id, coverage: draft.baseCoverage, hourlyRate: draft.baseHourlyRate, minimumMinutes: draft.baseMinimumMinutes, ...old, ...update });
    setDraft({ ...draft, rules });
  }
  function ruleEditor(id: string, name: string) {
    if (!draft) return null;
    const rule = id === 'base' ? { coverage: draft.baseCoverage, hourlyRate: draft.baseHourlyRate, minimumMinutes: draft.baseMinimumMinutes } : draft.rules.find(row => row.workTypeId === id);
    return <fieldset key={id} className="space-y-3 border-t pt-4">
      <legend className="pt-4 text-sm font-semibold">{name}</legend>
      <label className="block text-sm">{t('rates.coverage')}
        <select className={inputClass} data-testid={`billing-coverage-${id}`} value={rule?.coverage ?? 'inherit'} onChange={event => {
          const value = event.target.value;
          updateRule(id, value === 'inherit' ? null : { coverage: value as Coverage, ...(value !== 'billable' ? { hourlyRate: null, minimumMinutes: null } : {}) });
        }}>
          {id !== 'base' && <option value="inherit">{t('rates.inherits')}</option>}
          <option value="billable">{t('rates.billable')}</option><option value="included">{t('rates.included')}</option><option value="non_billable">{t('rates.nonBillable')}</option>
        </select>
      </label>
      {rule?.coverage === 'billable' && <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">{t('rates.hourlyRate')}<input data-testid={`billing-rate-${id}`} className={inputClass} type="number" min="0" max="99999999.99" step="0.01" value={rule.hourlyRate ?? ''} onChange={event => updateRule(id, { hourlyRate: event.target.value || null })} /></label>
        <label className="text-sm">{t('rates.minimum')}<input data-testid={`billing-minimum-${id}`} className={inputClass} type="number" min="0" max="2147483647" step="1" value={rule.minimumMinutes ?? ''} onChange={event => updateRule(id, { minimumMinutes: event.target.value === '' ? null : Number(event.target.value) })} /></label>
      </div>}
    </fieldset>;
  }
  return <section className="rounded-lg border bg-card p-6" data-testid="billing-rates-tab">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{t('rates.title')}</h2><p className="mt-1 max-w-prose text-sm text-muted-foreground">{t('rates.description')}</p></div>
      <button className={buttonClass} data-testid="billing-profile-create" disabled={busy} onClick={create}>{t('rates.create')}</button></div>
    {loading ? <p role="status" className="mt-4 text-sm">{t('common:states.loading')}</p> : failed ? <div role="alert" className="mt-4"><p>{t('rates.loadError')}</p><button className={buttonClass} data-testid="billing-rates-retry" onClick={() => void load()}>{t('common:actions.retry')}</button></div> : profiles.filter(p => p.isActive).length === 0 ? <p className="mt-4 text-sm text-muted-foreground">{t('rates.empty')}</p> : <div className="mt-5 overflow-x-auto">
      <table className="w-full text-left text-sm"><thead className="border-b text-muted-foreground"><tr>
        <th scope="col" className="p-3">{t('rates.profile')}</th><th scope="col" className="p-3">{t('rates.allOtherWork')}</th>
        {activeTypes.map(type => <th key={type.id} scope="col" className="p-3"><details><summary className="cursor-pointer rounded py-2 focus-visible:ring-2 focus-visible:ring-ring" data-testid={`billing-work-type-menu-${type.id}`}>{type.name}</summary><div className="flex flex-col gap-2 py-2">
          <button type="button" className={buttonClass} data-testid={`billing-work-type-rename-${type.id}`} onClick={() => workTypeManager.current?.rename(type.id)}>{t('settings:workTypes.rename')}</button>
          <button type="button" className={buttonClass} data-testid={`billing-work-type-archive-${type.id}`} onClick={() => workTypeManager.current?.archive(type.id)}>{t('settings:workTypes.archive')}</button>
          <button type="button" className={buttonClass} data-testid={`billing-work-type-add-${type.id}`} onClick={() => workTypeManager.current?.add()}>{t('settings:workTypes.create')}</button>
        </div></details></th>)}
        <th scope="col" className="p-3">{t('rates.actions')}</th>
      </tr></thead><tbody className="divide-y">{profiles.filter(p => p.isActive).map(p => <tr key={p.id} data-testid={`billing-profile-row-${p.id}`}>
        <th scope="row" className="p-3"><button className="text-left font-medium hover:underline" data-testid={`billing-profile-edit-${p.id}`} disabled={busy} onClick={() => edit(p)}>{p.name}</button>{p.isDefault && <span className="ml-2 rounded bg-muted px-2 py-1 text-xs font-normal">{t('rates.default')}</span>}<p className="mt-1 text-xs font-normal text-muted-foreground">{p.currencyCode}{p.roundingIncrementMinutes ? ` · ${t('rates.roundingSummary', { minutes: p.roundingIncrementMinutes })}` : ''}</p></th>
        <td className="p-3"><button className={buttonClass} data-testid={`billing-cell-${p.id}-base`} disabled={busy} onClick={() => edit(p)}>{outcome(p.baseCoverage, p.baseHourlyRate, p.baseMinimumMinutes, p.currencyCode)}</button></td>
        {activeTypes.map(type => { const rule = p.rules.find(row => row.workTypeId === type.id); return <td key={type.id} className="p-3"><button className={buttonClass} data-testid={`billing-cell-${p.id}-${type.id}`} disabled={busy} onClick={() => edit(p)}>{rule ? outcome(rule.coverage, rule.hourlyRate, rule.minimumMinutes, p.currencyCode) : <>{outcome(p.baseCoverage, p.baseHourlyRate, p.baseMinimumMinutes, p.currencyCode)}<span className="mt-1 block text-xs font-normal text-muted-foreground">{t('rates.inherits')}</span></>}</button></td>; })}
        <td className="p-3"><details><summary className="cursor-pointer rounded px-2 py-2 focus-visible:ring-2 focus-visible:ring-ring" data-testid={`billing-profile-menu-${p.id}`}>{t('rates.actions')}</summary><div className="flex min-w-40 flex-col gap-2 py-2">
          <button className={buttonClass} data-testid={`billing-profile-clone-${p.id}`} disabled={busy} onClick={() => edit(p, true)}>{t('rates.clone')}</button>
          <button className={buttonClass} data-testid={`billing-profile-default-${p.id}`} disabled={busy || p.isDefault} onClick={() => void rowAction(p, false)}>{t('rates.setDefault')}</button>
          <button className={buttonClass} data-testid={`billing-profile-archive-${p.id}`} disabled={busy || p.isDefault} onClick={() => void rowAction(p, true)}>{t('rates.archive')}</button>
          <p className="text-xs text-muted-foreground">{t('rates.usageUnavailable')}</p>
        </div></details></td>
      </tr>)}</tbody></table>
    </div>}
    <WorkTypesCard ref={workTypeManager} onLoad={acceptWorkTypes} />
    <Drawer open={draft !== null} onClose={() => setDraft(null)} title={cloneId ? t('rates.clone') : draft?.id ? t('rates.edit') : t('rates.create')} closeDisabled={busy} dataTestId="billing-profile-drawer" width="max-w-xl">
      {draft && <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy} className="space-y-4">
          <label className="block text-sm">{t('rates.name')}<input required maxLength={120} data-testid="billing-profile-name" className={inputClass} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
          {!cloneId && <><div className="grid grid-cols-2 gap-3">
            <label className="text-sm">{t('rates.currency')}<select className={inputClass} data-testid="billing-profile-currency" disabled={!!original && !!draft.id && (original.isDefault || original.baseHourlyRate !== null || original.rules.some(row => row.hourlyRate !== null))} value={draft.currencyCode} onChange={event => setDraft({ ...draft, currencyCode: event.target.value })}>{currencyOptions(draft.currencyCode).map(code => <option key={code} value={code}>{currencyLabel(code, i18n.language)}</option>)}</select></label>
            <label className="text-sm">{t('rates.rounding')}<input data-testid="billing-profile-rounding" className={inputClass} type="number" min="1" max="480" step="1" value={draft.roundingIncrementMinutes ?? ''} onChange={event => setDraft({ ...draft, roundingIncrementMinutes: event.target.value === '' ? null : Number(event.target.value) })} /></label>
          </div><p className="text-xs text-muted-foreground">{t('rates.currencyHelp')}</p>
          <label className="block text-sm">{t('rates.notes')}<textarea className={inputClass} data-testid="billing-profile-notes" maxLength={4000} value={draft.notes ?? ''} onChange={event => setDraft({ ...draft, notes: event.target.value || null })} /></label>
          {ruleEditor('base', t('rates.allOtherWork'))}{activeTypes.map(type => ruleEditor(type.id, type.name))}</>}
        </fieldset>
        {partialSave && <p role="alert" className="text-sm text-destructive">{t('rates.partialSave')}</p>}
        <div className="flex justify-end gap-2 border-t pt-4"><button type="button" className={buttonClass} data-testid="billing-profile-cancel" disabled={busy} onClick={() => setDraft(null)}>{t('common:actions.cancel')}</button><button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50" data-testid="billing-profile-save" disabled={busy || !draft.name.trim()}>{busy ? t('common:states.saving') : t('common:actions.save')}</button></div>
      </form>}
    </Drawer>
  </section>;
}
