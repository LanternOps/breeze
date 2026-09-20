import { useSyncExternalStore } from 'react';

// No client-side source can change the answer: once React has hydrated an
// island the value is permanently `true`, so the subscribe callback never has
// anything to notify and can drop its listener.
const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * `false` during server rendering AND during the client's hydration pass,
 * `true` from the first post-hydration render onwards.
 *
 * Use it to gate markup whose presence depends on browser-only state (auth
 * claims, `window`, `localStorage`). Rendering such a branch directly makes the
 * client's hydration output structurally differ from the SSR markup, and React
 * responds by throwing away and regenerating the whole subtree (#6391 — the
 * monitor editor's owner-scope block was a `<fieldset>` on the client where the
 * server had emitted the next `<section>`).
 *
 * Gate only the MARKUP. Behaviour derived from the same browser-only state —
 * form defaults, submit payloads — must keep reading it directly: those are
 * computed after hydration anyway, and routing them through this flag would
 * freeze them at their server-side value.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
