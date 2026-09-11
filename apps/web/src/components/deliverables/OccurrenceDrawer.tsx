import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { DeliverOccurrenceInput } from '@breeze/shared';
import {
  deliverOccurrence,
  listOccurrences,
  removeEvidence,
  uploadEvidence,
  reopenOccurrence,
  rescheduleOccurrence,
  waiveOccurrence,
  type Deliverable,
  type Fetcher,
  type Occurrence,
  type OccurrenceEvidence,
  type OccurrenceStatus,
} from '../../lib/api/serviceDeliverables';
import { ActionError, handleActionError } from '../../lib/runAction';
import { formatDate } from '../billing/shared/format';
import { Drawer } from '../shared/Drawer';
import { runClientAction } from '../../lib/runClientAction';

export interface OccurrenceDrawerProps {
  fetcher: Fetcher;
  orgId: string;
  deliverable: Deliverable;
  onClose: () => void;
  /** Fired after any occurrence changed, so the parent table can refresh its
   *  derived status / next-due columns. */
  onChanged?: () => void;
}

type ActionKind = 'deliver' | 'waive' | 'reschedule';

// Mirrors the API state machine (serviceDeliverableState.ts): deliver/waive
// need an ACTIVE occurrence, reopen a terminal one, reschedule any non-terminal.
const CAN_DELIVER_OR_WAIVE: ReadonlySet<OccurrenceStatus> = new Set(['open', 'awaiting_evidence', 'missed']);
const CAN_REOPEN: ReadonlySet<OccurrenceStatus> = new Set(['delivered', 'waived']);
const CAN_RESCHEDULE: ReadonlySet<OccurrenceStatus> = new Set(['scheduled', 'open', 'awaiting_evidence', 'missed']);

const STATUS_PILL: Record<OccurrenceStatus, string> = {
  scheduled: 'bg-muted text-muted-foreground',
  open: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
  awaiting_evidence: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  delivered: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  missed: 'bg-destructive/10 text-destructive',
  waived: 'bg-muted text-muted-foreground',
};

const LATE_PILL = 'inline-flex items-center rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive';
const ACTION_BTN = 'rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted disabled:opacity-50';
const INPUT = 'w-full rounded-md border bg-background px-2 py-1.5 text-sm';

/** Upload failures the document service can answer with; anything else falls
 *  back to the generic message. */
const UPLOAD_ERROR_KEYS: Record<string, string> = {
  FILE_TOO_LARGE: 'errors.tooLarge',
  UNSUPPORTED_DOCUMENT_TYPE: 'errors.unsupportedType',
  STORAGE_UNAVAILABLE: 'errors.storageUnavailable',
};

function isEvidenceRequired(err: unknown): boolean {
  if (!(err instanceof ActionError)) return false;
  if (err.code === 'EVIDENCE_REQUIRED') return true;
  const body = err.body as { code?: unknown } | undefined;
  return Boolean(body && typeof body === 'object' && body.code === 'EVIDENCE_REQUIRED');
}

function evidenceRef(ev: OccurrenceEvidence): string {
  const raw = ev.kind === 'document' ? ev.documentId : ev.reportRunId;
  return raw ? raw.slice(0, 8) : ev.id.slice(0, 8);
}

export default function OccurrenceDrawer({ fetcher, orgId, deliverable, onClose, onChanged }: OccurrenceDrawerProps) {
  const { t } = useTranslation('deliverables');
  const uid = useId();
  const [rows, setRows] = useState<Occurrence[]>([]);
  const [evidenceFiles, setEvidenceFiles] = useState<Record<string, File | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<{ id: string; kind: ActionKind } | null>(null);
  const [note, setNote] = useState('');
  const [reportRunId, setReportRunId] = useState('');
  const [reason, setReason] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await listOccurrences(fetcher, orgId, deliverable.id, 24);
        if (!cancelled) setRows(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error && err.message ? err.message : t('errors.loadFailed'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetcher, orgId, deliverable.id, t]);

  const openAction = (id: string, kind: ActionKind, current?: Occurrence) => {
    setAction({ id, kind });
    setInlineError(null);
    setNote('');
    setReportRunId('');
    setReason('');
    setDueAt(current?.dueAt ?? '');
  };

  const closeAction = () => {
    setAction(null);
    setInlineError(null);
  };

  const applyResult = (next: Occurrence) => {
    setRows((prev) => prev.map((r) => (r.id === next.id ? next : r)));
    onChanged?.();
  };

  const run = async (label: string, work: () => Promise<Occurrence>) => {
    if (busy) return;
    setBusy(true);
    setInlineError(null);
    try {
      const next = await runClientAction(work, { errorFallback: t('errors.actionFailed'), successMessage: label });
      applyResult(next);
      closeAction();
    } catch (err) {
      if (isEvidenceRequired(err)) setInlineError(t('errors.evidenceRequired'));
      handleActionError(err, t('errors.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  const submitAction = () => {
    if (!action) return;
    const { id, kind } = action;
    if (kind === 'deliver') {
      const trimmedRun = reportRunId.trim();
      const body: DeliverOccurrenceInput = {
        note: note.trim() ? note.trim() : undefined,
        ...(trimmedRun ? { evidence: [{ kind: 'report_run' as const, reportRunId: trimmedRun }] } : {}),
      };
      void run(t('toast.delivered'), () => deliverOccurrence(fetcher, orgId, id, body));
    } else if (kind === 'waive') {
      const trimmed = reason.trim();
      if (!trimmed) return;
      void run(t('toast.waived'), () => waiveOccurrence(fetcher, orgId, id, { reason: trimmed }));
    } else {
      if (!dueAt) return;
      void run(t('toast.rescheduled'), () => rescheduleOccurrence(fetcher, orgId, id, { dueAt }));
    }
  };

  /** Spec §7 upload-on-deliver: the file becomes an `evidence`-category
   *  document in this org's library (inheriting the deliverable's portal flag)
   *  and is linked to the occurrence in one request. */
  const uploadEvidenceFile = async (id: string) => {
    const file = evidenceFiles[id];
    if (!file || busy) return;
    const form = new FormData();
    form.append('file', file);
    form.append('title', file.name);
    setBusy(true);
    setInlineError(null);
    try {
      const next = await runClientAction(() => uploadEvidence(fetcher, orgId, id, form), {
        errorFallback: t('errors.uploadFailed'),
        successMessage: t('toast.evidenceUploaded'),
        friendly: (code) => (UPLOAD_ERROR_KEYS[code] ? t(/* i18n-dynamic */ UPLOAD_ERROR_KEYS[code]) : undefined),
      });
      applyResult(next);
      setEvidenceFiles((prev) => ({ ...prev, [id]: null }));
    } catch (err) {
      handleActionError(err, t('errors.uploadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const reopen = (id: string) => void run(t('toast.reopened'), () => reopenOccurrence(fetcher, orgId, id));
  const remove = (id: string, evidenceId: string) =>
    void run(t('toast.evidenceRemoved'), () => removeEvidence(fetcher, orgId, id, evidenceId));

  const saveDisabled =
    busy ||
    !action ||
    (action.kind === 'waive' && !reason.trim()) ||
    (action.kind === 'reschedule' && !dueAt);

  return (
    <Drawer
      open
      onClose={onClose}
      title={`${deliverable.name} — ${t('drawer.title')}`}
      width="max-w-xl"
      dataTestId="occurrence-drawer"
      closeDisabled={busy}
    >
      {loading ? (
        <div className="flex items-center justify-center py-8" data-testid="occurrence-drawer-loading">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      ) : error ? (
        <div className="px-3 py-6 text-center text-sm text-destructive" data-testid="occurrence-drawer-error">
          {error}
        </div>
      ) : (
        <ul className="divide-y" data-testid="occurrence-list">
          {rows.map((occ) => {
            const active = action?.id === occ.id ? action : null;
            const rescheduled = occ.originalDueAt !== occ.dueAt;
            return (
              <li key={occ.id} className="space-y-2 px-1 py-3" data-testid={`occurrence-row-${occ.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <div className="font-medium">
                      {formatDate(occ.periodStart)} – {formatDate(occ.periodEnd)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t('table.nextDue')}: {formatDate(occ.dueAt)}
                      {rescheduled && (
                        <span className="ml-1">({t('drawer.rescheduledFrom', { date: formatDate(occ.originalDueAt) })})</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {occ.late && <span className={LATE_PILL}>{t('drawer.late')}</span>}
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_PILL[occ.status]}`}
                      data-testid={`occurrence-status-${occ.id}`}
                    >
                      {t(/* i18n-dynamic */ `occurrence.status.${occ.status}`)}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">{t('drawer.evidence')}:</span>
                  {occ.evidence.length === 0 ? (
                    <span className="text-muted-foreground">{t('drawer.noEvidence')}</span>
                  ) : (
                    occ.evidence.map((ev) => (
                      <span
                        key={ev.id}
                        className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary"
                        data-testid={`evidence-chip-${ev.id}`}
                      >
                        {ev.kind === 'document' ? t('evidence.document') : t('evidence.reportRun')}
                        <span className="font-mono">{evidenceRef(ev)}</span>
                        <button
                          type="button"
                          onClick={() => remove(occ.id, ev.id)}
                          disabled={busy}
                          aria-label={t('actions.removeEvidence')}
                          className="ml-0.5 rounded-full px-1 leading-none hover:bg-primary/20 disabled:opacity-50"
                          data-testid={`evidence-remove-${ev.id}`}
                        >
                          ×
                        </button>
                      </span>
                    ))
                  )}
                </div>

                {occ.status !== 'waived' && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <label className="sr-only" htmlFor={`${uid}-evidence-file-${occ.id}`}>
                      {t('drawer.uploadEvidence')}
                    </label>
                    <input
                      id={`${uid}-evidence-file-${occ.id}`}
                      type="file"
                      accept="application/pdf,image/jpeg,image/png,image/webp"
                      className="max-w-[16rem] text-xs"
                      data-testid={`occurrence-evidence-file-${occ.id}`}
                      onChange={(e) =>
                        setEvidenceFiles((prev) => ({ ...prev, [occ.id]: e.target.files?.[0] ?? null }))}
                    />
                    <button
                      type="button"
                      onClick={() => void uploadEvidenceFile(occ.id)}
                      disabled={busy || !evidenceFiles[occ.id]}
                      className={ACTION_BTN}
                      data-testid={`occurrence-evidence-upload-${occ.id}`}
                    >
                      {t('drawer.upload')}
                    </button>
                    <span className="text-muted-foreground">{t('drawer.uploadEvidenceHint')}</span>
                  </div>
                )}

                {occ.deliveryNote && <p className="text-xs text-muted-foreground">{occ.deliveryNote}</p>}
                {occ.waivedReason && <p className="text-xs text-muted-foreground">{occ.waivedReason}</p>}

                {!active && (
                  <div className="flex flex-wrap gap-1.5">
                    {CAN_DELIVER_OR_WAIVE.has(occ.status) && (
                      <button
                        type="button"
                        onClick={() => openAction(occ.id, 'deliver', occ)}
                        disabled={busy}
                        className={ACTION_BTN}
                        data-testid={`occurrence-deliver-${occ.id}`}
                      >
                        {t('actions.deliver')}
                      </button>
                    )}
                    {CAN_DELIVER_OR_WAIVE.has(occ.status) && (
                      <button
                        type="button"
                        onClick={() => openAction(occ.id, 'waive', occ)}
                        disabled={busy}
                        className={ACTION_BTN}
                        data-testid={`occurrence-waive-${occ.id}`}
                      >
                        {t('actions.waive')}
                      </button>
                    )}
                    {CAN_REOPEN.has(occ.status) && (
                      <button
                        type="button"
                        onClick={() => reopen(occ.id)}
                        disabled={busy}
                        className={ACTION_BTN}
                        data-testid={`occurrence-reopen-${occ.id}`}
                      >
                        {t('actions.reopen')}
                      </button>
                    )}
                    {CAN_RESCHEDULE.has(occ.status) && (
                      <button
                        type="button"
                        onClick={() => openAction(occ.id, 'reschedule', occ)}
                        disabled={busy}
                        className={ACTION_BTN}
                        data-testid={`occurrence-reschedule-${occ.id}`}
                      >
                        {t('actions.reschedule')}
                      </button>
                    )}
                  </div>
                )}

                {active && (
                  <div className="space-y-2 rounded-lg border bg-muted/30 p-3" data-testid={`occurrence-action-${occ.id}`}>
                    {active.kind === 'deliver' && (
                      <>
                        <div>
                          <label htmlFor={`${uid}-note`} className="block text-xs font-medium text-muted-foreground">
                            {t('drawer.deliveryNote')}
                          </label>
                          <textarea
                            id={`${uid}-note`}
                            rows={2}
                            className={INPUT}
                            value={note}
                            onChange={(e) => setNote(e.target.value)}
                            maxLength={4000}
                          />
                        </div>
                        <div>
                          <label htmlFor={`${uid}-run`} className="block text-xs font-medium text-muted-foreground">
                            {t('evidence.reportRunId')}
                          </label>
                          <input
                            id={`${uid}-run`}
                            className={INPUT}
                            value={reportRunId}
                            onChange={(e) => setReportRunId(e.target.value)}
                            placeholder="00000000-0000-0000-0000-000000000000"
                          />
                        </div>
                      </>
                    )}
                    {active.kind === 'waive' && (
                      <div>
                        <label htmlFor={`${uid}-reason`} className="block text-xs font-medium text-muted-foreground">
                          {t('drawer.waivedReason')}
                        </label>
                        <textarea
                          id={`${uid}-reason`}
                          rows={2}
                          className={INPUT}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          maxLength={2000}
                        />
                      </div>
                    )}
                    {active.kind === 'reschedule' && (
                      <div>
                        <label htmlFor={`${uid}-due`} className="block text-xs font-medium text-muted-foreground">
                          {t('drawer.newDueDate')}
                        </label>
                        <input
                          id={`${uid}-due`}
                          type="date"
                          className={INPUT}
                          value={dueAt}
                          onChange={(e) => setDueAt(e.target.value)}
                        />
                      </div>
                    )}
                    {inlineError && (
                      <p className="text-sm text-destructive" role="alert" data-testid="occurrence-action-error">
                        {inlineError}
                      </p>
                    )}
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={closeAction}
                        disabled={busy}
                        className={ACTION_BTN}
                        data-testid="occurrence-action-cancel"
                      >
                        {t('actions.cancel')}
                      </button>
                      <button
                        type="button"
                        onClick={submitAction}
                        disabled={saveDisabled}
                        className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        data-testid="occurrence-action-save"
                      >
                        {t('actions.save')}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}
