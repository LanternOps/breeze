import type { TicketDetail } from './ticketConfig';
import { formatRelative } from './ticketConfig';

// Per-target SLA state for the detail rail. Unlike SlaChip (single most-urgent
// state for queue rows), each target gets its own met/breached/counting/paused
// row. Clock math mirrors slaState in ticketConfig.ts — change together.
type TimerState =
  | { kind: 'met'; at: string }
  | { kind: 'breached' }
  | { kind: 'counting'; minutesLeft: number }
  | { kind: 'paused'; minutesLeft: number };

function timerState(
  target: number,
  metAt: string | null,
  breached: boolean,
  createdAt: string,
  slaPausedAt: string | null | undefined,
  slaPausedMinutes: number | null | undefined,
  now: Date
): TimerState {
  if (metAt) return { kind: 'met', at: metAt };
  if (breached) return { kind: 'breached' };
  const clockEnd = slaPausedAt ? new Date(slaPausedAt) : now; // frozen while paused
  const activeElapsed = (clockEnd.getTime() - new Date(createdAt).getTime()) / 60_000 - (slaPausedMinutes ?? 0);
  const minutesLeft = Math.max(0, target - activeElapsed);
  return slaPausedAt ? { kind: 'paused', minutesLeft } : { kind: 'counting', minutesLeft };
}

function TimerRow({ label, state, testId }: { label: string; state: TimerState; testId: string }) {
  const text =
    state.kind === 'met' ? 'Met'
    : state.kind === 'breached' ? 'Breached'
    : state.kind === 'paused' ? `Paused · ${formatRelative(state.minutesLeft)} left`
    : `${formatRelative(state.minutesLeft)} left`;
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
  const breached = new Set((ticket.slaBreachReason ?? '').split(',').map((s) => s.trim()));
  const hasResponse = !!ticket.responseSlaMinutes;
  const hasResolution = !!ticket.resolutionSlaMinutes;
  if (!hasResponse && !hasResolution) return null;
  const terminal = ticket.status === 'resolved' || ticket.status === 'closed';
  return (
    <div className="space-y-2" data-testid="sla-timers">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">SLA</h3>
      {hasResponse && (
        <TimerRow label="First response" testId="sla-timer-response"
          state={timerState(ticket.responseSlaMinutes!, ticket.firstResponseAt, breached.has('response'),
            ticket.createdAt, ticket.slaPausedAt, ticket.slaPausedMinutes, now)} />
      )}
      {hasResolution && (
        <TimerRow label="Resolution" testId="sla-timer-resolution"
          // resolvedAt is stamped on resolve/close and cleared on reopen (ticketService);
          // terminal + updatedAt covers legacy rows that predate the stamp.
          state={timerState(ticket.resolutionSlaMinutes!, ticket.resolvedAt ?? (terminal ? ticket.updatedAt : null),
            breached.has('resolution'), ticket.createdAt, ticket.slaPausedAt, ticket.slaPausedMinutes, now)} />
      )}
      {ticket.slaPausedAt && !terminal && (
        <p className="text-xs text-muted-foreground" data-testid="sla-timers-paused">
          Clock paused while the ticket is {ticket.status === 'on_hold' ? 'on hold' : 'pending'}.
        </p>
      )}
    </div>
  );
}
