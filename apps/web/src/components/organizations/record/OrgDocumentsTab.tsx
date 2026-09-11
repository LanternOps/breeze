import { useCallback, useEffect, useState } from 'react';
import { Download, FileText, Plus, Trash2, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  deleteOrgDocument,
  listOrgDocuments,
  orgDocumentContentPath,
  replaceOrgDocument,
  updateOrgDocument,
  uploadOrgDocument,
  ORG_DOCUMENT_CATEGORIES,
  type OrgDocument,
  type OrgDocumentCategory,
} from '@/lib/api/orgDocuments';
import { formatDate } from '@/lib/dateTimeFormat';
import { ActionError, runAction } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { useLatest, type OrgFetch } from './orgRecordFetch';

/**
 * The organization record's Documents tab (#5573 W03): the org's document
 * library — runbooks, baselines, policies, exports and delivery evidence.
 *
 * Every request goes through the record's `orgFetch`, so the tab is pinned to
 * the org in the URL rather than to the OrgSwitcher (orgRecordFetch.ts), and
 * every mutation goes through `runAction` so success and failure are always
 * visible. Bytes are never a plain link: the content route needs the auth
 * header, so Download fetches it and hands the browser a blob URL.
 *
 * The list shows CURRENT versions; "Show earlier versions" adds superseded
 * ones, which stay downloadable (delivery evidence pins an exact version) but
 * can no longer be replaced or deleted — those act on the current version.
 */

type LoadState = { failed: true; message: string } | OrgDocument[] | null;

/** An open upload form: a brand-new document, or a replacement for one. */
type FormState = { mode: 'upload' } | { mode: 'replace'; target: OrgDocument } | null;

const UPLOAD_ERROR_KEYS: Record<string, string> = {
  FILE_TOO_LARGE: 'errors.tooLarge',
  UNSUPPORTED_DOCUMENT_TYPE: 'errors.unsupportedType',
  STORAGE_UNAVAILABLE: 'errors.storageUnavailable',
  NOT_HEAD: 'errors.notHead',
  EMPTY_FILE: 'errors.emptyFile',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function OrgDocumentsTab({ orgId, orgFetch }: { orgId: string; orgFetch: OrgFetch }) {
  const { t } = useTranslation('organizations');
  const [state, setState] = useState<LoadState>(null);
  const [category, setCategory] = useState<OrgDocumentCategory | ''>('');
  const [includeSuperseded, setIncludeSuperseded] = useState(false);
  const [form, setForm] = useState<FormState>(null);
  const [fields, setFields] = useState<{ title: string; description: string; category: OrgDocumentCategory; portalVisible: boolean }>({
    title: '', description: '', category: 'other', portalVisible: false,
  });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useLatest<LoadState>();

  /** Every key in this tab lives under one namespace prefix. */
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.documents.${key}`, vars ?? {}),
    [t],
  );

  const load = useCallback(async () => {
    const result = await latest.run(
      listOrgDocuments(orgFetch, orgId, {
        category: category || undefined,
        includeSuperseded,
      }).catch((err: unknown): LoadState => {
        console.error('[OrgDocumentsTab] failed to load documents', err);
        // The message is NOT translated here: `t` is not a stable identity, and
        // depending on it would make `load` change on every render and the
        // effect below refetch in a loop. Render translates the fallback.
        return { failed: true, message: err instanceof ActionError && err.message ? err.message : '' };
      }),
    );
    if (result === undefined) return;
    setState(result);
  }, [latest, orgFetch, orgId, category, includeSuperseded]);

  useEffect(() => { void load(); }, [load]);

  const friendly = useCallback((code: string) => {
    const key = UPLOAD_ERROR_KEYS[code];
    return key ? tr(key) : undefined;
  }, [tr]);

  /** Open the form for a new document, or for replacing `target` (whose
   *  metadata pre-fills the fields, since omitted fields are inherited). */
  const openForm = (next: Exclude<FormState, null>) => {
    const source = next.mode === 'replace' ? next.target : null;
    setFields({
      title: source?.title ?? '',
      description: source?.description ?? '',
      category: source?.category ?? 'other',
      portalVisible: source?.portalVisible ?? false,
    });
    setFile(null);
    setForm(next);
  };

  const submitDocument = async () => {
    if (!form) return;
    if (!file || file.size === 0) {
      showToast({ type: 'error', message: tr('errors.emptyFile') });
      return;
    }
    // Built by hand rather than `new FormData(formEl)`: the body must carry
    // exactly the fields the API validates, and nothing else.
    const data = new FormData();
    data.append('file', file);
    if (fields.title.trim()) data.append('title', fields.title.trim());
    if (fields.description.trim()) data.append('description', fields.description.trim());
    data.append('category', fields.category);
    data.append('portalVisible', fields.portalVisible ? 'true' : 'false');
    setBusy(true);
    try {
      await runAction({
        // FormData carries its own multipart boundary — never set Content-Type.
        request: () => (form.mode === 'replace'
          ? replaceOrgDocument(orgFetch, orgId, form.target.id, data)
          : uploadOrgDocument(orgFetch, orgId, data)),
        errorFallback: tr('errors.uploadFailed'),
        successMessage: tr(form.mode === 'replace' ? 'toast.replaced' : 'toast.uploaded'),
        friendly,
      });
      setForm(null);
      setFile(null);
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: tr('errors.uploadFailed') });
    } finally {
      setBusy(false);
    }
  };

  const togglePortal = async (row: OrgDocument) => {
    try {
      await runAction({
        request: () => updateOrgDocument(orgFetch, orgId, row.id, { portalVisible: !row.portalVisible }),
        errorFallback: tr('errors.updateFailed'),
        successMessage: tr('toast.updated'),
        friendly,
      });
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: tr('errors.updateFailed') });
    }
  };

  const remove = async (row: OrgDocument) => {
    // Deleting the current version removes every earlier version with it, so
    // the confirmation says so rather than implying one file.
    if (!window.confirm(tr('deleteConfirm', { title: row.title }))) return;
    try {
      await runAction({
        request: () => deleteOrgDocument(orgFetch, orgId, row.id),
        errorFallback: tr('errors.deleteFailed'),
        successMessage: tr('toast.deleted'),
        friendly,
      });
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: tr('errors.deleteFailed') });
    }
  };

  const download = async (row: OrgDocument) => {
    try {
      const res = await orgFetch(orgDocumentContentPath(orgId, row.id));
      if (!res.ok) throw new Error(`status ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      window.open(url, '_blank', 'noopener');
      // The new tab holds its own reference; release ours on the next tick.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      console.error('[OrgDocumentsTab] download failed', err);
      showToast({ type: 'error', message: tr('errors.downloadFailed') });
    }
  };

  const rows = Array.isArray(state) ? state : [];

  return (
    <div className="space-y-4" data-testid="org-documents-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{tr('title')}</h2>
          <p className="text-sm text-muted-foreground">{tr('subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="rounded-md border bg-background px-2 py-1 text-sm"
            data-testid="org-documents-category-filter"
            aria-label={tr('column.category')}
            value={category}
            onChange={(e) => setCategory(e.target.value as OrgDocumentCategory | '')}
          >
            <option value="">{tr('filter.all')}</option>
            {ORG_DOCUMENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>{tr(`category.${c}`)}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="org-documents-show-superseded"
              checked={includeSuperseded}
              onChange={(e) => setIncludeSuperseded(e.target.checked)}
            />
            {tr('showSuperseded')}
          </label>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
            data-testid="org-documents-upload-open"
            onClick={() => openForm({ mode: 'upload' })}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {tr('upload')}
          </button>
        </div>
      </div>

      {form && (
        <form
          className="space-y-3 rounded-lg border bg-card p-4"
          data-testid="org-document-form"
          onSubmit={(e) => { e.preventDefault(); void submitDocument(); }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">{tr('form.title')}</span>
              <input
                className="w-full rounded-md border bg-background px-2 py-1"
                name="title"
                data-testid="org-document-title"
                value={fields.title}
                onChange={(e) => setFields((f) => ({ ...f, title: e.target.value }))}
                maxLength={200}
                required={form.mode === 'upload'}
              />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted-foreground">{tr('form.category')}</span>
              <select
                className="w-full rounded-md border bg-background px-2 py-1"
                name="category"
                data-testid="org-document-category"
                value={fields.category}
                onChange={(e) => setFields((f) => ({ ...f, category: e.target.value as OrgDocumentCategory }))}
              >
                {ORG_DOCUMENT_CATEGORIES.map((c) => (
                  <option key={c} value={c}>{tr(`category.${c}`)}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">{tr('form.description')}</span>
            <textarea
              className="w-full rounded-md border bg-background px-2 py-1"
              name="description"
              data-testid="org-document-description"
              rows={2}
              maxLength={4000}
              value={fields.description}
              onChange={(e) => setFields((f) => ({ ...f, description: e.target.value }))}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="portalVisible"
              data-testid="org-document-portal-visible"
              checked={fields.portalVisible}
              onChange={(e) => setFields((f) => ({ ...f, portalVisible: e.target.checked }))}
            />
            {tr('form.portalVisible')}
          </label>
          <div className="text-sm">
            <span className="mb-1 block text-muted-foreground">{tr('form.file')}</span>
            <input
              type="file"
              name="file"
              data-testid="org-document-file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              required
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {form.mode === 'replace' ? tr('form.replaceHint') : tr('form.fileHint')}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              // The click handler is the one path that submits: `onSubmit`
              // alone covers Enter-in-a-field, but not every environment
              // dispatches submit from a button click.
              type="submit"
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-60"
              data-testid="org-document-submit"
              disabled={busy}
              onClick={(e) => { e.preventDefault(); void submitDocument(); }}
            >
              <Upload className="h-4 w-4" aria-hidden="true" />
              {busy ? tr('uploading') : tr(form.mode === 'replace' ? 'replace' : 'upload')}
            </button>
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 text-sm"
              data-testid="org-document-cancel"
              onClick={() => setForm(null)}
            >
              {tr('cancel')}
            </button>
          </div>
        </form>
      )}

      {state === null && <p className="text-sm text-muted-foreground">{tr('title')}…</p>}

      {state !== null && !Array.isArray(state) && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm" data-testid="org-documents-error">
          {state.message || tr('loadFailed')}
        </p>
      )}

      {Array.isArray(state) && state.length === 0 && (
        <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground" data-testid="org-documents-empty">
          {category ? tr('emptyFiltered') : tr('empty')}
        </p>
      )}

      {Array.isArray(state) && state.length > 0 && (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm" data-testid="org-documents-table">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{tr('column.title')}</th>
                <th className="px-3 py-2">{tr('column.category')}</th>
                <th className="px-3 py-2">{tr('column.size')}</th>
                <th className="px-3 py-2">{tr('column.uploaded')}</th>
                <th className="px-3 py-2">{tr('column.portal')}</th>
                <th className="px-3 py-2">{tr('column.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const superseded = row.supersededByDocumentId !== null;
                return (
                  <tr key={row.id} className="border-t" data-testid={`org-document-row-${row.id}`}>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-2">
                        <FileText className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        <span>{row.title}</span>
                        {superseded && (
                          <span
                            className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
                            data-testid={`org-document-superseded-${row.id}`}
                          >
                            {tr('badge.superseded')}
                          </span>
                        )}
                      </span>
                      {row.description && <p className="text-xs text-muted-foreground">{row.description}</p>}
                    </td>
                    <td className="px-3 py-2">{tr(`category.${row.category}`)}</td>
                    <td className="px-3 py-2">{formatBytes(row.byteSize)}</td>
                    <td className="px-3 py-2">{formatDate(row.createdAt)}</td>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        data-testid={`org-document-portal-${row.id}`}
                        aria-label={tr('form.portalVisible')}
                        checked={row.portalVisible}
                        onChange={() => void togglePortal(row)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
                          data-testid={`org-document-download-${row.id}`}
                          onClick={() => void download(row)}
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden="true" />
                          {tr('download')}
                        </button>
                        {!superseded && (
                          <button
                            type="button"
                            className="rounded-md border px-2 py-1 text-xs"
                            data-testid={`org-document-replace-${row.id}`}
                            onClick={() => openForm({ mode: 'replace', target: row })}
                          >
                            {tr('replace')}
                          </button>
                        )}
                        {!superseded && (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-destructive"
                            data-testid={`org-document-delete-${row.id}`}
                            onClick={() => void remove(row)}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            {tr('delete')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
