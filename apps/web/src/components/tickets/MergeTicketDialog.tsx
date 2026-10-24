import { useCallback, useEffect, useRef, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { Dialog } from '../shared/Dialog';
import { showToast } from '../shared/Toast';
import { ticketDisplayNumber, type TicketStatus } from './ticketConfig';

// Merge this ticket (the source) into another open ticket of the same org (the
// survivor), #8972 / spec §3.4. The preview is advisory; POST /merge
// revalidates under locks and is irreversible (D4), so the warning is visible
// text here rather than a second dialog.

/** The source ticket fields the dialog reads (a subset of TicketDetail). */
export interface MergeSource {
  id: string;
  internalNumber: string | null;
  ticketNumber?: string | null;
  orgId: string;
  deviceId: string | null;
  deviceHostname: string | null;
  submittedBy: string | null;
  submitterName: string | null;
  submitterEmail: string | null;
}

interface Candidate {
  id: string;
  internalNumber: string | null;
  subject: string;
  status: TicketStatus;
  statusName?: string | null;
  createdAt: string;
  deviceId: string | null;
  deviceHostname: string | null;
}

// Mirrors MergePreview (apps/api/src/services/ticketMerge/preview.ts).
type DroppedReason = 'between_pair' | 'pair_unique' | 'self' | 'canonical_duplicate' | 'cycle' | 'limit';
interface MergePreview {
  eligible: boolean;
  refusals: Array<{ code: string; side: 'source' | 'survivor' | 'both'; message: string }>;
  counts: Record<string, number>;
  droppedLinks: Array<{ linkId: string; linkType: string; otherTicketId: string; reason: DroppedReason }>;
  retainedExternalRefs: Array<{ id: string; principalName: string | null }>;
  deviceDifference: { source: string | null; survivor: string | null; result: string | null };
  requestersDiffer: boolean;
  sourceRequesterGainsAccess: boolean;
  suggestedSurvivorId: string;
}

interface MergeResult { data: { survivorId: string } }

// Every MERGED_TABLES key (apps/api/src/services/ticketMerge), in display order.
const COUNT_TABLES = [
  'ticket_comments', 'time_entries', 'ticket_parts', 'ticket_alert_links', 'ticket_attachments',
  'ticket_email_links', 'ticket_checklist_items', 'ticket_external_refs', 'ticket_links',
  'device_vulnerabilities', 'organization_key_dates', 'service_deliverable_occurrences',
  'ai_operator_task_targets', 'ticket_drafts',
] as const;

// MergeRefusalCode (apps/api/src/services/ticketMerge/errors.ts). An unknown
// code renders the server's message instead.
const REFUSAL_CODES = new Set([
  'MERGE_SAME_TICKET', 'MERGE_CROSS_ORG', 'MERGE_SOURCE_INELIGIBLE', 'MERGE_SURVIVOR_INELIGIBLE',
  'MERGE_DELIVERABLE_PINNED', 'MERGE_IMPORT_WINDOW', 'MERGE_APPROVAL_STATE', 'MERGE_WORK_KIND_MISMATCH',
  'MERGE_PENDING_INTENTS', 'ORG_MERGING', 'MERGE_SCOPE_DENIED',
]);

const DROPPED_REASONS = new Set<string>(['between_pair', 'pair_unique', 'self', 'canonical_duplicate', 'cycle', 'limit']);

const SEARCH_DEBOUNCE_MS = 250;
const TITLE_ID = 'ticket-merge-title';

interface Props {
  open: boolean;
  source: MergeSource;
  onClose: () => void;
  onMerged: (survivor: { id: string; internalNumber: string | null }) => void;
}

export default function MergeTicketDialog({ open, source, onClose, onMerged }: Props) {
  const { t } = useTranslation('tickets');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesFailed, setCandidatesFailed] = useState(false);
  const [target, setTarget] = useState<Candidate | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [notify, setNotify] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Guards a slow preview for an earlier target from landing over a newer one.
  const previewSeq = useRef(0);

  const sourceNumber = ticketDisplayNumber(source);
  const hasRequester = Boolean(source.submittedBy || source.submitterEmail);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const params = new URLSearchParams({ orgId: source.orgId, statusGroup: 'open', sort: 'oldest', limit: '100' });
    if (debouncedSearch) params.set('search', debouncedSearch);
    setCandidatesLoading(true);
    setCandidatesFailed(false);
    void (async () => {
      try {
        const res = await fetchWithAuth(`/tickets?${params.toString()}`);
        if (cancelled) return;
        if (res.status === 401) { void navigateTo(loginPathWithNext(), { replace: true }); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data?: Candidate[] };
        if (cancelled) return;
        const rows = (body.data ?? [])
          .filter((r) => r.id !== source.id)
          // The API sorts oldest first; keep it stable client-side too (D5).
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        setCandidates(rows);
      } catch (err) {
        if (cancelled) return;
        console.warn('[MergeTicketDialog] candidate list failed', err);
        setCandidates([]);
        setCandidatesFailed(true);
      } finally {
        if (!cancelled) setCandidatesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, source.id, source.orgId, debouncedSearch]);

  // `keepNotify`: a re-check of the SAME target (after a refused confirm) keeps
  // the user's notify choice; only a new target re-defaults it.
  const loadPreview = useCallback(async (into: Candidate, opts: { keepNotify?: boolean } = {}) => {
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    setPreviewFailed(false);
    try {
      const res = await fetchWithAuth(`/tickets/${source.id}/merge-preview?into=${encodeURIComponent(into.id)}`);
      if (seq !== previewSeq.current) return;
      if (res.status === 401) { void navigateTo(loginPathWithNext(), { replace: true }); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: MergePreview };
      if (seq !== previewSeq.current) return;
      if (!body.data) throw new Error('empty preview');
      setPreview(body.data);
      // D6: default on when the requesters differ; re-defaulted per target.
      if (!opts.keepNotify) setNotify(hasRequester && body.data.requestersDiffer);
    } catch (err) {
      if (seq !== previewSeq.current) return;
      console.warn('[MergeTicketDialog] preview failed', err);
      setPreview(null);
      setPreviewFailed(true);
    } finally {
      if (seq === previewSeq.current) setPreviewLoading(false);
    }
  }, [source.id, hasRequester]);

  const choose = (c: Candidate) => {
    setTarget(c);
    setPreview(null);
    void loadPreview(c);
  };

  const targetNumber = target ? ticketDisplayNumber(target) : '';

  const refusalCopy = (r: MergePreview['refusals'][number]) =>
    REFUSAL_CODES.has(r.code) ? t(/* i18n-dynamic */ `ticketWorkbench.merge.refusal.${r.code}`) : r.message;

  const confirm = async () => {
    if (!target || !preview?.eligible || submitting) return;
    setSubmitting(true);
    let result: MergeResult;
    try {
      result = await runAction<MergeResult>({
        request: () => fetchWithAuth(`/tickets/${source.id}/merge`, {
          method: 'POST',
          body: JSON.stringify({ intoTicketId: target.id, notifyRequester: notify }),
        }),
        errorFallback: t('ticketWorkbench.merge.failed'),
        successMessage: t('ticketWorkbench.merge.merged', { number: targetNumber }),
        friendly: (code) => {
          if (code === 'MFA_REQUIRED') return t('ticketWorkbench.merge.mfaRequired');
          if (code === 'TICKET_MERGED') return t('ticketWorkbench.merge.alreadyMerged');
          if (code === 'CONCURRENT_MODIFICATION') return t('ticketWorkbench.merge.retry');
          if (REFUSAL_CODES.has(code)) return t(/* i18n-dynamic */ `ticketWorkbench.merge.refusal.${code}`);
          return undefined;
        },
        onUnauthorized: () => void navigateTo(loginPathWithNext(), { replace: true }),
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('ticketWorkbench.merge.failed') });
        return;
      }
      // Already toasted. Stay open and refresh the preview so a refusal that
      // arose since the preview (a closed target, a new approval) shows inline.
      void loadPreview(target, { keepNotify: true });
      return;
    } finally {
      setSubmitting(false);
    }
    // Outside the try: the merge has happened, so a throw in the host's
    // handler must not surface as "Merge failed".
    const survivorId = result?.data?.survivorId ?? target.id;
    onMerged({ id: survivorId, internalNumber: survivorId === target.id ? target.internalNumber : null });
  };

  const hostnameFor = (deviceId: string | null): string => {
    if (!deviceId) return t('ticketWorkbench.merge.device.unknown');
    if (deviceId === source.deviceId && source.deviceHostname) return source.deviceHostname;
    if (target && deviceId === target.deviceId && target.deviceHostname) return target.deviceHostname;
    return t('ticketWorkbench.merge.device.unknown');
  };

  const sideLabel = (side: string) =>
    side === 'source' ? t('ticketWorkbench.merge.side.source')
      : side === 'survivor' ? t('ticketWorkbench.merge.side.survivor')
        : t('ticketWorkbench.merge.side.both');

  const nonZeroCounts = preview ? COUNT_TABLES.filter((k) => (preview.counts[k] ?? 0) > 0) : [];
  const device = preview?.deviceDifference;
  const showDevice = Boolean(device && device.source !== device.survivor);
  const suggestedNumber = preview && target && preview.suggestedSurvivorId !== target.id
    ? (preview.suggestedSurvivorId === source.id
      ? sourceNumber
      : ticketDisplayNumber(candidates.find((c) => c.id === preview.suggestedSurvivorId) ?? { id: preview.suggestedSurvivorId, internalNumber: null }))
    : null;
  const canConfirm = Boolean(target && preview?.eligible && !previewLoading && !submitting);

  return (
    <Dialog
      open={open}
      onClose={submitting ? () => {} : onClose}
      title={t('ticketWorkbench.merge.title', { number: sourceNumber })}
      labelledBy={TITLE_ID}
      maxWidth="lg"
      alignTop
      className="p-6"
    >
      <div data-testid="ticket-merge-dialog">
        <h2 id={TITLE_ID} className="text-lg font-semibold">{t('ticketWorkbench.merge.title', { number: sourceNumber })}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('ticketWorkbench.merge.description', { number: sourceNumber })}</p>

        <div className="mt-4" data-testid="ticket-merge-picker">
          <label htmlFor="ticket-merge-search" className="text-sm font-medium">{t('ticketWorkbench.merge.pickerLabel')}</label>
          <input
            id="ticket-merge-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={200}
            placeholder={t('ticketWorkbench.merge.searchPlaceholder')}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="ticket-merge-search"
          />
          <ul className="mt-2 max-h-56 divide-y overflow-y-auto rounded-md border" aria-label={t('ticketWorkbench.merge.pickerLabel')}>
            {candidatesLoading && candidates.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground" data-testid="ticket-merge-picker-loading">{t('ticketWorkbench.merge.loading')}</li>
            ) : candidatesFailed ? (
              <li className="px-3 py-2 text-sm text-destructive" data-testid="ticket-merge-picker-error">{t('ticketWorkbench.merge.candidatesFailed')}</li>
            ) : candidates.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground" data-testid="ticket-merge-picker-empty">{t('ticketWorkbench.merge.noCandidates')}</li>
            ) : candidates.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => choose(c)}
                  disabled={submitting}
                  aria-pressed={target?.id === c.id}
                  className={cn('flex w-full items-baseline gap-2 px-3 py-2 text-left text-sm hover:bg-muted', target?.id === c.id && 'bg-primary/10')}
                  data-testid={`ticket-merge-option-${c.id}`}
                >
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{ticketDisplayNumber(c)}</span>
                  <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{c.statusName || t(/* i18n-dynamic */ `ticketWorkbench.status.${c.status}`)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(c.createdAt, { year: 'numeric', month: 'short', day: 'numeric' })}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-muted-foreground">{t('ticketWorkbench.merge.pickerHint')}</p>
        </div>

        {target && previewLoading && !preview && (
          <p className="mt-4 text-sm text-muted-foreground" data-testid="ticket-merge-preview-loading">{t('ticketWorkbench.merge.previewLoading')}</p>
        )}
        {target && previewFailed && (
          <p className="mt-4 text-sm text-destructive" role="alert" data-testid="ticket-merge-preview-error">{t('ticketWorkbench.merge.previewFailed')}</p>
        )}

        {target && preview && (
          <div className="mt-4 space-y-3 rounded-md border bg-muted/30 p-3 text-sm" data-testid="ticket-merge-preview" aria-busy={previewLoading || undefined}>
            {preview.refusals.length > 0 && (
              <ul className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive" role="alert">
                {preview.refusals.map((r) => (
                  <li key={`${r.code}-${r.side}`} data-testid={`ticket-merge-refusal-${r.code}`}>
                    <span className="font-medium">{sideLabel(r.side)}:</span> {refusalCopy(r)}
                  </li>
                ))}
              </ul>
            )}
            {suggestedNumber && (
              <p className="text-xs text-warning" data-testid="ticket-merge-suggested">{t('ticketWorkbench.merge.suggested', { number: suggestedNumber })}</p>
            )}
            <div>
              <p className="font-medium">{t('ticketWorkbench.merge.movesTo', { number: targetNumber })}</p>
              {nonZeroCounts.length === 0 ? (
                <p className="text-muted-foreground" data-testid="ticket-merge-nothing-moves">{t('ticketWorkbench.merge.nothingMoves')}</p>
              ) : (
                <ul className="mt-1 list-disc pl-5">
                  {nonZeroCounts.map((k) => (
                    <li key={k} data-testid={`ticket-merge-count-${k}`}>
                      {t(/* i18n-dynamic */ `ticketWorkbench.merge.counts.${k}`, { count: preview.counts[k] })}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {preview.droppedLinks.length > 0 && (
              <div>
                <p className="font-medium">{t('ticketWorkbench.merge.droppedHeading')}</p>
                <ul className="mt-1 list-disc pl-5">
                  {preview.droppedLinks.map((l) => (
                    <li key={l.linkId} data-testid={`ticket-merge-dropped-${l.linkId}`}>
                      {DROPPED_REASONS.has(l.reason)
                        ? t(/* i18n-dynamic */ `ticketWorkbench.merge.dropped.${l.reason}`)
                        : l.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {preview.retainedExternalRefs.length > 0 && (
              <ul className="list-disc pl-5">
                {preview.retainedExternalRefs.map((r) => (
                  <li key={r.id} data-testid={`ticket-merge-retained-${r.id}`}>
                    {t('ticketWorkbench.merge.retained', { number: sourceNumber, name: r.principalName ?? t('ticketWorkbench.merge.anIntegration') })}
                  </li>
                ))}
              </ul>
            )}
            {showDevice && device && (
              <p data-testid="ticket-merge-device">
                {device.result && device.result === device.survivor
                  ? t('ticketWorkbench.merge.device.keeps', { device: hostnameFor(device.survivor) })
                  : t('ticketWorkbench.merge.device.takes', { device: hostnameFor(device.result ?? device.source) })}
              </p>
            )}
            {preview.sourceRequesterGainsAccess && (
              <p data-testid="ticket-merge-requester-access">
                {t('ticketWorkbench.merge.requesterAccess', { source: sourceNumber, survivor: targetNumber })}
              </p>
            )}
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={notify}
                disabled={!hasRequester || submitting}
                onChange={(e) => setNotify(e.target.checked)}
                data-testid="ticket-merge-notify"
              />
              <span>{t('ticketWorkbench.merge.notify', { number: sourceNumber })}</span>
            </label>
            {!hasRequester && (
              <p className="text-xs text-muted-foreground" data-testid="ticket-merge-no-requester">{t('ticketWorkbench.merge.noRequester', { number: sourceNumber })}</p>
            )}
            <p className="font-medium text-destructive" data-testid="ticket-merge-warning">
              {t('ticketWorkbench.merge.warning', { source: sourceNumber, survivor: targetNumber })}
            </p>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            data-testid="ticket-merge-cancel"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!canConfirm}
            className="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground disabled:opacity-50"
            data-testid="ticket-merge-confirm"
          >
            {submitting ? t('ticketWorkbench.merge.merging') : t('ticketWorkbench.merge.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
