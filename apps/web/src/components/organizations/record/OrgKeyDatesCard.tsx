import { useCallback, useEffect, useId, useState } from 'react';
import { CalendarClock, Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CreateKeyDateInput } from '@breeze/shared';
import {
  createKeyDate,
  deleteKeyDate,
  listKeyDates,
  updateKeyDate,
  type KeyDate,
  type KeyDateKind,
} from '@/lib/api/orgKeyDates';
import { formatDate } from '@/components/billing/shared/format';
import { ActionError, handleActionError } from '@/lib/runAction';
import { runClientAction } from '@/lib/runClientAction';
import { useLatest, type OrgFetch } from './orgRecordFetch';

const KINDS: readonly KeyDateKind[] = [
  'insurance_renewal',
  'vendor_contract_end',
  'compliance_deadline',
  'audit',
  'other',
];

/** A failed load keeps the server's message so the card can say WHY. */
interface LoadFailure {
  failed: true;
  message: string;
}

interface FormState {
  label: string;
  kind: KeyDateKind;
  date: string;
  recursAnnually: boolean;
  remindDaysBefore: string;
  portalVisible: boolean;
  notes: string;
}

const EMPTY_FORM: FormState = {
  label: '',
  kind: 'other',
  date: '',
  recursAnnually: false,
  remindDaysBefore: '',
  portalVisible: false,
  notes: '',
};

function formFrom(row: KeyDate): FormState {
  return {
    label: row.label,
    kind: row.kind,
    date: row.date,
    recursAnnually: row.recursAnnually,
    remindDaysBefore: row.remindDaysBefore === null ? '' : String(row.remindDaysBefore),
    portalVisible: row.portalVisible,
    notes: row.notes ?? '',
  };
}

function toInput(form: FormState): CreateKeyDateInput {
  const remind = form.remindDaysBefore.trim();
  return {
    label: form.label.trim(),
    kind: form.kind,
    date: form.date,
    recursAnnually: form.recursAnnually,
    remindDaysBefore: remind === '' ? null : Number(remind),
    portalVisible: form.portalVisible,
    notes: form.notes.trim() === '' ? null : form.notes.trim(),
  };
}

const INPUT = 'w-full rounded-md border bg-background px-2 py-1.5 text-sm';
const BUTTON = 'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-60';
const ICON_BUTTON = 'rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60';

/** `key_date` rows sort with contract ends by date; ties keep label order. */
function byDate(a: KeyDate, b: KeyDate): number {
  return a.date.localeCompare(b.date) || a.label.localeCompare(b.label);
}

/**
 * Key dates for one organization (#5573 W01): insurance renewals, compliance
 * deadlines, audits — plus every active contract's end date, which the API
 * synthesizes into the same list. Contract ends are read-only here (their
 * source of truth is the contract), key dates are editable inline.
 *
 * All requests go through the record's `orgFetch`, and every mutation through
 * `runAction` so the outcome is always toasted.
 */
export default function OrgKeyDatesCard({ orgId, orgFetch }: { orgId: string; orgFetch: OrgFetch }) {
  const { t } = useTranslation('deliverables');
  const [rows, setRows] = useState<KeyDate[] | LoadFailure | null>(null);
  // `'new'` = the add form; a row id = editing that row; null = closed.
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const latest = useLatest<KeyDate[] | LoadFailure>();
  const formId = useId();

  const load = useCallback(async () => {
    const fallback = t('keyDates.errors.loadFailed');
    const result = await latest.run(
      listKeyDates(orgFetch, orgId)
        .then((list): KeyDate[] | LoadFailure => {
          if (Array.isArray(list)) return [...list].sort(byDate);
          console.error('[OrgKeyDatesCard] key dates response is not a list', list);
          return { failed: true, message: fallback };
        })
        .catch((err: unknown): LoadFailure => {
          console.error('[OrgKeyDatesCard] failed to load key dates', err);
          return { failed: true, message: err instanceof ActionError && err.message ? err.message : fallback };
        }),
    );
    if (result === undefined) return;
    setRows(result);
  }, [latest, orgFetch, orgId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const openAdd = () => {
    setForm(EMPTY_FORM);
    setEditing('new');
    setArmedDelete(null);
  };
  const openEdit = (row: KeyDate) => {
    setForm(formFrom(row));
    setEditing(row.id);
    setArmedDelete(null);
  };
  const close = () => setEditing(null);

  const save = async () => {
    if (editing === null) return;
    const body = toInput(form);
    const target = editing;
    setSaving(true);
    try {
      await runClientAction(
        () => (target === 'new' ? createKeyDate(orgFetch, orgId, body) : updateKeyDate(orgFetch, orgId, target, body)),
        { errorFallback: t('keyDates.errors.saveFailed'), successMessage: t('keyDates.toast.saved') },
      );
      close();
      await load();
    } catch (err) {
      handleActionError(err, t('keyDates.errors.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setDeleting(id);
    try {
      await runClientAction(() => deleteKeyDate(orgFetch, orgId, id), {
        errorFallback: t('keyDates.errors.saveFailed'),
        successMessage: t('keyDates.toast.deleted'),
      });
      setArmedDelete(null);
      await load();
    } catch (err) {
      handleActionError(err, t('keyDates.errors.saveFailed'));
    } finally {
      setDeleting(null);
    }
  };

  const canSave = form.label.trim() !== '' && /^\d{4}-\d{2}-\d{2}$/.test(form.date) && !saving;

  const renderForm = () => (
    <form
      data-testid="key-date-form"
      className="space-y-2 border-b bg-muted/30 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <label htmlFor={`${formId}-label`} className="block text-xs font-medium text-muted-foreground">
            {t('keyDates.label')}
          </label>
          <input
            id={`${formId}-label`}
            className={INPUT}
            value={form.label}
            maxLength={200}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`${formId}-kind`} className="block text-xs font-medium text-muted-foreground">
            {t('keyDates.kind.label')}
          </label>
          <select
            id={`${formId}-kind`}
            className={INPUT}
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as KeyDateKind })}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(/* i18n-dynamic */ `keyDates.kind.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${formId}-date`} className="block text-xs font-medium text-muted-foreground">
            {t('keyDates.date')}
          </label>
          <input
            id={`${formId}-date`}
            type="date"
            className={INPUT}
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
        </div>
        <div>
          <label htmlFor={`${formId}-remind`} className="block text-xs font-medium text-muted-foreground">
            {t('keyDates.remindDaysBefore')}
          </label>
          <input
            id={`${formId}-remind`}
            type="number"
            min={0}
            max={365}
            className={INPUT}
            value={form.remindDaysBefore}
            onChange={(e) => setForm({ ...form, remindDaysBefore: e.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-4 text-sm">
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={form.recursAnnually}
            onChange={(e) => setForm({ ...form, recursAnnually: e.target.checked })}
          />
          {t('keyDates.recursAnnually')}
        </label>
        <label className="inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={form.portalVisible}
            onChange={(e) => setForm({ ...form, portalVisible: e.target.checked })}
          />
          {t('keyDates.portalVisible')}
        </label>
      </div>
      <div>
        <label htmlFor={`${formId}-notes`} className="block text-xs font-medium text-muted-foreground">
          {t('keyDates.notes')}
        </label>
        <textarea
          id={`${formId}-notes`}
          className={INPUT}
          rows={2}
          maxLength={4000}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
        />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className={BUTTON} onClick={close} disabled={saving}>
          {t('actions.cancel')}
        </button>
        <button
          type="submit"
          data-testid="key-date-form-save"
          className={`${BUTTON} bg-primary text-primary-foreground hover:bg-primary/90`}
          disabled={!canSave}
        >
          {t('actions.save')}
        </button>
      </div>
    </form>
  );

  return (
    <section data-testid="org-key-dates" className="rounded-lg border bg-card">
      <header className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('keyDates.title')}
        </h2>
        <button
          type="button"
          data-testid="key-date-add"
          className={BUTTON}
          onClick={openAdd}
          disabled={editing === 'new'}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          {t('keyDates.add')}
        </button>
      </header>

      {editing === 'new' && renderForm()}

      {rows === null ? (
        <div className="space-y-2 px-4 py-3">
          <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      ) : !Array.isArray(rows) ? (
        <p className="px-4 py-4 text-sm text-destructive" data-testid="org-key-dates-error">{rows.message}</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">{t('keyDates.empty')}</p>
      ) : (
        <ul className="divide-y">
          {rows.map((row) => {
            const isContract = row.source === 'contract_end';
            if (!isContract && editing === row.id) {
              return (
                <li key={row.id} data-testid={`key-date-row-${row.id}`}>
                  {renderForm()}
                </li>
              );
            }
            const armed = armedDelete === row.id;
            return (
              <li key={row.id} data-testid={`key-date-row-${row.id}`} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium">{row.label}</span>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        isContract ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {isContract ? t('keyDates.contractEnd') : t(/* i18n-dynamic */ `keyDates.kind.${row.kind}`)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {[
                      formatDate(row.date),
                      row.recursAnnually ? t('keyDates.recursAnnually') : null,
                      row.remindDaysBefore !== null ? `${t('keyDates.remindDaysBefore')}: ${row.remindDaysBefore}` : null,
                      row.portalVisible ? t('keyDates.portalVisible') : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                  {row.notes && <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{row.notes}</p>}
                </div>
                {!isContract && (
                  <div className="flex shrink-0 items-center gap-1">
                    {armed ? (
                      <>
                        <span className="text-xs text-muted-foreground">
                          {t('confirm.deleteKeyDate', { label: row.label })}
                        </span>
                        <button
                          type="button"
                          data-testid={`key-date-delete-confirm-${row.id}`}
                          className={`${BUTTON} border-destructive text-destructive`}
                          disabled={deleting === row.id}
                          onClick={() => void remove(row.id)}
                        >
                          {t('keyDates.delete')}
                        </button>
                        <button
                          type="button"
                          data-testid={`key-date-delete-cancel-${row.id}`}
                          className={BUTTON}
                          disabled={deleting === row.id}
                          onClick={() => setArmedDelete(null)}
                        >
                          {t('actions.cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          data-testid={`key-date-edit-${row.id}`}
                          className={ICON_BUTTON}
                          aria-label={t('keyDates.edit')}
                          title={t('keyDates.edit')}
                          onClick={() => openEdit(row)}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          data-testid={`key-date-delete-${row.id}`}
                          className={ICON_BUTTON}
                          aria-label={t('keyDates.delete')}
                          title={t('keyDates.delete')}
                          onClick={() => setArmedDelete(row.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
