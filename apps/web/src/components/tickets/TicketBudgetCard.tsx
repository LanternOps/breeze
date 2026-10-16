import { useEffect, useState } from 'react';
import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { usePermissions } from '../../lib/permissions';
import { runAction, handleActionError } from '../../lib/runAction';
import { approvalFriendly, type ApprovalSummary, type ApprovalTrigger } from '../../lib/ticketApproval';
import { formatMinutes } from '../../lib/timeFormat';
import { formatMoney } from '../billing/shared/format';

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const hoursText = (minutes: number | null) => (minutes == null ? '' : String(+(minutes / 60).toFixed(2)));

interface BarProps {
  testId: string;
  label: string;
  ceiling: number;
  consumed: number;
  held: number;
  usedText: string;
  heldText: string;
}

/** Consumed and held are separate segments so held time is never mistaken for billed. */
function UsageBar({ testId, label, ceiling, consumed, held, usedText, heldText }: BarProps) {
  const denom = Math.max(ceiling, consumed + held, 1);
  const over = consumed + held > ceiling;
  return (
    <div className="mt-1.5">
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={label}
        data-testid={testId}
      >
        <div
          className={over ? 'bg-red-500' : 'bg-primary'}
          style={{ width: `${(consumed * 100) / denom}%` }}
          data-testid={`${testId}-consumed`}
        />
        <div
          className="bg-amber-400"
          style={{ width: `${(held * 100) / denom}%` }}
          data-testid={`${testId}-held`}
        />
      </div>
      <p className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
        <span>{usedText}</span>
        {held > 0 && <span className="text-amber-700">{heldText}</span>}
      </p>
    </div>
  );
}

interface Props {
  ticketId: string;
  summary: ApprovalSummary | null;
  /** Called after any mutation so the host reloads the summary and the time list. */
  onChanged: () => void;
}

export default function TicketBudgetCard({ ticketId, summary, onChanged }: Props) {
  const { t } = useTranslation('tickets');
  const { can } = usePermissions();
  const canWrite = can('tickets', 'write');

  const initialHours = hoursText(summary?.budget.minutes ?? null);
  const initialAmount = summary?.budget.amount ?? '';
  const [hours, setHours] = useState(initialHours);
  const [amount, setAmount] = useState(initialAmount);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [requestOpen, setRequestOpen] = useState(false);
  const [trigger, setTrigger] = useState<ApprovalTrigger>('budget');
  const [extMinutes, setExtMinutes] = useState('');
  const [extAmount, setExtAmount] = useState('');
  const [windowStart, setWindowStart] = useState('');
  const [windowEnd, setWindowEnd] = useState('');
  const [message, setMessage] = useState('');
  const [requestError, setRequestError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Follow the server: after a save or a reload the inputs show what is stored.
  useEffect(() => { setHours(initialHours); setAmount(initialAmount); setBudgetError(null); }, [initialHours, initialAmount, ticketId]);
  useEffect(() => { setRequestOpen(false); }, [ticketId]);

  if (!summary) return null;
  const hasBudget = summary.budget.minutes != null || summary.budget.amount != null;
  if (!summary.policy.enabled.value && !hasBudget && summary.requests.length === 0) return null;

  const currency = summary.budget.currency;
  const money = (v: string) => (currency ? formatMoney(v, currency) : v);

  const saveBudget = async () => {
    const body: { budgetMinutes?: number | null; budgetAmount?: string | null } = {};
    if (hours.trim() !== initialHours) {
      if (hours.trim() === '') body.budgetMinutes = null;
      else {
        const m = Math.round(Number(hours) * 60);
        if (!Number.isFinite(m) || m <= 0) { setBudgetError(t('ticketApproval.budget.invalidHours')); return; }
        body.budgetMinutes = m;
      }
    }
    if (amount.trim() !== initialAmount) {
      if (amount.trim() === '') body.budgetAmount = null;
      else {
        if (!AMOUNT_RE.test(amount.trim()) || Number(amount) <= 0) { setBudgetError(t('ticketApproval.budget.invalidAmount')); return; }
        body.budgetAmount = amount.trim();
      }
    }
    setBudgetError(null);
    if (Object.keys(body).length === 0) return;
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${encodeURIComponent(ticketId)}`, { method: 'PATCH', body: JSON.stringify(body) }),
        errorFallback: t('ticketApproval.budget.saveFailed'),
        successMessage: t('ticketApproval.budget.saved'),
        friendly: approvalFriendly(t),
      });
      onChanged();
    } catch (err) {
      handleActionError(err, t('ticketApproval.budget.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const sendRequest = async () => {
    const body: Record<string, unknown> = { trigger };
    if (trigger === 'budget') {
      const m = extMinutes.trim() === '' ? null : Number(extMinutes);
      const a = extAmount.trim();
      const minutesOk = m !== null && Number.isInteger(m) && m > 0;
      const amountOk = a !== '' && AMOUNT_RE.test(a) && Number(a) > 0;
      if (!minutesOk && !amountOk) { setRequestError(t('ticketApproval.request.invalidExtension')); return; }
      if (m !== null && !minutesOk) { setRequestError(t('ticketApproval.request.invalidExtension')); return; }
      if (a !== '' && !amountOk) { setRequestError(t('ticketApproval.request.invalidExtension')); return; }
      if (minutesOk) body.extensionMinutes = m;
      if (amountOk) body.extensionAmount = a;
    } else {
      const start = windowStart ? new Date(windowStart) : null;
      const end = windowEnd ? new Date(windowEnd) : null;
      if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())
        || end <= start || end.getTime() - start.getTime() > MAX_WINDOW_MS) {
        setRequestError(t('ticketApproval.request.invalidWindow'));
        return;
      }
      body.coverageStartsAt = start.toISOString();
      body.coverageEndsAt = end.toISOString();
    }
    if (message.trim()) body.message = message.trim();
    setRequestError(null);
    setSending(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/tickets/${encodeURIComponent(ticketId)}/approval-requests`, { method: 'POST', body: JSON.stringify(body) }),
        errorFallback: t('ticketApproval.request.failed'),
        successMessage: t('ticketApproval.request.sent'),
        friendly: approvalFriendly(t),
      });
      setRequestOpen(false);
      setExtMinutes(''); setExtAmount(''); setWindowStart(''); setWindowEnd(''); setMessage('');
      onChanged();
    } catch (err) {
      handleActionError(err, t('ticketApproval.request.failed'));
    } finally {
      setSending(false);
    }
  };

  const triggers: ApprovalTrigger[] = [
    ...(summary.policy.budgetTrigger.value ? (['budget'] as const) : []),
    ...(summary.policy.afterHoursTrigger.value ? (['after_hours'] as const) : []),
  ];
  const canRequest = canWrite && summary.policy.enabled.value && triggers.length > 0;
  const effectiveTrigger = triggers.includes(trigger) ? trigger : (triggers[0] ?? 'budget');
  const ext = summary.approvedExtensions;
  const inputClass = 'w-full rounded-md border bg-background px-2 py-1 text-xs';

  return (
    <div className="mt-3 border-t pt-3" data-testid="ticket-budget-card">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('ticketApproval.budget.title')}</p>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="block text-[11px] text-muted-foreground">
          {t('ticketApproval.budget.hours')}
          <input
            type="number" min={0} step={0.25} value={hours} readOnly={!canWrite}
            onChange={(e) => setHours(e.target.value)}
            className={`${inputClass} mt-0.5`} data-testid="ticket-budget-hours"
          />
        </label>
        <label className="block text-[11px] text-muted-foreground">
          {currency ? `${t('ticketApproval.budget.amount')} (${currency})` : t('ticketApproval.budget.amount')}
          <input
            type="text" inputMode="decimal" value={amount} readOnly={!canWrite}
            onChange={(e) => setAmount(e.target.value)}
            className={`${inputClass} mt-0.5`} data-testid="ticket-budget-amount"
          />
        </label>
      </div>
      {budgetError && <p className="mt-1 text-[11px] text-destructive" data-testid="ticket-budget-error">{budgetError}</p>}
      {canWrite && (
        <button type="button" onClick={() => void saveBudget()} disabled={saving} className="mt-2 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50" data-testid="ticket-budget-save">
          {saving ? t('common:states.saving') : t('ticketApproval.budget.save')}
        </button>
      )}

      <div className="mt-2 space-y-0.5" data-testid="ticket-budget-usage">
        {summary.ceiling.minutes != null && (
          <>
            <p className="text-xs" data-testid="ticket-budget-ceiling">
              {ext.minutes > 0
                ? t('ticketApproval.budget.ceilingWithExtensions', {
                    ceiling: formatMinutes(summary.ceiling.minutes),
                    budget: formatMinutes(summary.budget.minutes),
                    extra: formatMinutes(ext.minutes),
                  })
                : t('ticketApproval.budget.ceiling', { ceiling: formatMinutes(summary.ceiling.minutes) })}
            </p>
            <UsageBar
              testId="ticket-budget-bar"
              label={t('ticketApproval.budget.barLabel')}
              ceiling={summary.ceiling.minutes}
              consumed={summary.consumed.minutes}
              held={summary.held.minutes}
              usedText={t('ticketApproval.budget.usedLegend', { value: formatMinutes(summary.consumed.minutes) })}
              heldText={t('ticketApproval.budget.heldLegend', { value: formatMinutes(summary.held.minutes) })}
            />
          </>
        )}
        {summary.ceiling.amount != null && (
          <>
            <p className="pt-1 text-xs" data-testid="ticket-budget-ceiling-amount">
              {summary.approvedExtensions.amount != null && Number(summary.approvedExtensions.amount) > 0 && summary.budget.amount != null
                ? t('ticketApproval.budget.ceilingWithExtensions', {
                    ceiling: money(summary.ceiling.amount),
                    budget: money(summary.budget.amount),
                    extra: money(summary.approvedExtensions.amount),
                  })
                : t('ticketApproval.budget.ceiling', { ceiling: money(summary.ceiling.amount) })}
            </p>
            <UsageBar
              testId="ticket-budget-bar-amount"
              label={t('ticketApproval.budget.barLabel')}
              ceiling={Number(summary.ceiling.amount)}
              consumed={Number(summary.consumed.amount ?? 0)}
              held={Number(summary.held.amount ?? 0)}
              usedText={t('ticketApproval.budget.usedLegend', { value: money(summary.consumed.amount ?? '0') })}
              heldText={t('ticketApproval.budget.heldLegend', { value: money(summary.held.amount ?? '0') })}
            />
          </>
        )}
        {summary.ceiling.minutes == null && summary.ceiling.amount == null && (
          <p className="text-xs text-muted-foreground" data-testid="ticket-budget-none">{t('ticketApproval.budget.noBudget')}</p>
        )}
        {summary.held.unpricedEntryCount > 0 && (
          <p className="text-[10px] text-muted-foreground" data-testid="ticket-budget-unpriced">
            {t('ticketApproval.budget.unpriced', { count: summary.held.unpricedEntryCount })}
          </p>
        )}
      </div>

      {canRequest && (
        <button type="button" onClick={() => setRequestOpen((o) => !o)} className="mt-2 rounded-md border px-2 py-1 text-xs hover:bg-muted" data-testid="ticket-budget-request-toggle">
          {t('ticketApproval.budget.requestApproval')}
        </button>
      )}

      {canRequest && requestOpen && (
        <div className="mt-2 space-y-1.5 rounded-md border bg-muted/30 p-2" data-testid="ticket-budget-request-form">
          {triggers.length > 1 && (
            <label className="block text-[11px] text-muted-foreground">
              {t('ticketApproval.request.trigger')}
              <select value={effectiveTrigger} onChange={(e) => setTrigger(e.target.value as ApprovalTrigger)} className={`${inputClass} mt-0.5`} data-testid="ticket-budget-request-trigger">
                <option value="budget">{t('ticketApproval.request.triggerBudget')}</option>
                <option value="after_hours">{t('ticketApproval.request.triggerAfterHours')}</option>
              </select>
            </label>
          )}
          {effectiveTrigger === 'budget' ? (
            <>
              <label className="block text-[11px] text-muted-foreground">
                {t('ticketApproval.request.extensionMinutes')}
                <input type="number" min={1} step={1} value={extMinutes} onChange={(e) => setExtMinutes(e.target.value)} className={`${inputClass} mt-0.5`} data-testid="ticket-budget-request-extension-minutes" />
              </label>
              <label className="block text-[11px] text-muted-foreground">
                {currency ? `${t('ticketApproval.request.extensionAmount')} (${currency})` : t('ticketApproval.request.extensionAmount')}
                <input type="text" inputMode="decimal" value={extAmount} onChange={(e) => setExtAmount(e.target.value)} className={`${inputClass} mt-0.5`} data-testid="ticket-budget-request-extension-amount" />
              </label>
            </>
          ) : (
            <>
              <label className="block text-[11px] text-muted-foreground">
                {t('ticketApproval.request.windowStart')}
                <input type="datetime-local" value={windowStart} onChange={(e) => setWindowStart(e.target.value)} className={`${inputClass} mt-0.5`} data-testid="ticket-budget-request-window-start" />
              </label>
              <label className="block text-[11px] text-muted-foreground">
                {t('ticketApproval.request.windowEnd')}
                <input type="datetime-local" value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} className={`${inputClass} mt-0.5`} data-testid="ticket-budget-request-window-end" />
              </label>
            </>
          )}
          <label className="block text-[11px] text-muted-foreground">
            {t('ticketApproval.request.message')}
            <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} className={`${inputClass} mt-0.5`} data-testid="ticket-budget-request-message" />
          </label>
          {requestError && <p className="text-[11px] text-destructive" data-testid="ticket-budget-request-error">{requestError}</p>}
          <button type="button" onClick={() => void sendRequest()} disabled={sending} className="w-full rounded-md bg-primary px-2 py-1 text-xs font-medium text-white disabled:opacity-50" data-testid="ticket-budget-request-submit">
            {sending ? t('common:states.saving') : t('ticketApproval.request.submit')}
          </button>
        </div>
      )}
    </div>
  );
}
