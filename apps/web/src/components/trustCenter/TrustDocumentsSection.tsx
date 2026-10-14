import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRUST_DOCUMENTS_MAX } from '@breeze/shared';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import type { OrgFetch } from '@/components/organizations/record/orgRecordFetch';
import { listOrgDocuments, type OrgDocument } from '@/lib/api/orgDocuments';
import { updateTrustDocuments } from '@/lib/api/trustPage';
import { handleActionError, runAction } from '@/lib/runAction';

export interface LinkedTrustDocument {
  documentId: string;
  /** Remembered so a superseded/missing link can still be named. */
  title: string;
  disclosureConfirmed: boolean;
}

const PRIORITY: Record<string, number> = { policy: 0, report: 1, evidence: 2 };

interface Props {
  orgId: string;
  orgFetch: OrgFetch;
  canWrite: boolean;
  // W1 follow-up: GET links from API (A2 lacks a read endpoint). Until then the
  // tab passes [] and the section tracks links for the current session only.
  initialLinks: LinkedTrustDocument[];
  onReload: () => Promise<void>;
}

export default function TrustDocumentsSection({ orgId, orgFetch, canWrite, initialLinks, onReload }: Props) {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.${key}`, vars ?? {}),
    [t],
  );
  const [library, setLibrary] = useState<OrgDocument[] | null>(null);
  const [libraryFailed, setLibraryFailed] = useState(false);
  const [links, setLinks] = useState<LinkedTrustDocument[]>(initialLinks);
  const [pending, setPending] = useState<OrgDocument | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listOrgDocuments(orgFetch, orgId, { includeSuperseded: false })
      .then((docs) => { if (!cancelled) setLibrary(docs); })
      .catch((err: unknown) => {
        console.error('[TrustDocumentsSection] failed to load the document library', err);
        if (!cancelled) setLibraryFailed(true);
      });
    return () => { cancelled = true; };
  }, [orgFetch, orgId]);

  const libraryById = useMemo(() => new Map((library ?? []).map((d) => [d.id, d])), [library]);
  const linkedIds = useMemo(() => new Set(links.map((l) => l.documentId)), [links]);
  const available = useMemo(
    () => (library ?? [])
      .filter((d) => d.supersededByDocumentId === null && !linkedIds.has(d.id))
      .sort((a, b) => (PRIORITY[a.category] ?? 3) - (PRIORITY[b.category] ?? 3)),
    [library, linkedIds],
  );
  const atMax = links.length >= TRUST_DOCUMENTS_MAX;

  const openAdd = (doc: OrgDocument) => {
    if (!canWrite) return;
    setChecked(false);
    setPending(doc);
  };
  const confirmAdd = () => {
    if (!pending || !checked) return;
    setLinks((prev) => [...prev, { documentId: pending.id, title: pending.title, disclosureConfirmed: true }]);
    setPending(null);
  };
  const move = (index: number, delta: -1 | 1) => setLinks((prev) => {
    const to = index + delta;
    if (to < 0 || to >= prev.length) return prev;
    const next = [...prev];
    [next[index], next[to]] = [next[to], next[index]];
    return next;
  });
  const remove = (id: string) => setLinks((prev) => prev.filter((l) => l.documentId !== id));

  const save = async () => {
    if (!canWrite) return;
    setBusy(true);
    setError(null);
    try {
      await runAction({
        request: () => updateTrustDocuments(orgFetch, orgId, links.map((l) => ({
          documentId: l.documentId, visibility: 'public' as const, disclosureConfirmed: l.disclosureConfirmed,
        }))),
        successMessage: tr('documents.saved'),
        errorFallback: tr('documents.saveFailed'),
        suppressErrorToast: (_status, code) => code === 'DOCUMENT_UNAVAILABLE',
        friendly: (code, _message, body) => {
          if (code !== 'DOCUMENT_UNAVAILABLE') return undefined;
          const ids = (body as { details?: { documentIds?: string[] } } | undefined)?.details?.documentIds ?? [];
          const names = ids.map((id) => links.find((l) => l.documentId === id)?.title ?? libraryById.get(id)?.title ?? id);
          const msg = tr('documents.unavailable', { titles: names.join(', ') });
          setError(msg);
          return msg;
        },
      });
      await onReload();
    } catch (err) {
      handleActionError(err, tr('documents.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" data-testid="trust-documents-section">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">{tr('sections.documentsHeading')}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{tr('documents.description')}</p>
        </div>
        <a href="#documents" className="text-sm text-primary underline" data-testid="trust-docs-upload-link">
          {tr('documents.upload')}
        </a>
      </div>

      {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert" data-testid="trust-docs-error">{error}</p>}

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h4 className="mb-2 text-sm font-semibold">{tr('documents.library')}</h4>
          {libraryFailed ? (
            <p className="text-sm text-destructive" role="alert">{tr('documents.libraryFailed')}</p>
          ) : library === null ? (
            <p className="text-sm text-muted-foreground">{tr('loading')}</p>
          ) : available.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="trust-docs-library-empty">{tr('documents.libraryEmpty')}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {available.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2 p-2 text-sm" data-testid={`trust-doc-lib-${d.id}`}>
                  <div className="min-w-0">
                    <div className="truncate font-medium">{d.title}</div>
                    <div className="text-xs text-muted-foreground">{d.category}</div>
                  </div>
                  <button
                    type="button"
                    disabled={!canWrite || atMax}
                    onClick={() => openAdd(d)}
                    className="shrink-0 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                    data-testid={`trust-doc-add-${d.id}`}
                  >
                    {tr('documents.add')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h4 className="mb-2 text-sm font-semibold">{tr('documents.linked', { count: links.length, max: TRUST_DOCUMENTS_MAX })}</h4>
          {links.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="trust-docs-linked-empty">{tr('documents.linkedEmpty')}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {links.map((l, i) => {
                const row = libraryById.get(l.documentId);
                const unavailable = library !== null && (!row || row.supersededByDocumentId !== null);
                return (
                  <li key={l.documentId} className="flex items-center justify-between gap-2 p-2 text-sm" data-testid={`trust-doc-linked-${l.documentId}`}>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{row?.title ?? l.title}</div>
                      {unavailable && (
                        <div className="text-xs text-warning" data-testid={`trust-doc-superseded-${l.documentId}`}>
                          {tr('documents.superseded')}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button type="button" disabled={!canWrite || i === 0} onClick={() => move(i, -1)} aria-label={tr('documents.moveUp')}
                        className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50" data-testid={`trust-doc-up-${l.documentId}`}>↑</button>
                      <button type="button" disabled={!canWrite || i === links.length - 1} onClick={() => move(i, 1)} aria-label={tr('documents.moveDown')}
                        className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50" data-testid={`trust-doc-down-${l.documentId}`}>↓</button>
                      <button type="button" disabled={!canWrite} onClick={() => remove(l.documentId)}
                        className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50" data-testid={`trust-doc-remove-${l.documentId}`}>
                        {tr('documents.remove')}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <button
        type="button"
        disabled={!canWrite || busy}
        onClick={() => void save()}
        className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="trust-docs-save"
      >
        {tr('documents.save')}
      </button>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmAdd}
        title={tr('documents.disclosureTitle')}
        message={tr('documents.disclosureMessage', { title: pending?.title ?? '' })}
        confirmLabel={tr('documents.disclosureConfirm')}
        variant="warning"
        confirmDisabled={!checked}
        confirmTestId="trust-doc-disclosure-confirm"
      >
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} data-testid="trust-doc-disclosure-checkbox" />
          <span>{tr('documents.disclosureCheckbox')}</span>
        </label>
      </ConfirmDialog>
    </section>
  );
}
