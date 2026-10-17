import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TRUST_DOCUMENTS_MAX, type TrustDocumentVisibility } from '@breeze/shared';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import type { OrgFetch } from '@/components/organizations/record/orgRecordFetch';
import { listOrgDocuments, type OrgDocument } from '@/lib/api/orgDocuments';
import { updateTrustDocuments, type TrustLinkedDocument } from '@/lib/api/trustPage';
import { handleActionError, runAction } from '@/lib/runAction';

export interface LinkedTrustDocument {
  documentId: string;
  /** Remembered so a superseded/missing link can still be named. */
  title: string;
  /** Public: anyone with the page link downloads it. Gated: only requesters the MSP approves (W02d). */
  visibility: TrustDocumentVisibility;
  disclosureConfirmed: boolean;
  /** The visibility the server holds a confirmation for (absent for a link added in this session). */
  savedVisibility?: TrustDocumentVisibility;
  /** Server says the row is superseded or deleted. */
  unavailable?: boolean;
}

/** What the open disclosure dialog confirms: a new link, or a linked document whose visibility changed. */
type PendingDisclosure =
  | { kind: 'add'; doc: OrgDocument; visibility: TrustDocumentVisibility }
  | { kind: 'reconfirm'; documentId: string; title: string; visibility: TrustDocumentVisibility };

const PRIORITY: Record<string, number> = { policy: 0, report: 1, evidence: 2 };

interface Props {
  orgId: string;
  orgFetch: OrgFetch;
  canWrite: boolean;
  /** Server-saved links; the local list re-seeds whenever these change. */
  documents: TrustLinkedDocument[];
  onReload: () => Promise<void>;
  /** The page revision the editor loaded; when given it is sent, so a concurrent edit is a 409, not an overwrite. */
  expectedRevision?: number;
}

export default function TrustDocumentsSection({ orgId, orgFetch, canWrite, documents, onReload, expectedRevision }: Props) {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.${key}`, vars ?? {}),
    [t],
  );
  const [library, setLibrary] = useState<OrgDocument[] | null>(null);
  const [libraryFailed, setLibraryFailed] = useState(false);
  const serverLinks = useMemo<LinkedTrustDocument[]>(
    () => [...documents].sort((a, b) => a.sortOrder - b.sortOrder).map((d) => ({
      documentId: d.documentId,
      title: d.title,
      visibility: d.visibility ?? 'public',
      savedVisibility: d.visibility ?? 'public',
      disclosureConfirmed: d.disclosureConfirmedAt !== null,
      unavailable: d.supersededByDocumentId !== null || d.deleted,
    })),
    [documents],
  );
  const [links, setLinks] = useState<LinkedTrustDocument[]>(serverLinks);
  // Re-seed only when the SAVED list actually changes, so an unrelated reload
  // (e.g. a controls toggle) does not discard unsaved edits here.
  const signature = JSON.stringify(serverLinks);
  const seeded = useRef(signature);
  useEffect(() => {
    if (seeded.current === signature) return;
    seeded.current = signature;
    setLinks(serverLinks);
  }, [signature, serverLinks]);
  const [pending, setPending] = useState<PendingDisclosure | null>(null);
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
  const unconfirmed = links.some((l) => !l.disclosureConfirmed);

  const openAdd = (doc: OrgDocument) => {
    if (!canWrite) return;
    setChecked(false);
    setPending({ kind: 'add', doc, visibility: 'public' });
  };
  const openReconfirm = (l: LinkedTrustDocument) => {
    if (!canWrite) return;
    setChecked(false);
    setPending({ kind: 'reconfirm', documentId: l.documentId, title: libraryById.get(l.documentId)?.title ?? l.title, visibility: l.visibility });
  };
  const confirmPending = () => {
    if (!pending || !checked) return;
    if (pending.kind === 'add') {
      const { doc, visibility } = pending;
      setLinks((prev) => [...prev, { documentId: doc.id, title: doc.title, visibility, disclosureConfirmed: true }]);
    } else {
      const id = pending.documentId;
      setLinks((prev) => prev.map((l) => (l.documentId === id ? { ...l, disclosureConfirmed: true } : l)));
    }
    setPending(null);
  };
  /**
   * A visibility change is a new disclosure decision (public reaches anyone; gated reaches approved requesters),
   * so it needs a fresh confirmation — unless it returns to the visibility the server already holds one for.
   */
  const setVisibility = (id: string, visibility: TrustDocumentVisibility) => setLinks((prev) => prev.map((l) => {
    if (l.documentId !== id) return l;
    const confirmedOnServer = documents.some((d) => d.documentId === id && d.disclosureConfirmedAt !== null);
    return { ...l, visibility, disclosureConfirmed: l.savedVisibility === visibility && confirmedOnServer };
  }));
  const move = (index: number, delta: -1 | 1) => setLinks((prev) => {
    const to = index + delta;
    if (to < 0 || to >= prev.length) return prev;
    const next = [...prev];
    [next[index], next[to]] = [next[to], next[index]];
    return next;
  });
  const remove = (id: string) => setLinks((prev) => prev.filter((l) => l.documentId !== id));

  const save = async () => {
    if (!canWrite || unconfirmed) return;
    setBusy(true);
    setError(null);
    try {
      await runAction({
        request: () => {
          const body = links.map((l) => ({ documentId: l.documentId, visibility: l.visibility, disclosureConfirmed: l.disclosureConfirmed }));
          return expectedRevision === undefined
            ? updateTrustDocuments(orgFetch, orgId, body)
            : updateTrustDocuments(orgFetch, orgId, body, expectedRevision);
        },
        successMessage: tr('documents.saved'),
        errorFallback: tr('documents.saveFailed'),
        suppressErrorToast: (_status, code) => code === 'DOCUMENT_UNAVAILABLE' || code === 'REVISION_MISMATCH',
        friendly: (code, _message, body) => {
          if (code === 'REVISION_MISMATCH') {
            const msg = tr('errors.revisionMismatch');
            setError(msg);
            return msg;
          }
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

  const gatedPending = pending?.visibility === 'gated';
  const pendingTitle = pending ? (pending.kind === 'add' ? pending.doc.title : pending.title) : '';

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
                const unavailable = l.unavailable === true || (library !== null && (!row || row.supersededByDocumentId !== null));
                return (
                  <li key={l.documentId} className="flex items-center justify-between gap-2 p-2 text-sm" data-testid={`trust-doc-linked-${l.documentId}`}>
                    <div className="min-w-0">
                      <div className="truncate font-medium">{row?.title ?? l.title}</div>
                      {unavailable && (
                        <div className="text-xs text-warning" data-testid={`trust-doc-superseded-${l.documentId}`}>
                          {tr('documents.superseded')}
                        </div>
                      )}
                      <div className="mt-1 flex items-center gap-2">
                        <select
                          value={l.visibility}
                          disabled={!canWrite}
                          onChange={(e) => setVisibility(l.documentId, e.target.value as TrustDocumentVisibility)}
                          aria-label={tr('documents.visibilityLabel')}
                          className="rounded-md border bg-background px-1.5 py-0.5 text-xs disabled:opacity-50"
                          data-testid={`trust-doc-visibility-${l.documentId}`}
                        >
                          <option value="public">{tr('documents.visibilityPublic')}</option>
                          <option value="gated">{tr('documents.visibilityGated')}</option>
                        </select>
                        {!l.disclosureConfirmed && (
                          <button
                            type="button"
                            disabled={!canWrite}
                            onClick={() => openReconfirm(l)}
                            className="rounded-md border border-warning px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
                            data-testid={`trust-doc-reconfirm-${l.documentId}`}
                          >
                            {tr('documents.reconfirm')}
                          </button>
                        )}
                      </div>
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

      {unconfirmed && (
        <p className="text-sm text-warning" data-testid="trust-docs-reconfirm-needed">{tr('documents.reconfirmNeeded')}</p>
      )}
      <button
        type="button"
        disabled={!canWrite || busy || unconfirmed}
        onClick={() => void save()}
        className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="trust-docs-save"
      >
        {tr('documents.save')}
      </button>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmPending}
        title={tr(gatedPending ? 'documents.disclosureTitleGated' : 'documents.disclosureTitle')}
        message={tr(gatedPending ? 'documents.disclosureMessageGated' : 'documents.disclosureMessage', { title: pendingTitle })}
        confirmLabel={tr(pending?.kind === 'reconfirm' ? 'documents.disclosureConfirmChange' : 'documents.disclosureConfirm')}
        variant="warning"
        confirmDisabled={!checked}
        confirmTestId="trust-doc-disclosure-confirm"
      >
        {pending?.kind === 'add' && (
          <label className="mt-3 flex items-center gap-2 text-sm">
            <span>{tr('documents.visibilityLabel')}</span>
            <select
              value={pending.visibility}
              onChange={(e) => { setChecked(false); setPending({ ...pending, visibility: e.target.value as TrustDocumentVisibility }); }}
              className="rounded-md border bg-background px-1.5 py-0.5 text-sm"
              data-testid="trust-doc-add-visibility"
            >
              <option value="public">{tr('documents.visibilityPublic')}</option>
              <option value="gated">{tr('documents.visibilityGated')}</option>
            </select>
          </label>
        )}
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} data-testid="trust-doc-disclosure-checkbox" />
          <span>{tr(gatedPending ? 'documents.disclosureCheckboxGated' : 'documents.disclosureCheckbox')}</span>
        </label>
      </ConfirmDialog>
    </section>
  );
}
