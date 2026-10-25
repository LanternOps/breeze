import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import type { TicketDetail } from './ticketConfig';
import { formatRelative } from './ticketConfig';

// Reads the server-stored due dates (#8973: responseDueAt / resolutionDueAt, which already include
// paused time) — no target arithmetic here. Same due dates as slaState in ticketConfig.ts; unlike
// slaState it does not use the warn points or slaBusinessMinutesRemaining.
type TimerState =
  | { kind: 'met' }
  | { kind: 'metLate' }
  | { kind: 'missed' }
  | { kind: 'breached' }
  | { kind: 'counting'; minutesLeft: number }
  | { kind: 'paused'; minutesLeft: number };

function timerState(
  due: string,
  metAt: string | null,
  breached: boolean,
  terminal: boolean,
  slaPausedAt: string | null | undefined,
  now: Date
): TimerState {
  if (metAt) return new Date(metAt).getTime() <= new Date(due).getTime() ? { kind: 'met' } : { kind: 'metLate' };
  if (breached) return { kind: 'breached' };
  if (terminal) return { kind: 'missed' };
  const clockEnd = slaPausedAt ? new Date(slaPausedAt) : now; // frozen while paused
  const minutesLeft = Math.max(0, (new Date(due).getTime() - clockEnd.getTime()) / 60_000);
  return slaPausedAt ? { kind: 'paused', minutesLeft } : { kind: 'counting', minutesLeft };
}

function TimerRow({ label, state, testId }: { label: string; state: TimerState; testId: string }) {
  const { t } = useTranslation('tickets');
  const text =
    state.kind === 'met' ? t('slaTimers.state.met')
    : state.kind === 'metLate' ? t('slaTimers.state.metLate')
    : state.kind === 'missed' ? t('slaTimers.state.notMet')
    : state.kind === 'breached' ? t('slaTimers.state.breached')
    : state.kind === 'paused' ? t('slaTimers.state.pausedLeft', { relative: formatRelative(state.minutesLeft) })
    : t('slaTimers.state.left', { relative: formatRelative(state.minutesLeft) });
  const tone =
    (state.kind === 'breached' || state.kind === 'metLate') ? 'text-red-700 dark:text-red-400'
    : state.kind === 'met' ? 'text-success'
    : 'text-muted-foreground';
  return (
    <div className="flex items-center justify-between text-sm" data-testid={testId}>
      <span className="text-muted-foreground">{label}</span>
      <span className={tone}>{text}</span>
    </div>
  );
}

export function SlaTimers({ ticket, now = new Date() }: { ticket: TicketDetail; now?: Date }) {
  const { t } = useTranslation('tickets');
  const breached = new Set((ticket.slaBreachReason ?? '').split(',').map((s) => s.trim()));
  const hasResponse = !!ticket.responseDueAt;
  const hasResolution = !!ticket.resolutionDueAt;
  if (!hasResponse && !hasResolution) return null;
  const terminal = ticket.status === 'resolved' || ticket.status === 'closed';
  return (
    <div className="space-y-2" data-testid="sla-timers">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('slaTimers.title')}</h3>
      {hasResponse && (
        <TimerRow label={t('slaTimers.firstResponse')} testId="sla-timer-response"
          state={timerState(ticket.responseDueAt!, ticket.firstResponseAt, breached.has('response'),
            terminal, ticket.slaPausedAt, now)} />
      )}
      {hasResolution && (
        <TimerRow label={t('slaTimers.resolution')} testId="sla-timer-resolution"
          // resolvedAt is stamped on resolve/close and cleared on reopen (ticketService).
          // A legacy terminal row that predates the stamp has no completion time
          // (updatedAt moves on any later edit), so it reads "Met" as it always did.
          state={!ticket.resolvedAt && terminal && !breached.has('resolution')
            ? { kind: 'met' }
            : timerState(ticket.resolutionDueAt!, ticket.resolvedAt ?? null,
              breached.has('resolution'), terminal, ticket.slaPausedAt, now)} />
      )}
      {ticket.slaPausedAt && !terminal && (
        <p className="text-xs text-muted-foreground" data-testid="sla-timers-paused">
          {t('slaTimers.clockPaused', {
            status: ticket.status === 'on_hold' ? t('slaTimers.status.onHold') : t('slaTimers.status.pending'),
          })}
        </p>
      )}
    </div>
  );
}
