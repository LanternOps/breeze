import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useState } from 'react';
import { variablesForContext } from '@breeze/shared';
import {
  listCannedResponses,
  createCannedResponse,
  updateCannedResponse,
  deleteCannedResponse,
  type CannedResponse,
} from '../../lib/ticketResponseTemplatesApi';

interface FormState {
  id: string | null; // null = creating a new one
  name: string;
  category: string;
  body: string;
}

const EMPTY_FORM: FormState = { id: null, name: '', category: '', body: '' };

export default function CannedResponsesCard() {
  const { t } = useTranslation('settings');
  const [items, setItems] = useState<CannedResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      setItems(await listCannedResponses());
    } catch {
      setError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = () => setForm({ ...EMPTY_FORM });
  const openEdit = (response: CannedResponse) =>
    setForm({ id: response.id, name: response.name, category: response.category ?? '', body: response.body });

  const save = useCallback(async () => {
    if (!form || !form.name.trim() || !form.body.trim() || saving) return;
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        body: form.body,
        category: form.category.trim() ? form.category.trim() : null,
      };
      if (form.id !== null) {
        await updateCannedResponse(form.id, payload);
      } else {
        await createCannedResponse(payload);
      }
      setForm(null);
      await load();
    } catch {
      // failure already surfaced via runAction toast; keep the form open
    } finally {
      setSaving(false);
    }
  }, [form, saving, load]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await deleteCannedResponse(id);
        await load();
      } catch {
        // surfaced via runAction toast
      }
    },
    [load],
  );

  return (
    <div className="max-w-3xl" data-testid="canned-responses-card">
      <section className="rounded-lg border p-4">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">{t('cannedResponsesCard.cannedResponses')}</h2>
            <p className="text-xs text-muted-foreground">
              {t('cannedResponsesCard.reusableReplyTemplatesWithMergeVariablesSharedAcrossAllO')}</p>
          </div>
          <button
            type="button"
            onClick={openNew}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white"
            data-testid="canned-response-new"
          >
            {t('cannedResponsesCard.new')}</button>
        </div>

        {form && (
          <div className="mb-4 rounded-md border bg-muted/20 p-3" data-testid="canned-response-form">
            <label className="text-xs font-medium" htmlFor="canned-response-name">
              {t('cannedResponsesCard.name')}</label>
            <input
              id="canned-response-name"
              type="text"
              value={form.name}
              disabled={saving}
              onChange={(e) => setForm((f) => (f ? { ...f, name: e.target.value } : f))}
              className="mt-0.5 mb-2 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
              data-testid="canned-response-name"
            />

            <label className="text-xs font-medium" htmlFor="canned-response-category">
              {t('cannedResponsesCard.category')}<span className="text-muted-foreground">{t('cannedResponsesCard.optional')}</span>
            </label>
            <input
              id="canned-response-category"
              type="text"
              value={form.category}
              disabled={saving}
              onChange={(e) => setForm((f) => (f ? { ...f, category: e.target.value } : f))}
              className="mt-0.5 mb-2 block w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
              data-testid="canned-response-category"
            />

            <label className="text-xs font-medium" htmlFor="canned-response-body">
              {t('cannedResponsesCard.body')}</label>
            <textarea
              id="canned-response-body"
              value={form.body}
              disabled={saving}
              onChange={(e) => setForm((f) => (f ? { ...f, body: e.target.value } : f))}
              rows={4}
              className="mt-0.5 block w-full resize-y rounded-md border bg-background px-2.5 py-1.5 text-sm"
              data-testid="canned-response-body"
            />

            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              <span className="text-xs text-muted-foreground">{t('cannedResponsesCard.insert')}</span>
              {variablesForContext('canned').map((v) => (
                <button
                  key={v.key}
                  type="button"
                  disabled={saving}
                  onClick={() => setForm((f) => (f ? { ...f, body: `${f.body}{{${v.key}}}` } : f))}
                  className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                  data-testid={`canned-response-var-${v.key}`}
                  title={v.label}
                >
                  {v.label}
                </button>
              ))}
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void save()}
                disabled={saving || !form.name.trim() || !form.body.trim()}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                data-testid="canned-response-save"
              >
                {saving ? t('cannedResponsesCard.saving') : t('cannedResponsesCard.save')}
              </button>
              <button
                type="button"
                onClick={() => setForm(null)}
                disabled={saving}
                className="rounded-md border px-3 py-1.5 text-sm"
                data-testid="canned-response-cancel"
              >
                {t('cannedResponsesCard.cancel')}</button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="text-center text-sm text-muted-foreground" data-testid="canned-responses-loading">
            {t('cannedResponsesCard.loading')}</p>
        ) : error ? (
          <p className="text-center text-sm text-muted-foreground" data-testid="canned-responses-error">
            {t('cannedResponsesCard.failedToLoadCannedResponses')}{' '}
            <button type="button" onClick={() => void load()} className="underline hover:text-foreground">
              {t('cannedResponsesCard.retry')}</button>
          </p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="canned-responses-empty">
            {t('cannedResponsesCard.noCannedResponsesYetCreateOneToSpeedUpReplies')}</p>
        ) : (
          <ul className="divide-y">
            {items.map((response) => (
              <li key={response.id} className="flex items-start justify-between gap-3 py-2" data-testid={`canned-response-row-${response.id}`}>
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {response.category ? <span className="text-muted-foreground">{response.category} · </span> : null}
                    {response.name}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{response.body}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-sm">
                  <button
                    type="button"
                    onClick={() => openEdit(response)}
                    className="text-muted-foreground hover:text-foreground"
                    data-testid={`canned-response-edit-${response.id}`}
                  >
                    {t('cannedResponsesCard.edit')}</button>
                  <button
                    type="button"
                    onClick={() => void remove(response.id)}
                    className="text-muted-foreground hover:text-foreground"
                    data-testid={`canned-response-delete-${response.id}`}
                  >
                    {t('cannedResponsesCard.delete')}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
