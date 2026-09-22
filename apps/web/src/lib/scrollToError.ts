import { useEffect, useRef, type RefObject } from 'react';

/**
 * Scrolls an element into view and moves focus to it. Used for validation
 * errors on long forms/panels where the error renders far from the control
 * that triggered it — without this, submitting an invalid form reads as a
 * silent no-op when the error banner is off-screen.
 *
 * Fixes #6494.
 */
export function scrollErrorIntoView(el: HTMLElement | null | undefined): void {
  if (!el) {
    // This is only called once an error just became truthy, so a null ref
    // here is always a wiring bug (a missed ref callback, a typo'd field
    // key) — never a legitimate "nothing to show" state. Warn in dev so a
    // future regression here doesn't silently reintroduce #6494.
    if (import.meta.env.DEV) {
      console.warn('[scrollErrorIntoView] called with no element — the error ref is not attached.');
    }
    return;
  }
  // jsdom (unit tests) doesn't implement scrollIntoView — guard so tests that
  // don't stub it don't crash a passive effect.
  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (el.getAttribute('tabindex') == null) {
    el.setAttribute('tabindex', '-1');
  }
  el.focus({ preventScroll: true });
}

/**
 * Hook form of {@link scrollErrorIntoView} for the common case of a single
 * error value (or combined truthy/falsy error state) rendered in one place.
 * Scrolls the returned ref's element into view and focuses it whenever
 * `error` becomes truthy with a value that differs from the last error it
 * saw — both on a falsy->truthy transition, and when one truthy error is
 * immediately replaced by a different one (e.g. a caller that sets a new
 * error string without an intervening render that clears it first — those
 * two setState calls are batched into a single commit, so comparing only
 * booleans would miss the change). Attach the ref to the element that
 * renders the error (or the first invalid field).
 */
export function useScrollToError<T extends HTMLElement = HTMLElement>(
  error: unknown,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const prevError = useRef<unknown>(undefined);

  useEffect(() => {
    if (error && error !== prevError.current) {
      scrollErrorIntoView(ref.current);
    }
    prevError.current = error;
  }, [error]);

  return ref;
}
