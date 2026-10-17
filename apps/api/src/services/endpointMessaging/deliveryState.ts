/**
 * Endpoint message delivery state machine (#8742 W02).
 *
 *   queued ──► delivered ──► displayed ──► acknowledged | dismissed
 *     │            │             │
 *     └────────────┴─────────────┴──► expired | retracted | superseded
 *   queued ──► failed            (only before anything was shown)
 *
 * Inputs: the notify_user command result drives delivered/failed; the agent's
 * message events (routes/agents/messageEvents.ts) drive displayed,
 * acknowledged, dismissed and expired; the operator drives retracted; the
 * retention sweep marks past-expiry live deliveries expired.
 *
 * Events and the command result race (an ack can land before the result), so
 * a forward jump (queued -> acknowledged) is legal, and a late lower-rank
 * input is a no-op, never a regression. Terminal states are final. Every
 * write is a compare-and-set on `status IN allowedFromStatuses(to)`, so
 * concurrent writers cannot regress a row either.
 */
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import {
  endpointMessageDeliveries,
  ENDPOINT_MESSAGE_DELIVERY_STATUSES,
  type EndpointMessageDeliveryStatus as Status,
  type EndpointMessageReceiptEvent,
} from '../../db/schema/endpointMessages';

export const DELIVERY_TERMINAL_STATUSES: readonly Status[] = [
  'acknowledged',
  'dismissed',
  'expired',
  'retracted',
  'failed',
  'superseded',
];

/** Non-terminal states, in progress order. */
const LIVE_RANK: Readonly<Record<'queued' | 'delivered' | 'displayed', number>> = {
  queued: 0,
  delivered: 1,
  displayed: 2,
};

const TERMINAL = new Set<Status>(DELIVERY_TERMINAL_STATUSES);

export function isTerminalDeliveryStatus(s: Status): boolean {
  return TERMINAL.has(s);
}

export function canTransition(from: Status, to: Status): boolean {
  if (TERMINAL.has(from)) return false;
  const fromRank = LIVE_RANK[from as keyof typeof LIVE_RANK];
  if (to === 'failed') return from === 'queued';
  if (TERMINAL.has(to)) return true;
  const toRank = LIVE_RANK[to as keyof typeof LIVE_RANK];
  return toRank > fromRank;
}

/** Every status a row may be in for a write to `to` to apply. */
export function allowedFromStatuses(to: Status): Status[] {
  return ENDPOINT_MESSAGE_DELIVERY_STATUSES.filter((from) => canTransition(from, to));
}

/** CAS predicate for a transition to `to`, ANDed with the caller's row filter. */
export function transitionWhere(to: Status, rowFilter: SQL | undefined): SQL | undefined {
  return and(rowFilter, inArray(endpointMessageDeliveries.status, allowedFromStatuses(to)));
}

/** The timestamp column a transition stamps, if any. */
export function transitionTimestamps(to: Status, at: Date): Partial<typeof endpointMessageDeliveries.$inferInsert> {
  switch (to) {
    case 'delivered':
      return { deliveredAt: at };
    case 'displayed':
      return { displayedAt: at };
    case 'acknowledged':
      return { acknowledgedAt: at };
    case 'dismissed':
      return { dismissedAt: at };
    case 'retracted':
      return { retractedAt: at };
    default:
      return {};
  }
}

export function deliveryStatusFromEvent(event: EndpointMessageReceiptEvent): Status {
  return event;
}

export type DeliveryFailureCode = 'no_helper' | 'agent_unsupported' | 'undelivered';

export type CommandResultOutcome =
  | { status: 'delivered'; surface: 'assist' | 'native' | null }
  | { status: 'retracted' }
  | { status: 'failed'; errorCode: DeliveryFailureCode };

function parseStdout(stdout: string | undefined): Record<string, unknown> {
  if (!stdout) return {};
  try {
    const parsed = JSON.parse(stdout) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Map a notify_user command result onto a delivery outcome. The error text is
 * the agent's (handlers_user_message.go); it is classified, never stored.
 */
export function deliveryStatusFromCommandResult(result: {
  status: 'completed' | 'failed' | 'timeout';
  error?: string;
  stdout?: string;
}): CommandResultOutcome {
  if (result.status === 'completed') {
    const out = parseStdout(result.stdout);
    // The agent had already been told to retract this message and showed nothing.
    if (out.delivered === false && out.retracted === true) return { status: 'retracted' };
    const surface = out.surface === 'assist' || out.surface === 'native' ? out.surface : null;
    return { status: 'delivered', surface };
  }
  const error = (result.error ?? '').trim().toLowerCase();
  if (error.startsWith('unknown command type')) return { status: 'failed', errorCode: 'agent_unsupported' };
  if (error.includes('no user helper connected')) return { status: 'failed', errorCode: 'no_helper' };
  return { status: 'failed', errorCode: 'undelivered' };
}

/** Row filter for one delivery by its notify_user command. */
export function byCommand(commandId: string, deviceId: string): SQL | undefined {
  return and(eq(endpointMessageDeliveries.commandId, commandId), eq(endpointMessageDeliveries.deviceId, deviceId));
}
