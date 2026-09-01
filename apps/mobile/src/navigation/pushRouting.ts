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

/**
 * Live-tap guard.
 *
 * expo delivers the response that LAUNCHED the app to the response listener as
 * well as through `getLastNotificationResponseAsync()`, so a cold-start tap
 * arrives down both paths and would otherwise be handled twice.
 *
 * The default is the opposite of {@link shouldReplayResponse} on purpose: a
 * live tap is a real user action, so being unable to dedupe it (no identifier)
 * must not mean discarding it. The worst case is one redundant navigation to a
 * screen the technician just asked for.
 */
export function shouldHandleTap(
  identifier: string | null | undefined,
  lastHandled: string | null
): boolean {
  if (!identifier) return true;
  return identifier !== lastHandled;
}
