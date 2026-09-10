import { getSafeNext } from './authNext';

interface NavigateOptions {
  replace?: boolean;
}

/**
 * `'soft'` when Astro's view-transition router handled the navigation (the
 * document is swapped in place and `transition:persist` islands survive);
 * `'hard'` when it fell back to a full page load. Callers that need to act
 * AFTER a navigation (e.g. show a toast from a persisted island) can only do
 * so on the soft path — on the hard path the page is about to unload.
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

  try {
    const { navigate } = await import('astro:transitions/client');
    await navigate(safePath, {
      history: options.replace ? 'replace' : 'auto'
    });
    return 'soft';
  } catch {
    if (options.replace) {
      window.location.replace(safePath);
    } else {
      window.location.assign(safePath);
    }
    return 'hard';
  }
}
