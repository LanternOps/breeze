import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import type { TicketDetail } from './ticketConfig';
import { formatRelative } from './ticketConfig';

// Clock math mirrors slaState in ticketConfig.ts, which is the client twin of
// services/ticketSla.ts, jobs/ticketSlaWorker.ts, and the SQL in routes/tickets/tickets.ts.
// Change all of them together.
type TimerState =
  | { kind: 'met' }
  | { kind: 'missed' }
  | { kind: 'breached' }
  | { kind: 'counting'; minutesLeft: number }
  | { kind: 'paused'; minutesLeft: number };

function timerState(
  target: number,
  metAt: string | null,
  breached: boolean,
  terminal: boolean,
  createdAt: string,
  slaPausedAt: string | null | undefined,
  slaPausedMinutes: number | null | undefined,
  now: Date
): TimerState {
  if (metAt) return { kind: 'met' };
  if (breached) return { kind: 'breached' };
  if (terminal) return { kind: 'missed' };
  const clockEnd = slaPausedAt ? new Date(slaPausedAt) : now; // frozen while paused
  const activeElapsed = (clockEnd.getTime() - new Date(createdAt).getTime()) / 60_000 - (slaPausedMinutes ?? 0);
  const minutesLeft = Math.max(0, target - activeElapsed);
  return slaPausedAt ? { kind: 'paused', minutesLeft } : { kind: 'counting', minutesLeft };
}

function TimerRow({ label, state, testId }: { label: string; state: TimerState; testId: string }) {
  const { t } = useTranslation('tickets');
  const text =
    state.kind === 'met' ? t('slaTimers.state.met')
    : state.kind === 'missed' ? t('slaTimers.state.notMet')
    : state.kind === 'breached' ? t('slaTimers.state.breached')
    : state.kind === 'paused' ? t('slaTimers.state.pausedLeft', { relative: formatRelative(state.minutesLeft) })
    : t('slaTimers.state.left', { relative: formatRelative(state.minutesLeft) });
  const tone =
    state.kind === 'breached' ? 'text-red-700 dark:text-red-400'
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
  const hasResponse = !!ticket.responseSlaMinutes;
  const hasResolution = !!ticket.resolutionSlaMinutes;
  if (!hasResponse && !hasResolution) return null;
  const terminal = ticket.status === 'resolved' || ticket.status === 'closed';
  return (
    <div className="space-y-2" data-testid="sla-timers">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('slaTimers.title')}</h3>
      {hasResponse && (
        <TimerRow label={t('slaTimers.firstResponse')} testId="sla-timer-response"
          state={timerState(ticket.responseSlaMinutes!, ticket.firstResponseAt, breached.has('response'),
            terminal, ticket.createdAt, ticket.slaPausedAt, ticket.slaPausedMinutes, now)} />
      )}
      {hasResolution && (
        <TimerRow label={t('slaTimers.resolution')} testId="sla-timer-resolution"
          // resolvedAt is stamped on resolve/close and cleared on reopen (ticketService);
          // terminal + updatedAt covers legacy rows that predate the stamp.
          state={timerState(ticket.resolutionSlaMinutes!, ticket.resolvedAt ?? (terminal ? ticket.updatedAt : null),
            breached.has('resolution'), terminal, ticket.createdAt, ticket.slaPausedAt, ticket.slaPausedMinutes, now)} />
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
