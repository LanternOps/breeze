import { parseTicketData } from '../services/notifications';

/**
 * W10 (#4336). Where a push tap should land, decided without touching
 * navigation state — so the decision is unit-testable and the component that
 * performs it stays a thin listener.
 *
 * Only ticket pushes route here. Approval pushes are owned by `ApprovalGate`
 * (it focuses the approval and takes the screen over) and alert pushes have no
 * tap handler yet; both must resolve to `null` rather than being routed twice.
 */
export type PushRoute = { kind: 'ticket'; ticketId: string } | null;

/** AsyncStorage key holding the last notification response we already acted on. */
export const LAST_HANDLED_RESPONSE_KEY = 'notif:lastHandledResponseId';

export function resolvePushRoute(data: Record<string, unknown> | null | undefined): PushRoute {
  const ticket = parseTicketData(data);
  return ticket ? { kind: 'ticket', ticketId: ticket.ticketId } : null;
}

/**
 * Cold-start replay guard.
 *
 * `getLastNotificationResponseAsync()` returns the SAME response on every
 * mount for the whole process lifetime — it is "what launched the app", not "a
 * new tap". Replaying it unguarded yanks the technician back to a ticket every
 * time the navigator remounts. The response identifier is the only stable
 * discriminator, so no identifier means no replay.
 */
export function shouldReplayResponse(
  identifier: string | null | undefined,
  lastHandled: string | null
): boolean {
  if (!identifier) return false;
  return identifier !== lastHandled;
}
