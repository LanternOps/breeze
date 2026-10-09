import { useEffect, useState } from 'react';
import { AlertTriangle, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Dialog } from '../shared/Dialog';
import { showToast } from '../shared/Toast';
import { fetchWithAuth } from '../../stores/auth';
import { ActionError, runAction } from '../../lib/runAction';
import type { ReliabilityBaselineReason } from './ReliabilityBaselineSection';

export type ReliabilityBaselineDialogProps = {
  deviceId: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
};

const REASONS: ReliabilityBaselineReason[] = ['remediated', 'reimaged', 'hardware_replaced'];
// Mirrors the API's BASELINE_MAX_BACKDATE_DAYS.
const MAX_BACKDATE_DAYS = 30;
const MINUTE_MS = 60 * 1000;
const NOTE_MAX = 2000;

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DDTHH:mm` in the browser's local zone — what datetime-local reads and writes. */
function toLocalInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

type Bounds = { min: string; max: string };

function computeBounds(now: Date): Bounds {
  // Round the floor UP to the next whole minute: a picker value equal to `min`
  // must still be inside the server's 30-day window when it arrives.
  const oldest = new Date(now.getTime() - MAX_BACKDATE_DAYS * 24 * 60 * MINUTE_MS);
  const oldestCeil = new Date(Math.ceil(oldest.getTime() / MINUTE_MS) * MINUTE_MS);
  return { min: toLocalInputValue(oldestCeil), max: toLocalInputValue(now) };
}

export default function ReliabilityBaselineDialog({ deviceId, open, onClose, onSaved }: ReliabilityBaselineDialogProps) {
  const { t } = useTranslation('devices');
  const [reason, setReason] = useState<ReliabilityBaselineReason>('remediated');
  const [bounds, setBounds] = useState<Bounds>(() => computeBounds(new Date()));
  const [localValue, setLocalValue] = useState(() => bounds.max);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each open starts a fresh form whose window is anchored to "now".
  useEffect(() => {
    if (!open) return;
    const next = computeBounds(new Date());
    setBounds(next);
    setLocalValue(next.max);
    setReason('remediated');
    setNote('');
    setError(null);
    setSubmitting(false);
  }, [open]);

  const noteRequired = reason === 'remediated';
  const trimmedNote = note.trim();
  const whenValid = localValue !== '' && !Number.isNaN(new Date(localValue).getTime());
  const canSave = !submitting && whenValid && !(noteRequired && trimmedNote === '');

  const submit = async () => {
    if (!canSave) return;
    setSubmitting(true);
    setError(null);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/reliability/${deviceId}/baselines`, {
            method: 'POST',
            body: JSON.stringify({
              reason,
              baselineAt: new Date(localValue).toISOString(),
              note: trimmedNote || undefined,
            }),
          }),
        errorFallback: t('deviceReliabilityPanel.baseline.saveError'),
        friendly: (code) =>
          code === 'baseline_too_old'
            ? t('deviceReliabilityPanel.baseline.tooOld')
            : code === 'baseline_in_future'
              ? t('deviceReliabilityPanel.baseline.inFuture')
              : code === 'note_required'
                ? t('deviceReliabilityPanel.baseline.noteRequired')
                : undefined,
        successMessage: t('deviceReliabilityPanel.baseline.saved'),
      });
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // the auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('deviceReliabilityPanel.baseline.saveError') });
        return;
      }
      // runAction already toasted, but the toast sits beneath this dialog's
      // backdrop (#2429) — repeat the reason inline so the form keeps the
      // user's input and the failure is readable.
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const title = t('deviceReliabilityPanel.baseline.dialogTitle');

  return (
    <Dialog open={open} onClose={onClose} title={title} maxWidth="lg" className="p-6">
      <div className="flex gap-4">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
          <Wrench className="h-5 w-5 text-primary" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t('deviceReliabilityPanel.baseline.dialogDescription')}</p>
        </div>
      </div>

      <div className="mt-6 space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="baseline-reason">
            {t('deviceReliabilityPanel.baseline.reasonLabel')}
          </label>
          <select
            id="baseline-reason"
            data-testid="baseline-reason"
            value={reason}
            onChange={(e) => { setReason(e.target.value as ReliabilityBaselineReason); setError(null); }}
            disabled={submitting}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            {REASONS.map((value) => (
              <option key={value} value={value}>
                {t(/* i18n-dynamic */ `deviceReliabilityPanel.baseline.reasons.${value}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="baseline-at">
            {t('deviceReliabilityPanel.baseline.whenLabel')}
          </label>
          <input
            id="baseline-at"
            data-testid="baseline-at"
            type="datetime-local"
            value={localValue}
            min={bounds.min}
            max={bounds.max}
            onChange={(e) => { setLocalValue(e.target.value); setError(null); }}
            disabled={submitting}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="baseline-note">
            {t('deviceReliabilityPanel.baseline.noteLabel')}
            {noteRequired && <span className="text-destructive" aria-hidden="true"> *</span>}
          </label>
          <textarea
            id="baseline-note"
            data-testid="baseline-note"
            value={note}
            maxLength={NOTE_MAX}
            rows={3}
            required={noteRequired}
            aria-describedby={noteRequired ? 'baseline-note-hint' : undefined}
            onChange={(e) => { setNote(e.target.value); setError(null); }}
            disabled={submitting}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          {noteRequired && (
            <p id="baseline-note-hint" className="text-xs text-muted-foreground">
              {t('deviceReliabilityPanel.baseline.noteRequiredHint')}
            </p>
          )}
        </div>
      </div>

      {error != null && (
        <p className="mt-4 flex items-start gap-2 text-sm text-destructive" role="alert" data-testid="baseline-error">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          data-testid="baseline-cancel"
          className="rounded-md border px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {t('common:actions.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canSave}
          data-testid="baseline-save"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {t('deviceReliabilityPanel.baseline.save')}
        </button>
      </div>
    </Dialog>
  );
}
