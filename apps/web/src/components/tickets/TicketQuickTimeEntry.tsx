import { useEffect, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { usePermissions } from '../../lib/permissions';
import { runAction, handleActionError } from '../../lib/runAction';
import { broadcastBillingChanged } from '../../lib/timerActions';
import BillingOutcome, { type BillingOutcomeStamp } from '../time/BillingOutcome';
import WorkTypeSelect from '../shared/WorkTypeSelect';

export type QuickTimeDefaults = (BillingOutcomeStamp & { workTypeId?: string | null }) | null;

interface Props {
  ticketId: string;
  /** The ticket's billing defaults (rate, billable, work type) from
   *  GET /tickets/:id/billing-summary. `undefined` = load them here. */
  defaults?: QuickTimeDefaults;
  /** `ticket-billing-quick-add` in Time & billing; the composer uses its own. */
  testIdPrefix?: string;
  /** After the entry is saved (the host refreshes, closes). */
  onLogged: () => void | Promise<void>;
}

/**
 * Log time on a ticket: minutes, description, work type, rate, billable. The
 * one place the quick time entry is written (POST /time-entries), shared by
 * the Time & billing section and the composer's Log time.
 */
export default function TicketQuickTimeEntry({ ticketId, defaults: defaultsProp, testIdPrefix = 'ticket-billing-quick-add', onLogged }: Props) {
  const { t } = useTranslation('tickets');
  const { can } = usePermissions();
  const canManageBilling = can('time_entries', 'manage_billing');
  const [loadedDefaults, setLoadedDefaults] = useState<QuickTimeDefaults>(null);
  const defaults = defaultsProp === undefined ? loadedDefaults : defaultsProp;
  const [minutes, setMinutes] = useState('');
  const [description, setDescription] = useState('');
  const [billableOverride, setBillableOverride] = useState<boolean | undefined>(undefined);
  // THREE states, not two. `undefined` = the tech never touched the picker, so
  // omit the field and let the server apply the ticket category's default.
  // `null` = they explicitly chose "No work type", which must be SENT — sending
  // nothing would re-apply the category default and make that option
  // unreachable on any category that has one.
  const [workTypeId, setWorkTypeId] = useState<string | null | undefined>(undefined);
  // #5321: the rate box shows the ticket's resolved default until the tech
  // types over it, so a prefill still lands when the defaults resolve after
  // the form is already open.
  const [rate, setRate] = useState('');
  const [rateDirty, setRateDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = (part: string) => `${testIdPrefix}-${part}`;

  // Without a host-supplied summary (the composer), read the defaults once.
  useEffect(() => {
    if (defaultsProp !== undefined) return;
    let cancelled = false;
    void fetchWithAuth(`/tickets/${ticketId}/billing-summary`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (!cancelled) setLoadedDefaults((body?.data?.defaults as QuickTimeDefaults) ?? null); })
      .catch(() => { /* no prefill: the server applies its defaults */ });
    return () => { cancelled = true; };
  }, [defaultsProp, ticketId]);

  // Derived, not stored: an untouched box mirrors the ticket default the moment
  // the defaults land; once the tech types, their value wins.
  const billable = billableOverride ?? defaults?.isBillable ?? true;
  const workTypeChanged = workTypeId !== undefined && workTypeId !== (defaults?.workTypeId ?? null);
  const defaultRate = defaults?.hourlyRate ?? null;
  const rateCurrency = defaults?.currencyCode ?? null;
  const rateValue = rateDirty ? rate : (workTypeChanged ? '' : defaultRate ?? '');
  // `<input type="number" min={0}>` does not stop a typed negative here — the
  // submit is an onClick, not a form submit, so no constraint validation runs.
  // Name the problem rather than letting the button be a dead no-op.
  const typedRate = rateValue.trim();
  const parsedRate = typedRate === '' ? undefined : Math.round(Number(typedRate) * 100) / 100;
  const rateInvalid = parsedRate !== undefined && (!Number.isFinite(parsedRate) || parsedRate < 0);
  // Billable + no rate is precisely the row invoice assembly refuses to bill
  // (ALL_MISSING_RATE 409). Say it here, not three screens later. A bad rate is
  // a different complaint — never show both.
  const missingRate = !workTypeChanged && billable && typedRate === '' && defaults?.coverage !== 'included';

  const submit = async () => {
    const mins = Math.round(Number(minutes));
    if (!Number.isFinite(mins) || mins <= 0) return;
    // Blank stays blank: omit hourlyRate so the server's org/category default
    // still applies. A typed rate is sent at the minor-unit precision the API
    // validator accepts (multipleOf 0.01). An invalid one is already named
    // inline by `rateInvalid`, so returning here is not silent.
    if (rateInvalid) return;
    const rateNumber = parsedRate;
    setBusy(true);
    try {
      const end = new Date();
      const start = new Date(end.getTime() - mins * 60_000);
      await runAction({
        request: () =>
          fetchWithAuth('/time-entries', {
            method: 'POST',
            body: JSON.stringify({
              ticketId,
              startedAt: start.toISOString(),
              endedAt: end.toISOString(),
              description: description || undefined,
              ...(canManageBilling && billableOverride !== undefined ? { isBillable: billable } : {}),
              // Untouched (undefined) omits the field so the server-side
              // category default applies; an explicit "No work type" sends null.
              ...(workTypeId !== undefined ? { workTypeId } : {}),
              ...(canManageBilling && rateDirty && rateNumber !== undefined ? { hourlyRate: rateNumber } : {}),
            }),
          }),
        errorFallback: t('ticketTimeBilling.toast.logFailed'),
        successMessage: t('ticketTimeBilling.toast.logged'),
      });
      setWorkTypeId(undefined);
      setMinutes('');
      setDescription('');
      setRate('');
      setRateDirty(false);
      setBillableOverride(undefined);
      await onLogged();
      // Notify the focus view's feed (and other billing listeners) so the new
      // time-entry line appears without a manual reload — mirrors the timer
      // start/stop and parts-mutation paths.
      broadcastBillingChanged();
    } catch (err) {
      handleActionError(err, t('ticketTimeBilling.toast.logFailedSentence'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5" data-testid={testIdPrefix}>
      <input
        type="number"
        min={1}
        step={1}
        value={minutes}
        onChange={(e) => setMinutes(e.target.value)}
        placeholder={t('ticketTimeBilling.minutes')}
        aria-label={t('ticketTimeBilling.minutes')}
        className="w-full rounded-md border bg-background px-2 py-1 text-xs"
        data-testid={id('minutes')}
      />
      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={t('ticketTimeBilling.descriptionPlaceholder')}
        aria-label={t('common:labels.description')}
        className="w-full rounded-md border bg-background px-2 py-1 text-xs"
        data-testid={id('description')}
      />
      <p className="mt-1 text-xs text-muted-foreground" data-testid={testIdPrefix === 'ticket-billing-quick-add' ? 'time-entry-note-invoice-cue' : id('invoice-cue')}>
        {t('ticketTimeBilling.noteInvoiceCue')}
      </p>
      <label className="block text-xs text-muted-foreground">
        {t('workType.label')}
        <WorkTypeSelect value={workTypeId === undefined ? defaults?.workTypeId ?? null : workTypeId} onChange={setWorkTypeId} testId={id('work-type')} disabled={busy} />
      </label>
      <BillingOutcome stamp={defaults} overrides={canManageBilling ? { ...(billableOverride !== undefined ? { isBillable: billableOverride } : {}), ...(rateDirty && parsedRate !== undefined && !rateInvalid ? { hourlyRate: String(parsedRate) } : {}) } : undefined} pending={workTypeChanged} testId={id('outcome')} />
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          min={0}
          step={0.01}
          readOnly={!canManageBilling}
          value={rateValue}
          onChange={(e) => { setRate(e.target.value); setRateDirty(true); }}
          placeholder={t('ticketTimeBilling.rate')}
          aria-label={rateCurrency
            ? t('ticketTimeBilling.rateWithCurrency', { currency: rateCurrency })
            : t('ticketTimeBilling.rate')}
          className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-xs"
          data-testid={id('rate')}
        />
        {/* Persistent, not a placeholder: the box is prefilled in the common
            case, and a placeholder would hide the currency exactly then. */}
        {rateCurrency && (
          <span className="shrink-0 text-xs text-muted-foreground" data-testid={id('rate-currency')}>
            {rateCurrency}
          </span>
        )}
      </div>
      <label className="flex items-center gap-1.5 text-xs">
        <input
          type="checkbox"
          checked={billable}
          disabled={!canManageBilling}
          onChange={(e) => setBillableOverride(e.target.checked)}
          data-testid={id('billable')}
        />
        {t('ticketTimeBilling.billable')}
      </label>
      {rateInvalid && (
        <p className="text-xs text-destructive-ink" data-testid={id('rate-invalid')}>
          {t('ticketTimeBilling.rateInvalid')}
        </p>
      )}
      {missingRate && (
        <p className="text-xs text-warning-ink" data-testid={id('no-rate')}>
          {t('ticketTimeBilling.noRateWarning')}
        </p>
      )}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        className="w-full rounded-md bg-primary px-2 py-1 text-xs font-medium text-white disabled:opacity-50"
        data-testid={id('submit')}
      >
        {busy ? t('common:states.saving') : t('common:actions.save')}
      </button>
    </div>
  );
}
