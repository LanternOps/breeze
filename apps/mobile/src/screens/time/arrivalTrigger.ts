/**
 * Tiny in-process bus for "check for an arrival now". The Tickets pull-to-refresh
 * and tab focus emit; `useArrivalPrompt` listens. A bus (not a prop) because the
 * emitters live in screens that have no business knowing about location.
 */
type Listener = (manual: boolean) => void;

const listeners = new Set<Listener>();

export function subscribeArrivalCheck(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `manual` = the technician pulled to refresh; it bypasses the 5-minute read debounce. */
export function requestArrivalCheck(manual = false): void {
  for (const listener of [...listeners]) {
    try {
      listener(manual);
    } catch {
      // One bad subscriber must not stop the others.
    }
  }
}

const ARRIVAL_TABS = new Set(['HomeTab', 'TicketsTab']);

export function isArrivalTab(routeName: string): boolean {
  return ARRIVAL_TABS.has(routeName);
}
