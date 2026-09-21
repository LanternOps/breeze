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
  if (!el) return;
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
 * `error` transitions from falsy to truthy. Attach the ref to the element
 * that renders the error (or the first invalid field).
 */
export function useScrollToError<T extends HTMLElement = HTMLElement>(
  error: unknown,
): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const hadError = useRef(false);

  useEffect(() => {
    const hasError = Boolean(error);
    if (hasError && !hadError.current) {
      scrollErrorIntoView(ref.current);
    }
    hadError.current = hasError;
  }, [error]);

  return ref;
}
