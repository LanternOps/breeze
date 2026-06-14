import { fetchWithAuth } from '../stores/auth';
import { runAction } from './runAction';

export const TIMER_CHANGED_EVENT = 'breeze:timer-changed';
export const BILLING_CHANGED_EVENT = 'breeze:billing-changed';

export function broadcastBillingChanged(): void {
  window.dispatchEvent(new CustomEvent(BILLING_CHANGED_EVENT));
}

/** Subscribe to billing-affecting changes (parts/time mutations); returns unsubscribe. */
export function onBillingChanged(cb: () => void): () => void {
  window.addEventListener(BILLING_CHANGED_EVENT, cb);
  return () => window.removeEventListener(BILLING_CHANGED_EVENT, cb);
}

export interface RunningTimer {
  id: string;
  ticketId: string | null;
  startedAt: string;
  description: string | null;
  isBillable: boolean;
  ticketNumber: string | null;
  ticketSubject: string | null;
}

function broadcastTimerChanged(): void {
  window.dispatchEvent(new CustomEvent(TIMER_CHANGED_EVENT));
}

export async function fetchRunningTimer(): Promise<RunningTimer | null> {
  const res = await fetchWithAuth('/time-entries/running');
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { data?: RunningTimer | null } | null;
  return body?.data ?? null;
}

const FRIENDLY_MESSAGES: Record<string, string> = {
  NO_RUNNING_TIMER: 'No timer is currently running.',
  TICKET_NOT_FOUND: 'That ticket no longer exists.',
  APPROVED_IMMUTABLE: 'Approved entries can only be changed by an admin.',
  ENTRY_RUNNING: 'A timer is already running — stop it first.',
  TICKET_WRONG_PARTNER: 'That ticket belongs to a different partner.',
};

const friendly = (code: string): string | undefined => FRIENDLY_MESSAGES[code];

/** Subscribe to timer changes; returns an unsubscribe function for effect cleanup. */
export function onTimerChanged(cb: () => void): () => void {
  window.addEventListener(TIMER_CHANGED_EVENT, cb);
  return () => window.removeEventListener(TIMER_CHANGED_EVENT, cb);
}

/**
 * @throws {ActionError} Failures are already toasted by runAction — callers should swallow
 * ActionError (return early on 401) and only toast non-ActionError.
 */
export async function startTimerAction(input: { ticketId?: string; description?: string } = {}): Promise<void> {
  await runAction({
    request: () => fetchWithAuth('/time-entries/start', { method: 'POST', body: JSON.stringify(input) }),
    errorFallback: 'Failed to start timer',
    successMessage: 'Timer started',
    friendly,
  });
  broadcastTimerChanged();
}

/**
 * @throws {ActionError} Failures are already toasted by runAction — callers should swallow
 * ActionError (return early on 401) and only toast non-ActionError.
 */
export async function stopTimerAction(input: { description?: string; isBillable?: boolean } = {}): Promise<void> {
  await runAction({
    request: () => fetchWithAuth('/time-entries/stop', { method: 'POST', body: JSON.stringify(input) }),
    errorFallback: 'Failed to stop timer',
    successMessage: 'Time entry saved',
    friendly,
  });
  broadcastTimerChanged();
}
