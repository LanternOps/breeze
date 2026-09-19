// W02 must move this card into the Rates screen and remove it from here.
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import { loginPathWithNext } from '../../lib/authScope';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import { resetWorkTypeCache, type WorkTypeOption } from '../shared/WorkTypeSelect';

const endpoint = '/billing-profiles/work-types';
const inputClass = 'min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';
const buttonClass = 'rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export default function WorkTypesCard({ onLoad }: { onLoad?: (workTypes: WorkTypeOption[]) => void }) {
  const { t } = useTranslation('settings');
  const [workTypes, setWorkTypes] = useState<WorkTypeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const response = await fetchWithAuth(`${endpoint}?includeInactive=true`);
      if (!response.ok) throw new Error('Work type list unavailable');
      const data = await response.json();
      if (!Array.isArray(data?.workTypes)) throw new Error('Invalid work type list');
      setWorkTypes(data.workTypes);
      onLoad?.(data.workTypes);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [onLoad]);
  useEffect(() => { void load(); }, [load]);

  async function mutate(method: 'POST' | 'PATCH' | 'DELETE', id?: string) {
    const nextName = (method === 'POST' ? name : editName).trim();
    if (busy || (method !== 'DELETE' && (!nextName || nextName.length > 60))) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(id ? `${endpoint}/${id}` : endpoint, {
          method,
          ...(method === 'DELETE' ? {} : { body: JSON.stringify({ name: nextName }) }),
        }),
        successMessage: t('workTypes.saveSuccess'),
        errorFallback: t('workTypes.saveError'),
        friendly: (code) => code === 'WORK_TYPE_NAME_TAKEN' ? t('workTypes.nameTaken') : undefined,
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true }),
      });
      resetWorkTypeCache();
      if (method === 'POST') setName('');
      else setEditingId(null);
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('workTypes.saveError') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 border-t pt-6" data-testid="work-types-card" aria-labelledby="work-types-title">
      <h2 id="work-types-title" className="text-lg font-semibold">{t('workTypes.title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t('workTypes.description')}</p>
      <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void mutate('POST'); }}>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm font-medium">
          {t('workTypes.newName')}
          <input data-testid="work-type-new-name" className={inputClass} maxLength={60} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
        </label>
        <button type="submit" data-testid="work-type-create" className={buttonClass} disabled={busy || !name.trim()}>{t('workTypes.create')}</button>
      </form>
      {loading ? <p className="mt-4 text-sm text-muted-foreground" role="status">{t('ticketCategoriesPage.loading')}</p>
        : failed ? <div className="mt-4 flex flex-wrap items-center gap-2 text-sm" role="alert">
          {t('workTypes.loadError')}
          <button type="button" className={buttonClass} onClick={() => void load()}>{t('ticketCategoriesPage.retry')}</button>
        </div>
        : workTypes.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">{t('workTypes.empty')}</p>
        : <ul className="mt-4 divide-y">
          {workTypes.map((workType) => <li key={workType.id} data-testid={`work-type-row-${workType.id}`} className="flex flex-wrap items-center gap-3 py-3">
            {editingId === workType.id ? <form className="flex w-full flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void mutate('PATCH', workType.id); }}>
              <input aria-label={t('workTypes.rename')} data-testid="work-type-edit-name" className={inputClass} maxLength={60} value={editName} disabled={busy} onChange={(event) => setEditName(event.target.value)} autoFocus />
              <button type="submit" data-testid="work-type-save" className={buttonClass} disabled={busy || !editName.trim()}>{t('ticketCategoriesPage.save')}</button>
              <button type="button" className={buttonClass} disabled={busy} onClick={() => setEditingId(null)}>{t('ticketCategoriesPage.cancel')}</button>
            </form> : <>
              <span className="min-w-0 flex-1 break-words text-sm font-medium">{workType.name}</span>
              <span className="rounded-full bg-muted px-2 py-1 text-xs">{workType.isActive ? t('ticketCategoriesPage.active') : t('workTypes.archived')}</span>
              <button type="button" data-testid={`work-type-rename-${workType.id}`} className={buttonClass} disabled={busy} onClick={() => { setEditingId(workType.id); setEditName(workType.name); }}>{t('workTypes.rename')}</button>
              {workType.isActive && <button type="button" data-testid={`work-type-archive-${workType.id}`} className={buttonClass} disabled={busy} onClick={() => void mutate('DELETE', workType.id)}>{t('workTypes.archive')}</button>}
            </>}
          </li>)}
        </ul>}
    </section>
  );
}
