import { getSafeNext } from './authNext';

interface NavigateOptions {
  replace?: boolean;
}

/**
 * `'soft'` when Astro's view-transition router swapped the document in place
 * (`transition:persist` islands survived and the page is still alive);
 * `'hard'` when a full page load is happening instead — our own fallback, or
 * Astro's: `navigate()` RESOLVES rather than throws on its internal hard-load
 * paths (fetch failure, non-HTML response, missing view-transitions meta,
 * cross-origin), so "did not throw" is not evidence of a swap. The witness is
 * the `astro:after-swap` event. Outside a browser nothing navigates at all and
 * the result is `'hard'`. Callers that need to act AFTER a navigation (e.g.
 * show a toast from a persisted island) can only do so on the soft path.
 */
export type NavigationMode = 'soft' | 'hard';

export async function navigateTo(path: string, options: NavigateOptions = {}): Promise<NavigationMode> {
  if (typeof window === 'undefined') {
    return 'hard';
  }

  // Guard against open-redirect: callers may pass server-supplied values
  // (e.g. notification/command `href`). Only allow same-origin relative paths;
  // anything else falls back to '/'.
  const safePath = getSafeNext(path, '/');

  let swapped = false;
  const onSwap = () => { swapped = true; };
  document.addEventListener('astro:after-swap', onSwap, { once: true });
  try {
    const { navigate } = await import('astro:transitions/client');
    await navigate(safePath, {
      history: options.replace ? 'replace' : 'auto'
    });
    return swapped ? 'soft' : 'hard';
  } catch {
    if (options.replace) {
      window.location.replace(safePath);
    } else {
      window.location.assign(safePath);
    }
    return 'hard';
  } finally {
    document.removeEventListener('astro:after-swap', onSwap);
  }
}
